//! Listing lookups and the passthrough v4 (snipe-protected) read endpoints.
//! Building, signing and submitting purchases and listings comes in stage 2.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{seg, Client, Req};
use crate::error::{Error, Result};

/// `GET /market/escrow/:inscription_id`: the live listing, with its protection markers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MarketListing {
    pub inscription_id: String,
    /// `txid:vout` or the 36-byte wire form in hex, depending on the endpoint.
    pub outpoint: String,
    pub seller_address: String,
    #[serde(default)]
    pub buyer_address: Option<String>,
    /// What the buyer pays, marketplace fee included.
    pub satoshi_price: u64,
    #[serde(default)]
    pub escrow_price: Option<u64>,
    #[serde(default)]
    pub market_royalty: Option<f64>,
    #[serde(default)]
    pub creator_royalty: Option<f64>,
    #[serde(default)]
    pub creator_address: Option<String>,
    #[serde(default)]
    pub secure_purchase_version: Option<u32>,
    #[serde(default)]
    pub secure_purchase_state: Option<String>,
    #[serde(default)]
    pub protected: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// What protection the marketplace offers right now, and its co-signer key.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SecurePurchaseCapabilities {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub customer_enabled: Option<bool>,
    #[serde(default)]
    pub listing_enabled: Option<bool>,
    #[serde(default)]
    pub build_enabled: Option<bool>,
    #[serde(default)]
    pub submit_enabled: Option<bool>,
    #[serde(default)]
    pub escrow_policy: Option<String>,
    #[serde(default)]
    pub policy: Option<String>,
    #[serde(default)]
    pub cosigner_public_key: Option<String>,
    #[serde(default)]
    pub max_items_per_purchase: Option<u32>,
    /// Smallest postage a protected listing accepts (330).
    #[serde(default)]
    pub min_postage_sats: Option<u64>,
    #[serde(default)]
    pub settlement: Option<String>,
    #[serde(default)]
    pub protocols: Option<Vec<String>>,
    #[serde(default)]
    pub protocol_status: Option<BTreeMap<String, String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `GET /market/secure-listing/:outpoint`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecureListingStatus {
    pub version: u32,
    pub state: String,
    pub outpoint: String,
    /// `ordinal`, `rune`, `alkane`, `tap` or `brc20`.
    pub protocol: String,
    pub policy: String,
    #[serde(default)]
    pub template_digest: Option<String>,
}

fn is_error_body(v: &Value) -> bool {
    match v.get("error") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Market endpoints. Get one with [`Client::market`].
#[derive(Clone, Copy, Debug)]
pub struct MarketApi<'a>(pub(crate) &'a Client);

/// Passthrough v4 purchase reads. Get one with [`Client::secure_purchase`].
#[derive(Clone, Copy, Debug)]
pub struct SecurePurchaseApi<'a>(pub(crate) &'a Client);

/// Passthrough v4 listing reads. Get one with [`Client::secure_listing`].
#[derive(Clone, Copy, Debug)]
pub struct SecureListingApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Listing lookups.
    pub fn market(&self) -> MarketApi<'_> {
        MarketApi(self)
    }

    /// Protected purchase endpoints.
    pub fn secure_purchase(&self) -> SecurePurchaseApi<'_> {
        SecurePurchaseApi(self)
    }

    /// Protected listing endpoints.
    pub fn secure_listing(&self) -> SecureListingApi<'_> {
        SecureListingApi(self)
    }
}

impl MarketApi<'_> {
    /// The live listing for an inscription, or `None` when it is not for sale.
    pub fn listing(&self, inscription_id: &str) -> Result<Option<MarketListing>> {
        let raw = self
            .0
            .send(Req::get(format!("/market/escrow/{}", seg(inscription_id))).accept(&[404]))?;
        if raw.status == 404 {
            return Ok(None);
        }
        let value: Value = crate::client::decode(&raw)?;
        if value.is_null() || is_error_body(&value) {
            return Ok(None);
        }
        serde_json::from_value(value)
            .map(Some)
            .map_err(|source| Error::Decode {
                method: raw.method.into(),
                path: raw.path,
                source,
            })
    }
}

impl SecurePurchaseApi<'_> {
    /// `GET /market/secure-purchase/capabilities`. Fails with
    /// [`Error::Unavailable`] when the API reports none.
    pub fn capabilities(&self) -> Result<SecurePurchaseCapabilities> {
        let value: Value = self
            .0
            .json(Req::get("/market/secure-purchase/capabilities".into()))?;
        match value.get("secure_purchase") {
            Some(sp) if sp.is_object() && !is_error_body(&value) => {
                serde_json::from_value(sp.clone()).map_err(|source| Error::Decode {
                    method: "GET".into(),
                    path: "/market/secure-purchase/capabilities".into(),
                    source,
                })
            }
            _ => Err(Error::Unavailable(
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Protected purchase capabilities unavailable")
                    .to_string(),
            )),
        }
    }
}

impl SecureListingApi<'_> {
    /// The protected listing at this outpoint, or `None`.
    pub fn status(&self, outpoint: &str) -> Result<Option<SecureListingStatus>> {
        let raw = self.0.send(
            Req::get(format!("/market/secure-listing/{}", seg(outpoint)))
                .accept(&[404])
                .no_store(),
        )?;
        if raw.status == 404 {
            return Ok(None);
        }
        let value: Value = crate::client::decode(&raw)?;
        if value.is_null() || is_error_body(&value) {
            return Ok(None);
        }
        match value.get("secure_listing") {
            Some(Value::Null) | None => Ok(None),
            Some(v) => serde_json::from_value(v.clone())
                .map(Some)
                .map_err(|source| Error::Decode {
                    method: raw.method.into(),
                    path: raw.path,
                    source,
                }),
        }
    }
}
