//! BIP-39 mnemonics (English), matching `@scure/bip39`.
//!
//! PBKDF2-HMAC-SHA512 is built on `bitcoin::hashes`; the wordlist is embedded.
//! Mnemonics and passphrases must be ASCII: BIP-39 asks for NFKD
//! normalization, which this crate does not carry the Unicode tables for, so
//! non-ASCII input is refused rather than silently deriving a different seed.

use bitcoin::hashes::{hmac, sha256, sha512, Hash, HashEngine};

use super::wordlist::ENGLISH;
use super::{fail, SigningError};

/// Word counts BIP-39 allows.
const WORD_COUNTS: [usize; 5] = [12, 15, 18, 21, 24];

/// Mnemonic for 16, 20, 24, 28 or 32 bytes of entropy.
pub fn entropy_to_mnemonic(entropy: &[u8]) -> Result<String, SigningError> {
    if !(16..=32).contains(&entropy.len()) || entropy.len() % 4 != 0 {
        return fail(
            "invalid_entropy",
            "Entropy must be 16, 20, 24, 28 or 32 bytes",
        );
    }
    let checksum = sha256::Hash::hash(entropy).to_byte_array();
    let bits = entropy.len() * 8 + entropy.len() / 4;
    let bit = |i: usize| -> u32 {
        let byte = if i < entropy.len() * 8 {
            entropy[i / 8]
        } else {
            checksum[(i - entropy.len() * 8) / 8]
        };
        u32::from((byte >> (7 - (i % 8))) & 1)
    };
    let words: Vec<&str> = (0..bits / 11)
        .map(|w| {
            let idx = (0..11).fold(0u32, |acc, j| (acc << 1) | bit(w * 11 + j));
            ENGLISH[idx as usize]
        })
        .collect();
    Ok(words.join(" "))
}

/// Entropy of a mnemonic, checking word count, words and checksum.
/// Words are separated by single spaces, exactly as `@scure/bip39` requires.
pub fn mnemonic_to_entropy(mnemonic: &str) -> Result<Vec<u8>, SigningError> {
    let words: Vec<&str> = mnemonic.split(' ').collect();
    if !WORD_COUNTS.contains(&words.len()) {
        return fail("invalid_mnemonic", "Invalid mnemonic: wrong word count");
    }
    let mut indexes = Vec::with_capacity(words.len());
    for w in &words {
        match ENGLISH.binary_search(w) {
            Ok(i) => indexes.push(i as u32),
            Err(_) => return fail("invalid_mnemonic", "Invalid mnemonic: unknown word"),
        }
    }
    let total_bits = words.len() * 11;
    let cs_bits = total_bits / 33;
    let ent_bytes = (total_bits - cs_bits) / 8;
    let bit = |i: usize| -> u8 { ((indexes[i / 11] >> (10 - (i % 11))) & 1) as u8 };
    let entropy: Vec<u8> = (0..ent_bytes)
        .map(|b| (0..8).fold(0u8, |acc, j| (acc << 1) | bit(b * 8 + j)))
        .collect();
    let checksum = sha256::Hash::hash(&entropy).to_byte_array();
    for i in 0..cs_bits {
        let expected = (checksum[i / 8] >> (7 - (i % 8))) & 1;
        if bit(ent_bytes * 8 + i) != expected {
            return fail("invalid_mnemonic", "Invalid mnemonic: bad checksum");
        }
    }
    Ok(entropy)
}

/// True for a mnemonic with a valid word count, words and checksum.
pub fn validate_mnemonic(mnemonic: &str) -> bool {
    mnemonic_to_entropy(mnemonic).is_ok()
}

/// A fresh 12-word mnemonic (128 bits from the OS CSPRNG).
pub fn generate_mnemonic() -> Result<String, SigningError> {
    let mut entropy = [0u8; 16];
    getrandom::getrandom(&mut entropy)
        .map_err(|e| SigningError::new("rng_failed", format!("OS random source failed: {e}")))?;
    entropy_to_mnemonic(&entropy)
}

/// The 64-byte BIP-39 seed: PBKDF2-HMAC-SHA512, 2048 rounds, salt
/// `"mnemonic" + passphrase`. Like `mnemonicToSeedSync`, the mnemonic is not
/// validated here. ASCII only (see the module docs).
pub fn mnemonic_to_seed(mnemonic: &str, passphrase: &str) -> Result<[u8; 64], SigningError> {
    if !mnemonic.is_ascii() || !passphrase.is_ascii() {
        return fail(
            "unsupported_mnemonic",
            "Only ASCII mnemonics and passphrases are supported (NFKD normalization is not available)",
        );
    }
    let mut salt = Vec::with_capacity(12 + passphrase.len());
    salt.extend_from_slice(b"mnemonic");
    salt.extend_from_slice(passphrase.as_bytes());
    Ok(pbkdf2_hmac_sha512(mnemonic.as_bytes(), &salt, 2048))
}

/// PBKDF2 (RFC 8018) with HMAC-SHA512, one 64-byte block.
fn pbkdf2_hmac_sha512(password: &[u8], salt: &[u8], rounds: u32) -> [u8; 64] {
    let keyed = hmac::HmacEngine::<sha512::Hash>::new(password);
    let mut engine = keyed.clone();
    engine.input(salt);
    engine.input(&1u32.to_be_bytes());
    let mut u = hmac::Hmac::<sha512::Hash>::from_engine(engine).to_byte_array();
    let mut out = u;
    for _ in 1..rounds {
        let mut engine = keyed.clone();
        engine.input(&u);
        u = hmac::Hmac::<sha512::Hash>::from_engine(engine).to_byte_array();
        for (o, b) in out.iter_mut().zip(u.iter()) {
            *o ^= b;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordlist_is_the_bip39_english_list() {
        let joined = ENGLISH.join("\n") + "\n";
        assert_eq!(
            sha256::Hash::hash(joined.as_bytes()).to_string(),
            "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
        );
        assert!(
            ENGLISH.windows(2).all(|w| w[0] < w[1]),
            "sorted for binary search"
        );
    }

    #[test]
    fn pbkdf2_rfc_vector() {
        // RFC 6070-style check for SHA-512 (password/salt, 1 round), widely published.
        let out = pbkdf2_hmac_sha512(b"password", b"salt", 1);
        assert_eq!(
            super::super::util::to_hex(&out),
            "867f70cf1ade02cff3752599a3a53dc4af34c7a669815ae5d513554e1c8cf252c02d470a285a0501bad999bfe943c08f050235d7d68b1da55e63f73b60a57fce"
        );
    }

    #[test]
    fn generated_mnemonics_validate() {
        let m = generate_mnemonic().unwrap();
        assert_eq!(m.split(' ').count(), 12);
        assert!(validate_mnemonic(&m));
        assert_ne!(m, generate_mnemonic().unwrap());
    }
}
