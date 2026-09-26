//! A tiny HTTP/1.1 test server on `std::net::TcpListener` (no mock-server
//! dependency). Every response closes its connection.

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

pub fn fixture_text(rel: &str) -> String {
    std::fs::read_to_string(fixtures_dir().join(rel))
        .unwrap_or_else(|e| panic!("reading fixtures/{rel}: {e}"))
}

pub fn fixture(rel: &str) -> serde_json::Value {
    serde_json::from_str(&fixture_text(rel))
        .unwrap_or_else(|e| panic!("parsing fixtures/{rel}: {e}"))
}

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn param(&self, key: &str) -> Option<String> {
        self.query
            .split('&')
            .filter(|p| !p.is_empty())
            .find_map(|p| {
                let (k, v) = p.split_once('=').unwrap_or((p, ""));
                (percent_decode(k) == key).then(|| percent_decode(v))
            })
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("JSON request body")
    }
}

pub enum Reply {
    Http {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// Close-delimited body written in chunks, `delay` apart, then held open for `hold`.
    Stream {
        status: u16,
        headers: Vec<(String, String)>,
        chunks: Vec<Vec<u8>>,
        delay: Duration,
        hold: Duration,
    },
    /// Close the connection without responding.
    Hangup,
}

impl Reply {
    pub fn json(status: u16, body: &serde_json::Value) -> Reply {
        Reply::Http {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: serde_json::to_vec(body).unwrap(),
        }
    }

    pub fn raw(status: u16, content_type: Option<&str>, body: &str) -> Reply {
        Reply::Http {
            status,
            headers: content_type
                .map(|c| vec![("Content-Type".into(), c.into())])
                .unwrap_or_default(),
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn empty(status: u16) -> Reply {
        Reply::raw(status, None, "")
    }

    pub fn with_header(mut self, k: &str, v: &str) -> Reply {
        match &mut self {
            Reply::Http { headers, .. } | Reply::Stream { headers, .. } => {
                headers.push((k.into(), v.into()))
            }
            Reply::Hangup => {}
        }
        self
    }

    /// An SSE response split into chunks of `size` bytes.
    pub fn sse(text: &str, size: usize) -> Reply {
        Reply::Stream {
            status: 200,
            headers: vec![("Content-Type".into(), "text/event-stream".into())],
            chunks: text
                .as_bytes()
                .chunks(size.max(1))
                .map(<[u8]>::to_vec)
                .collect(),
            delay: Duration::ZERO,
            hold: Duration::ZERO,
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

type Handler = dyn Fn(&Request, usize) -> Reply + Send + Sync;

pub struct Server {
    pub url: String,
    log: Arc<Mutex<Vec<Request>>>,
}

impl Server {
    /// Starts a server; `handler` gets each request and its 0-based index.
    pub fn start(handler: impl Fn(&Request, usize) -> Reply + Send + Sync + 'static) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let counter = Arc::new(AtomicUsize::new(0));
        let log2 = log.clone();
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let (handler, log, counter) = (handler.clone(), log2.clone(), counter.clone());
                thread::spawn(move || serve(conn, &*handler, &log, &counter));
            }
        });
        Server { url, log }
    }

    pub fn requests(&self) -> Vec<Request> {
        self.log.lock().unwrap().clone()
    }

    pub fn count(&self) -> usize {
        self.log.lock().unwrap().len()
    }

    pub fn client(&self) -> ordinalswallet::ClientBuilder {
        ordinalswallet::Client::builder()
            .base_url(&self.url)
            .retry_delay(Duration::from_millis(1))
            .max_delay(Duration::from_millis(50))
            .timeout(Duration::from_secs(5))
    }
}

fn serve(conn: TcpStream, handler: &Handler, log: &Mutex<Vec<Request>>, counter: &AtomicUsize) {
    let mut reader = BufReader::new(conn.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.trim_end().split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.trim_end().split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let len = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0usize);
    let mut body = vec![0; len];
    reader.read_exact(&mut body).ok();
    let (path, query) = target
        .split_once('?')
        .map(|(p, q)| (p.to_string(), q.to_string()))
        .unwrap_or((target, String::new()));
    let req = Request {
        method,
        path,
        query,
        headers,
        body,
    };
    log.lock().unwrap().push(req.clone());
    let n = counter.fetch_add(1, Ordering::SeqCst);
    let mut conn = conn;
    match handler(&req, n) {
        Reply::Hangup => {}
        Reply::Http {
            status,
            headers,
            body,
        } => {
            let mut head = format!(
                "HTTP/1.1 {status} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                reason(status),
                body.len()
            );
            for (k, v) in headers {
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            head.push_str("\r\n");
            let _ = conn.write_all(head.as_bytes());
            let _ = conn.write_all(&body);
        }
        Reply::Stream {
            status,
            headers,
            chunks,
            delay,
            hold,
        } => {
            let mut head = format!(
                "HTTP/1.1 {status} {}\r\nConnection: close\r\n",
                reason(status)
            );
            for (k, v) in headers {
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            head.push_str("\r\n");
            if conn.write_all(head.as_bytes()).is_err() {
                return;
            }
            for c in chunks {
                if conn.write_all(&c).and_then(|_| conn.flush()).is_err() {
                    return;
                }
                if !delay.is_zero() {
                    thread::sleep(delay);
                }
            }
            thread::sleep(hold);
        }
    }
    let _ = conn.flush();
    let _ = conn.shutdown(std::net::Shutdown::Both);
}
