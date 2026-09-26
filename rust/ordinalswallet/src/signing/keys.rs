//! In-memory signing keys: BIP-39 mnemonic or WIF to the wallet's key, its
//! BIP-86 taproot address and the P2WPKH address of the same key.

use std::fmt;
use std::str::FromStr;
use std::sync::OnceLock;

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::key::{Keypair, TapTweak};
use bitcoin::secp256k1::{self, All, Message, Secp256k1, SecretKey};
use bitcoin::{Address, CompressedPublicKey, Network, PrivateKey, TapNodeHash, XOnlyPublicKey};

use super::bip39::{mnemonic_to_seed, validate_mnemonic};
use super::{bip322, fail, SigningError};

/// The derivation path of the SDK wallet key (BIP-86, first receive address),
/// the same as `@ow-cli/core` `keypairFromMnemonic`.
pub const DERIVATION_PATH: &str = "m/86'/0'/0'/0/0";

pub(crate) fn secp() -> &'static Secp256k1<All> {
    static SECP: OnceLock<Secp256k1<All>> = OnceLock::new();
    SECP.get_or_init(Secp256k1::new)
}

/// A private key held in memory, plus how Schnorr signatures get their
/// BIP-340 auxiliary randomness.
///
/// By default every Schnorr signature draws 32 fresh bytes from the OS
/// CSPRNG. [`SigningKey::with_aux_rand`] fixes them, which makes signatures
/// reproducible (the shared test vectors use all-zero aux data); that is
/// safe (BIP-340 nonces stay secret without it) but gives up the side-channel
/// hardening fresh randomness adds, so only do it for tests. ECDSA
/// signatures are RFC 6979 deterministic either way.
///
/// The secret is erased (best effort) when the key is dropped. `Debug`
/// never prints it.
pub struct SigningKey {
    secret: SecretKey,
    aux_rand: Option<[u8; 32]>,
}

impl fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SigningKey")
            .field("x_only_public_key", &self.x_only_hex())
            .finish_non_exhaustive()
    }
}

impl Drop for SigningKey {
    fn drop(&mut self) {
        self.secret.non_secure_erase();
    }
}

impl Clone for SigningKey {
    fn clone(&self) -> Self {
        SigningKey {
            secret: self.secret,
            aux_rand: self.aux_rand,
        }
    }
}

impl SigningKey {
    /// The key at [`DERIVATION_PATH`] of a BIP-39 mnemonic (no passphrase).
    /// Refuses a mnemonic that fails [`validate_mnemonic`].
    pub fn from_mnemonic(mnemonic: &str) -> Result<Self, SigningError> {
        if !validate_mnemonic(mnemonic) {
            return fail("invalid_mnemonic", "Invalid mnemonic");
        }
        let seed = mnemonic_to_seed(mnemonic, "")?;
        let master = Xpriv::new_master(Network::Bitcoin, &seed)
            .map_err(|e| SigningError::new("derivation_failed", e.to_string()))?;
        let path = DerivationPath::from_str(DERIVATION_PATH).expect("constant path parses");
        let derived = master
            .derive_priv(secp(), &path)
            .map_err(|e| SigningError::new("derivation_failed", e.to_string()))?;
        Ok(Self::from_secret_key(derived.private_key))
    }

    /// A WIF private key (compressed or not; the public key used is always
    /// the compressed one, as in the TypeScript SDK).
    pub fn from_wif(wif: &str) -> Result<Self, SigningError> {
        let key = PrivateKey::from_wif(wif)
            .map_err(|e| SigningError::new("invalid_wif", format!("Invalid WIF: {e}")))?;
        Ok(Self::from_secret_key(key.inner))
    }

    /// A raw 32-byte private key.
    pub fn from_secret_bytes(bytes: &[u8]) -> Result<Self, SigningError> {
        let secret = SecretKey::from_slice(bytes)
            .map_err(|_| SigningError::new("invalid_private_key", "Invalid private key"))?;
        Ok(Self::from_secret_key(secret))
    }

    fn from_secret_key(secret: SecretKey) -> Self {
        SigningKey {
            secret,
            aux_rand: None,
        }
    }

    /// Use fixed BIP-340 auxiliary randomness for every Schnorr signature
    /// (reproducible signatures; tests and vectors only).
    pub fn with_aux_rand(mut self, aux_rand: [u8; 32]) -> Self {
        self.aux_rand = Some(aux_rand);
        self
    }

