//! Shared, language-neutral vectors in the repo-root `fixtures/` directory.
//! `packages/api/__tests__/shared-vectors.test.ts` asserts the same files.

mod common;

use std::time::{Duration, UNIX_EPOCH};

use common::{fixture, fixture_text, Reply, Server};
use ordinalswallet::auth::{generate_nonce, sign_in_message};
use ordinalswallet::feeds::{FeedDelta, FeedPage, FeedStore, DEFAULT_MAX_ROWS};
use ordinalswallet::retry::{compute_retry_delay, parse_retry_after};
use ordinalswallet::stream::{SseItem, SseParser};
use ordinalswallet::*;
use serde_json::{json, Value};

fn s(v: &Value) -> &str {
    v.as_str()
        .unwrap_or_else(|| panic!("expected string, got {v}"))
}

#[test]
fn sign_in_message_vectors() {
    let v = fixture("sign-in-message.json");
    for c in v["cases"].as_array().unwrap() {
        let got = sign_in_message(
            s(&c["address"]),
            s(&c["nonce"]),
            c["issued_at_ms"].as_u64().unwrap(),
        );
        assert_eq!(got, s(&c["expected"]));
        let templ = s(&v["template"])
            .replace("{address}", s(&c["address"]))
            .replace("{nonce}", s(&c["nonce"]))
            .replace("{issued_at_ms}", &c["issued_at_ms"].to_string());
        assert_eq!(templ, got);
    }
    let a = generate_nonce().unwrap();
    assert_eq!(a.len() as u64, v["nonce"]["hex_length"].as_u64().unwrap());
    assert!(a
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_ne!(a, generate_nonce().unwrap());
}

#[test]
fn outpoint_vectors() {
    let v = fixture("outpoint.json");
    for c in v["valid"].as_array().unwrap() {
        let ser = s(&c["serialized"]);
        assert!(is_serialized_outpoint(ser), "{}", c["name"]);
        assert_eq!(
            outpoint_to_txid_vout(ser).unwrap(),
            s(&c["txid_vout"]),
            "{}",
            c["name"]
        );
        assert_eq!(
            parse_serialized_outpoint(ser).unwrap().vout as u64,
            c["vout"].as_u64().unwrap()
        );
        assert_eq!(
            txid_vout_to_serialized(s(&c["txid_vout"])).unwrap(),
            ser.to_ascii_lowercase()
        );
    }
    for c in v["passthrough"].as_array().unwrap() {
        assert_eq!(
            outpoint_to_txid_vout(s(&c["input"])).unwrap(),
            s(&c["expected"])
        );
    }
    for c in v["roundtrip"].as_array().unwrap() {
        assert_eq!(
            txid_vout_to_serialized(s(&c["txid_vout"])).unwrap(),
            s(&c["serialized"])
        );
        assert_eq!(
            outpoint_to_txid_vout(s(&c["serialized"])).unwrap(),
            s(&c["txid_vout"])
        );
    }
    for bad in v["invalid_serialized"].as_array().unwrap() {
        assert!(
            matches!(outpoint_to_txid_vout(s(bad)), Err(Error::InvalidInput(_))),
            "{bad}"
        );
    }
    for bad in v["invalid_txid_vout"].as_array().unwrap() {
        assert!(txid_vout_to_serialized(s(bad)).is_err(), "{bad}");
    }
    let satpoint = s(&fixture("api/inscription.json")["satpoint"]).to_string();
    let mut parts = satpoint.split(':');
    let expected = format!("{}:{}", parts.next().unwrap(), parts.next().unwrap());
    assert_eq!(s(&v["valid"][0]["txid_vout"]), expected);
}

#[test]
fn client_header_vectors() {
    let v = fixture("client-header.json");
    for c in v["cases"].as_array().unwrap() {
        let expected = s(&c["expected"]).replace("{sdk}", SDK_CLIENT_TOKEN);
        assert_eq!(
            build_client_header(c["app_name"].as_str()),
            expected,
            "{}",
            c["name"]
        );
    }
    assert!(SDK_CLIENT_TOKEN.starts_with("ordinalswallet-rs/"));
    assert_eq!(
        SDK_CLIENT_TOKEN,
        format!("ordinalswallet-rs/{}", env!("CARGO_PKG_VERSION"))
    );

    // And on the wire.
    let server =
        Server::start(|_, _| Reply::json(200, &json!({"indexer_height": 1, "chain_height": 1})));
    for c in v["cases"].as_array().unwrap() {
        let mut b = server.client();
        if let Some(app) = c["app_name"].as_str() {
            b = b.app_name(app);
        }
        b.build().unwrap().network().health().unwrap();
    }
    let reqs = server.requests();
    for (c, r) in v["cases"].as_array().unwrap().iter().zip(&reqs) {
        assert_eq!(
            r.header(s(&v["header"])),
            Some(
                s(&c["expected"])
                    .replace("{sdk}", SDK_CLIENT_TOKEN)
                    .as_str()
            )
        );
        assert_eq!(r.header("user-agent"), Some(SDK_CLIENT_TOKEN));
    }
}

#[test]
fn retry_vectors() {
    let v = fixture("retry.json");
    let d = RetryConfig::default();
    assert_eq!(d.retries as u64, v["defaults"]["retries"].as_u64().unwrap());
    assert_eq!(
        d.retry_delay.as_millis() as u64,
        v["defaults"]["retry_delay_ms"].as_u64().unwrap()
    );
    assert_eq!(
        d.max_delay.as_millis() as u64,
        v["defaults"]["max_delay_ms"].as_u64().unwrap()
    );

    let now = UNIX_EPOCH + Duration::from_millis(v["now_ms"].as_u64().unwrap());
    for c in v["parse_retry_after"].as_array().unwrap() {
        let got = parse_retry_after(c["value"].as_str(), now).map(|d| d.as_millis() as u64);
        assert_eq!(got, c["expected_ms"].as_u64(), "Retry-After {}", c["value"]);
    }
    for c in v["compute_delay"].as_array().unwrap() {
        let got = compute_retry_delay(
            c["attempt"].as_u64().unwrap() as u32,
            Duration::from_millis(c["retry_delay_ms"].as_u64().unwrap()),
            Duration::from_millis(c["max_delay_ms"].as_u64().unwrap()),
            c["retry_after"].as_str(),
            c["random"].as_f64().unwrap(),
        )
        .map(|d| d.as_millis() as u64);
        assert_eq!(got, c["expected_ms"].as_u64(), "{c}");
    }
    for b in v["default_backoff_bounds"].as_array().unwrap() {
        for r in [0.0, 0.25, 0.5, 0.999, 1.0] {
            let got = compute_retry_delay(
                b["attempt"].as_u64().unwrap() as u32,
                d.retry_delay,
                d.max_delay,
                None,
                r,
            )
            .unwrap()
            .as_millis() as u64;
            assert!(
                got >= b["min_ms"].as_u64().unwrap() && got <= b["max_ms"].as_u64().unwrap(),
                "{b} r={r} got {got}"
            );
        }
    }

    let statuses = |k: &str| {
        v["retryable_status"][k]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as u16)
            .collect::<Vec<_>>()
    };
    for (status, retried) in statuses("retry")
        .into_iter()
        .map(|s| (s, true))
        .chain(statuses("no_retry").into_iter().map(|s| (s, false)))
    {
        let server = Server::start(move |_, n| {
            if n == 0 {
                Reply::empty(status)
            } else {
                Reply::json(200, &json!({"indexer_height": 1, "chain_height": 1}))
            }
        });
        let _ = server.client().build().unwrap().network().health();
        assert_eq!(
            server.count(),
            if retried { 2 } else { 1 },
            "status {status}"
        );
    }
}

