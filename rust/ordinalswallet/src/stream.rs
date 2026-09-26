//! Server-Sent Events: an incremental `text/event-stream` parser and a
//! blocking, reconnecting subscriber exposed as an [`Iterator`].
//!
//! The subscriber reconnects with exponential backoff (honouring the stream's
//! `retry:` field and `Retry-After`), resumes with `Last-Event-ID`, treats 45s
//! without bytes as a dead connection, and stops on HTTP 4xx other than 408
//! and 429. Iterate it on its own thread; stop it with [`CloseHandle::close`]
//! or by dropping it.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::client::Client;
use crate::error::Error;
use crate::retry::{jitter, parse_retry_after};

/// One dispatched SSE event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SseEvent {
    /// Event name; `message` when the server sent no `event:` field.
    pub event: String,
    /// Data lines joined with `\n`.
    pub data: String,
    /// Last event ID seen on the stream, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// Output of [`SseParser`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SseItem {
    Event(SseEvent),
    /// Server-requested reconnection delay (`retry:` field), in ms.
    Retry(u64),
    /// Comment line (e.g. `keep-alive`), without the leading colon.
    Comment(String),
}

/// Incremental parser for the `text/event-stream` format (WHATWG HTML §9.2.6).
/// Chunks may split lines anywhere, including between CR and LF.
///
/// ```
/// use ordinalswallet::stream::{SseItem, SseParser};
/// let mut p = SseParser::new();
/// let mut items = p.push("event: btc\nda");
/// items.extend(p.push("ta: {\"usd\":1}\n\n"));
/// match &items[0] {
///     SseItem::Event(e) => assert_eq!((e.event.as_str(), e.data.as_str()), ("btc", "{\"usd\":1}")),
///     other => panic!("{other:?}"),
/// }
/// ```
#[derive(Debug, Default)]
pub struct SseParser {
    buf: String,
    started: bool,
    event_type: String,
    data: Vec<String>,
    last_id: Option<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a decoded text chunk and returns what it completed.
    pub fn push(&mut self, chunk: &str) -> Vec<SseItem> {
        let mut chunk = chunk;
        if !self.started && !chunk.is_empty() {
            chunk = chunk.strip_prefix('\u{feff}').unwrap_or(chunk);
            self.started = true;
        }
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        self.drain(false, &mut out);
        out
    }

    /// Ends the stream: flushes a trailing partial line. An event without its
    /// terminating blank line is discarded, per spec.
    pub fn finish(&mut self) -> Vec<SseItem> {
        let mut out = Vec::new();
        self.drain(true, &mut out);
        self.event_type.clear();
        self.data.clear();
        out
    }

    fn drain(&mut self, final_: bool, out: &mut Vec<SseItem>) {
        let buf = std::mem::take(&mut self.buf);
        let bytes = buf.as_bytes();
        let mut start = 0;
        let mut i = 0;
        while i < bytes.len() {
            let c = bytes[i];
            if c == b'\n' || c == b'\r' {
                // A lone trailing CR might be the first half of CRLF: wait for more.
                if c == b'\r' && i == bytes.len() - 1 && !final_ {
                    break;
                }
                self.line(&buf[start..i], out);
                if c == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            i += 1;
        }
        let rest = &buf[start..];
        if final_ && !rest.is_empty() {
            self.line(rest, out);
        } else {
            self.buf = rest.to_string();
        }
    }

    fn line(&mut self, l: &str, out: &mut Vec<SseItem>) {
        if l.is_empty() {
            return self.dispatch(out);
        }
        if let Some(comment) = l.strip_prefix(':') {
            out.push(SseItem::Comment(comment.trim_start().to_string()));
            return;
        }
        let (field, value) = match l.find(':') {
            Some(i) => (&l[..i], &l[i + 1..]),
            None => (l, ""),
        };
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event_type = value.to_string(),
            "data" => self.data.push(value.to_string()),
            "id" if !value.contains('\0') => self.last_id = Some(value.to_string()),
            "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                if let Ok(ms) = value.parse() {
                    out.push(SseItem::Retry(ms));
                }
            }
            _ => {}
        }
    }

    fn dispatch(&mut self, out: &mut Vec<SseItem>) {
        let event_type = std::mem::take(&mut self.event_type);
        if self.data.is_empty() {
            return;
        }
        let data = std::mem::take(&mut self.data).join("\n");
        out.push(SseItem::Event(SseEvent {
            event: if event_type.is_empty() {
                "message".into()
            } else {
                event_type
            },
            data,
            id: self.last_id.clone(),
        }));
    }
}

