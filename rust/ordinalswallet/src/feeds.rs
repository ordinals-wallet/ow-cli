//! The unified sales tape (OW sales, other marketplaces and the mempool):
//! pages, an in-memory [`FeedStore`] and live streams.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{seg, Client, Req};
use crate::error::{Error, Result};
use crate::retry::RetryMode;
use crate::stream::{subscribe, CloseHandle, StreamEvent, SubscribeOptions, Subscription};

/// Feed and quote GETs retry `503 Retry-After` while a feed rebuilds.
pub(crate) const FEED_RETRIES: RetryMode = RetryMode::Times(3);

/// Default number of rows a [`FeedStore`] keeps.
pub const DEFAULT_MAX_ROWS: usize = 200;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeedSale {
    /// `ask_fill`, `bid_fill`, …
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_name: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeedCollection {
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeedEscrow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub satoshi_price: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bought_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purchase_txid: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AlkaneTrade {
    /// `buy` or `sell`.
    pub side: String,
    pub asset_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_name: Option<String>,
    /// Decimal text (the API sends a string or a number).
    #[serde(deserialize_with = "crate::de::opt_decimal")]
    pub amount: Option<String>,
    pub txid: String,
    #[serde(default)]
    pub swapper: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A row of the unified sales tape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeedRow {
    /// Stable row ID; use it to deduplicate.
    pub key: String,
    /// `pending` or `confirmed`.
    #[serde(default)]
    pub status: String,
    /// `ow` (Ordinals Wallet), `global` (another marketplace) or `mempool`.
    #[serde(default)]
    pub source: String,
    /// Venue ID. See [`crate::MARKETPLACES`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_sats: Option<u64>,
    /// Milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts: Option<i64>,
    /// When the row was first seen, milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub txid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_height: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inscription_id: Option<String>,
    /// Lot size for fungible tokens, as decimal text (the API sends a string or a number).
    #[serde(
        default,
        deserialize_with = "crate::de::opt_decimal",
        skip_serializing_if = "Option::is_none"
    )]
    pub amount: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seller_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buyer_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inscriptions_in_tx: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sighash: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signals: Option<u32>,
    /// Pending rows only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sale: Option<FeedSale>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<FeedCollection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escrow: Option<FeedEscrow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alkane_trade: Option<AlkaneTrade>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl FeedRow {
    pub fn is_pending(&self) -> bool {
        self.status == "pending"
    }
}

/// A page of the tape, or a stream `snapshot`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FeedPage {
    /// Collection slug, or `@home` for the market-wide feed.
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub version: Option<i64>,
    #[serde(default)]
    pub tip: Option<i64>,
    #[serde(default)]
    pub built_at: Option<i64>,
    #[serde(default)]
    pub rows: Vec<FeedRow>,
    /// Cursor for the next (older) page.
    #[serde(default)]
    pub next: Option<String>,
}

/// A removed row: its key, or the row itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RemovedKey {
    Key(String),
    Row { key: String },
}

impl RemovedKey {
    pub fn key(&self) -> &str {
        match self {
            RemovedKey::Key(k) | RemovedKey::Row { key: k } => k,
        }
    }
}

/// `delta` event on a feed stream. `updated` rows may be partial and are
/// merged field by field over the existing row.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FeedDelta {
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub prev: Option<i64>,
    #[serde(default)]
    pub version: Option<i64>,
    #[serde(default)]
    pub tip: Option<i64>,
    #[serde(default)]
    pub added: Vec<FeedRow>,
    #[serde(default)]
    pub updated: Vec<Map<String, Value>>,
    #[serde(default)]
    pub removed: Vec<RemovedKey>,
}

/// Paging for feed pages.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedPageParams {
    /// Default 100, max 200.
    pub limit: Option<u32>,
    /// `next` from the previous page.
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MempoolInfo {
    pub spending_txid: String,
    pub sighash: String,
    /// Unix seconds.
    pub seen_at: i64,
    pub outpoint: String,
}

