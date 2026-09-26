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

/// Signing-feature smoke: the live co-signer and policy match what this build
/// pins, and the wallet key derivation yields addresses the API accepts.
/// GET requests only; nothing is signed for or sent to the API.
#[cfg(feature = "signing")]
#[test]
#[ignore = "hits the live API"]
fn live_signing_smoke() {
    use ordinalswallet::signing::passthrough::{PASSTHROUGH_POLICY, PINNED_COSIGNER_XONLY_HEX};
    use ordinalswallet::signing::SigningKey;

    let c = Client::builder()
        .app_name("ordinalswallet-rs-smoke/1")
        .build()
        .unwrap();
    let caps = c.secure_purchase().capabilities().unwrap();
    println!(
        "capabilities: policy {:?}, co-signer {:?}, min postage {:?}",
        caps.escrow_policy, caps.cosigner_public_key, caps.min_postage_sats
    );
    assert_eq!(caps.escrow_policy.as_deref(), Some(PASSTHROUGH_POLICY));
    assert_eq!(
        caps.cosigner_public_key.as_deref(),
        Some(PINNED_COSIGNER_XONLY_HEX)
    );

    let key = SigningKey::from_mnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    )
    .unwrap();
    for address in [key.p2tr_address(), key.p2wpkh_address()] {
        let balance = c.wallet().balance(&address).unwrap();
        println!("balance of test address {address}: {balance:?}");
    }
    let offers = c.offers().for_wallet(&key.p2tr_address()).unwrap();
    println!(
        "offers for test address: {} received, {} sent",
        offers.received.len(),
        offers.sent.len()
    );
}
