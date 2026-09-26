//! Candles, fair-value bands and valuations.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::{seg, Client, Req};
use crate::error::Result;

/// Max slugs per `POST /collections/valuation` request.
pub const VALUATION_BATCH_LIMIT: usize = 200;

/// Candle bucket size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OhlcvInterval {
    M5,
    M15,
    H1,
    H4,
    H12,
    D1,
    W1,
}

impl OhlcvInterval {
    pub fn as_str(self) -> &'static str {
        match self {
            OhlcvInterval::M5 => "5m",
            OhlcvInterval::M15 => "15m",
            OhlcvInterval::H1 => "1h",
            OhlcvInterval::H4 => "4h",
            OhlcvInterval::H12 => "12h",
            OhlcvInterval::D1 => "1d",
            OhlcvInterval::W1 => "1w",
        }
    }
}

/// Price denomination: sats, USD, or market cap (USD × supply).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OhlcvDenom {
    Sats,
    Usd,
    Mcap,
}

impl OhlcvDenom {
    pub fn as_str(self) -> &'static str {
        match self {
            OhlcvDenom::Sats => "sats",
            OhlcvDenom::Usd => "usd",
            OhlcvDenom::Mcap => "mcap",
        }
    }
}

/// `Mark` = fair-value trace, `Trades` = raw sale OHLC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OhlcvSeries {
    Mark,
    Trades,
}

impl OhlcvSeries {
    pub fn as_str(self) -> &'static str {
        match self {
            OhlcvSeries::Mark => "mark",
            OhlcvSeries::Trades => "trades",
        }
    }
}

/// Query for [`ChartsApi::ohlcv`]. Every field is optional.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OhlcvParams {
    pub interval: Option<OhlcvInterval>,
    pub denom: Option<OhlcvDenom>,
    pub series: Option<OhlcvSeries>,
    /// Unix seconds. Defaults to ~300 buckets back.
    pub start: Option<i64>,
    /// Unix seconds. Page back with `end` for deeper history.
    pub end: Option<i64>,
    /// Override the supply used for `mcap`.
    pub supply: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OhlcvCandle {
    /// Bucket start, unix seconds.
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub median: f64,
    pub volume: f64,
    pub trades: u64,
    /// No sales in this bucket; in usd/mcap it still moves with BTC. Don't draw volume.
    pub synthetic: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OhlcvTrendPoint {
    pub time: i64,
    pub p10: f64,
    pub p50: f64,
    pub p90: f64,
    pub fair: f64,
    pub samples: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OhlcvPrint {
    /// Unix seconds.
    pub time: i64,
    /// Price in the requested denomination.
    pub price: f64,
    pub price_sats: f64,
    #[serde(default)]
    pub inscription: Option<String>,
    /// Lot size for fungible tokens, as decimal text (the API sends a string or a number).
    #[serde(default, deserialize_with = "crate::de::opt_decimal")]
    pub amount: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OhlcvInvariants {
    #[serde(default)]
    pub violations: Vec<Value>,
}

/// `GET /collection/:slug/ohlcv`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ohlcv {
    pub slug: String,
    pub interval: String,
    pub denom: String,
    pub series: String,
    pub candles: Vec<OhlcvCandle>,
    pub trend: Vec<OhlcvTrendPoint>,
    /// Sales kept in the candles.
    pub prints: Vec<OhlcvPrint>,
    /// Sales filtered out as outliers.
    pub outliers: Vec<OhlcvPrint>,
    /// BTC price used for usd/mcap.
    #[serde(default)]
    pub btc_usd: Option<f64>,
    /// Supply used for mcap.
    #[serde(default)]
    pub supply: Option<f64>,
    #[serde(default)]
    pub supply_source: Option<String>,
    #[serde(default)]
    pub invariants: Option<OhlcvInvariants>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ValuationInputs {
    #[serde(default)]
    pub best_bid_sats: Option<f64>,
    #[serde(default)]
    pub floor_sats: Option<f64>,
    #[serde(default)]
    pub tape_sats: Option<f64>,
    pub bid_depth: u64,
    pub trades_7d: u64,
    pub trades_30d: u64,
    #[serde(default)]
    pub median_7d_sats: Option<f64>,
    #[serde(default)]
    pub median_30d_sats: Option<f64>,
    #[serde(default)]
    pub last_sale_sats: Option<f64>,
    /// Unix seconds.
    #[serde(default)]
    pub last_sale_ts: Option<f64>,
}

/// Fair value, range, confidence and inputs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Valuation {
    pub slug: String,
    #[serde(default)]
    pub fair_sats: Option<f64>,
    #[serde(default)]
    pub fair_usd: Option<f64>,
    #[serde(default)]
    pub low_sats: Option<f64>,
    #[serde(default)]
    pub low_usd: Option<f64>,
    #[serde(default)]
    pub high_sats: Option<f64>,
    #[serde(default)]
    pub high_usd: Option<f64>,
    /// 0 to 1.
    pub confidence: f64,
    /// `book-and-tape`, `book-midpoint`, `discounted-floor`, `bid-only`, `tape-only` or `unpriced`.
    pub method: String,
    /// `global` (sales across marketplaces) or `ordinals_wallet` (fallback).
    pub tape_source: String,
    pub inputs: ValuationInputs,
    #[serde(default)]
    pub supply: Option<f64>,
    #[serde(default)]
    pub marketcap_sats: Option<f64>,
    #[serde(default)]
    pub marketcap_usd: Option<f64>,
}

#[derive(Deserialize)]
struct ValuationsResponse {
    #[serde(default)]
    valuations: Vec<Valuation>,
}

/// Chart and valuation endpoints. Get one with [`Client::charts`].
#[derive(Clone, Copy, Debug)]
pub struct ChartsApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Chart and valuation endpoints.
    pub fn charts(&self) -> ChartsApi<'_> {
        ChartsApi(self)
    }
}

