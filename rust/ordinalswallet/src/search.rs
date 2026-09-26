//! Collection search and identifier resolution.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{seg, Client, Req};
use crate::error::Result;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SearchCollection {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub total_supply: Option<u64>,
    #[serde(default)]
    pub verified: Option<bool>,
    #[serde(default)]
    pub floor_price: Option<u64>,
    #[serde(default)]
    pub floor_price_per: Option<f64>,
    #[serde(default)]
    pub listed: Option<u64>,
    #[serde(default)]
    pub volume_week: Option<u64>,
    #[serde(default)]
    pub global_volume_day: Option<u64>,
    #[serde(default)]
    pub fair_sats: Option<f64>,
    #[serde(default)]
    pub change_week_fair: Option<f64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `GET /v2/search/:query`. Free text returns `collections`; an inscription
/// id/number, txid, address or rune id returns `url` (an ordinalswallet.com path).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SearchResult {
    #[serde(default)]
    pub collections: Option<Vec<SearchCollection>>,
    #[serde(default)]
    pub url: Option<String>,
}

impl Client {
    /// Search collections, or resolve an identifier to a site path. No match
    /// (the API's 404) returns empty `collections`. `limit` defaults to 16.
    pub fn search(&self, input: &str, limit: Option<u32>) -> Result<SearchResult> {
        let req = Req::get(format!("/v2/search/{}", seg(input)))
            .query("limit", limit.unwrap_or(16))
            .accept(&[404]);
        let raw = self.send(req)?;
        if raw.status == 404 {
            return Ok(SearchResult {
                collections: Some(Vec::new()),
                url: None,
            });
        }
        crate::client::decode(&raw)
    }
}
