//! Listing lookups, cancel-escrow, and the passthrough v4 (snipe-protected)
//! listing and purchase endpoints.
//!
//! The write endpoints return templates to verify and sign locally
//! (`ordinalswallet::signing::listing` / `::passthrough` with the `signing`
//! feature) or store signatures; none is retried. Only
//! `secure_purchase().submit` and `market().cancel_escrow` change state
//! beyond a stored authorization: submit hands signed sales to the
//! marketplace, which co-signs and broadcasts them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{api_error, seg, Client, Req};
use crate::error::{Error, Result};
use crate::retry::RetryMode;

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

/// `POST /market/cancel-escrow`: exactly one of `outpoint` (`txid:vout`,
/// protected and outpoint-keyed listings) or `inscription_id` (standard
/// listings). `signature` is an `/auth/session` token for the address that
/// holds the listed item (the legacy proof PSBT is accepted for one release).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelEscrowRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inscription_id: Option<String>,
    pub signature: String,
}

/// The cancelled row, for protected listings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CancelledListing {
    pub escrow_id: String,
    /// True when the row was a snipe-protected (passthrough v4) listing.
    #[serde(default)]
    pub secure_v2: bool,
    #[serde(default)]
    pub previous_state: Option<String>,
    pub state: String,
}

/// `POST /market/cancel-escrow` success body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CancelEscrowResponse {
    pub success: bool,
    /// `cancelled` or `already_cancelled` (protected listings).
    #[serde(default)]
    pub transition: Option<String>,
    #[serde(default)]
    pub listing: Option<CancelledListing>,
}

/// One item of `POST /market/secure-listing/build-bulk`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecureListingBuildItem {
    pub outpoint: String,
    pub escrow_price_sats: u64,
}

/// `POST /market/secure-listing/build-bulk`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecureListingBuildBulkRequest {
    /// `ordinal`, `rune`, `alkane`, `tap` or `brc20`.
    pub protocol: String,
    /// Where the sale pays the seller.
    pub seller_address: String,
    /// Compressed (33-byte) hex public key of the wallet holding the items.
    pub seller_public_key: String,
    pub items: Vec<SecureListingBuildItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}

/// A row of a bulk listing response: either built templates / an authorized
/// listing, or a per-item refusal (`error: true` with `code`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SecureListingRow {
    pub outpoint: String,
    #[serde(default)]
    pub error: Option<bool>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub policy: Option<String>,
    #[serde(default)]
    pub template_digest: Option<String>,
    /// Passthrough PSBT: the item into the seller's escrow.
    #[serde(default)]
    pub psbt: Option<String>,
    /// Sale template PSBT: the escrow paying the seller.
    #[serde(default)]
    pub sale_psbt: Option<String>,
    #[serde(default)]
    pub passthrough_txid: Option<String>,
    #[serde(default)]
    pub escrow_value: Option<u64>,
    #[serde(default)]
    pub escrow_price_sats: Option<u64>,
    #[serde(default)]
    pub escrow_script: Option<String>,
    #[serde(default)]
    pub cosigner_public_key: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl SecureListingRow {
    /// True for a per-item refusal.
    pub fn is_error(&self) -> bool {
        self.error == Some(true)
    }
}

/// `POST /market/secure-listing/build-bulk` and `/authorize-bulk`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SecureListingBulkResponse {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub policy: Option<String>,
    #[serde(default)]
    pub items: Vec<SecureListingRow>,
}

/// One item of `POST /market/secure-listing/authorize-bulk`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecureListingAuthorizeItem {
    pub outpoint: String,
    pub protocol: String,
    pub seller_public_key: String,
    pub template_digest: String,
    /// Signed passthrough PSBT.
    pub psbt: String,
    /// Sale template PSBT carrying the seller's script-path pre-signature.
    pub sale_psbt: String,
    /// The price the templates were built for (required when repricing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escrow_price_sats: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}

