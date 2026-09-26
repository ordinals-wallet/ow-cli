//! Wallet sign-in (`POST /auth/session`) and a session-token cache.
//!
//! The API verifies a BIP-322 signature over [`sign_in_message`] and returns
//! a 24-hour token for `signature` / `creator_signature` fields. Producing the
//! signature is the job of a [`MessageSigner`]; key-based signers arrive with
//! the `signing` feature (stage 2). Any external wallet can implement the trait.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::client::{Client, Req};
use crate::error::{Error, Result};
use crate::retry::RetryMode;

/// Body of `POST /auth/session`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateSessionRequest {
    pub address: String,
    /// 16 to 64 hex characters; burned on first use.
    pub nonce: String,
    /// Unix milliseconds; must be within the last 5 minutes.
    pub issued_at: u64,
    /// Base64 BIP-322 simple signature over [`sign_in_message`].
    pub signature: String,
}

/// A wallet session. `token` goes in `signature` / `creator_signature` fields.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthSession {
    /// `ows1.…` session token. Treat like a password.
    pub token: String,
    pub address: String,
    /// Unix seconds. Tokens last 24 hours.
    pub expires_at: u64,
}

impl std::fmt::Debug for AuthSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthSession")
            .field("token", &"<redacted>")
            .field("address", &self.address)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// The exact sign-in message the API rebuilds and verifies. Must match byte
/// for byte, so never reformat it.
///
/// ```
/// let m = ordinalswallet::auth::sign_in_message("bc1qexample", "00ff", 1700000000000);
/// assert!(m.starts_with("Sign in to Ordinals Wallet\n\n"));
/// assert!(m.ends_with("Address: bc1qexample\nNonce: 00ff\nIssued At: 1700000000000"));
/// ```
pub fn sign_in_message(address: &str, nonce: &str, issued_at_ms: u64) -> String {
    format!(
        "Sign in to Ordinals Wallet\n\n\
         This proves you own this address. It does not move funds or cost a fee.\n\n\
         Address: {address}\n\
         Nonce: {nonce}\n\
         Issued At: {issued_at_ms}"
    )
}

/// A random 32-hex-character nonce (16 bytes from the OS CSPRNG).
pub fn generate_nonce() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| Error::Unavailable(format!("OS random source failed: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Signs the sign-in message for an address: a base64 BIP-322 simple signature.
pub trait MessageSigner: Send + Sync {
    fn sign_message(&self, address: &str, message: &str) -> Result<String>;
}

impl<F> MessageSigner for F
where
    F: Fn(&str, &str) -> Result<String> + Send + Sync,
{
    fn sign_message(&self, address: &str, message: &str) -> Result<String> {
        self(address, message)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `/auth/*` endpoints. Get one with [`Client::auth`].
#[derive(Clone, Copy, Debug)]
pub struct AuthApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Wallet sign-in.
    pub fn auth(&self) -> AuthApi<'_> {
        AuthApi(self)
    }
}

impl AuthApi<'_> {
    /// Raw `POST /auth/session`. Never retried (the nonce is single-use).
    /// API failures come back as [`Error::Auth`].
    pub fn create_session(
        &self,
        address: &str,
        nonce: &str,
        issued_at_ms: u64,
        signature: &str,
    ) -> Result<AuthSession> {
        let body = CreateSessionRequest {
            address: address.into(),
            nonce: nonce.into(),
            issued_at: issued_at_ms,
            signature: signature.into(),
        };
        self.0
            .json(Req::post("/auth/session".into(), &body)?.retry(RetryMode::Never))
            .map_err(to_auth_error)
    }

    /// Builds the message with a fresh nonce (unless given), has `signer` sign
    /// it and exchanges the signature for a session.
    pub fn sign_in(
        &self,
        address: &str,
        signer: &dyn MessageSigner,
        nonce: Option<&str>,
        issued_at_ms: Option<u64>,
    ) -> Result<AuthSession> {
        let nonce = match nonce {
            Some(n) => n.to_string(),
            None => generate_nonce()?,
        };
        let issued_at = issued_at_ms.unwrap_or_else(now_ms);
        let signature =
            signer.sign_message(address, &sign_in_message(address, &nonce, issued_at))?;
        self.create_session(address, &nonce, issued_at, &signature)
    }
}

fn to_auth_error(err: Error) -> Error {
    match err {
        Error::Api {
            status,
            ref message,
            ..
        } => {
            let message = if message.is_empty() {
                format!("Sign-in failed (HTTP {status})")
            } else {
                message.clone()
            };
            Error::Auth {
                status,
                message,
                source: Some(Box::new(err)),
            }
        }
        other => other,
    }
}

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Caches one session per address and signs in again when a token is within
/// `refresh_before_secs` (default 300) of expiry. Concurrent callers for the
/// same address share one sign-in.
///
/// ```no_run
/// use ordinalswallet::auth::SessionManager;
/// let client = ordinalswallet::Client::new();
/// let signer = |_addr: &str, _msg: &str| -> ordinalswallet::Result<String> {
///     Ok("<base64 BIP-322 signature from your wallet>".into())
/// };
/// let sessions = SessionManager::new(client).with_signer(signer);
/// let token = sessions.get_token("bc1p…", None)?;
/// # Ok::<(), ordinalswallet::Error>(())
/// ```
pub struct SessionManager {
    client: Client,
    signer: Option<Arc<dyn MessageSigner>>,
    refresh_before_secs: u64,
    clock: Clock,
    sessions: Mutex<HashMap<String, AuthSession>>,
    inflight: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl std::fmt::Debug for SessionManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionManager")
            .field("refresh_before_secs", &self.refresh_before_secs)
            .finish_non_exhaustive()
    }
}