fn apply_step(store: &mut FeedStore, step: &Value) -> Vec<ordinalswallet::feeds::FeedRow> {
    if let Some(snap) = step.get("snapshot") {
        let page: FeedPage = serde_json::from_value(snap.clone()).unwrap();
        store.apply_snapshot(page).to_vec()
    } else {
        let delta: FeedDelta = serde_json::from_value(step["delta"].clone()).unwrap();
        store.apply_delta(delta).unwrap().to_vec()
    }
}

#[test]
fn feeds_delta_vectors() {
    let v = fixture("feeds-deltas.json");
    for c in v["cases"].as_array().unwrap() {
        let mut store = FeedStore::new(
            c["max_rows"]
                .as_u64()
                .map_or(DEFAULT_MAX_ROWS, |n| n as usize),
        );
        for (i, step) in c["steps"].as_array().unwrap().iter().enumerate() {
            let rows = apply_step(&mut store, step);
            let ctx = format!("{} step {i}", c["name"]);
            let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
            let want: Vec<&str> = step["expect"]["keys"]
                .as_array()
                .unwrap()
                .iter()
                .map(s)
                .collect();
            assert_eq!(keys, want, "{ctx}");
            assert_eq!(store.version(), step["expect"]["version"].as_i64(), "{ctx}");
            assert_eq!(store.tip(), step["expect"]["tip"].as_i64(), "{ctx}");
            let got: Vec<Value> = rows
                .iter()
                .map(|r| json!({"key": r.key, "status": r.status, "price_sats": r.price_sats, "ts": r.ts}))
                .collect();
            assert_eq!(Value::Array(got), step["expect"]["rows"], "{ctx}");
        }
    }

    let replay = &v["sse_replay"];
    let mut store = FeedStore::default();
    let mut parser = SseParser::new();
    let mut items = parser.push(&fixture_text(s(&replay["sse"])));
    items.extend(parser.finish());
    let mut got = Vec::new();
    for item in items {
        if let SseItem::Event(e) = item {
            let rows = if e.event == "snapshot" {
                store
                    .apply_snapshot(serde_json::from_str(&e.data).unwrap())
                    .to_vec()
            } else {
                store
                    .apply_delta(serde_json::from_str(&e.data).unwrap())
                    .unwrap()
                    .to_vec()
            };
            got.push(json!({
                "event": e.event, "version": store.version(), "tip": store.tip(),
                "keys": rows.iter().map(|r| r.key.clone()).collect::<Vec<_>>(),
            }));
        }
    }
    assert_eq!(Value::Array(got), replay["after_each_event"]);
}

