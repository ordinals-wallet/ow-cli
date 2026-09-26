#![allow(clippy::result_large_err)] // signer closures return ordinalswallet::Result
//! Request shape, retries, errors and endpoint helpers against an in-process server.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{fixture, Reply, Server};
use ordinalswallet::auth::{AuthSession, SessionManager};
use ordinalswallet::charts::{OhlcvDenom, OhlcvInterval, OhlcvParams};
use ordinalswallet::collection::SoldEscrowsParams;
use ordinalswallet::feeds::FeedPageParams;
use ordinalswallet::offers::OfferErrorKind;
use ordinalswallet::sales::SalesParams;
use ordinalswallet::*;
use serde_json::json;

fn ok_health() -> Reply {
    Reply::json(200, &json!({"indexer_height": 1, "chain_height": 2}))
}

#[test]
fn retries_gets_on_5xx_429_and_hangups() {
    let server = Server::start(|_, n| match n {
        0 => Reply::raw(502, None, "boom"),
        1 => Reply::empty(429),
        2 => Reply::Hangup,
        _ => ok_health(),
    });
    let h = server
        .client()
        .retries(3)
        .build()
        .unwrap()
        .network()
        .health()
        .unwrap();
    assert_eq!(h.chain_height, 2);
    assert_eq!(server.count(), 4);
}

#[test]
fn gives_up_after_retries_and_reports_count() {
    let server = Server::start(|_, _| Reply::raw(500, Some("text/plain"), "down"));
    let err = server
        .client()
        .retries(3)
        .build()
        .unwrap()
        .network()
        .health()
        .unwrap_err();
    assert_eq!(server.count(), 4);
    assert_eq!(
        (err.status(), err.retries(), err.to_string().as_str()),
        (500, 3, "down")
    );
    assert!(err.is_transient());
}

#[test]
fn network_errors_have_status_zero() {
    let server = Server::start(|_, _| Reply::Hangup);
    let err = server
        .client()
        .retries(0)
        .build()
        .unwrap()
        .network()
        .health()
        .unwrap_err();
    assert!(matches!(err, Error::Network { .. }), "{err:?}");
    assert_eq!(err.status(), 0);
    assert!(err.is_transient() && err.code().is_some());
}

#[test]
fn posts_are_not_retried_unless_opted_in() {
    let server = Server::start(|_, n| {
        if n == 0 {
            Reply::raw(503, None, "boom")
        } else {
            Reply::json(200, &json!({"valuations": []}))
        }
    });
    let client = server.client().build().unwrap();
    assert_eq!(
        client.charts().valuations(&["a"]).unwrap_err().status(),
        503
    );
    assert_eq!(server.count(), 1);

    let server = Server::start(|_, n| {
        if n == 0 {
            Reply::raw(503, None, "boom")
        } else {
            Reply::json(200, &json!({"ok": true}))
        }
    });
    let v: serde_json::Value = server
        .client()
        .build()
        .unwrap()
        .post_json("/y", &json!({}), RetryMode::Always)
        .unwrap();
    assert_eq!(v, json!({"ok": true}));
    assert_eq!(server.count(), 2);
}

#[test]
fn retry_after_is_honoured_or_fails_fast() {
    let server = Server::start(|_, n| {
        if n == 0 {
            Reply::empty(429).with_header("Retry-After", "1")
        } else {
            ok_health()
        }
    });
    let t0 = Instant::now();
    server
        .client()
        .max_delay(Duration::from_secs(5))
        .build()
        .unwrap()
        .network()
        .health()
        .unwrap();
    assert!(t0.elapsed() >= Duration::from_millis(950));
    assert_eq!(server.count(), 2);

    let server = Server::start(|_, _| Reply::empty(503).with_header("Retry-After", "120"));
    let err = server
        .client()
        .build()
        .unwrap()
        .network()
        .health()
        .unwrap_err();
    assert_eq!((server.count(), err.status()), (1, 503));
}