    /// The raw private key. Handle with care.
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.secret.secret_bytes()
    }

    /// 33-byte compressed public key.
    pub fn public_key(&self) -> [u8; 33] {
        self.secret.public_key(secp()).serialize()
    }

    /// Hex of [`SigningKey::public_key`], the form the API's `public_key` fields take.
    pub fn public_key_hex(&self) -> String {
        super::util::to_hex(&self.public_key())
    }

    /// 32-byte x-only public key (the untweaked BIP-340 key).
    pub fn x_only_public_key(&self) -> [u8; 32] {
        self.xonly().serialize()
    }

    fn x_only_hex(&self) -> String {
        super::util::to_hex(&self.x_only_public_key())
    }

    pub(crate) fn xonly(&self) -> XOnlyPublicKey {
        self.keypair().x_only_public_key().0
    }

    pub(crate) fn keypair(&self) -> Keypair {
        Keypair::from_secret_key(secp(), &self.secret)
    }

    /// The key's BIP-86 taproot address (`bc1p…`), the SDK wallet address.
    pub fn p2tr_address(&self) -> String {
        Address::p2tr(secp(), self.xonly(), None, Network::Bitcoin).to_string()
    }

    /// The P2WPKH address (`bc1q…`) of the same key.
    pub fn p2wpkh_address(&self) -> String {
        let pk = CompressedPublicKey(self.secret.public_key(secp()));
        Address::p2wpkh(&pk, Network::Bitcoin).to_string()
    }

    fn aux(&self) -> Result<[u8; 32], SigningError> {
        if let Some(aux) = self.aux_rand {
            return Ok(aux);
        }
        let mut aux = [0u8; 32];
        getrandom::getrandom(&mut aux).map_err(|e| {
            SigningError::new("rng_failed", format!("OS random source failed: {e}"))
        })?;
        Ok(aux)
    }

    /// BIP-340 signature with the untweaked key (script-path spends).
    pub(crate) fn sign_schnorr(&self, digest: [u8; 32]) -> Result<[u8; 64], SigningError> {
        let aux = self.aux()?;
        let sig =
            secp().sign_schnorr_with_aux_rand(&Message::from_digest(digest), &self.keypair(), &aux);
        Ok(*sig.as_ref())
    }

    /// BIP-340 signature with the key tweaked for a taproot output
    /// (`merkle_root` = None for a BIP-86 key-path output).
    pub(crate) fn sign_schnorr_tweaked(
        &self,
        digest: [u8; 32],
        merkle_root: Option<TapNodeHash>,
    ) -> Result<[u8; 64], SigningError> {
        let aux = self.aux()?;
        let tweaked = self.keypair().tap_tweak(secp(), merkle_root).to_keypair();
        let sig = secp().sign_schnorr_with_aux_rand(&Message::from_digest(digest), &tweaked, &aux);
        Ok(*sig.as_ref())
    }

    /// Low-S DER ECDSA signature (RFC 6979), without the sighash byte.
    pub(crate) fn sign_ecdsa(&self, digest: [u8; 32]) -> Vec<u8> {
        secp()
            .sign_ecdsa(&Message::from_digest(digest), &self.secret)
            .serialize_der()
            .to_vec()
    }

    /// A BIP-322 simple signature (base64) of `message` for `address`
    /// (this key's `bc1p…` or `bc1q…` address).
    pub fn sign_message(&self, address: &str, message: &str) -> Result<String, SigningError> {
        bip322::sign_simple(address, message.as_bytes(), self)
    }
}

/// Signs the sign-in message for [`crate::auth::SessionManager`] and
/// [`crate::auth::AuthApi::sign_in`] with this key (BIP-322 simple).
impl crate::auth::MessageSigner for SigningKey {
    fn sign_message(&self, address: &str, message: &str) -> crate::Result<String> {
        SigningKey::sign_message(self, address, message).map_err(crate::Error::from)
    }
}

pub(crate) fn verify_schnorr(sig: &[u8], digest: [u8; 32], key: &[u8]) -> bool {
    let (Ok(sig), Ok(key)) = (
        secp256k1::schnorr::Signature::from_slice(sig),
        XOnlyPublicKey::from_slice(key),
    ) else {
        return false;
    };
    secp()
        .verify_schnorr(&sig, &Message::from_digest(digest), &key)
        .is_ok()
}
