//! Serde helpers for fields the API sends in more than one JSON type.

use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// Accepts a JSON string or number (or null) and keeps its decimal text, so
/// token amounts like `"22.4"` and `2835900` both decode without losing precision.
pub(crate) fn opt_decimal<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(Value::Number(n)) => Ok(Some(n.to_string())),
        Some(other) => Err(serde::de::Error::custom(format!(
            "expected a decimal string or number, got {other}"
        ))),
    }
}

/// Accepts a number, null, or a string such as `"5.85%"` (some collections
/// store trait percentages as text). Text that is not a number becomes `None`.
pub(crate) fn opt_percent<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().trim_end_matches('%').trim().parse().ok(),
        _ => None,
    })
}