/// `POST /market/secure-listing/recover`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecureListingRecoverRequest {
    /// Txid of the confirmed passthrough whose output 0 is the stranded escrow.
    pub passthrough_txid: String,
    pub fee_rate: f64,
    /// Defaults to the listing's payout address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
}

/// `POST /market/secure-listing/recover`: an unsigned recovery PSBT.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecureListingRecoverResponse {
    #[serde(default)]
    pub version: Option<u32>,
    pub psbt: String,
    #[serde(default)]
    pub recovery_txid: Option<String>,
    #[serde(default)]
    pub escrow_outpoint: Option<String>,
    #[serde(default)]
    pub escrow_value: Option<u64>,
    #[serde(default)]
    pub value: Option<u64>,
    #[serde(default)]
    pub fee: Option<u64>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub sequence: Option<u32>,
    #[serde(default)]
    pub spendable_after_confirmations: Option<u32>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `POST /wallet/secure-purchase/build`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildSecurePurchaseRequest {
    pub outpoints: Vec<String>,
    /// `ordinal`.
    pub protocol: String,
    pub from: String,
    pub public_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub fee_rate: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_type: Option<String>,
}

/// The passthrough a sale spends, witness-stripped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecurePurchaseParent {
    pub txid: String,
    pub raw: String,
    #[serde(default)]
    pub source_outpoint: Option<String>,
}

/// One single-item sale of a protected purchase.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecurePurchaseSale {
    pub sale_txid: String,
    #[serde(default)]
    pub chain_index: Option<u32>,
    pub psbt: String,
    pub parent: SecurePurchaseParent,
    #[serde(default)]
    pub miner_fee_sats: Option<u64>,
}

/// The build's setup transaction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecurePurchaseSetup {
    pub txid: String,
    pub psbt: String,
    #[serde(default)]
    pub fee_sats: Option<u64>,
}

/// The build's own figures. The SDK re-derives amounts from the transactions.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SecurePurchaseEconomics {
    #[serde(default)]
    pub total_price_sats: Option<u64>,
    #[serde(default)]
    pub ow_fee_sats: Option<u64>,
    #[serde(default)]
    pub creator_royalty_sats: Option<u64>,
    #[serde(default)]
    pub miner_fee_sats: Option<u64>,
    #[serde(default)]
    pub setup_fee_sats: Option<u64>,
    /// Everything the purchase costs.
    #[serde(default)]
    pub buyer_total_sats: Option<u64>,
    #[serde(default)]
    pub fee_rate_sat_vb: Option<f64>,
    #[serde(default)]
    pub estimated_vbytes: Option<u64>,
}

/// `POST /wallet/secure-purchase/build`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildSecurePurchaseResponse {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub policy: Option<String>,
    #[serde(default)]
    pub sale_txid: Option<String>,
    #[serde(default)]
    pub setup: Option<SecurePurchaseSetup>,
    #[serde(default)]
    pub sales: Vec<SecurePurchaseSale>,
    #[serde(default)]
    pub economics: Option<SecurePurchaseEconomics>,
    #[serde(default)]
    pub buyer_address: Option<String>,
    #[serde(default)]
    pub recipient_address: Option<String>,
    #[serde(default)]
    pub cosigner_public_key: Option<String>,
    /// RFC 3339. Past it, nothing may be signed or submitted.
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One link of `POST /market/secure-purchase/submit`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubmitSecurePurchaseLink {
    pub sale_txid: String,
    /// The sale PSBT with ONLY the buyer's inputs signed, unfinalized.
    pub psbt: String,
    /// The signed setup PSBT; first link only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_psbt: Option<String>,
}

/// `POST /market/secure-purchase/submit`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubmitSecurePurchaseRequest {
    pub sales: Vec<SubmitSecurePurchaseLink>,
}