#[test]
fn endpoint_paths_and_queries() {
    let server = Server::start(|r, _| match r.path.as_str() {
        "/collection/bitcoin-puppets/sold-escrows" => {
            Reply::json(200, &fixture("api/sold-escrows.json"))
        }
        "/collection/bitcoin-puppets/sales" => Reply::json(200, &fixture("api/sales.json")),
        "/collection/bitcoin-puppets/ohlcv" => Reply::json(200, &fixture("api/ohlcv.json")),
        "/collection/bitcoin-puppets/feed" => Reply::json(200, &fixture("api/feed.json")),
        "/collection/bitcoin-puppets/attributes" => {
            Reply::json(200, &fixture("api/attributes.json"))
        }
        "/wallet/bc1qx/rune-outpoints/840000:3" => Reply::json(200, &json!([])),
        "/blockheight" => Reply::raw(200, Some("text/plain"), "968716\n"),
        "/" => Reply::json(200, &fixture("api/health.json")),
        p => Reply::raw(500, None, &format!("unexpected {p}")),
    });
    let c = server.client().build().unwrap();
    c.collection()
        .sold_escrows(
            "bitcoin-puppets",
            SoldEscrowsParams {
                limit: 5,
                offset: Some(10),
            },
        )
        .unwrap();
    c.sales()
        .sales(
            "bitcoin-puppets",
            SalesParams {
                limit: Some(3),
                before_height: Some(900_000),
            },
        )
        .unwrap();
    let params = OhlcvParams {
        interval: Some(OhlcvInterval::H4),
        denom: Some(OhlcvDenom::Usd),
        start: Some(1),
        ..Default::default()
    };
    c.charts().ohlcv("bitcoin-puppets", &params).unwrap();
    c.feeds()
        .collection_feed(
            "bitcoin-puppets",
            &FeedPageParams {
                limit: Some(3),
                cursor: Some("2~abc".into()),
            },
        )
        .unwrap();
    c.collection().attributes("bitcoin-puppets").unwrap();
    c.wallet().rune_outpoints("bc1qx", "840000:3").unwrap();
    assert_eq!(c.network().blockheight().unwrap(), 968_716);
    assert!(c.network().health().unwrap().chain_height > 0);

    let r = server.requests();
    assert_eq!(
        (r[0].param("limit"), r[0].param("offset")),
        (Some("5".into()), Some("10".into()))
    );
    assert_eq!(
        (r[1].param("limit"), r[1].param("before_height")),
        (Some("3".into()), Some("900000".into()))
    );
    assert_eq!(
        (
            r[2].param("interval"),
            r[2].param("denom"),
            r[2].param("start"),
            r[2].param("series")
        ),
        (
            Some("4h".into()),
            Some("usd".into()),
            Some("1".into()),
            None
        )
    );
    assert_eq!(r[3].param("cursor"), Some("2~abc".into()));
    assert!(r.iter().all(|r| r.method == "GET"));
}

#[test]
fn quotes_dedupe_and_chunk_at_64() {
    let live = fixture("api/quotes.json");
    let server = Server::start(move |r, _| {
        let mut body = live.clone();
        let slugs = r.param("collections").unwrap_or_default();
        body["marks"] = slugs
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|s| {
                let mut m = live["marks"][0].clone();
                m["slug"] = json!(s);
                m
            })
            .collect();
        Reply::json(200, &body)
    });
    let c = server.client().build().unwrap();
    let one = c
        .quotes()
        .get(&["bitcoin-puppets", "nodemonkes", "bitcoin-puppets"])
        .unwrap();
    assert_eq!(one.marks.len(), 2);
    let slugs: Vec<String> = (0..130).map(|i| format!("s{i}")).collect();
    let many = c.quotes().get(&slugs).unwrap();
    assert_eq!(many.marks.len(), 130);
    let sizes: Vec<usize> = server.requests()[1..]
        .iter()
        .map(|r| r.param("collections").unwrap().split(',').count())
        .collect();
    assert_eq!(sizes, vec![64, 64, 2]);
    assert!(matches!(
        c.quotes().stream(
            &(0..65).map(|i| format!("s{i}")).collect::<Vec<_>>(),
            Default::default()
        ),
        Err(Error::InvalidInput(_))
    ));
}

