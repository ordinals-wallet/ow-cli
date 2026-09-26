//! The reconnecting SSE subscriber and the feed/quote streams built on it.

mod common;

use std::time::Duration;

use common::{fixture, fixture_text, Reply, Server};
use ordinalswallet::feeds::{FeedStreamEvent, FeedUpdateKind};
use ordinalswallet::quotes::QuotesStreamEvent;
use ordinalswallet::stream::{subscribe, StreamEvent, SubscribeOptions};
use ordinalswallet::{Error, SDK_CLIENT_TOKEN};

fn fast() -> SubscribeOptions {
    SubscribeOptions {
        initial_backoff: Duration::from_millis(1),
        max_backoff: Duration::from_millis(20),
        ..Default::default()
    }
}

#[test]
fn delivers_named_events_with_headers() {
    let server = Server::start(|_, _| Reply::sse(&fixture_text("sse/quotes_stream.txt"), 17));
    let c = server.client().app_name("sse-test/1").build().unwrap();
    let mut names = Vec::new();
    for ev in subscribe(&c, c.url("/quotes/stream", &[]), fast()) {
        match ev {
            StreamEvent::Event(e) => {
                names.push(e.event.clone());
                if e.event == "mark" {
                    break;
                }
            }
            StreamEvent::Open => {}
            StreamEvent::Error { error, .. } => panic!("{error}"),
        }
    }
    assert_eq!(names, ["snapshot", "btc", "btc", "btc", "mark"]);
    let r = &server.requests()[0];
    assert_eq!(r.header("accept"), Some("text/event-stream"));
    assert_eq!(
        r.header("x-ow-client"),
        Some(format!("sse-test/1 {SDK_CLIENT_TOKEN}").as_str())
    );
    assert_eq!(r.header("user-agent"), Some(SDK_CLIENT_TOKEN));
}

#[test]
fn retries_503_with_retry_after_then_reconnects_with_last_event_id() {
    let server = Server::start(|_, n| match n {
        0 => Reply::raw(503, None, "rebuilding").with_header("Retry-After", "0"),
        1 => Reply::sse("id: 41\nevent: btc\ndata: {\"usd\":1,\"ts\":1}\n\n", 64),
        _ => Reply::sse("event: btc\ndata: {\"usd\":2,\"ts\":2}\n\n", 64),
    });
    let c = server.client().build().unwrap();
    let mut errors = Vec::new();
    let mut btc = 0;
    for ev in subscribe(&c, c.url("/s", &[]), fast()) {
        match ev {
            StreamEvent::Error { error, fatal } => errors.push((error, fatal)),
            StreamEvent::Event(_) => {
                btc += 1;
                if btc == 2 {
                    break;
                }
            }
            StreamEvent::Open => {}
        }
    }
    assert!(
        matches!(errors[0], (Error::SseHttp { status: 503, retry_after: Some(d) }, false) if d.is_zero()),
        "{errors:?}"
    );
    assert!(matches!(&errors[1], (Error::Stream(m), false) if m == "SSE stream ended"));
    assert_eq!(server.count(), 3);
    assert_eq!(server.requests()[2].header("last-event-id"), Some("41"));
}

#[test]
fn http_4xx_is_fatal_but_408_and_429_are_not() {
    let server = Server::start(|_, _| Reply::raw(404, None, "nope"));
    let c = server.client().build().unwrap();
    let events: Vec<_> = subscribe(&c, c.url("/s", &[]), fast()).collect();
    assert!(matches!(
        events.as_slice(),
        [StreamEvent::Error {
            error: Error::SseHttp { status: 404, .. },
            fatal: true
        }]
    ));
    assert_eq!(server.count(), 1);

    let server = Server::start(|_, n| {
        if n == 0 {
            Reply::empty(429)
        } else {
            Reply::sse("data: x\n\n", 8)
        }
    });
    let c = server.client().build().unwrap();
    let mut sub = subscribe(&c, c.url("/s", &[]), fast());
    assert!(matches!(
        sub.next(),
        Some(StreamEvent::Error { fatal: false, .. })
    ));
    assert!(matches!(sub.next(), Some(StreamEvent::Open)));
    assert!(
        matches!(sub.next(), Some(StreamEvent::Event(e)) if e.data == "x" && e.event == "message")
    );
}