/// `POST /market/secure-purchase/submit`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubmitSecurePurchaseResponse {
    pub accepted: bool,
    #[serde(default)]
    pub txid: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub parents: Option<Vec<String>>,
    /// Set when a chain was only partly broadcast.
    #[serde(default)]
    pub stopped_at: Option<u32>,
    #[serde(default)]
    pub stopped_code: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
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
    /// `POST /market/cancel-escrow` with an owner proof. Never retried.
    /// Refuses (before any request) unless exactly one identifier is given.
    pub fn cancel_escrow(&self, req: &CancelEscrowRequest) -> Result<CancelEscrowResponse> {
        let has = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
        if has(&req.outpoint) == has(&req.inscription_id) {
            return Err(Error::InvalidInput(
                "cancel_escrow needs exactly one of outpoint or inscription_id".into(),
            ));
        }
        self.0
            .json(Req::post("/market/cancel-escrow".into(), req)?.retry(RetryMode::Never))
    }

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

impl SecurePurchaseApi<'_> {
    /// `POST /wallet/secure-purchase/build`: sale PSBTs to verify before
    /// signing (`signing::passthrough::verify_passthrough_purchase`). Never retried.
    pub fn build(&self, req: &BuildSecurePurchaseRequest) -> Result<BuildSecurePurchaseResponse> {
        self.0
            .json(Req::post("/wallet/secure-purchase/build".into(), req)?.retry(RetryMode::Never))
    }

    /// `POST /market/secure-purchase/submit`: hands back sales with only the
    /// buyer's inputs signed; the marketplace co-signs and broadcasts. Never retried.
    pub fn submit(
        &self,
        req: &SubmitSecurePurchaseRequest,
    ) -> Result<SubmitSecurePurchaseResponse> {
        self.0
            .json(Req::post("/market/secure-purchase/submit".into(), req)?.retry(RetryMode::Never))
    }
}

impl SecureListingApi<'_> {
    /// Build both templates for up to 100 items. Per-item refusals come back
    /// as rows with `error: true`. Never retried.
    pub fn build_bulk(
        &self,
        req: &SecureListingBuildBulkRequest,
    ) -> Result<SecureListingBulkResponse> {
        self.0.json(
            Req::post("/market/secure-listing/build-bulk".into(), req)?
                .retry(RetryMode::Never)
                .no_store(),
        )
    }

    /// Publish signed templates. Always one row per item; a single-item call
    /// (which the API answers with the bare item, HTTP 400 on refusal) is
    /// normalized to the same shape. Never retried.
    pub fn authorize_bulk(
        &self,
        items: &[SecureListingAuthorizeItem],
    ) -> Result<SecureListingBulkResponse> {
        let path = "/market/secure-listing/authorize-bulk";
        let single = items.len() == 1;
        let req = Req::post(path.into(), &serde_json::json!({ "items": items }))?
            .retry(RetryMode::Never)
            .no_store()
            .accept(if single { &[400] } else { &[] });
        let raw = self.0.send(req)?;
        let data: Value = crate::client::decode(&raw)?;
        let bare_item = single
            && !data.get("items").is_some_and(Value::is_array)
            && data.get("outpoint").is_some_and(Value::is_string);
        let decode_err = |source| Error::Decode {
            method: "POST".into(),
            path: path.into(),
            source,
        };
        if bare_item {
            let row: SecureListingRow = serde_json::from_value(data).map_err(decode_err)?;
            return Ok(SecureListingBulkResponse {
                items: vec![row],
                ..Default::default()
            });
        }
        if raw.status == 400 {
            return Err(api_error(400, "Bad Request", &raw.body, "POST", path, 0));
        }
        serde_json::from_value(data).map_err(decode_err)
    }

    /// Build (never sign) the seller's recovery of an escrow that confirmed
    /// without its sale. Never retried.
    pub fn recover(
        &self,
        req: &SecureListingRecoverRequest,
    ) -> Result<SecureListingRecoverResponse> {
        self.0.json(
            Req::post("/market/secure-listing/recover".into(), req)?
                .retry(RetryMode::Never)
                .no_store(),
        )
    }

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
