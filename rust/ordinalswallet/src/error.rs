//! The SDK's error type.

use std::fmt;
use std::time::Duration;

use serde_json::Value;

/// Result alias used throughout the crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

/// Every failure the SDK reports.
///
/// Branch on [`Error::status`] (or match [`Error::Api`]) rather than on the
/// message: the API returns `{"error":true,"message":…}`, `{"error":"…"}`,
/// plain text or an empty body depending on the endpoint.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// The API answered with a non-success status.
    Api {
        /// HTTP status.
        status: u16,
        /// `code` from the body, or the `error` string when the body also has a `message`.
        code: Option<String>,
        /// Best human-readable message found in the body, else `HTTP <status> …`.
        message: String,
        /// Raw body: parsed JSON, or a JSON string for plain text; `None` when empty.
        body: Option<Value>,
        /// `GET`, `POST`, …
        method: String,
        /// Request path, e.g. `/collection/bitcoin-puppets`.
        path: String,
        /// Retries performed before giving up.
        retries: u32,
    },

    /// No response arrived: connect failure, reset, timeout, DNS, TLS.
    Network {
        /// Transport error class, e.g. `ConnectionFailed`, `Io`, `Dns`.
        code: String,
        message: String,
        method: String,
        path: String,
        retries: u32,
        source: Option<BoxError>,
    },

    /// A success response that did not match the expected shape.
    Decode {
        method: String,
        path: String,
        source: serde_json::Error,
    },

    /// Sign-in failed: bad, expired or reused signature, or no signer.
    /// `status` is 0 when no request was made.
    Auth {
        status: u16,
        message: String,
        source: Option<Box<Error>>,
    },

    /// An argument was rejected before any request was made.
    InvalidInput(String),

    /// A feature the API reports as unavailable (e.g. protected purchase capabilities).
    Unavailable(String),

    /// An SSE endpoint answered with a non-2xx status.
    SseHttp {
        status: u16,
        /// Parsed `Retry-After`, when present.
        retry_after: Option<Duration>,
    },

    /// An SSE connection ended, failed mid-stream or went idle. The subscriber reconnects.
    Stream(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Api { message, .. }
            | Error::Network { message, .. }
            | Error::Auth { message, .. } => f.write_str(message),
            Error::Decode {
                method,
                path,
                source,
            } => write!(f, "failed to decode {method} {path}: {source}"),
            Error::InvalidInput(m) => write!(f, "invalid input: {m}"),
            Error::Unavailable(m) | Error::Stream(m) => f.write_str(m),
            Error::SseHttp { status, .. } => write!(f, "SSE request failed with HTTP {status}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Network {
                source: Some(s), ..
            } => Some(s.as_ref()),
            Error::Decode { source, .. } => Some(source),
            Error::Auth {
                source: Some(s), ..
            } => Some(s.as_ref()),
            _ => None,
        }
    }
}

impl Error {
    /// HTTP status, or 0 when no response arrived or no request was made.
    pub fn status(&self) -> u16 {
        match self {
            Error::Api { status, .. }
            | Error::Auth { status, .. }
            | Error::SseHttp { status, .. } => *status,
            _ => 0,
        }
    }

    /// API error code (`offer_expired`, `invalid_inscription_id`, …) or transport code.
    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Api { code, .. } => code.as_deref(),
            Error::Network { code, .. } => Some(code),
            Error::Auth {
                source: Some(inner),
                ..
            } => inner.code(),
            _ => None,
        }
    }

    /// The raw error body, when the API sent one.
    pub fn body(&self) -> Option<&Value> {
        match self {
            Error::Api { body, .. } => body.as_ref(),
            Error::Auth {
                source: Some(inner),
                ..
            } => inner.body(),
            _ => None,
        }
    }

    /// Retries performed before this error was returned.
    pub fn retries(&self) -> u32 {
        match self {
            Error::Api { retries, .. } | Error::Network { retries, .. } => *retries,
            _ => 0,
        }
    }

    /// True for 5xx, 429 and network failures: worth retrying later.
    pub fn is_transient(&self) -> bool {
        match self {
            Error::Network { .. } | Error::Stream(_) => true,
            Error::Api { status, .. } | Error::SseHttp { status, .. } => {
                *status == 429 || *status >= 500
            }
            _ => false,
        }
    }

    /// Typed classification for `/market/offers` failures, from the body's `code`.
    pub fn offer_kind(&self) -> Option<crate::offers::OfferErrorKind> {
        if self.status() == 0 {
            return None;
        }
        let code = self.body()?.get("code")?.as_str()?;
        Some(crate::offers::OfferErrorKind::from_code(code))
    }
}

/// Pulls a readable message out of the API's non-uniform error bodies.
///
/// Strings are trimmed (and cut to 500 characters); objects yield `message`,
/// else `error`, when either is a non-blank string.
pub fn extract_error_message(body: &Value) -> Option<String> {
    match body {
        Value::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.chars().take(500).collect())
        }
        Value::Object(map) => ["message", "error"].iter().find_map(|k| match map.get(*k) {
            Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
            _ => None,
        }),
        _ => None,
    }
}

pub(crate) fn extract_error_code(body: &Value) -> Option<String> {
    let map = body.as_object()?;
    if let Some(Value::String(code)) = map.get("code") {
        return Some(code.clone());
    }
    match (map.get("error"), map.get("message")) {
        (Some(Value::String(e)), Some(Value::String(_))) => Some(e.clone()),
        _ => None,
    }
}

/// Parses a response body the way the API's clients see it: JSON when it
/// parses (whatever the content type), else the text; `None` when empty.
pub(crate) fn parse_body(bytes: &[u8]) -> Option<Value> {
    if bytes.is_empty() {
        return None;
    }
    serde_json::from_slice(bytes)
        .ok()
        .or_else(|| Some(Value::String(String::from_utf8_lossy(bytes).into_owned())))
}