#[test]
fn valuations_dedupe_and_batch_at_200() {
    let server = Server::start(|r, _| {
        let slugs = r.json()["slugs"].as_array().unwrap().clone();
        let v = fixture("api/valuation.json");
        Reply::json(
            200,
            &json!({"valuations": slugs.iter().map(|s| { let mut x = v.clone(); x["slug"] = s.clone(); x }).collect::<Vec<_>>()}),
        )
    });
    let mut slugs: Vec<String> = (0..450).map(|i| format!("c{i}")).collect();
    slugs.extend((0..10).map(|i| format!("c{i}")));
    let out = server
        .client()
        .build()
        .unwrap()
        .charts()
        .valuations(&slugs)
        .unwrap();
    assert_eq!(out.len(), 450);
    let sizes: Vec<usize> = server
        .requests()
        .iter()
        .map(|r| r.json()["slugs"].as_array().unwrap().len())
        .collect();
    assert_eq!(sizes, vec![200, 200, 50]);
    assert!(server
        .requests()
        .iter()
        .all(|r| r.method == "POST" && r.header("content-type") == Some("application/json")));
}

#[test]
fn not_found_reads_map_to_none_or_empty() {
    let server = Server::start(|r, _| match r.path.as_str() {
        p if p.starts_with("/v2/search/") => Reply::empty(404),
        p if p.starts_with("/market/escrow/0") => {
            Reply::json(404, &json!({"error": true, "message": "not found"}))
        }
        p if p.starts_with("/market/escrow/e") => {
            Reply::json(200, &json!({"error": true, "message": "no listing"}))
        }
        p if p.starts_with("/market/escrow/") => {
            Reply::json(200, &fixture("api/market-listing.json"))
        }
        "/market/secure-purchase/capabilities" => {
            Reply::json(200, &fixture("api/secure-purchase-capabilities.json"))
        }
        p if p.starts_with("/market/secure-listing/") => Reply::empty(404),
        p => Reply::raw(500, None, p),
    });
    let c = server.client().build().unwrap();
    assert_eq!(
        c.search("nothing here", None).unwrap().collections,
        Some(vec![])
    );
    assert_eq!(server.requests()[0].path, "/v2/search/nothing%20here");
    assert_eq!(server.requests()[0].param("limit"), Some("16".into()));
    assert!(c.market().listing("0abc").unwrap().is_none());
    assert!(c.market().listing("eabc").unwrap().is_none());
    assert_eq!(
        c.market().listing("4919i0").unwrap().unwrap().protected,
        Some(true)
    );
    assert_eq!(
        c.secure_purchase().capabilities().unwrap().min_postage_sats,
        Some(330)
    );
    assert!(c.secure_listing().status("ab:0").unwrap().is_none());
    assert_eq!(
        server.requests().last().unwrap().header("cache-control"),
        Some("no-store")
    );
}

#[test]
fn capabilities_unavailable() {
    let server =
        Server::start(|_, _| Reply::json(200, &json!({"error": true, "message": "disabled"})));
    let err = server
        .client()
        .build()
        .unwrap()
        .secure_purchase()
        .capabilities()
        .unwrap_err();
    assert!(
        matches!(&err, Error::Unavailable(m) if m == "disabled"),
        "{err:?}"
    );
}

#[test]
fn offers_reads_and_error_kinds() {
    let live = fixture("api/offers-live.json");
    let server = Server::start(move |r, _| match r.path.as_str() {
        "/market/offers/collection/bitmap" => Reply::json(200, &live["collection_bitmap"]),
        "/market/offers/wallet/bc1qx" => Reply::json(200, &live["wallet"]),
        "/market/offers/inscription/abci0" => Reply::json(200, &live["inscription"]),
        "/market/offers/inscription/bad" => Reply::json(400, &live["invalid_inscription"]),
        _ => Reply::json(
            409,
            &json!({"error": true, "code": "offer_expired", "message": "Offer has expired"}),
        ),
    });
    let c = server.client().build().unwrap();
    assert_eq!(c.offers().for_collection("bitmap").unwrap().slug, "bitmap");
    assert!(c.offers().for_wallet("bc1qx").unwrap().received.is_empty());
    assert!(c
        .offers()
        .for_inscription("abci0")
        .unwrap()
        .offers
        .is_empty());
    let bad = c.offers().for_inscription("bad").unwrap_err();
    assert_eq!(
        bad.offer_kind(),
        Some(OfferErrorKind::Other("invalid_inscription_id".into()))
    );
    let expired = c.offers().reconcile("o1", Some("tx")).unwrap_err();
    assert_eq!(
        (expired.offer_kind(), expired.status()),
        (Some(OfferErrorKind::Expired), 409)
    );
    assert_eq!(
        server.requests().last().unwrap().param("txid"),
        Some("tx".into())
    );
}

