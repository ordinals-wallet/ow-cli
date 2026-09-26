//! Every recorded live response in `fixtures/api/` decodes into its Rust type.
//! The TypeScript msw handlers serve the same files.

mod common;

use common::fixture;
use ordinalswallet::charts::{Ohlcv, Valuation};
use ordinalswallet::collection::{AttributeGroup, CollectionMetadata, CollectionStats, Escrow};
use ordinalswallet::feeds::{FeedDelta, FeedPage, MempoolSale, RecentListing};
use ordinalswallet::market::{MarketListing, SecurePurchaseCapabilities};
use ordinalswallet::network::{FeeEstimates, Health};
use ordinalswallet::offers::{
    CollectionOffersResponse, InscriptionOffersResponse, WalletOffersResponse,
};
use ordinalswallet::quotes::QuotesSnapshot;
use ordinalswallet::sales::{SalesPage, SalesVolume, WalletSalesPage};
use ordinalswallet::search::SearchResult;
use ordinalswallet::wallet::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn decode<T: DeserializeOwned>(name: &str, v: Value) -> T {
    serde_json::from_value(v).unwrap_or_else(|e| panic!("fixtures/api/{name}: {e}"))
}

fn check(name: &str) {
    let v = fixture(&format!("api/{name}"));
    match name {
        "activity.json" | "feed.json" => {
            let p: FeedPage = decode(name, v);
            assert!(!p.rows.is_empty() && p.version.is_some());
        }
        "alkanes-balance.json" => assert!(!decode::<Vec<AlkanesBalance>>(name, v).is_empty()),
        "alkanes-outpoints.json" => assert!(!decode::<Vec<TokenOutpoint>>(name, v).is_empty()),
        "attributes.json" => assert!(decode::<Vec<AttributeGroup>>(name, v)[0].values[0].count > 0),
        "brc20-balance.json" => assert!(!decode::<Vec<Brc20Balance>>(name, v).is_empty()),
        "collection-stats.json" => {
            assert!(decode::<CollectionStats>(name, v).floor_price.is_some())
        }
        "collection.json" => assert!(!decode::<CollectionMetadata>(name, v).slug.is_empty()),
        "escrows.json" | "sold-escrows.json" | "sold-escrows-rune.json" => {
            assert!(decode::<Vec<Escrow>>(name, v)[0].satoshi_price > 0)
        }
        "fee-estimates.json" => assert!(decode::<FeeEstimates>(name, v).fastest_fee > 0.0),
        "health.json" => assert!(decode::<Health>(name, v).chain_height > 900_000),
        "inscription-outpoint.json" => assert_eq!(
            decode::<InscriptionOutpoint>(name, v)
                .inscription
                .outpoint
                .len(),
            72
        ),
        "inscription.json" => assert!(decode::<InscriptionDetail>(name, v).satpoint.is_some()),
        "market-listing.json" => assert!(decode::<MarketListing>(name, v).protected.is_some()),
        "mempool_sales.json" => assert_eq!(
            decode::<Vec<MempoolSale>>(name, v)[0]
                .mempool
                .spending_txid
                .len(),
            64
        ),
        "offers-live.json" => {
            decode::<CollectionOffersResponse>(name, v["collection_bitmap"].clone());
            decode::<WalletOffersResponse>(name, v["wallet"].clone());
            decode::<InscriptionOffersResponse>(name, v["inscription"].clone());
        }
        "ohlcv.json" | "ohlcv_usd.json" => assert!(!decode::<Ohlcv>(name, v).candles.is_empty()),
        "quotes.json" => assert!(decode::<QuotesSnapshot>(name, v).btc.is_some()),
        "recent_listings.json" => assert!(
            decode::<Vec<RecentListing>>(name, v)[0]
                .escrow
                .satoshi_price
                > 0
        ),
        "rune-balance.json" => assert!(!decode::<Vec<RuneBalance>>(name, v).is_empty()),
        "sales.json" => assert!(!decode::<SalesPage>(name, v).sales.is_empty()),
        "sales_volume.json" => assert!(!decode::<SalesVolume>(name, v).buckets.is_empty()),
        "search-collections.json" => assert!(!decode::<SearchResult>(name, v)
            .collections
            .unwrap()
            .is_empty()),
        "search-url.json" => assert!(decode::<SearchResult>(name, v).url.is_some()),
        "secure-purchase-capabilities.json" => {
            let caps: SecurePurchaseCapabilities = decode(name, v["secure_purchase"].clone());
            assert!(caps.cosigner_public_key.is_some());
        }
        "valuation.json" => assert!(decode::<Valuation>(name, v).fair_sats.is_some()),
        "valuations.json" => {
            assert!(!decode::<Vec<Valuation>>(name, v["valuations"].clone()).is_empty())
        }
        "wallet-balance.json" => {
            decode::<WalletBalance>(name, v);
        }
        "wallet-inscriptions.json" => assert!(decode::<Vec<WalletInscription>>(name, v)[0]
            .outpoint
            .is_some()),
        "wallet.json" => assert!(!decode::<WalletInfo>(name, v).inscriptions.is_empty()),
        "wallet_sales.json" => assert!(!decode::<WalletSalesPage>(name, v).sales.is_empty()),
        other => panic!("fixtures/api/{other} has no decode check; add one here"),
    }
}

