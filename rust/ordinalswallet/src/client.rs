//! The blocking HTTP client: configuration, identification headers, retries
//! and error mapping.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{extract_error_code, extract_error_message, parse_body, Error, Result};
use crate::retry::{compute_retry_delay, is_retryable_status, jitter, RetryConfig, RetryMode};

/// Default API origin.
pub const DEFAULT_BASE_URL: &str = "https://turbo.ordinalswallet.com";

/// Header that identifies SDK traffic to the API.
pub const CLIENT_HEADER: &str = "x-ow-client";

/// Crate version, from `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// This SDK's product token, e.g. `ordinalswallet-rs/0.1.0`. Sent as the
/// `User-Agent` and as the last token of `x-ow-client`, so the API can tell
/// Rust SDK traffic from the TypeScript SDK's `ow-cli/<version>`.
pub const SDK_CLIENT_TOKEN: &str = concat!("ordinalswallet-rs/", env!("CARGO_PKG_VERSION"));

/// Default request timeout.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Builds the `x-ow-client` value: the caller's tokens (whitespace collapsed)
/// followed by [`SDK_CLIENT_TOKEN`]. A blank `app_name` is ignored.
///
/// ```
/// use ordinalswallet::{build_client_header, SDK_CLIENT_TOKEN};
/// assert_eq!(build_client_header(Some("  my-bot/1.2  ")), format!("my-bot/1.2 {SDK_CLIENT_TOKEN}"));
/// assert_eq!(build_client_header(Some("   ")), SDK_CLIENT_TOKEN);
/// assert_eq!(build_client_header(None), SDK_CLIENT_TOKEN);
/// ```
pub fn build_client_header(app_name: Option<&str>) -> String {
    let app = app_name
        .map(|a| a.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    if app.is_empty() {
        SDK_CLIENT_TOKEN.to_string()
    } else {
        format!("{app} {SDK_CLIENT_TOKEN}")
    }
}

/// Percent-encodes one path segment (RFC 3986 `pchar`: unreserved, sub-delims, `:` and `@` stay).
pub(crate) fn seg(s: &str) -> String {
    encode(s, |b| {
        b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@".contains(&b)
    })
}

/// Percent-encodes a query key or value like JavaScript's `encodeURIComponent`.
pub(crate) fn query_component(s: &str) -> String {
    encode(s, |b| {
        b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b)
    })
}

