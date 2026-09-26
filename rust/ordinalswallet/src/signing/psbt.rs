//! PSBT plumbing shared by the offer and protected-trading modules: parsing,
//! outpoints, txids, sighashes and a port of `@scure/btc-signer`'s
//! `Transaction.signIdx` for the input types this SDK signs.

use std::str::FromStr;

use bitcoin::hashes::Hash;
use bitcoin::key::TapTweak;
use bitcoin::psbt::{Input, Psbt};
use bitcoin::script::Instruction;
use bitcoin::secp256k1::XOnlyPublicKey;
use bitcoin::sighash::{EcdsaSighashType, Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::{LeafVersion, TapLeafHash};
use bitcoin::{
    ecdsa, taproot, Address, CompressedPublicKey, Network, OutPoint, Script, ScriptBuf,
    Transaction, TxOut, Witness,
};

use super::keys::{secp, SigningKey};
use super::util::{base64_decode, from_hex, is_hex, to_hex};

pub(crate) const SIGHASH_DEFAULT: u8 = 0x00;
pub(crate) const SIGHASH_ALL: u8 = 0x01;
pub(crate) const TAPSCRIPT_LEAF_VERSION: u8 = 0xc0;

/// A PSBT in hex.
pub(crate) fn parse_hex(hex: &str) -> Option<Psbt> {
    Psbt::deserialize(&from_hex(hex)?).ok()
}

/// A PSBT in hex, or base64 when it is not hex (offers routes accept both).
pub(crate) fn parse_hex_or_base64(s: &str) -> Option<Psbt> {
    let bytes = if is_hex(s) {
        from_hex(s)?
    } else {
        base64_decode(s)?
    };
    Psbt::deserialize(&bytes).ok()
}

pub(crate) fn to_psbt_hex(psbt: &Psbt) -> String {
    to_hex(&psbt.serialize())
}

/// Output script of a mainnet address.
pub(crate) fn script_for_address(address: &str) -> Option<ScriptBuf> {
    Address::from_str(address)
        .ok()?
        .require_network(Network::Bitcoin)
        .ok()
        .map(|a| a.script_pubkey())
}

/// `txid:vout` in display order.
pub(crate) fn outpoint_string(o: &OutPoint) -> String {
    format!("{}:{}", o.txid, o.vout)
}

/// Witness-stripped txid, in display order.
pub(crate) fn txid_of(tx: &Transaction) -> String {
    tx.compute_txid().to_string()
}

/// The input's PSBT sighash field, as the raw 32-bit value.
pub(crate) fn sighash_field(input: &Input) -> Option<u32> {
    input.sighash_type.map(|t| t.to_u32())
}

pub(crate) fn witness_items(w: &Witness) -> Vec<Vec<u8>> {
    w.iter().map(|i| i.to_vec()).collect()
}

/// The consensus byte of a leaf version (0xc0 for tapscript).
pub(crate) fn leaf_version_byte(v: LeafVersion) -> u8 {
    v.to_consensus()
}

fn all_prevouts(psbt: &Psbt) -> Result<Vec<TxOut>, String> {
    psbt.inputs
        .iter()
        .enumerate()
        .map(|(i, input)| {
            input
                .witness_utxo
                .clone()
                .ok_or_else(|| format!("input {i}: missing witness UTXO"))
        })
        .collect()
}

/// BIP-341 signature message digest for input `idx` (key path when `leaf`
/// is None), over every input's prevout.
pub(crate) fn taproot_digest(
    tx: &Transaction,
    prevouts: &[TxOut],
    idx: usize,
    sighash: u8,
    leaf: Option<(&Script, LeafVersion)>,
) -> Result<[u8; 32], String> {
    let ty = TapSighashType::from_consensus_u8(sighash).map_err(|e| e.to_string())?;
    let mut cache = SighashCache::new(tx);
    let prevouts = Prevouts::All(prevouts);
    let hash = match leaf {
        None => cache.taproot_key_spend_signature_hash(idx, &prevouts, ty),
        Some((script, ver)) => cache.taproot_script_spend_signature_hash(
            idx,
            &prevouts,
            TapLeafHash::from_script(script, ver),
            ty,
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(hash.to_byte_array())
}

fn tap_signature(sig: [u8; 64], sighash: u8) -> Result<taproot::Signature, String> {
    let mut bytes = sig.to_vec();
    if sighash != SIGHASH_DEFAULT {
        bytes.push(sighash);
    }
    taproot::Signature::from_slice(&bytes).map_err(|e| e.to_string())
}

fn script_has_push(script: &Script, key: &[u8]) -> bool {
    script
        .instructions()
        .any(|i| matches!(i, Ok(Instruction::PushBytes(p)) if p.as_bytes() == key))
}

/// Port of `Transaction.signIdx(privateKey, idx, allowedSighash)` from
/// `@scure/btc-signer` 1.8 for taproot (key and script path) and P2WPKH
/// inputs. The sighash is the input's PSBT field, else SIGHASH_DEFAULT for
/// taproot and SIGHASH_ALL for segwit v0, and must be in `allowed`.
pub(crate) fn sign_idx(
    psbt: &mut Psbt,
    idx: usize,
    key: &SigningKey,
    allowed: &[u8],
) -> Result<(), String> {
    let input = psbt
        .inputs
        .get(idx)
        .ok_or_else(|| format!("Wrong input index={idx}"))?;
    let prevout = input
        .witness_utxo
        .clone()
        .ok_or_else(|| format!("input {idx}: missing witness UTXO"))?;
    let taproot = prevout.script_pubkey.is_p2tr();
    let default = if taproot {
        SIGHASH_DEFAULT
    } else {
        SIGHASH_ALL
    };
    let sighash = match sighash_field(input) {
        None => default,
        Some(v) if v <= 0xff => v as u8,
        Some(v) => return Err(format!("Input with not allowed sigHash={v}")),
    };
    if !allowed.contains(&sighash) {
        return Err(format!(
            "Input with not allowed sigHash={sighash}. Allowed: {allowed:?}"
        ));
    }
    if sighash & 0x1f == 0x03 && idx >= psbt.unsigned_tx.output.len() {
        return Err(format!(
            "Input with sighash SINGLE, but there is no output with corresponding index={idx}"
        ));
    }

    if taproot {
        let prevouts = all_prevouts(psbt)?;
        let tx = psbt.unsigned_tx.clone();
        let ours = key.xonly();
        let mut signed = false;
        let input = &psbt.inputs[idx];
        let merkle_root = input.tap_merkle_root;
        if let Some(internal) = input.tap_internal_key {
            let expected_output = internal
                .tap_tweak(secp(), merkle_root)
                .0
                .to_x_only_public_key();
            let key_path = if internal == ours {
                Some(true)
            } else if expected_output == ours {
                Some(false)
            } else {
                None
            };
            if let Some(tweak) = key_path {
                let digest = taproot_digest(&tx, &prevouts, idx, sighash, None)?;
                let sig = if tweak {
                    key.sign_schnorr_tweaked(digest, merkle_root)
                } else {
                    key.sign_schnorr(digest)
                }
                .map_err(|e| e.message)?;
                psbt.inputs[idx].tap_key_sig = Some(tap_signature(sig, sighash)?);
                signed = true;
            }
        }
        let leaves: Vec<(ScriptBuf, LeafVersion)> =
            psbt.inputs[idx].tap_scripts.values().cloned().collect();
        for (script, ver) in leaves {
            if !script_has_push(&script, &ours.serialize()) {
                continue;
            }
            let digest = taproot_digest(&tx, &prevouts, idx, sighash, Some((&script, ver)))?;
            let sig = key.sign_schnorr(digest).map_err(|e| e.message)?;
            let leaf_hash = TapLeafHash::from_script(&script, ver);
            psbt.inputs[idx]
                .tap_script_sigs
                .insert((ours, leaf_hash), tap_signature(sig, sighash)?);
            signed = true;
        }
        if !signed {
            return Err("No taproot scripts signed".into());
        }
        return Ok(());
    }

    let pubkey = CompressedPublicKey::from_slice(&key.public_key()).expect("valid key");
    if !prevout.script_pubkey.is_p2wpkh()
        || prevout.script_pubkey != ScriptBuf::new_p2wpkh(&pubkey.wpubkey_hash())
    {
        return Err(format!(
            "Input script doesn't have pubKey: {}",
            to_hex(prevout.script_pubkey.as_bytes())
        ));
    }
    let ty = EcdsaSighashType::from_standard(u32::from(sighash)).map_err(|e| e.to_string())?;
    let digest = SighashCache::new(&psbt.unsigned_tx)
        .p2wpkh_signature_hash(idx, &prevout.script_pubkey, prevout.value, ty)
        .map_err(|e| e.to_string())?
        .to_byte_array();
    let mut sig = key.sign_ecdsa(digest);
    sig.push(sighash);
    let sig = ecdsa::Signature::from_slice(&sig).map_err(|e| e.to_string())?;
    psbt.inputs[idx]
        .partial_sigs
        .insert(bitcoin::PublicKey::new(pubkey.0), sig);
    Ok(())
}

/// Port of `finalizeIdx` for the key-path and P2WPKH inputs this SDK signs:
/// the final witness is set and every other signing field is dropped.
pub(crate) fn finalize_idx(psbt: &mut Psbt, idx: usize) -> Result<(), String> {
    let input = &mut psbt.inputs[idx];
    let witness = if let Some(sig) = input.tap_key_sig {
        Witness::from_slice(&[sig.to_vec()])
    } else if input.partial_sigs.len() == 1 {
        let (pk, sig) = input.partial_sigs.iter().next().expect("one");
        Witness::from_slice(&[sig.to_vec(), pk.to_bytes()])
    } else {
        return Err(format!("input {idx}: nothing to finalize"));
    };
    let keep = Input {
        non_witness_utxo: input.non_witness_utxo.take(),
        witness_utxo: input.witness_utxo.take(),
        final_script_sig: input.final_script_sig.take(),
        final_script_witness: Some(witness),
        proprietary: std::mem::take(&mut input.proprietary),
        unknown: std::mem::take(&mut input.unknown),
        ..Default::default()
    };
    *input = keep;
    Ok(())
}

/// x-only key from 32 bytes, or from a 33-byte compressed key.
pub(crate) fn x_only_of(bytes: &[u8]) -> Option<XOnlyPublicKey> {
    match bytes.len() {
        33 => XOnlyPublicKey::from_slice(&bytes[1..]).ok(),
        32 => XOnlyPublicKey::from_slice(bytes).ok(),
        _ => None,
    }
}