/// Incremental UTF-8 decoder: keeps a split code point for the next chunk and
/// replaces invalid bytes with U+FFFD, like `TextDecoder`.
#[derive(Debug, Default)]
pub(crate) struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            self.pending.drain(..valid + n);
                        }
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }

    pub fn finish(&mut self) -> String {
        let out = if self.pending.is_empty() {
            String::new()
        } else {
            "\u{fffd}".to_string()
        };
        self.pending.clear();
        out
    }
}

/// Subscriber settings.
#[derive(Clone, Debug)]
pub struct SubscribeOptions {
    /// Extra request headers.
    pub headers: Vec<(String, String)>,
    /// First reconnect delay. Default 1s.
    pub initial_backoff: Duration,
    /// Reconnect delay ceiling. Default 30s.
    pub max_backoff: Duration,
    /// Reconnect when no bytes arrive for this long. Default 45s; `None` disables.
    pub idle_timeout: Option<Duration>,
}

impl Default for SubscribeOptions {
    fn default() -> Self {
        SubscribeOptions {
            headers: Vec::new(),
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(30),
            idle_timeout: Some(Duration::from_secs(45)),
        }
    }
}

/// What a [`Subscription`] yields.
#[derive(Debug)]
pub enum StreamEvent {
    /// Connection (re)established.
    Open,
    Event(SseEvent),
    /// Transport or HTTP error. When `fatal` the iterator ends after this item;
    /// otherwise it reconnects.
    Error {
        error: Error,
        fatal: bool,
    },
}

/// Stops a [`Subscription`] from another thread. The iterator returns `None`
/// once its current read returns (at most the idle timeout later) or its
/// backoff sleep notices.
#[derive(Clone, Debug)]
pub struct CloseHandle(Arc<AtomicBool>);

