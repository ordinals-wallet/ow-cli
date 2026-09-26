//! BIP-322 "simple" message signatures for P2TR (key path) and P2WPKH.
//!
//! A simple signature is the witness stack of a virtual `to_sign`
//! transaction spending a virtual `to_spend` output locked to the signer's
//! address, serialized and base64 encoded. This is what `POST /auth/session`
//! verifies (`bip322::verify_simple_encoded` on the server).
//! Port of `@ow-cli/core` `bip322.ts`.

use std::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::hashes::{sha256, Hash, HashEngine};
use bitcoin::secp256k1::{ecdsa, Message, PublicKey};
use bitcoin::sighash::{EcdsaSighashType, Prevouts, SighashCache, TapSighashType};
use bitcoin::transaction::Version;
use bitcoin::{
    Address, Amount, CompressedPublicKey, Network, OutPoint, ScriptBuf, Sequence, Transaction,
    TxIn, TxOut, Txid, Witness,
};

use super::keys::{secp, verify_schnorr, SigningKey};
use super::util::{base64_decode, base64_encode};
use super::{fail, SigningError};

/// Address types BIP-322 signing supports here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressType {
    P2tr,
    P2wpkh,
}

/// `tagged_hash("BIP0322-signed-message", message)`.
pub fn message_hash(message: &[u8]) -> [u8; 32] {
    tagged_hash("BIP0322-signed-message", message)
}

pub(crate) fn tagged_hash(tag: &str, data: &[u8]) -> [u8; 32] {
    let t = sha256::Hash::hash(tag.as_bytes());
    let mut engine = sha256::Hash::engine();
    engine.input(t.as_ref());
    engine.input(t.as_ref());
    engine.input(data);
    sha256::Hash::from_engine(engine).to_byte_array()
}

/// Output script for a mainnet `bc1p…` / `bc1q…` address, with its type.
pub fn address_script(address: &str) -> Result<(AddressType, ScriptBuf), SigningError> {
    let addr = Address::from_str(address)
        .ok()
        .and_then(|a| a.require_network(Network::Bitcoin).ok())
        .ok_or_else(|| {
            SigningError::new("invalid_address", format!("Invalid address: {address}"))
        })?;
    let script = addr.script_pubkey();
    if script.is_p2tr() {
        Ok((AddressType::P2tr, script))
    } else if script.is_p2wpkh() {
        Ok((AddressType::P2wpkh, script))
    } else {
        fail(
            "unsupported_address",
            "BIP-322: unsupported address type (only bc1p and bc1q are supported)",
        )
    }
}

fn to_spend(script_pubkey: &ScriptBuf, message: &[u8]) -> Transaction {
    let mut script_sig = vec![0x00, 0x20];
    script_sig.extend_from_slice(&message_hash(message));
    Transaction {
        version: Version(0),
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: Txid::all_zeros(),
                vout: 0xffff_ffff,
            },
            script_sig: ScriptBuf::from_bytes(script_sig),
            sequence: Sequence(0),
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::ZERO,
            script_pubkey: script_pubkey.clone(),
        }],
    }
}

/// Display-order txid of the virtual `to_spend` transaction.
pub fn to_spend_txid(script_pubkey: &ScriptBuf, message: &[u8]) -> String {
    to_spend(script_pubkey, message).compute_txid().to_string()
}

fn to_sign(script_pubkey: &ScriptBuf, message: &[u8]) -> Transaction {
    Transaction {
        version: Version(0),
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: to_spend(script_pubkey, message).compute_txid(),
                vout: 0,
            },
            script_sig: ScriptBuf::new(),
            sequence: Sequence(0),
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::ZERO,
            script_pubkey: ScriptBuf::from_bytes(vec![0x6a]),
        }],
    }
}

fn taproot_digest(
    script_pubkey: &ScriptBuf,
    message: &[u8],
    sighash: TapSighashType,
) -> Option<[u8; 32]> {
    let tx = to_sign(script_pubkey, message);
    let prevouts = [TxOut {
        value: Amount::ZERO,
        script_pubkey: script_pubkey.clone(),
    }];
    SighashCache::new(&tx)
        .taproot_key_spend_signature_hash(0, &Prevouts::All(&prevouts), sighash)
        .ok()
        .map(|h| h.to_byte_array())
}

fn segwit_digest(script_pubkey: &ScriptBuf, message: &[u8]) -> Option<[u8; 32]> {
    let tx = to_sign(script_pubkey, message);
    SighashCache::new(&tx)
        .p2wpkh_signature_hash(0, script_pubkey, Amount::ZERO, EcdsaSighashType::All)
        .ok()
        .map(|h| h.to_byte_array())
}

fn encode_witness(stack: &[Vec<u8>]) -> String {
    let mut w = Witness::new();
    for item in stack {
        w.push(item);
    }
    base64_encode(&bitcoin::consensus::serialize(&w))
}