/// Deduplicates, keeping first occurrences in order.
pub(crate) fn dedupe<S: AsRef<str>>(items: &[S]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items
        .iter()
        .map(|s| s.as_ref().to_string())
        .filter(|s| seen.insert(s.clone()))
        .collect()
}

impl ChartsApi<'_> {
    /// Candles and the fair-value band for a collection, rune or token.
    /// `GET /collection/:slug/ohlcv` (cached 60s, up to 5,000 buckets).
    pub fn ohlcv(&self, slug: &str, params: &OhlcvParams) -> Result<Ohlcv> {
        let req = Req::get(format!("/collection/{}/ohlcv", seg(slug)))
            .query_opt("interval", params.interval.map(OhlcvInterval::as_str))
            .query_opt("denom", params.denom.map(OhlcvDenom::as_str))
            .query_opt("series", params.series.map(OhlcvSeries::as_str))
            .query_opt("start", params.start)
            .query_opt("end", params.end)
            .query_opt("supply", params.supply);
        self.0.json(req)
    }

    /// Fair value, range, confidence and inputs. `GET /collection/:slug/valuation`.
    pub fn valuation(&self, slug: &str) -> Result<Valuation> {
        self.0
            .json(Req::get(format!("/collection/{}/valuation", seg(slug))))
    }

    /// Fair value for many collections: deduplicated, sent in batches of
    /// [`VALUATION_BATCH_LIMIT`] (`POST /collections/valuation`, read-only),
    /// merged in order. Unknown slugs are left out.
    pub fn valuations<S: AsRef<str>>(&self, slugs: &[S]) -> Result<Vec<Valuation>> {
        let unique = dedupe(slugs);
        let mut out = Vec::new();
        for chunk in unique.chunks(VALUATION_BATCH_LIMIT) {
            let body = serde_json::json!({ "slugs": chunk });
            let page: ValuationsResponse = self
                .0
                .json(Req::post("/collections/valuation".into(), &body)?)?;
            out.extend(page.valuations);
        }
        Ok(out)
    }
}