impl SessionManager {
    pub fn new(client: Client) -> Self {
        SessionManager {
            client,
            signer: None,
            refresh_before_secs: 300,
            clock: Arc::new(now_ms),
            sessions: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    /// Default signer used when `get_session` is called without one.
    pub fn with_signer(mut self, signer: impl MessageSigner + 'static) -> Self {
        self.signer = Some(Arc::new(signer));
        self
    }

    /// Refresh when this close to `expires_at`. Default 300 seconds.
    pub fn refresh_before_secs(mut self, secs: u64) -> Self {
        self.refresh_before_secs = secs;
        self
    }

    /// Clock in unix milliseconds; injectable for tests.
    pub fn with_clock(mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, AuthSession>> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The cached session if it is still comfortably valid.
    pub fn peek(&self, address: &str) -> Option<AuthSession> {
        let now_secs = (self.clock)() as f64 / 1000.0;
        self.lock_sessions()
            .get(address)
            .filter(|s| (s.expires_at as f64 - self.refresh_before_secs as f64) > now_secs)
            .cloned()
    }

    /// A valid session for `address`, signing in if needed.
    pub fn get_session(
        &self,
        address: &str,
        signer: Option<&dyn MessageSigner>,
    ) -> Result<AuthSession> {
        if let Some(s) = self.peek(address) {
            return Ok(s);
        }
        let gate = {
            let mut inflight = self.inflight.lock().unwrap_or_else(|p| p.into_inner());
            inflight.entry(address.to_string()).or_default().clone()
        };
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        // Another caller may have signed in while we waited.
        if let Some(s) = self.peek(address) {
            return Ok(s);
        }
        let fallback = self.signer.clone();
        let signer: &dyn MessageSigner = match (signer, fallback.as_deref()) {
            (Some(s), _) => s,
            (None, Some(s)) => s,
            (None, None) => {
                return Err(Error::Auth {
                    status: 0,
                    message: format!("No signer available to sign in {address}"),
                    source: None,
                })
            }
        };
        let session = self
            .client
            .auth()
            .sign_in(address, signer, None, Some((self.clock)()))?;
        self.lock_sessions()
            .insert(address.to_string(), session.clone());
        Ok(session)
    }

    /// The session token for `address`, for `signature` / `creator_signature` fields.
    pub fn get_token(&self, address: &str, signer: Option<&dyn MessageSigner>) -> Result<String> {
        Ok(self.get_session(address, signer)?.token)
    }

    /// Store a session obtained elsewhere.
    pub fn set(&self, session: AuthSession) {
        self.lock_sessions()
            .insert(session.address.clone(), session);
    }

    /// Forget a token, e.g. after the API rejects it.
    pub fn invalidate(&self, address: &str) {
        self.lock_sessions().remove(address);
    }

    pub fn clear(&self) {
        self.lock_sessions().clear();
    }
}