fn read_varint(bytes: &[u8], off: &mut usize) -> Option<usize> {
    let first = *bytes.get(*off)?;
    *off += 1;
    match first {
        0..=0xfc => Some(first as usize),
        0xfd => {
            let v = u16::from_le_bytes([*bytes.get(*off)?, *bytes.get(*off + 1)?]);
            *off += 2;
            Some(v as usize)
        }
        _ => None,
    }
}

fn decode_witness(encoded: &str) -> Option<Vec<Vec<u8>>> {
    // Newer BIP-322 revisions prefix simple signatures with "smp"; accept both.
    let bytes = base64_decode(encoded.strip_prefix("smp").unwrap_or(encoded))?;
    let mut off = 0;
    let n = read_varint(&bytes, &mut off)?;
    let mut stack = Vec::new();
    for _ in 0..n {
        let len = read_varint(&bytes, &mut off)?;
        let item = bytes.get(off..off.checked_add(len)?)?;
        stack.push(item.to_vec());
        off += len;
    }
    (off == bytes.len()).then_some(stack)
}

/// Sign `message` for `address` with a BIP-322 simple signature (base64).
///
/// - `bc1p…`: key-path Schnorr signature with SIGHASH_DEFAULT (64 bytes). The
///   address must be the BIP-86 key-path output of `key`.
/// - `bc1q…`: ECDSA signature with SIGHASH_ALL plus the compressed public key.
pub fn sign_simple(
    address: &str,
    message: &[u8],
    key: &SigningKey,
) -> Result<String, SigningError> {
    let (kind, script) = address_script(address)?;
    match kind {
        AddressType::P2tr => {
            let expected = ScriptBuf::new_p2tr(secp(), key.xonly(), None);
            if expected != script {
                return fail(
                    "key_mismatch",
                    "BIP-322: private key does not control this taproot address",
                );
            }
            let digest =
                taproot_digest(&script, message, TapSighashType::Default).ok_or_else(|| {
                    SigningError::new("sign_failed", "BIP-322: taproot signing failed")
                })?;
            let sig = key.sign_schnorr_tweaked(digest, None)?;
            Ok(encode_witness(&[sig.to_vec()]))
        }
        AddressType::P2wpkh => {
            let pubkey = key.public_key();
            let expected = ScriptBuf::new_p2wpkh(
                &CompressedPublicKey::from_slice(&pubkey)
                    .expect("valid")
                    .wpubkey_hash(),
            );
            if expected != script {
                return fail(
                    "key_mismatch",
                    "BIP-322: private key does not control this segwit address",
                );
            }
            let digest = segwit_digest(&script, message).ok_or_else(|| {
                SigningError::new("sign_failed", "BIP-322: segwit signing failed")
            })?;
            let mut sig = key.sign_ecdsa(digest);
            sig.push(EcdsaSighashType::All as u8);
            Ok(encode_witness(&[sig, pubkey.to_vec()]))
        }
    }
}

/// Verify a BIP-322 simple signature for a `bc1p…` (key path) or `bc1q…`
/// address. Returns false for anything malformed rather than failing.
pub fn verify_simple(address: &str, message: &[u8], signature: &str) -> bool {
    let Ok((kind, script)) = address_script(address) else {
        return false;
    };
    let Some(stack) = decode_witness(signature) else {
        return false;
    };
    match kind {
        AddressType::P2tr => {
            if stack.len() != 1 {
                return false;
            }
            let sig = &stack[0];
            let hash_type = match sig.len() {
                64 => TapSighashType::Default,
                65 if sig[64] == 0x01 => TapSighashType::All,
                _ => return false,
            };
            let Some(digest) = taproot_digest(&script, message, hash_type) else {
                return false;
            };
            verify_schnorr(&sig[..64], digest, &script.as_bytes()[2..34])
        }
        AddressType::P2wpkh => {
            if stack.len() != 2 {
                return false;
            }
            let (sig, pubkey) = (&stack[0], &stack[1]);
            if pubkey.len() != 33 || sig.last() != Some(&0x01) {
                return false;
            }
            let Ok(pk) = CompressedPublicKey::from_slice(pubkey) else {
                return false;
            };
            if ScriptBuf::new_p2wpkh(&pk.wpubkey_hash()) != script {
                return false;
            }
            let Some(digest) = segwit_digest(&script, message) else {
                return false;
            };
            let Ok(sig) = ecdsa::Signature::from_der(&sig[..sig.len() - 1]) else {
                return false;
            };
            let Ok(pk) = PublicKey::from_slice(pubkey) else {
                return false;
            };
            secp()
                .verify_ecdsa(&Message::from_digest(digest), &sig, &pk)
                .is_ok()
        }
    }
}