#[test]
fn every_api_fixture_decodes() {
    let mut names: Vec<String> = std::fs::read_dir(common::fixtures_dir().join("api"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    assert!(names.len() >= 30, "{names:?}");
    for n in &names {
        check(n);
    }
}

#[test]
fn stream_captures_decode() {
    use ordinalswallet::stream::{SseItem, SseParser};
    for (file, kinds) in [
        ("sse/activity_stream.txt", ["snapshot", "delta"]),
        ("sse/quotes_stream.txt", ["snapshot", "btc"]),
    ] {
        let mut p = SseParser::new();
        let mut items = p.push(&common::fixture_text(file));
        items.extend(p.finish());
        for item in items {
            let SseItem::Event(e) = item else { continue };
            assert!(
                kinds.contains(&e.event.as_str()) || e.event == "mark",
                "{file}: {}",
                e.event
            );
            match (file, e.event.as_str()) {
                ("sse/activity_stream.txt", "snapshot") => drop(decode::<FeedPage>(
                    file,
                    serde_json::from_str(&e.data).unwrap(),
                )),
                ("sse/activity_stream.txt", _) => drop(decode::<FeedDelta>(
                    file,
                    serde_json::from_str(&e.data).unwrap(),
                )),
                (_, "snapshot") => drop(decode::<QuotesSnapshot>(
                    file,
                    serde_json::from_str(&e.data).unwrap(),
                )),
                (_, "btc") => drop(decode::<ordinalswallet::quotes::BtcQuote>(
                    file,
                    serde_json::from_str(&e.data).unwrap(),
                )),
                _ => drop(decode::<ordinalswallet::quotes::MarkQuote>(
                    file,
                    serde_json::from_str(&e.data).unwrap(),
                )),
            }
        }
    }
}

#[test]
fn attribute_percent_as_number_text_or_null() {
    let v = serde_json::json!([
        { "trait_type": "Background", "value": "Peach", "percent": "5.85%" },
        { "trait_type": "Body", "value": "Yellow", "percent": 6.21 },
        { "trait_type": "Mouth", "value": "Surprise", "percent": null },
        { "trait_type": "Eyes", "value": "Laser" },
        { "trait_type": "Hat", "value": "Cap", "percent": "n/a" }
    ]);
    let attrs: Vec<InscriptionAttribute> = serde_json::from_value(v).unwrap();
    let got: Vec<Option<f64>> = attrs.iter().map(|a| a.percent).collect();
    assert_eq!(got, [Some(5.85), Some(6.21), None, None, None]);
}
