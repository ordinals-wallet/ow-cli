//! Collection metadata, stats, listings, Ordinals Wallet sales and traits.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{seg, Client, Req};
use crate::error::Result;

/// Icon inscription reference attached to collections.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IconInscription {
    pub id: String,
    pub content_type: String,
}

/// `GET /collection/:slug`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CollectionMetadata {
    #[serde(default)]
    pub id: Option<String>,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub icon_inscription: Option<IconInscription>,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub verified: Option<bool>,
    #[serde(default)]
    pub total_supply: Option<u64>,
    #[serde(default)]
    pub socials: Option<HashMap<String, String>>,
    #[serde(default)]
    pub creator_address: Option<String>,
    #[serde(default)]
    pub gallery_inscription_id: Option<String>,
    #[serde(default)]
    pub highest_inscription_num: Option<i64>,
    #[serde(default)]
    pub lowest_inscription_num: Option<i64>,
    #[serde(default)]
    pub sponsored_priority: Option<i64>,
    #[serde(default)]
    pub featured_priority: Option<i64>,
    /// Fair value in sats.
    #[serde(default)]
    pub fair_sats: Option<f64>,
    /// 7-day change of fair value, in percent.
    #[serde(default)]
    pub change_week_fair: Option<f64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A listing ("escrow") or, from `/sold-escrows`, a completed Ordinals Wallet sale.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Escrow {
    pub id: String,
    /// `None` for fungible (rune) sales.
    #[serde(default)]
    pub inscription_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// `txid:vout` holding the item.
    #[serde(default)]
    pub outpoint: Option<String>,
    /// Asking / sale price in sats.
    pub satoshi_price: u64,
    #[serde(default)]
    pub seller_address: Option<String>,
    #[serde(default)]
    pub buyer_address: Option<String>,
    #[serde(default)]
    pub purchase_txid: Option<String>,
    /// ISO timestamp (UTC). `None` or `""` when unsold.
    #[serde(default)]
    pub bought_at: Option<String>,
    /// ISO timestamp (UTC).
    #[serde(default)]
    pub created: Option<String>,
    #[serde(default)]
    pub creator_address: Option<String>,
    /// Unit price for fungible assets, decimal string; `""` for single inscriptions.
    #[serde(default)]
    pub price_per: Option<String>,
    /// Quantity for fungible assets, decimal string; `""` for single inscriptions.
    #[serde(default)]
    pub amount: Option<String>,
    /// Listed / settled with snipe protection.
    #[serde(default)]
    pub protected: Option<bool>,
    /// Purchases are relayed privately to miners (BRC-20, TAP).
    #[serde(default)]
    pub private_relay: Option<bool>,
    /// `2` for protected listings.
    #[serde(default)]
    pub secure_purchase_version: Option<u32>,
    /// e.g. `listed`, `broadcast`, `settled`.
    #[serde(default)]
    pub secure_purchase_state: Option<String>,
    /// Venue id for rune sales from other marketplaces.
    #[serde(default)]
    pub marketplace: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `GET /collection/:slug/stats`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CollectionStats {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub total_supply: Option<u64>,
    #[serde(default)]
    pub floor_price: Option<u64>,
    #[serde(default)]
    pub floor_price_per: Option<f64>,
    #[serde(default)]
    pub volume_total: Option<u64>,
    #[serde(default)]
    pub volume_day: Option<u64>,
    #[serde(default)]
    pub listed: Option<u64>,
    #[serde(default)]
    pub listed_count: Option<u64>,
    #[serde(default)]
    pub sales: Option<u64>,
    #[serde(default)]
    pub owners: Option<u64>,
    #[serde(default)]
    pub total_volume: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One trait type and its values, from `GET /collection/:slug/attributes`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AttributeGroup {
    pub trait_type: String,
    pub values: Vec<AttributeValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AttributeValue {
    pub trait_type: String,
    pub value: String,
    /// Items with this value.
    pub count: u64,
}

/// Paging for [`CollectionApi::sold_escrows`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SoldEscrowsParams {
    /// Results per page, max 100. Default 20.
    pub limit: u32,
    pub offset: Option<u32>,
}

impl Default for SoldEscrowsParams {
    fn default() -> Self {
        SoldEscrowsParams {
            limit: 20,
            offset: None,
        }
    }
}

/// `/collection/:slug` endpoints. Get one with [`Client::collection`].
#[derive(Clone, Copy, Debug)]
pub struct CollectionApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Collection endpoints.
    pub fn collection(&self) -> CollectionApi<'_> {
        CollectionApi(self)
    }
}

impl CollectionApi<'_> {
    /// `GET /collection/:slug`.
    pub fn metadata(&self, slug: &str) -> Result<CollectionMetadata> {
        self.0.json(Req::get(format!("/collection/{}", seg(slug))))
    }

    /// `GET /collection/:slug/stats`.
    pub fn stats(&self, slug: &str) -> Result<CollectionStats> {
        self.0
            .json(Req::get(format!("/collection/{}/stats", seg(slug))))
    }

    /// Active listings. `GET /collection/:slug/escrows`.
    pub fn escrows(&self, slug: &str) -> Result<Vec<Escrow>> {
        self.0
            .json(Req::get(format!("/collection/{}/escrows", seg(slug))))
    }

    /// Ordinals Wallet sales, most recent first. `GET /collection/:slug/sold-escrows`.
    pub fn sold_escrows(&self, slug: &str, params: SoldEscrowsParams) -> Result<Vec<Escrow>> {
        let req = Req::get(format!("/collection/{}/sold-escrows", seg(slug)))
            .query("limit", params.limit)
            .query_opt("offset", params.offset);
        self.0.json(req)
    }

    /// Every trait type with each value and its count. `GET /collection/:slug/attributes`.
    pub fn attributes(&self, slug: &str) -> Result<Vec<AttributeGroup>> {
        self.0
            .json(Req::get(format!("/collection/{}/attributes", seg(slug))))
    }
}