#[test]
fn sales_iterator_pages_backwards() {
    let template = fixture("api/sales.json")["sales"][0].clone();
    let t2 = template.clone();
    let server = Server::start(move |r, _| {
        let before: Option<u64> = r.param("before_height").map(|s| s.parse().unwrap());
        let (heights, more): (Vec<u64>, bool) = match before {
            None => (vec![100, 99], true),
            Some(99) => (vec![98, 97], true),
            Some(97) => (vec![97], true), // cursor does not move: stop
            _ => (vec![], false),
        };
        let sales: Vec<_> = heights
            .iter()
            .map(|h| {
                let mut s = t2.clone();
                s["block_height"] = json!(h);
                s
            })
            .collect();
        Reply::json(
            200,
            &json!({"sales": sales, "has_more": more, "matched_inscriptions": 1}),
        )
    });
    let c = server.client().build().unwrap();
    let got: Vec<u64> = c
        .sales()
        .iter_sales(
            "x",
            SalesParams {
                limit: Some(2),
                ..Default::default()
            },
        )
        .map(|s| s.unwrap().block_height)
        .collect();
    assert_eq!(got, vec![100, 99, 98, 97, 97]);
    assert_eq!(server.count(), 3);
    assert!(template.is_object());
}

#[test]
fn create_session_is_never_retried_and_maps_to_auth() {
    let server =
        Server::start(|_, _| Reply::json(503, &json!({"error": true, "message": "try later"})));
    let c = server.client().build().unwrap();
    let err = c
        .auth()
        .create_session("bc1qx", "00ff00ff00ff00ff", 1, "sig")
        .unwrap_err();
    assert!(
        matches!(&err, Error::Auth { status: 503, message, .. } if message == "try later"),
        "{err:?}"
    );
    assert_eq!(server.count(), 1);
}

#[test]
fn session_manager_signs_in_once_and_refreshes() {
    let server = Server::start(|r, _| {
        let b = r.json();
        assert!(b["nonce"].as_str().unwrap().len() == 32 && b["signature"] == "SIG");
        Reply::json(
            200,
            &json!({"token": format!("ows1.{}", b["issued_at"]), "address": b["address"], "expires_at": 1_000_000}),
        )
    });
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = signed.clone();
    let now = Arc::new(std::sync::atomic::AtomicU64::new(500_000_000));
    let clock = now.clone();
    let mgr = Arc::new(
        SessionManager::new(server.client().build().unwrap())
            .with_signer(move |addr: &str, msg: &str| {
                log.lock()
                    .unwrap()
                    .push((addr.to_string(), msg.to_string()));
                std::thread::sleep(Duration::from_millis(50));
                Ok("SIG".to_string())
            })
            .with_clock(move || clock.load(std::sync::atomic::Ordering::SeqCst)),
    );
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let m = mgr.clone();
            std::thread::spawn(move || m.get_token("bc1qx", None).unwrap())
        })
        .collect();
    let tokens: Vec<String> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(tokens.iter().all(|t| *t == tokens[0]));
    assert_eq!(server.count(), 1, "concurrent callers share one sign-in");
    assert!(signed.lock().unwrap()[0].1.contains("Issued At: 500000000"));

    now.store(1_000_000_000 - 299_000, std::sync::atomic::Ordering::SeqCst); // within 300s of expiry
    assert!(mgr.peek("bc1qx").is_none());
    mgr.get_session("bc1qx", None).unwrap();
    assert_eq!(server.count(), 2);

    mgr.set(AuthSession {
        token: "t".into(),
        address: "bc1qother".into(),
        expires_at: u64::MAX / 2000,
    });
    assert_eq!(mgr.get_token("bc1qother", None).unwrap(), "t");
    mgr.invalidate("bc1qother");
    assert!(mgr.peek("bc1qother").is_none());
    let err = SessionManager::new(server.client().build().unwrap())
        .get_session("bc1qz", None)
        .unwrap_err();
    assert!(matches!(err, Error::Auth { status: 0, .. }));
    assert!(
        !format!("{:?}", mgr.peek("bc1qx")).contains("ows1."),
        "tokens are redacted in Debug"
    );
}