#[test]
fn idle_timeout_reconnects() {
    let server = Server::start(|_, _| Reply::Stream {
        status: 200,
        headers: vec![],
        chunks: vec![b"data: first\n\n".to_vec()],
        delay: Duration::ZERO,
        hold: Duration::from_secs(3),
    });
    let c = server.client().build().unwrap();
    let opts = SubscribeOptions {
        idle_timeout: Some(Duration::from_millis(200)),
        ..fast()
    };
    let mut sub = subscribe(&c, c.url("/s", &[]), opts);
    assert!(matches!(sub.next(), Some(StreamEvent::Open)));
    assert!(matches!(sub.next(), Some(StreamEvent::Event(_))));
    match sub.next() {
        Some(StreamEvent::Error {
            error: Error::Stream(m),
            fatal: false,
        }) => assert_eq!(m, "SSE idle timeout"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(sub.next(), Some(StreamEvent::Open)));
    assert_eq!(server.count(), 2);
}

#[test]
fn close_handle_stops_iteration() {
    let server = Server::start(|_, _| Reply::raw(503, None, "down"));
    let c = server.client().build().unwrap();
    let opts = SubscribeOptions {
        initial_backoff: Duration::from_secs(30),
        ..Default::default()
    };
    let mut sub = subscribe(&c, c.url("/s", &[]), opts);
    let handle = sub.close_handle();
    assert!(matches!(
        sub.next(),
        Some(StreamEvent::Error { fatal: false, .. })
    ));
    let t = std::thread::spawn(move || sub.next().is_none());
    std::thread::sleep(Duration::from_millis(100));
    handle.close();
    assert!(t.join().unwrap(), "closed subscription ends");
}

#[test]
fn activity_feed_stream_replays_the_capture() {
    let server = Server::start(|_, _| Reply::sse(&fixture_text("sse/activity_stream.txt"), 512));
    let c = server.client().app_name("feed-test/1").build().unwrap();
    let expected = fixture("feeds-deltas.json")["sse_replay"]["after_each_event"].clone();
    let n = expected.as_array().unwrap().len();
    let mut updates = Vec::new();
    for ev in c.feeds().stream_activity_feed(200, fast()) {
        match ev {
            FeedStreamEvent::Rows(u) => {
                updates.push(u);
                if updates.len() == n {
                    break;
                }
            }
            FeedStreamEvent::Open => {}
            FeedStreamEvent::Error { error, .. } => panic!("{error}"),
        }
    }
    assert_eq!(updates[0].kind, FeedUpdateKind::Snapshot);
    assert!(updates[1..].iter().all(|u| u.kind == FeedUpdateKind::Delta));
    for (u, e) in updates.iter().zip(expected.as_array().unwrap()) {
        let keys: Vec<&str> = u.rows.iter().map(|r| r.key.as_str()).collect();
        let want: Vec<&str> = e["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap())
            .collect();
        assert_eq!(keys, want);
        assert_eq!(u.version, e["version"].as_i64());
    }
    assert_eq!(
        server.requests()[0].path,
        "/inscriptions/activity/feed/stream"
    );
    assert_eq!(
        server.requests()[0].header("x-ow-client"),
        Some(format!("feed-test/1 {SDK_CLIENT_TOKEN}").as_str())
    );
}

#[test]
fn quotes_stream_replays_snapshot_into_btc_and_mark() {
    let server = Server::start(|_, _| Reply::sse(&fixture_text("sse/quotes_stream.txt"), 64));
    let c = server.client().build().unwrap();
    let (mut snapshots, mut snapshot_marks, mut btc, mut marks) = (0, 0, 0, Vec::new());
    for ev in c
        .quotes()
        .stream(&["bitcoin-puppets", "nodemonkes"], fast())
        .unwrap()
    {
        match ev {
            QuotesStreamEvent::Snapshot(s) => {
                snapshots += 1;
                snapshot_marks = s.marks.len();
            }
            QuotesStreamEvent::Btc(_) => btc += 1,
            QuotesStreamEvent::Mark(m) => {
                marks.push(m.slug);
                if marks.len() == snapshot_marks + 1 {
                    break;
                }
            }
            QuotesStreamEvent::Open => {}
            QuotesStreamEvent::Error { error, .. } => panic!("{error}"),
        }
    }
    assert_eq!((snapshots, btc), (1, 4)); // snapshot btc + 3 live btc events before the live mark
    assert!(marks.contains(&"bitcoin-puppets".to_string()));
    assert_eq!(
        server.requests()[0].param("collections"),
        Some("bitcoin-puppets,nodemonkes".into())
    );
}
