//! The global sales tape: every on-chain sale across marketplaces.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::client::{seg, Client, Req};
use crate::error::Result;

/// Global sales tape venue IDs.
pub const MARKETPLACES: &[(i64, &str)] = &[
    (0, "Unknown"),
    (1, "Ordinals Wallet"),
    (2, "Satflow"),
    (3, "Magic Eden"),
    (4, "OrdSwap"),
    (5, "Gamma"),
    (6, "OrdinalsMarket"),
    (7, "OpenOrdex"),
    (8, "OKX"),
    (9, "UniSat"),
    (10, "ord.net"),
    (11, "Ord Dropz"),
    (12, "DotSwap"),
];

/// Venue name for a marketplace ID (`Unknown` for unmapped IDs).
///
/// ```
/// assert_eq!(ordinalswallet::marketplace_name(Some(2)), "Satflow");
/// assert_eq!(ordinalswallet::marketplace_name(Some(99)), "Unknown");
/// assert_eq!(ordinalswallet::marketplace_name(None), "Unknown");
/// ```
pub fn marketplace_name(id: Option<i64>) -> &'static str {
    id.and_then(|id| MARKETPLACES.iter().find(|(k, _)| *k == id))
        .map_or(MARKETPLACES[0].1, |(_, name)| name)
}

/// A sale detected on-chain.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GlobalSale {
    pub block_height: u64,
    /// Unix seconds.
    pub block_timestamp: i64,
    pub txid: String,
    pub inscription_id: String,
    #[serde(default)]
    pub sequence_number: Option<i64>,
    /// Items in the same transaction. A sweep of 5 items is 5 rows.
    #[serde(default)]
    pub inscriptions_in_tx: Option<u32>,
    /// Venue ID. See [`MARKETPLACES`].
    pub marketplace: i64,
    /// Seller's signature type (129 = ALL|ANYONECANPAY).
    pub sighash: u32,
    #[serde(default)]
    pub signals: Option<u32>,
    pub seller_address: String,
    pub buyer_address: String,
    /// What the buyer paid for the lot.
    pub price_sats: u64,
    pub old_satpoint: String,
    pub new_satpoint: String,
}

/// `GET /collection/:slug/sales`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SalesPage {
    pub sales: Vec<GlobalSale>,
    pub has_more: bool,
    #[serde(default)]
    pub matched_inscriptions: Option<u64>,
}

/// A sale a wallet bought or sold.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WalletSale {
    #[serde(flatten)]
    pub sale: GlobalSale,
    /// `buyer` or `seller`.
    pub role: String,
}

/// `GET /wallet/:address/global-sales`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WalletSalesPage {
    pub address: String,
    pub sales: Vec<WalletSale>,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VolumeTotals {
    /// Transactions.
    pub count: u64,
    pub volume_sats: u64,
    #[serde(default)]
    pub count_with_price: Option<u64>,
    /// Items.
    pub count_items: u64,
    pub item_volume_sats: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VolumeBucket {
    /// `YYYY-MM-DD` (UTC).
    pub date: String,
    pub block_height_first: u64,
    pub block_height_last: u64,
    /// Keyed by marketplace ID (as a string).
    pub by_marketplace: BTreeMap<String, VolumeTotals>,
    pub total: VolumeTotals,
}

/// `GET /collection/:slug/sales-volume`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SalesVolume {
    pub from_height: u64,
    pub to_height: u64,
    pub buckets: Vec<VolumeBucket>,
}

/// Paging for sales endpoints.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SalesParams {
    /// Page size, default 100, max 1,000.
    pub limit: Option<u32>,
    /// Cursor (exclusive): the last `block_height` of the previous page.
    pub before_height: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SalesVolumeParams {
    pub from_height: Option<u64>,
    pub to_height: Option<u64>,
}

/// Sales tape endpoints. Get one with [`Client::sales`].
#[derive(Clone, Copy, Debug)]
pub struct SalesApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Global sales tape endpoints.
    pub fn sales(&self) -> SalesApi<'_> {
        SalesApi(self)
    }
}

