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
