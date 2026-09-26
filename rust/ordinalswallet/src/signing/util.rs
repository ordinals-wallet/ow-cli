//! Hex and base64 without extra crates.

use bitcoin::hex::{DisplayHex, FromHex};

pub(crate) fn to_hex(bytes: &[u8]) -> String {
    bytes.to_lower_hex_string()
}

/// Strict hex (even length, `[0-9a-fA-F]`).
pub(crate) fn from_hex(s: &str) -> Option<Vec<u8>> {
    Vec::<u8>::from_hex(s).ok()
}

pub(crate) fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (what `btoa` produces).
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Base64 decode with the WHATWG "forgiving" rules `atob` uses: ASCII
/// whitespace is ignored, padding is optional, leftover bits are dropped.
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = s
        .bytes()
        .filter(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r'))
        .collect();
    if data.len() % 4 == 0 {
        for _ in 0..2 {
            if data.last() == Some(&b'=') {
                data.pop();
            }
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for c in data {
        let v = ALPHABET.iter().position(|&a| a == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_and_is_forgiving() {
        for n in 0..70u8 {
            let bytes: Vec<u8> = (0..n).map(|i| i.wrapping_mul(37)).collect();
            let enc = base64_encode(&bytes);
            assert_eq!(base64_decode(&enc).unwrap(), bytes);
            assert_eq!(base64_decode(enc.trim_end_matches('=')).unwrap(), bytes);
        }
        assert_eq!(base64_encode(b"Hello World"), "SGVsbG8gV29ybGQ=");
        assert_eq!(base64_decode(" SGVs\nbG8=").unwrap(), b"Hello");
        assert!(base64_decode("not-valid-base64!!!").is_none());
        assert!(base64_decode("A").is_none());
    }
}