/// A pending sale in the mempool (`GET /mempool/sales`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MempoolSale {
    pub id: String,
    #[serde(default)]
    pub num: Option<i64>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub meta: Option<Value>,
    #[serde(default)]
    pub collection: Option<FeedCollection>,
    #[serde(default)]
    pub escrow: Option<Map<String, Value>>,
    /// Decimal text (the API sends a string or a number).
    #[serde(default, deserialize_with = "crate::de::opt_decimal")]
    pub amount: Option<String>,
    #[serde(default)]
    pub rune_id: Option<String>,
    pub mempool: MempoolInfo,
    #[serde(default)]
    pub marketplace: Option<i64>,
    #[serde(default)]
    pub sale: Option<FeedSale>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecentListingEscrow {
    pub satoshi_price: u64,
    pub seller_address: String,
    #[serde(default)]
    pub buyer_address: Option<String>,
    #[serde(default)]
    pub protected: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A new Ordinals Wallet listing (`GET /inscriptions/recent-listings`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecentListing {
    pub id: String,
    #[serde(default)]
    pub num: Option<i64>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub meta: Option<Value>,
    #[serde(default)]
    pub collection: Option<Map<String, Value>>,
    pub escrow: RecentListingEscrow,
    pub marketplace: i64,
    /// Decimal text (the API sends a string or a number).
    #[serde(default, deserialize_with = "crate::de::opt_decimal")]
    pub amount: Option<String>,
    #[serde(default)]
    pub rune_id: Option<String>,
    pub listed_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Feed ordering: pending first, then newest `ts` (missing = 0), then key.
pub fn compare_feed_rows(a: &FeedRow, b: &FeedRow) -> Ordering {
    b.is_pending()
        .cmp(&a.is_pending())
        .then_with(|| b.ts.unwrap_or(0).cmp(&a.ts.unwrap_or(0)))
        .then_with(|| a.key.cmp(&b.key))
}

/// In-memory feed state keyed by row `key`, sorted with [`compare_feed_rows`].
/// Keeps at most `max_rows` rows (0 = unlimited), dropping the tail.
#[derive(Clone, Debug)]
pub struct FeedStore {
    max_rows: usize,
    map: HashMap<String, FeedRow>,
    sorted: Vec<FeedRow>,
    version: Option<i64>,
    tip: Option<i64>,
}

impl Default for FeedStore {
    fn default() -> Self {
        FeedStore::new(DEFAULT_MAX_ROWS)
    }
}

impl FeedStore {
    /// A store that keeps at most `max_rows` rows; 0 keeps everything.
    pub fn new(max_rows: usize) -> Self {
        FeedStore {
            max_rows,
            map: HashMap::new(),
            sorted: Vec::new(),
            version: None,
            tip: None,
        }
    }

    /// Replaces all rows with a snapshot page.
    pub fn apply_snapshot(&mut self, page: FeedPage) -> &[FeedRow] {
        self.map.clear();
        for r in page.rows {
            self.map.insert(r.key.clone(), r);
        }
        self.version = page.version;
        self.tip = page.tip;
        self.rebuild()
    }

    /// Applies `removed`, then `added`, then `updated` (merged over existing rows).
    pub fn apply_delta(&mut self, delta: FeedDelta) -> Result<&[FeedRow]> {
        for k in &delta.removed {
            self.map.remove(k.key());
        }
        for r in delta.added {
            self.map.insert(r.key.clone(), r);
        }
        for patch in delta.updated {
            let key = match patch.get("key") {
                Some(Value::String(k)) => k.clone(),
                _ => {
                    return Err(Error::InvalidInput(
                        "feed delta row without a string key".into(),
                    ))
                }
            };
            let mut merged = match self.map.get(&key) {
                Some(old) => match serde_json::to_value(old) {
                    Ok(Value::Object(m)) => m,
                    _ => Map::new(),
                },
                None => Map::new(),
            };
            merged.extend(patch);
            let row: FeedRow =
                serde_json::from_value(Value::Object(merged)).map_err(|source| Error::Decode {
                    method: "SSE".into(),
                    path: "delta.updated".into(),
                    source,
                })?;
            self.map.insert(key, row);
        }
        if delta.version.is_some() {
            self.version = delta.version;
        }
        if delta.tip.is_some() {
            self.tip = delta.tip;
        }
        Ok(self.rebuild())
    }

    fn rebuild(&mut self) -> &[FeedRow] {
        let mut rows: Vec<FeedRow> = self.map.values().cloned().collect();
        rows.sort_by(compare_feed_rows);
        if self.max_rows > 0 && rows.len() > self.max_rows {
            for r in rows.drain(self.max_rows..) {
                self.map.remove(&r.key);
            }
        }
        self.sorted = rows;
        &self.sorted
    }

    /// Current rows, sorted.
    pub fn rows(&self) -> &[FeedRow] {
        &self.sorted
    }

    pub fn version(&self) -> Option<i64> {
        self.version
    }

    pub fn tip(&self) -> Option<i64> {
        self.tip
    }
}

/// Whether a [`FeedUpdate`] came from a `snapshot` or a `delta`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedUpdateKind {
    Snapshot,
    Delta,
}

/// The feed's rows after a snapshot or delta.
#[derive(Clone, Debug, PartialEq)]
pub struct FeedUpdate {
    pub kind: FeedUpdateKind,
    /// Current rows: pending first, then newest.
    pub rows: Vec<FeedRow>,
    pub version: Option<i64>,
    pub tip: Option<i64>,
}

/// What a [`FeedStream`] yields.
#[derive(Debug)]
pub enum FeedStreamEvent {
    /// Connection (re)established; a fresh snapshot follows.
    Open,
    Rows(FeedUpdate),
    /// When `fatal` the iterator ends after this item; otherwise it reconnects.
    Error {
        error: Error,
        fatal: bool,
    },
}

/// A live feed: an SSE subscription folded through a [`FeedStore`].
#[derive(Debug)]
pub struct FeedStream {
    sub: Subscription,
    store: FeedStore,
}

impl FeedStream {
    pub fn close_handle(&self) -> CloseHandle {
        self.sub.close_handle()
    }

    pub fn close(&mut self) {
        self.sub.close();
    }

    /// The underlying store (current rows, version, tip).
    pub fn store(&self) -> &FeedStore {
        &self.store
    }
}

impl Iterator for FeedStream {
    type Item = FeedStreamEvent;

    fn next(&mut self) -> Option<FeedStreamEvent> {
        loop {
            let ev = match self.sub.next()? {
                StreamEvent::Open => return Some(FeedStreamEvent::Open),
                StreamEvent::Error { error, fatal } => {
                    return Some(FeedStreamEvent::Error { error, fatal })
                }
                StreamEvent::Event(ev) => ev,
            };
            let decode_err = |source| Error::Decode {
                method: "SSE".into(),
                path: ev.event.clone(),
                source,
            };
            let kind = match ev.event.as_str() {
                "snapshot" => match serde_json::from_str::<FeedPage>(&ev.data) {
                    Ok(page) => {
                        self.store.apply_snapshot(page);
                        FeedUpdateKind::Snapshot
                    }
                    Err(e) => {
                        return Some(FeedStreamEvent::Error {
                            error: decode_err(e),
                            fatal: false,
                        })
                    }
                },
                "delta" => match serde_json::from_str::<FeedDelta>(&ev.data) {
                    Ok(delta) => match self.store.apply_delta(delta) {
                        Ok(_) => FeedUpdateKind::Delta,
                        Err(error) => {
                            return Some(FeedStreamEvent::Error {
                                error,
                                fatal: false,
                            })
                        }
                    },
                    Err(e) => {
                        return Some(FeedStreamEvent::Error {
                            error: decode_err(e),
                            fatal: false,
                        })
                    }
                },
                _ => continue,
            };
            return Some(FeedStreamEvent::Rows(FeedUpdate {
                kind,
                rows: self.store.rows().to_vec(),
                version: self.store.version(),
                tip: self.store.tip(),
            }));
        }
    }
}

/// Feed endpoints. Get one with [`Client::feeds`].
#[derive(Clone, Copy, Debug)]
pub struct FeedsApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Sales tape pages and streams.
    pub fn feeds(&self) -> FeedsApi<'_> {
        FeedsApi(self)
    }
}

