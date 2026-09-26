//! Live smoke test against production. GET requests only; never POSTs.
//! Run manually: `cargo test --test live -- --ignored --nocapture`

use std::time::{Duration, Instant};

use ordinalswallet::charts::{OhlcvInterval, OhlcvParams};
use ordinalswallet::quotes::QuotesStreamEvent;
use ordinalswallet::sales::SalesParams;
use ordinalswallet::stream::SubscribeOptions;
use ordinalswallet::Client;

const SLUG: &str = "bitcoin-puppets";

#[test]
#[ignore = "hits the live API"]
fn live_get_smoke() {
    let c = Client::builder()
        .app_name("ordinalswallet-rs-smoke/1")
        .build()
        .unwrap();

    let h = c.network().health().unwrap();
    println!(
        "health: indexer {} chain {}",
        h.indexer_height, h.chain_height
    );

    let v = c.charts().valuation(SLUG).unwrap();
    println!(
        "valuation: fair {:?} sats, method {}, confidence {:.2}",
        v.fair_sats, v.method, v.confidence
    );
    assert!(v.fair_sats.is_some());

    let o = c
        .charts()
        .ohlcv(
            SLUG,
            &OhlcvParams {
                interval: Some(OhlcvInterval::D1),
                ..Default::default()
            },
        )
        .unwrap();
    println!(
        "ohlcv: {} candles, {} trend points, {} prints",
        o.candles.len(),
        o.trend.len(),
        o.prints.len()
    );
    assert!(!o.candles.is_empty());

    let page = c
        .sales()
        .sales(
            SLUG,
            SalesParams {
                limit: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
    println!(
        "sales: {} rows, has_more {}, newest height {:?}",
        page.sales.len(),
        page.has_more,
        page.sales.first().map(|s| s.block_height)
    );
    let paged: Vec<_> = c
        .sales()
        .iter_sales(
            SLUG,
            SalesParams {
                limit: Some(3),
                ..Default::default()
            },
        )
        .take(7)
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(paged.len(), 7);
    assert!(paged
        .windows(2)
        .all(|w| w[0].block_height >= w[1].block_height));

    let t0 = Instant::now();
    let mut stream = c
        .quotes()
        .stream(&[SLUG], SubscribeOptions::default())
        .unwrap();
    let (mut snapshot, mut btc) = (false, None);
    for ev in stream.by_ref() {
        match ev {
            QuotesStreamEvent::Snapshot(s) => {
                snapshot = true;
                println!(
                    "quotes stream: snapshot with {} marks after {:?}",
                    s.marks.len(),
                    t0.elapsed()
                );
            }
            QuotesStreamEvent::Btc(b) => {
                btc = Some(b.usd);
                break;
            }
            QuotesStreamEvent::Error { error, fatal } => {
                panic!("stream error (fatal {fatal}): {error}")
            }
            _ => {}
        }
        assert!(t0.elapsed() < Duration::from_secs(30));
    }
    stream.close();
    println!("quotes stream: BTC ${:?}", btc);
    assert!(snapshot && btc.unwrap_or(0.0) > 0.0);
}