fn page_req(path: String, p: SalesParams) -> Req<'static> {
    Req::get(path)
        .query_opt("limit", p.limit)
        .query_opt("before_height", p.before_height)
}

impl<'a> SalesApi<'a> {
    /// Every on-chain sale of a collection, newest first. `GET /collection/:slug/sales`.
    pub fn sales(&self, slug: &str, params: SalesParams) -> Result<SalesPage> {
        self.0
            .json(page_req(format!("/collection/{}/sales", seg(slug)), params))
    }

    /// Daily volume by marketplace. `GET /collection/:slug/sales-volume`.
    pub fn sales_volume(&self, slug: &str, params: SalesVolumeParams) -> Result<SalesVolume> {
        let req = Req::get(format!("/collection/{}/sales-volume", seg(slug)))
            .query_opt("from_height", params.from_height)
            .query_opt("to_height", params.to_height);
        self.0.json(req)
    }

    /// Sales a wallet bought or sold, across marketplaces. `GET /wallet/:address/global-sales`.
    pub fn wallet_sales(&self, address: &str, params: SalesParams) -> Result<WalletSalesPage> {
        self.0.json(page_req(
            format!("/wallet/{}/global-sales", seg(address)),
            params,
        ))
    }

    /// Every sale of a collection, newest first, paging with `before_height`
    /// until `has_more` is false. Pages are fetched lazily.
    pub fn iter_sales(&self, slug: &str, params: SalesParams) -> SalesIter<'a, GlobalSale> {
        let client = self.0;
        let slug = slug.to_string();
        SalesIter::new(
            params,
            Box::new(move |p| {
                let page = SalesApi(client).sales(&slug, p)?;
                Ok((page.sales, page.has_more))
            }),
            |s| s.block_height,
        )
    }

    /// Every sale a wallet was part of, newest first.
    pub fn iter_wallet_sales(
        &self,
        address: &str,
        params: SalesParams,
    ) -> SalesIter<'a, WalletSale> {
        let client = self.0;
        let address = address.to_string();
        SalesIter::new(
            params,
            Box::new(move |p| {
                let page = SalesApi(client).wallet_sales(&address, p)?;
                Ok((page.sales, page.has_more))
            }),
            |s| s.sale.block_height,
        )
    }
}

type FetchPage<'a, T> = Box<dyn FnMut(SalesParams) -> Result<(Vec<T>, bool)> + 'a>;

/// Lazily pages through a sales endpoint. Yields `Err` once and stops if a page fails.
pub struct SalesIter<'a, T> {
    fetch: FetchPage<'a, T>,
    height: fn(&T) -> u64,
    limit: Option<u32>,
    before: Option<u64>,
    buf: VecDeque<T>,
    done: bool,
}

impl<T> std::fmt::Debug for SalesIter<'_, T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SalesIter")
            .field("before_height", &self.before)
            .field("buffered", &self.buf.len())
            .field("done", &self.done)
            .finish()
    }
}

impl<'a, T> SalesIter<'a, T> {
    fn new(params: SalesParams, fetch: FetchPage<'a, T>, height: fn(&T) -> u64) -> Self {
        SalesIter {
            fetch,
            height,
            limit: params.limit,
            before: params.before_height,
            buf: VecDeque::new(),
            done: false,
        }
    }
}

impl<T> Iterator for SalesIter<'_, T> {
    type Item = Result<T>;

    fn next(&mut self) -> Option<Result<T>> {
        loop {
            if let Some(s) = self.buf.pop_front() {
                return Some(Ok(s));
            }
            if self.done {
                return None;
            }
            let params = SalesParams {
                limit: self.limit,
                before_height: self.before,
            };
            match (self.fetch)(params) {
                Err(e) => {
                    self.done = true;
                    return Some(Err(e));
                }
                Ok((sales, has_more)) => {
                    let last = sales.last().map(self.height);
                    self.buf.extend(sales);
                    match last {
                        // Stop on the last page, or if the cursor fails to move backwards.
                        Some(last) if has_more && self.before.map_or(true, |b| last < b) => {
                            self.before = Some(last)
                        }
                        _ => self.done = true,
                    }
                }
            }
        }
    }
}