impl CloseHandle {
    pub fn close(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_closed(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

struct Conn {
    reader: Box<dyn Read + Send + Sync + 'static>,
    decoder: Utf8Decoder,
    parser: SseParser,
}

/// A reconnecting SSE subscription. See the [module docs](self).
pub struct Subscription {
    client: Client,
    agent: ureq::Agent,
    url: String,
    opts: SubscribeOptions,
    closed: CloseHandle,
    conn: Option<Conn>,
    queue: VecDeque<StreamEvent>,
    attempt: u32,
    server_retry: Option<u64>,
    last_event_id: Option<String>,
    sleep: Option<Duration>,
    done: bool,
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("url", &self.url)
            .field("connected", &self.conn.is_some())
            .finish()
    }
}

/// Subscribes to an SSE endpoint. `url` is absolute (see [`Client::url`]).
/// Nothing connects until the first call to `next()`.
pub fn subscribe(client: &Client, url: String, opts: SubscribeOptions) -> Subscription {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(client.timeout())
        .user_agent(crate::SDK_CLIENT_TOKEN);
    if let Some(idle) = opts.idle_timeout {
        builder = builder.timeout_read(idle);
    }
    Subscription {
        client: client.clone(),
        agent: builder.build(),
        url,
        opts,
        closed: CloseHandle(Arc::new(AtomicBool::new(false))),
        conn: None,
        queue: VecDeque::new(),
        attempt: 0,
        server_retry: None,
        last_event_id: None,
        sleep: None,
        done: false,
    }
}

impl Subscription {
    /// A handle that stops this subscription from another thread.
    pub fn close_handle(&self) -> CloseHandle {
        self.closed.clone()
    }

    /// Stops the subscription.
    pub fn close(&mut self) {
        self.closed.close();
        self.conn = None;
    }

    /// The `Last-Event-ID` sent on the next reconnect.
    pub fn last_event_id(&self) -> Option<&str> {
        self.last_event_id.as_deref()
    }

    fn backoff(&mut self) -> Duration {
        let base = self
            .server_retry
            .map(|ms| ms as f64)
            .unwrap_or(self.opts.initial_backoff.as_millis() as f64);
        let d = (base * 2f64.powi(self.attempt.min(30) as i32))
            .min(self.opts.max_backoff.as_millis() as f64);
        self.attempt += 1;
        Duration::from_millis((d * (0.8 + jitter() * 0.4)).round() as u64)
    }

    fn fail(&mut self, error: Error) {
        self.conn = None;
        self.queue.push_back(StreamEvent::Error {
            error,
            fatal: false,
        });
        self.sleep = Some(self.backoff());
    }

    /// Sleeps in short slices so `close()` from another thread is noticed.
    fn nap(&self, total: Duration) {
        let until = Instant::now() + total;
        while !self.closed.is_closed() {
            let now = Instant::now();
            if now >= until {
                return;
            }
            std::thread::sleep((until - now).min(Duration::from_millis(50)));
        }
    }

    fn connect(&mut self) {
        let mut req = self
            .client
            .request(&self.agent, "GET", &self.url)
            .set("Accept", "text/event-stream")
            .set("Cache-Control", "no-cache");
        for (k, v) in &self.opts.headers {
            req = req.set(k, v);
        }
        if let Some(id) = &self.last_event_id {
            req = req.set("Last-Event-ID", id);
        }
        match req.call() {
            Ok(resp) => {
                self.conn = Some(Conn {
                    reader: resp.into_reader(),
                    decoder: Utf8Decoder::default(),
                    parser: SseParser::new(),
                });
                self.queue.push_back(StreamEvent::Open);
            }
            Err(ureq::Error::Status(status, resp)) => {
                let retry_after = parse_retry_after(resp.header("retry-after"), SystemTime::now());
                let fatal = (400..500).contains(&status) && status != 408 && status != 429;
                self.queue.push_back(StreamEvent::Error {
                    error: Error::SseHttp {
                        status,
                        retry_after,
                    },
                    fatal,
                });
                if fatal {
                    self.done = true;
                } else {
                    self.sleep = Some(match retry_after {
                        Some(d) => d,
                        None => self.backoff(),
                    });
                }
            }
            Err(ureq::Error::Transport(t)) => {
                let e = crate::client::network_error(t, "GET", &self.url, 0);
                self.fail(e);
            }
        }
    }

    fn handle(&mut self, items: Vec<SseItem>) {
        for item in items {
            match item {
                SseItem::Event(ev) => {
                    if ev.id.is_some() {
                        self.last_event_id.clone_from(&ev.id);
                    }
                    self.attempt = 0;
                    self.queue.push_back(StreamEvent::Event(ev));
                }
                SseItem::Retry(ms) => self.server_retry = Some(ms),
                SseItem::Comment(_) => {}
            }
        }
    }

    fn read(&mut self) {
        let Some(conn) = self.conn.as_mut() else {
            return;
        };
        let mut buf = [0u8; 16 * 1024];
        match conn.reader.read(&mut buf) {
            Ok(0) => {
                let mut tail = conn.decoder.finish();
                let mut items = conn.parser.push(&std::mem::take(&mut tail));
                items.extend(conn.parser.finish());
                self.handle(items);
                self.fail(Error::Stream("SSE stream ended".into()));
            }
            Ok(n) => {
                let text = conn.decoder.decode(&buf[..n]);
                let items = conn.parser.push(&text);
                self.handle(items);
            }
            Err(e) => {
                let message = if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) {
                    "SSE idle timeout".to_string()
                } else {
                    format!("SSE read failed: {e}")
                };
                self.fail(Error::Stream(message));
            }
        }
    }
}

impl Iterator for Subscription {
    type Item = StreamEvent;

    fn next(&mut self) -> Option<StreamEvent> {
        loop {
            if self.closed.is_closed() {
                self.conn = None;
                return None;
            }
            if let Some(ev) = self.queue.pop_front() {
                return Some(ev);
            }
            if self.done {
                return None;
            }
            if let Some(d) = self.sleep.take() {
                self.nap(d);
                continue;
            }
            if self.conn.is_none() {
                self.connect();
            } else {
                self.read();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_decoder_handles_split_code_points() {
        let s = "a€b😀";
        let bytes = s.as_bytes();
        for split in 0..bytes.len() {
            let mut d = Utf8Decoder::default();
            let mut out = d.decode(&bytes[..split]);
            out.push_str(&d.decode(&bytes[split..]));
            out.push_str(&d.finish());
            assert_eq!(out, s);
        }
        let mut d = Utf8Decoder::default();
        assert_eq!(d.decode(&[b'a', 0xff, b'b']), "a\u{fffd}b");
        assert_eq!(d.decode(&[0xe2, 0x82]), "");
        assert_eq!(d.finish(), "\u{fffd}");
    }
}
