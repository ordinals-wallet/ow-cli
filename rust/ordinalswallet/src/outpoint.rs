//! Helpers for the API's serialized outpoints.
//!
//! `/wallet/:address`, `/wallet/:address/inscriptions` and
//! `/inscription/:id/outpoint` return outpoints as 72 hex characters: the txid
//! in little-endian (raw) byte order followed by `vout` as a 4-byte
//! little-endian integer. Listing endpoints already use `txid:vout`.

use std::fmt;

use crate::error::{Error, Result};

/// A decoded outpoint.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct OutPoint {
    /// Display-order (big-endian) txid, lowercase hex.
    pub txid: String,
    pub vout: u32,
}

impl fmt::Display for OutPoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.txid, self.vout)
    }
}

fn is_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// True for a 72-hex serialized outpoint.
pub fn is_serialized_outpoint(value: &str) -> bool {
    value.len() == 72 && is_hex(value)
}

fn is_txid_vout(value: &str) -> bool {
    match value.split_once(':') {
        Some((txid, vout)) => {
            txid.len() == 64
                && is_hex(txid)
                && !vout.is_empty()
                && vout.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

/// Reverses the byte order of a hex string (two characters per byte).
fn reverse_hex(hex: &str) -> String {
    hex.as_bytes()
        .rchunks(2)
        .map(|p| std::str::from_utf8(p).unwrap_or_default())
        .collect()
}

/// Splits a 72-hex serialized outpoint into txid and vout.
///
/// ```
/// let op = ordinalswallet::parse_serialized_outpoint(
///     "73285fb379038569e574137912e14d312bfc9487fe96f9347683aa64b405c6f500000000",
/// )?;
/// assert_eq!(op.to_string(), "f5c605b464aa837634f996fe8794fc2b314de112791374e569850379b35f2873:0");
/// # Ok::<(), ordinalswallet::Error>(())
/// ```
pub fn parse_serialized_outpoint(serialized: &str) -> Result<OutPoint> {
    if !is_serialized_outpoint(serialized) {
        return Err(Error::InvalidInput(format!(
            "invalid serialized outpoint (expected 72 hex chars): {serialized}"
        )));
    }
    let hex = serialized.to_ascii_lowercase();
    let txid = reverse_hex(&hex[..64]);
    let le = u32::from_str_radix(&hex[64..], 16).map_err(|e| Error::InvalidInput(e.to_string()))?;
    Ok(OutPoint {
        txid,
        vout: le.swap_bytes(),
    })
}

/// Converts a serialized outpoint to `txid:vout`. `txid:vout` input is
/// returned lowercased, so outpoints from any endpoint can be normalised.
pub fn outpoint_to_txid_vout(value: &str) -> Result<String> {
    if is_txid_vout(value) {
        return Ok(value.to_ascii_lowercase());
    }
    Ok(parse_serialized_outpoint(value)?.to_string())
}

/// Inverse of [`outpoint_to_txid_vout`]: `txid:vout` to the 72-hex serialized form.
pub fn txid_vout_to_serialized(txid_vout: &str) -> Result<String> {
    if !is_txid_vout(txid_vout) {
        return Err(Error::InvalidInput(format!(
            "invalid outpoint (expected <64-hex txid>:<vout>): {txid_vout}"
        )));
    }
    let (txid, vout) = txid_vout.split_once(':').unwrap_or_default();
    let vout: u32 = vout
        .parse()
        .map_err(|_| Error::InvalidInput(format!("vout out of range: {vout}")))?;
    Ok(format!(
        "{}{:08x}",
        reverse_hex(&txid.to_ascii_lowercase()),
        vout.swap_bytes()
    ))
}
