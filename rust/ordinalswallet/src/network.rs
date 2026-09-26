//! Health, block height and fee rates.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{Client, Req};
use crate::error::{Error, Result};

/// `GET /`. When `indexer_height` trails `chain_height`, the newest block is
/// not yet reflected in ownership and listings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    pub indexer_height: u64,
    pub chain_height: u64,
}

/// Fee rates in sat/vB (`GET /wallet/fee-estimates`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeEstimates {
    pub fastest_fee: f64,
    pub half_hour_fee: f64,
    pub hour_fee: f64,
    pub economy_fee: f64,
    pub minimum_fee: f64,
    /// Per-block-target rates (`"1"`, `"2"`, …) when present.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Network endpoints. Get one with [`Client::network`].
#[derive(Clone, Copy, Debug)]
pub struct NetworkApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Health, block height and fee endpoints.
    pub fn network(&self) -> NetworkApi<'_> {
        NetworkApi(self)
    }
}

impl NetworkApi<'_> {
    /// Indexer and chain heights. `GET /`.
    pub fn health(&self) -> Result<Health> {
        self.0.json(Req::get("/".into()))
    }

    /// Current block height. `GET /blockheight` (plain text).
    pub fn blockheight(&self) -> Result<u64> {
        let text = self.0.text(Req::get("/blockheight".into()))?;
        text.trim().parse().map_err(|_| {
            Error::Unavailable(format!("unexpected /blockheight body: {:?}", text.trim()))
        })
    }

    /// `GET /wallet/fee-estimates`.
    pub fn fee_estimates(&self) -> Result<FeeEstimates> {
        self.0.json(Req::get("/wallet/fee-estimates".into()))
    }
}