/// Parses `input` fed as byte chunks of the given sizes (cycled), decoding
/// UTF-8 incrementally like the subscriber does.
fn parse_all(input: &str, sizes: Option<&[usize]>) -> Value {
    let mut p = SseParser::new();
    let mut items = Vec::new();
    match sizes {
        None => items.extend(p.push(input)),
        Some(sizes) => {
            let bytes = input.as_bytes();
            let (mut i, mut n) = (0, 0);
            let mut pending: Vec<u8> = Vec::new();
            while i < bytes.len() {
                let end = (i + sizes[n % sizes.len()]).min(bytes.len());
                n += 1;
                pending.extend_from_slice(&bytes[i..end]);
                i = end;
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) => e.valid_up_to(),
                };
                let text = String::from_utf8(pending.drain(..valid).collect()).unwrap();
                items.extend(p.push(&text));
            }
        }
    }
    items.extend(p.finish());
    let mut events = Vec::new();
    let mut comments = Vec::new();
    let mut retries = Vec::new();
    for it in items {
        match it {
            SseItem::Event(e) => events.push(serde_json::to_value(e).unwrap()),
            SseItem::Comment(c) => comments.push(Value::String(c)),
            SseItem::Retry(ms) => retries.push(json!(ms)),
        }
    }
    json!({"events": events, "comments": comments, "retries": retries})
}

#[test]
fn sse_vectors() {
    let dir = common::fixtures_dir().join("sse");
    let mut n = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        let Some(base) = name.strip_suffix(".expected.json") else {
            continue;
        };
        n += 1;
        let expected = fixture(&format!("sse/{name}"));
        let input = fixture_text(s(&expected["source"]));
        let want = json!({"events": expected["events"], "comments": expected["comments"], "retries": expected["retries"]});
        assert_eq!(parse_all(&input, None), want, "{base}");
        for sizes in [&[1usize][..], &[2, 7], &[13], &[3, 1, 50], &[4096]] {
            assert_eq!(parse_all(&input, Some(sizes)), want, "{base} {sizes:?}");
        }
        assert_eq!(
            parse_all(&input.replace('\n', "\r\n"), Some(&[1, 2, 3])),
            want,
            "{base} CRLF"
        );
        assert_eq!(
            parse_all(&input.replace('\n', "\r"), Some(&[5])),
            want,
            "{base} CR"
        );
    }
    assert!(n >= 3, "expected at least 3 SSE vectors, found {n}");
}

#[test]
fn error_body_vectors() {
    let v = fixture("error-bodies.json");
    for c in v["cases"].as_array().unwrap() {
        let case = c.clone();
        let server = Server::start(move |_, _| match case["body"].as_str() {
            None => Reply::empty(case["status"].as_u64().unwrap() as u16),
            Some(body) => Reply::raw(
                case["status"].as_u64().unwrap() as u16,
                case["content_type"].as_str(),
                body,
            ),
        });
        let err = server
            .client()
            .retries(0)
            .build()
            .unwrap()
            .network()
            .fee_estimates()
            .unwrap_err();
        let name = &c["name"];
        let Error::Api {
            status,
            code,
            message,
            body,
            ..
        } = &err
        else {
            panic!("{name}: {err:?}")
        };
        assert_eq!(*status as u64, c["status"].as_u64().unwrap(), "{name}");
        assert_eq!(code.as_deref(), c["expected"]["code"].as_str(), "{name}");
        assert_eq!(
            body.clone().unwrap_or(Value::Null),
            c["expected"]["body"],
            "{name}"
        );
        match c["expected"]["message"].as_str() {
            Some(m) => assert_eq!(message, m, "{name}"),
            None => assert!(
                message.starts_with(s(&c["expected"]["message_prefix"])),
                "{name}: {message}"
            ),
        }
        assert_eq!(err.to_string(), *message);
    }
}