fn encode(s: &str, keep: impl Fn(u8) -> bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if keep(b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Configures a [`Client`].
#[derive(Clone, Debug)]
pub struct ClientBuilder {
    base_url: String,
    timeout: Duration,
    app_name: Option<String>,
    retry: RetryConfig,
}

impl Default for ClientBuilder {
    fn default() -> Self {
        ClientBuilder {
            base_url: DEFAULT_BASE_URL.to_string(),
            timeout: DEFAULT_TIMEOUT,
            app_name: None,
            retry: RetryConfig::default(),
        }
    }
}

impl ClientBuilder {
    /// API origin (`http://` or `https://`). Default [`DEFAULT_BASE_URL`].
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    /// Whole-request timeout. SSE streams instead use an idle (read) timeout. Default 30s.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Identifies your application: one or more space-separated `<name>/<version>`
    /// tokens, sent ahead of the SDK token in `x-ow-client`.
    pub fn app_name(mut self, app_name: impl Into<String>) -> Self {
        self.app_name = Some(app_name.into());
        self
    }

    /// Retries after the first attempt for GET/HEAD on network errors, 429 and 5xx. Default 2.
    pub fn retries(mut self, retries: u32) -> Self {
        self.retry.retries = retries;
        self
    }

    /// Base backoff, doubled per retry with jitter. Default 300ms.
    pub fn retry_delay(mut self, delay: Duration) -> Self {
        self.retry.retry_delay = delay;
        self
    }

    /// Longest single wait between retries. `Retry-After` is honoured up to
    /// this bound; a longer one fails fast. Default 10s.
    pub fn max_delay(mut self, delay: Duration) -> Self {
        self.retry.max_delay = delay;
        self
    }

    /// Builds the client.
    pub fn build(self) -> Result<Client> {
        let base = self.base_url.trim().trim_end_matches('/').to_string();
        let valid_scheme = base.starts_with("https://") || base.starts_with("http://");
        if !valid_scheme
            || base.contains(['?', '#'])
            || base.split("://").nth(1).map_or(true, str::is_empty)
        {
            return Err(Error::InvalidInput(format!(
                "base_url must be an http(s) origin, got {:?}",
                self.base_url
            )));
        }
        let client_header = build_client_header(self.app_name.as_deref());
        if client_header.bytes().any(|b| !(0x20..0x7f).contains(&b)) {
            return Err(Error::InvalidInput(format!(
                "app_name {:?} must be printable ASCII",
                self.app_name
            )));
        }
        let agent = ureq::AgentBuilder::new()
            .timeout(self.timeout)
            .user_agent(SDK_CLIENT_TOKEN)
            .build();
        Ok(Client {
            inner: Arc::new(Inner {
                agent,
                base,
                timeout: self.timeout,
                retry: self.retry,
                client_header,
            }),
        })
    }
}

/// Ordinals Wallet API client (blocking). Cheap to clone; clones share one
/// connection pool. Every method blocks the calling thread; run long-lived
/// streams on their own thread.
///
/// Endpoints are grouped like the TypeScript SDK's namespaces:
/// [`Client::collection`], [`Client::wallet`], [`Client::charts`], [`Client::feeds`], …
///
/// ```no_run
/// let client = ordinalswallet::Client::builder().app_name("my-bot/1.0").build()?;
/// let stats = client.collection().stats("bitcoin-puppets")?;
/// println!("floor: {:?}", stats.floor_price);
/// # Ok::<(), ordinalswallet::Error>(())
/// ```
#[derive(Clone, Debug)]
pub struct Client {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    agent: ureq::Agent,
    base: String,
    timeout: Duration,
    retry: RetryConfig,
    client_header: String,
}

impl Default for Client {
    fn default() -> Self {
        Client::new()
    }
}

/// A buffered HTTP response.
#[derive(Debug)]
pub(crate) struct Raw {
    pub status: u16,
    pub body: Vec<u8>,
    pub method: &'static str,
    pub path: String,
}

/// Everything needed to send one request.
#[derive(Debug)]
pub(crate) struct Req<'a> {
    pub method: &'static str,
    pub path: String,
    pub query: Vec<(&'a str, String)>,
    pub body: Option<Vec<u8>>,
    pub retry: RetryMode,
    /// Non-2xx statuses returned as `Ok` instead of an error (e.g. 404 for "not listed").
    pub accept: &'a [u16],
    pub no_store: bool,
}

impl<'a> Req<'a> {
    pub fn get(path: String) -> Self {
        Req {
            method: "GET",
            path,
            query: Vec::new(),
            body: None,
            retry: RetryMode::Default,
            accept: &[],
            no_store: false,
        }
    }

    pub fn post<B: Serialize + ?Sized>(path: String, body: &B) -> Result<Self> {
        let body = serde_json::to_vec(body)
            .map_err(|e| Error::InvalidInput(format!("request body: {e}")))?;
        Ok(Req {
            method: "POST",
            body: Some(body),
            ..Req::get(path)
        })
    }

    pub fn query(mut self, key: &'a str, value: impl ToString) -> Self {
        self.query.push((key, value.to_string()));
        self
    }

    pub fn query_opt(self, key: &'a str, value: Option<impl ToString>) -> Self {
        match value {
            Some(v) => self.query(key, v),
            None => self,
        }
    }

    pub fn retry(mut self, retry: RetryMode) -> Self {
        self.retry = retry;
        self
    }

    pub fn accept(mut self, statuses: &'a [u16]) -> Self {
        self.accept = statuses;
        self
    }

    pub fn no_store(mut self) -> Self {
        self.no_store = true;
        self
    }
}

impl Client {
    /// A client for the production API with default settings.
    pub fn new() -> Client {
        ClientBuilder::default()
            .build()
            .expect("default client configuration is valid")
    }

    /// Starts configuring a client.
    pub fn builder() -> ClientBuilder {
        ClientBuilder::default()
    }

    /// The API origin requests go to, without a trailing slash.
    pub fn base_url(&self) -> &str {
        &self.inner.base
    }

    /// The `x-ow-client` value this client sends.
    pub fn client_header(&self) -> &str {
        &self.inner.client_header
    }

    /// The client's retry settings.
    pub fn retry_config(&self) -> RetryConfig {
        self.inner.retry
    }

    pub(crate) fn timeout(&self) -> Duration {
        self.inner.timeout
    }

    /// Absolute URL for `path` (already percent-encoded, starting with `/`)
    /// plus query params, which are encoded here.
    pub fn url(&self, path: &str, query: &[(&str, String)]) -> String {
        let mut url = format!("{}{}", self.inner.base, path);
        for (i, (k, v)) in query.iter().enumerate() {
            url.push(if i == 0 { '?' } else { '&' });
            url.push_str(&query_component(k));
            url.push('=');
            url.push_str(&query_component(v));
        }
        url
    }

    /// GET `path` (percent-encoded, starting with `/`) and decode the JSON
    /// body, retrying per the client's policy. Escape hatch for endpoints this
    /// SDK does not wrap.
    pub fn get_json<T: DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<T> {
        let mut req = Req::get(path.to_string());
        req.query = query.to_vec();
        self.json(req)
    }

    /// POST a JSON body to `path` and decode the JSON response. Not retried
    /// unless `retry` opts in ([`RetryMode::Always`] or [`RetryMode::Times`]).
    pub fn post_json<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
        retry: RetryMode,
    ) -> Result<T> {
        self.json(Req::post(path.to_string(), body)?.retry(retry))
    }

    pub(crate) fn json<T: DeserializeOwned>(&self, req: Req<'_>) -> Result<T> {
        let raw = self.send(req)?;
        decode(&raw)
    }

    pub(crate) fn text(&self, req: Req<'_>) -> Result<String> {
        let raw = self.send(req)?;
        Ok(String::from_utf8_lossy(&raw.body).into_owned())
    }

    /// Starts a request with the identification header set; used by streams.
    pub(crate) fn request(&self, agent: &ureq::Agent, method: &str, url: &str) -> ureq::Request {
        agent
            .request(method, url)
            .set(CLIENT_HEADER, &self.inner.client_header)
    }

    pub(crate) fn send(&self, req: Req<'_>) -> Result<Raw> {
        let cfg = self.inner.retry;
        let idempotent = matches!(req.method, "GET" | "HEAD" | "OPTIONS");
        let allowed = req.retry.allowed(idempotent, &cfg);
        let url = self.url(&req.path, &req.query);
        let mut done = 0u32;

        loop {
            let mut request = self.request(&self.inner.agent, req.method, &url);
            if req.no_store {
                request = request.set("Cache-Control", "no-store");
            }
            let result = match &req.body {
                Some(body) => request
                    .set("Content-Type", "application/json")
                    .send_bytes(body),
                None => request.call(),
            };

            let (response, failure) = match result {
                Ok(resp) => (Some(resp), None),
                Err(ureq::Error::Status(_, resp)) => (Some(resp), None),
                Err(ureq::Error::Transport(t)) => (None, Some(t)),
            };

            if let Some(resp) = response {
                let status = resp.status();
                let reason = resp.status_text().to_string();
                let retry_after = resp.header("retry-after").map(str::to_owned);
                let mut body = Vec::new();
                match resp.into_reader().read_to_end(&mut body) {
                    Ok(_) => {
                        if (200..300).contains(&status) || req.accept.contains(&status) {
                            return Ok(Raw {
                                status,
                                body,
                                method: req.method,
                                path: req.path,
                            });
                        }
                        if is_retryable_status(status) && done < allowed {
                            if let Some(delay) = compute_retry_delay(
                                done + 1,
                                cfg.retry_delay,
                                cfg.max_delay,
                                retry_after.as_deref(),
                                jitter(),
                            ) {
                                done += 1;
                                std::thread::sleep(delay);
                                continue;
                            }
                        }
                        return Err(api_error(
                            status, &reason, &body, req.method, &req.path, done,
                        ));
                    }
                    Err(e) => {
                        if done < allowed {
                            done += 1;
                            std::thread::sleep(
                                compute_retry_delay(
                                    done,
                                    cfg.retry_delay,
                                    cfg.max_delay,
                                    None,
                                    jitter(),
                                )
                                .unwrap_or_default(),
                            );
                            continue;
                        }
                        return Err(Error::Network {
                            code: "Io".into(),
                            message: format!("{e} ({} {})", req.method, req.path),
                            method: req.method.into(),
                            path: req.path,
                            retries: done,
                            source: Some(Box::new(e)),
                        });
                    }
                }
            }

            let t = failure.expect("either a response or a transport error");
            if done < allowed {
                done += 1;
                std::thread::sleep(
                    compute_retry_delay(done, cfg.retry_delay, cfg.max_delay, None, jitter())
                        .unwrap_or_default(),
                );
                continue;
            }
            return Err(network_error(t, req.method, &req.path, done));
        }
    }
}

pub(crate) fn decode<T: DeserializeOwned>(raw: &Raw) -> Result<T> {
    serde_json::from_slice(&raw.body).map_err(|source| Error::Decode {
        method: raw.method.into(),
        path: raw.path.clone(),
        source,
    })
}

pub(crate) fn api_error(
    status: u16,
    reason: &str,
    body: &[u8],
    method: &str,
    path: &str,
    retries: u32,
) -> Error {
    let parsed = parse_body(body);
    let message = parsed
        .as_ref()
        .and_then(extract_error_message)
        .unwrap_or_else(|| {
            let reason = if reason.is_empty() {
                String::new()
            } else {
                format!(" {reason}")
            };
            format!("HTTP {status}{reason} ({method} {path})")
        });
    Error::Api {
        status,
        code: parsed.as_ref().and_then(extract_error_code),
        message,
        body: parsed,
        method: method.to_string(),
        path: path.to_string(),
        retries,
    }
}

pub(crate) fn network_error(t: ureq::Transport, method: &str, path: &str, retries: u32) -> Error {
    Error::Network {
        code: format!("{:?}", t.kind()),
        message: format!("{t} ({method} {path})"),
        method: method.to_string(),
        path: path.to_string(),
        retries,
        source: Some(Box::new(t)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_keep_colons_and_escape_slashes() {
        assert_eq!(seg("alkane-2:68479"), "alkane-2:68479");
        assert_eq!(seg("a/b c?d#e%"), "a%2Fb%20c%3Fd%23e%25");
        assert_eq!(seg("é"), "%C3%A9");
    }

    #[test]
    fn url_joins_base_path_and_query() {
        let c = Client::builder()
            .base_url("http://h.test/api/")
            .build()
            .unwrap();
        let u = c.url(
            "/quotes",
            &[
                ("collections", "a,b".to_string()),
                ("x y", "1&2".to_string()),
            ],
        );
        assert_eq!(u, "http://h.test/api/quotes?collections=a%2Cb&x%20y=1%262");
    }

    #[test]
    fn rejects_bad_base_urls() {
        for bad in [
            "ftp://x",
            "turbo.ordinalswallet.com",
            "https://",
            "https://x/?q=1",
        ] {
            assert!(Client::builder().base_url(bad).build().is_err(), "{bad}");
        }
        assert!(
            Client::builder().app_name("bad\nname").build().is_ok(),
            "newlines collapse to spaces"
        );
        assert!(Client::builder().app_name("naïve/1").build().is_err());
    }
}