fn page_req(path: String, p: &FeedPageParams) -> Req<'static> {
    Req::get(path)
        .query_opt("limit", p.limit)
        .query_opt("cursor", p.cursor.clone())
        .retry(FEED_RETRIES)
}

impl FeedsApi<'_> {
    /// One page of a collection's tape (pending first, then newest). `GET /collection/:slug/feed`.
    pub fn collection_feed(&self, slug: &str, params: &FeedPageParams) -> Result<FeedPage> {
        self.0
            .json(page_req(format!("/collection/{}/feed", seg(slug)), params))
    }

    /// One page of the market-wide tape. `GET /inscriptions/activity/feed`.
    pub fn activity_feed(&self, params: &FeedPageParams) -> Result<FeedPage> {
        self.0
            .json(page_req("/inscriptions/activity/feed".into(), params))
    }

    /// Every pending sale in the mempool (recomputed every 2s). `GET /mempool/sales`.
    pub fn mempool_sales(&self) -> Result<Vec<MempoolSale>> {
        self.0
            .json(Req::get("/mempool/sales".into()).retry(FEED_RETRIES))
    }

    /// Newest Ordinals Wallet listings site-wide (`limit` 25, 50 or 100).
    /// `GET /inscriptions/recent-listings`.
    pub fn recent_listings(&self, limit: u32) -> Result<Vec<RecentListing>> {
        self.0.json(
            Req::get("/inscriptions/recent-listings".into())
                .query("limit", limit)
                .retry(FEED_RETRIES),
        )
    }

    fn stream(&self, path: String, max_rows: usize, opts: SubscribeOptions) -> FeedStream {
        FeedStream {
            sub: subscribe(self.0, self.0.url(&path, &[]), opts),
            store: FeedStore::new(max_rows),
        }
    }

    /// Live tape for one collection (`GET /collection/:slug/feed/stream`):
    /// yields the current rows after each snapshot and delta.
    ///
    /// ```no_run
    /// use ordinalswallet::feeds::FeedStreamEvent;
    /// let client = ordinalswallet::Client::new();
    /// for ev in client.feeds().stream_collection_feed("bitcoin-puppets", 200, Default::default()) {
    ///     if let FeedStreamEvent::Rows(update) = ev {
    ///         println!("{} rows, newest {:?}", update.rows.len(), update.rows.first().map(|r| &r.key));
    ///     }
    /// }
    /// ```
    pub fn stream_collection_feed(
        &self,
        slug: &str,
        max_rows: usize,
        opts: SubscribeOptions,
    ) -> FeedStream {
        self.stream(
            format!("/collection/{}/feed/stream", seg(slug)),
            max_rows,
            opts,
        )
    }

    /// Live market-wide tape. `GET /inscriptions/activity/feed/stream`.
    pub fn stream_activity_feed(&self, max_rows: usize, opts: SubscribeOptions) -> FeedStream {
        self.stream("/inscriptions/activity/feed/stream".into(), max_rows, opts)
    }
}
