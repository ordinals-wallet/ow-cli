//! Legacy owner proof for `POST /market/cancel-escrow`. Port of
//! `@ow-cli/core` `cancel-proof.ts`.
//!
//! **Deprecated:** send an `/auth/session` token as `signature` instead
//! ([`crate::signing::trade::delist`] does). The API accepts this proof for
//! one release only, when the input spending the listed outpoint verifies
//! against that output's script and on-chain amount, is signed
//! SIGHASH_DEFAULT/ALL and commits to an output of at least 21M BTC. The proof built here has one input and one
//! output, so it satisfies either route. It is signed on the key path with
//! SIGHASH_DEFAULT (64 bytes), never ANYONECANPAY (the API refuses that shape
//! as `seal_not_a_cancel_proof`). Its output pays 21M BTC back to the owner,
//! far more than the input holds, so it can never be mined, even if it leaks.

use std::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::psbt::{Psbt, PsbtSighashType};
use bitcoin::transaction::Version;
use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};

use super::keys::{secp, SigningKey};
use super::psbt::{outpoint_string, parse_hex, sign_idx, to_psbt_hex, witness_items, x_only_of};
use super::{fail, SigningError};

/// 21,000,000 BTC in sats. Always exceeds the proof's single input.
pub const CANCEL_PROOF_OUTPUT_SATS: u64 = 2_100_000_000_000_000;
/// SIGHASH_DEFAULT: taproot's commit-to-everything type (64-byte signature).
pub const CANCEL_PROOF_SIGHASH: u8 = 0x00;
const ALL_ANYONECANPAY: i32 = 0x81;

fn parse_outpoint(outpoint: &str) -> Result<OutPoint, SigningError> {
    let bad = || {
        SigningError::new(
            "invalid_outpoint",
            format!("Invalid outpoint (expected <txid>:<vout>): {outpoint}"),
        )
    };
    let (txid, vout) = outpoint.split_once(':').ok_or_else(bad)?;
    if txid.len() != 64
        || !txid.bytes().all(|b| b.is_ascii_hexdigit())
        || vout.is_empty()
        || !vout.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(bad());
    }
    let index = vout
        .parse::<u64>()
        .ok()
        .filter(|&v| v <= 0xffff_ffff)
        .ok_or_else(|| {
            SigningError::new("invalid_outpoint", format!("vout out of range: {vout}"))
        })?;
    Ok(OutPoint {
        txid: Txid::from_str(&txid.to_lowercase()).map_err(|_| bad())?,
        vout: index as u32,
    })
}

/// Deprecated (see the module docs). Build and sign the cancel proof for the
/// item at `outpoint`, owned by `key`; `value_sats` must match the chain. `public_key` (33-byte compressed or x-only)
/// must be the key's own. Returns PSBT hex for `market.cancel_escrow`.
pub fn build_cancel_proof(
    outpoint: &str,
    value_sats: u64,
    public_key: &[u8],
    key: &SigningKey,
) -> Result<String, SigningError> {
    let prevout = parse_outpoint(outpoint)?;
    if value_sats == 0 || value_sats >= CANCEL_PROOF_OUTPUT_SATS {
        return fail(
            "invalid_outpoint_value",
            format!("Invalid outpoint value: {value_sats}"),
        );
    }
    let owner = x_only_of(public_key).ok_or_else(|| {
        SigningError::new(
            "invalid_public_key",
            format!("Invalid public key length: {}", public_key.len()),
        )
    })?;
    if owner != key.xonly() {
        return fail(
            "key_mismatch",
            "The private key does not match the public key",
        );
    }
    let script = ScriptBuf::new_p2tr(secp(), owner, None);
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: prevout,
            script_sig: ScriptBuf::new(),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(CANCEL_PROOF_OUTPUT_SATS),
            script_pubkey: script.clone(),
        }],
    };
    let mut psbt = Psbt::from_unsigned_tx(tx)
        .map_err(|e| SigningError::new("invalid_cancel_proof", e.to_string()))?;
    psbt.inputs[0].witness_utxo = Some(TxOut {
        value: Amount::from_sat(value_sats),
        script_pubkey: script.clone(),
    });
    psbt.inputs[0].tap_internal_key = Some(owner);
    psbt.inputs[0].sighash_type = Some(PsbtSighashType::from_u32(u32::from(CANCEL_PROOF_SIGHASH)));
    sign_idx(&mut psbt, 0, key, &[CANCEL_PROOF_SIGHASH]).map_err(|_| {
        SigningError::new("invalid_cancel_proof", "Signing the cancel proof failed")
    })?;
    let Some(sig) = psbt.inputs[0].tap_key_sig else {
        return fail("invalid_cancel_proof", "Signing the cancel proof failed");
    };
    // The proof's output exceeds its input on purpose; finalize the key-path spend by hand.
    psbt.inputs[0].final_script_witness = Some(Witness::from_slice(&[sig.to_vec()]));
    let hex = to_psbt_hex(&psbt);
    assert_cancel_proof_shape(&hex, &script)?;
    Ok(hex)
}

/// A decoded cancel proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CancelProofShape {
    pub inputs: usize,
    pub outputs: usize,
    /// Sighash byte of the proof signature; 0x00 for a 64-byte signature, -1 when absent.
    pub sighash: i32,
    pub signature_length: usize,
    pub outpoint: String,
    pub output_sats: u64,
}

/// Decode a cancel proof (a self-check before anything is sent, and for tests).
pub fn inspect_cancel_proof(psbt_hex: &str) -> Result<CancelProofShape, SigningError> {
    let tx =
        parse_hex(psbt_hex).ok_or_else(|| SigningError::new("invalid_psbt", "Not a valid PSBT"))?;
    let Some(input) = tx.inputs.first() else {
        return fail("invalid_cancel_proof", "Cancel proof has no inputs");
    };
    let witness = input
        .final_script_witness
        .as_ref()
        .map(witness_items)
        .unwrap_or_default();
    let sig = witness.first().cloned().unwrap_or_default();
    let sighash = match sig.len() {
        65 => i32::from(sig[64]),
        64 => i32::from(CANCEL_PROOF_SIGHASH),
        _ => -1,
    };
    Ok(CancelProofShape {
        inputs: tx.inputs.len(),
        outputs: tx.outputs.len(),
        sighash,
        signature_length: sig.len(),
        outpoint: outpoint_string(&tx.unsigned_tx.input[0].previous_output),
        output_sats: tx
            .unsigned_tx
            .output
            .first()
            .map_or(0, |o| o.value.to_sat()),
    })
}

fn assert_cancel_proof_shape(psbt_hex: &str, owner_script: &ScriptBuf) -> Result<(), SigningError> {
    let shape = inspect_cancel_proof(psbt_hex)?;
    let tx =
        parse_hex(psbt_hex).ok_or_else(|| SigningError::new("invalid_psbt", "Not a valid PSBT"))?;
    let out = tx.unsigned_tx.output.first();
    if shape.inputs != 1
        || shape.outputs != 1
        || shape.signature_length != 64
        || shape.sighash == ALL_ANYONECANPAY
        || shape.output_sats != CANCEL_PROOF_OUTPUT_SATS
        || out.map(|o| &o.script_pubkey) != Some(owner_script)
    {
        return fail(
            "invalid_cancel_proof",
            "Refusing to send a malformed cancel proof",
        );
    }
    Ok(())
}
