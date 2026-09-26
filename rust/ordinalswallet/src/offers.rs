//! Offers v1 (`/market/offers`): funded bids on an item, a collection or a
//! trait. Reads, plus the write routes that place, accept, fill, reject and
//! cancel offers.
//!
//! Every PSBT a write route returns is built by the server. Verify it before
//! signing: with the `signing` feature, `ordinalswallet::signing::offers`
//! (`sign_offer_funding`, `sign_offer_presign`, `sign_accept_psbt`,
//! `sign_offer_cancel`) checks each one against the values you already trust
//! and refuses anything else. Write routes are never retried.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{seg, Client, Req};
use crate::error::Result;
use crate::retry::RetryMode;

/// Typed classification of an offers API error code. See [`crate::Error::offer_kind`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OfferErrorKind {
    /// `offer_expired`: past `expires_at`.
    Expired,
    /// `offer_not_active`, `offer_not_building`, `offer_not_cancellable`: wrong state.
    NotActive,
    /// `item_moved`, `stale`, `item_changed`: the item moved since the offer was made.
    ItemMoved,
    /// `not_the_owner`, `not_the_buyer`: the address is not a party to this action.
    NotOwner,
    /// `item_not_eligible`: the item doesn't match the collection or trait.
    ItemNotEligible,
    /// `offer_attempt_pending`: a broadcast is in flight; call reconcile.
    AttemptPending,
    /// `unauthorized`: missing, expired or wrong-address session token.
    Unauthorized,
    /// Any other code.
    Other(String),
}

impl OfferErrorKind {
    pub fn from_code(code: &str) -> Self {
        match code {
            "offer_expired" => Self::Expired,
            "offer_not_active" | "offer_not_building" | "offer_not_cancellable" => Self::NotActive,
            "item_moved" | "stale" | "item_changed" => Self::ItemMoved,
            "not_the_owner" | "not_the_buyer" => Self::NotOwner,
            "item_not_eligible" => Self::ItemNotEligible,
            "offer_attempt_pending" => Self::AttemptPending,
            "unauthorized" => Self::Unauthorized,
            other => Self::Other(other.to_string()),
        }
    }
}

/// An offer. Amounts are sats.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Offer {
    pub id: String,
    /// `item`, `collection` or `trait`.
    pub scope: String,
    #[serde(default)]
    pub inscription_id: Option<String>,
    #[serde(default)]
    pub item_outpoint: Option<String>,
    #[serde(default)]
    pub item_value: Option<u64>,
    #[serde(default)]
    pub seller_address: Option<String>,
    pub buyer_address: String,
    #[serde(default)]
    pub buyer_payment_address: Option<String>,
    #[serde(default)]
    pub collection_slug: Option<String>,
    #[serde(default)]
    pub trait_type: Option<String>,
    #[serde(default)]
    pub trait_value: Option<String>,
    /// What the seller receives.
    pub price_sats: u64,
    #[serde(default)]
    pub market_fee_sats: Option<u64>,
    #[serde(default)]
    pub network_fee_sats: Option<u64>,
    #[serde(default)]
    pub escrow_value: Option<u64>,
    #[serde(default)]
    pub total_sats: Option<u64>,
    /// `building`, `active`, `accepted`, `rejected`, `expired`, `stale`, `cancelled`.
    pub state: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub funding_txid: Option<String>,
    #[serde(default)]
    pub funding_vout: Option<u32>,
    #[serde(default)]
    pub accepted_txid: Option<String>,
    #[serde(default)]
    pub cancel_txid: Option<String>,
    #[serde(default)]
    pub filled_inscription_id: Option<String>,
    #[serde(default)]
    pub recovery_delay_blocks: Option<u32>,
    pub expires_at: String,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `GET /market/offers/inscription/:id`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct InscriptionOffersResponse {
    /// Item offers on this inscription.
    #[serde(default)]
    pub offers: Vec<Offer>,
    /// Collection and trait offers this inscription could fill.
    #[serde(default)]
    pub collection_offers: Vec<Offer>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CollectionOffersSummary {
    pub count: u64,
    pub item_count: u64,
    pub collection_count: u64,
    pub trait_count: u64,
    pub top_price_sats: u64,
    pub top_collection_sats: u64,
    pub total_sats: u64,
}

/// `GET /market/offers/collection/:slug`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CollectionOffersResponse {
    pub slug: String,
    pub summary: CollectionOffersSummary,
    #[serde(default)]
    pub offers: Vec<Offer>,
    #[serde(default)]
    pub collection_offers: Vec<Offer>,
    #[serde(default)]
    pub trait_offers: Vec<Offer>,
}

/// `GET /market/offers/wallet/:address`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WalletOffersResponse {
    #[serde(default)]
    pub received: Vec<Offer>,
    #[serde(default)]
    pub sent: Vec<Offer>,
}

/// `GET /market/offers/:id/reconcile`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReconcileOfferResponse {
    pub offer: Offer,
}

/// `POST /market/offers/build`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BuildOfferRequest {
    /// `item` (default), `collection` or `trait`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Required for item offers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inscription_id: Option<String>,
    /// Required for collection and trait offers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trait_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trait_value: Option<String>,
    /// Where the item is delivered; public key is 33-byte compressed hex.
    pub buyer_address: String,
    pub buyer_public_key: String,
    /// What funds the offer; public key is 33-byte compressed hex.
    pub buyer_payment_address: String,
    pub buyer_payment_public_key: String,
    /// Minimum 10,000.
    pub price_sats: u64,
    /// 1-500 sat/vB, prepaid for the sale.
    pub fee_rate: f64,
    /// 1-30, default 7.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validity_days: Option<u32>,
    /// Optional public note, up to 500 characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Present when the funding txid is already final (native segwit/taproot inputs).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BatchAccept {
    pub accept_psbt: String,
    pub sign_input_index: usize,
}

/// `POST /market/offers/build`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildOfferResponse {
    #[serde(default)]
    pub version: Option<u32>,
    pub offer_id: String,
    pub scope: String,
    /// Hex PSBT moving `escrow_value` into the offer escrow.
    pub funding_psbt: String,
    #[serde(default)]
    pub batch_accept: Option<BatchAccept>,
    #[serde(default)]
    pub escrow_address: Option<String>,
    pub escrow_value: u64,
    pub price_sats: u64,
    pub market_fee_sats: u64,
    #[serde(default)]
    pub network_fee_sats: Option<u64>,
    #[serde(default)]
    pub validity_days: Option<u32>,
    pub recovery_delay_blocks: u32,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `POST /market/offers/:id/prepare`: the acceptance template to pre-sign.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PrepareOfferResponse {
    pub offer_id: String,
    pub scope: String,
    #[serde(default)]
    pub funding_txid: Option<String>,
    /// Hex PSBT; pre-sign only the escrow leaf input at `sign_input_index`.
    pub accept_psbt: String,
    pub sign_input_index: usize,
    #[serde(default)]
    pub tapscript: Option<bool>,
    /// 0x01 (item offers) or 0x82 (collection/trait).
    pub sighash: u32,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `POST /market/offers/:id/activate`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivateOfferRequest {
    pub funding_psbt: String,
    pub accept_psbt: String,
}

/// `POST /market/offers/:id/activate`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivateOfferResponse {
    pub offer: Offer,
    pub funding_txid: String,
}

/// `POST /market/offers/:id/build-accept`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildAcceptRequest {
    pub seller_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seller_public_key: Option<String>,
}

/// `POST /market/offers/:id/build-accept`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildAcceptResponse {
    pub offer: Offer,
    pub accept_psbt: String,
    pub sign_input_index: usize,
    #[serde(default)]
    pub tapscript: Option<bool>,
    pub sighash: u32,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `POST /market/offers/:id/accept` and `/fill`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AcceptOfferRequest {
    pub seller_address: String,
    pub signed_psbt: String,
}

/// `POST /market/offers/:id/build-fill`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildFillRequest {
    pub seller_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seller_public_key: Option<String>,
    pub inscription_id: String,
}

/// `POST /market/offers/:id/build-fill`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildFillResponse {
    pub offer: Offer,
    pub inscription_id: String,
    pub fill_psbt: String,
    pub sign_input_index: usize,
    #[serde(default)]
    pub tapscript: Option<bool>,
    pub sighash: u32,
    #[serde(default)]
    pub miner_fee_sats: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `POST /market/offers/:id/fill`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FillOfferRequest {
    pub seller_address: String,
    pub inscription_id: String,
    pub signed_psbt: String,
}

/// Result of accept, fill and cancel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettleOfferResponse {
    pub offer_id: String,
    pub txid: String,
    pub state: String,
    #[serde(default)]
    pub inscription_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `POST /market/offers/:id/reject`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RejectOfferResponse {
    pub offer_id: String,
    pub state: String,
}

/// `POST /market/offers/:id/build-cancel`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildCancelRequest {
    pub buyer_address: String,
    /// Default 2, clamped to 1-500.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_rate: Option<f64>,
}

/// `POST /market/offers/:id/build-cancel`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildCancelResponse {
    pub offer_id: String,
    pub cancel_psbt: String,
    pub sign_input_index: usize,
    #[serde(default)]
    pub tapscript: Option<bool>,
    pub sighash: u32,
    #[serde(default)]
    pub fee_rate: Option<f64>,
}

/// `POST /market/offers/:id/cancel`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CancelOfferRequest {
    pub buyer_address: String,
    pub signed_psbt: String,
}

/// Offer reads and writes. Get one with [`Client::offers`].
#[derive(Clone, Copy, Debug)]
pub struct OffersApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Offers v1 reads.
    pub fn offers(&self) -> OffersApi<'_> {
        OffersApi(self)
    }
}

impl OffersApi<'_> {
    fn post<T: serde::de::DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        path: String,
        body: &B,
    ) -> Result<T> {
        self.0.json(Req::post(path, body)?.retry(RetryMode::Never))
    }

    /// Step 1: build the funding PSBT and escrow for a new offer.
    pub fn build(&self, req: &BuildOfferRequest) -> Result<BuildOfferResponse> {
        self.post("/market/offers/build".into(), req)
    }

    /// Step 2: exchange the signed funding PSBT for the acceptance template to pre-sign.
    pub fn prepare(
        &self,
        offer_id: &str,
        signed_funding_psbt: &str,
    ) -> Result<PrepareOfferResponse> {
        self.post(
            format!("/market/offers/{}/prepare", seg(offer_id)),
            &serde_json::json!({ "funding_psbt": signed_funding_psbt }),
        )
    }

    /// Step 3: submit both signed PSBTs; the funding is broadcast and the offer goes live.
    pub fn activate(
        &self,
        offer_id: &str,
        req: &ActivateOfferRequest,
    ) -> Result<ActivateOfferResponse> {
        self.post(format!("/market/offers/{}/activate", seg(offer_id)), req)
    }

    /// Seller, item offers: the sale PSBT to verify and sign.
    pub fn build_accept(
        &self,
        offer_id: &str,
        req: &BuildAcceptRequest,
    ) -> Result<BuildAcceptResponse> {
        self.post(
            format!("/market/offers/{}/build-accept", seg(offer_id)),
            req,
        )
    }

    /// Seller, item offers: submit the signed sale.
    pub fn accept(&self, offer_id: &str, req: &AcceptOfferRequest) -> Result<SettleOfferResponse> {
        self.post(format!("/market/offers/{}/accept", seg(offer_id)), req)
    }

    /// Seller, collection/trait offers: the sale PSBT for one of your items.
    pub fn build_fill(&self, offer_id: &str, req: &BuildFillRequest) -> Result<BuildFillResponse> {
        self.post(format!("/market/offers/{}/build-fill", seg(offer_id)), req)
    }

    /// Seller, collection/trait offers: submit the signed sale.
    pub fn fill(&self, offer_id: &str, req: &FillOfferRequest) -> Result<SettleOfferResponse> {
        self.post(format!("/market/offers/{}/fill", seg(offer_id)), req)
    }

    /// Seller declines, off-chain. `token` is a wallet session token for
    /// `address` (see [`crate::auth::SessionManager`]); it is sent as `signature`.
    pub fn reject(
        &self,
        offer_id: &str,
        address: &str,
        token: &str,
    ) -> Result<RejectOfferResponse> {
        self.post(
            format!("/market/offers/{}/reject", seg(offer_id)),
            &serde_json::json!({ "address": address, "signature": token }),
        )
    }

    /// Buyer: the refund PSBT to verify and sign.
    pub fn build_cancel(
        &self,
        offer_id: &str,
        req: &BuildCancelRequest,
    ) -> Result<BuildCancelResponse> {
        self.post(
            format!("/market/offers/{}/build-cancel", seg(offer_id)),
            req,
        )
    }

    /// Buyer: submit the signed refund.
    pub fn cancel(&self, offer_id: &str, req: &CancelOfferRequest) -> Result<SettleOfferResponse> {
        self.post(format!("/market/offers/{}/cancel", seg(offer_id)), req)
    }

    /// Item offers on an inscription, plus collection/trait offers it could fill.
    pub fn for_inscription(&self, inscription_id: &str) -> Result<InscriptionOffersResponse> {
        self.0.json(Req::get(format!(
            "/market/offers/inscription/{}",
            seg(inscription_id)
        )))
    }

    /// Up to 200 of each kind for a collection, best price first, plus a summary.
    pub fn for_collection(&self, slug: &str) -> Result<CollectionOffersResponse> {
        self.0
            .json(Req::get(format!("/market/offers/collection/{}", seg(slug))))
    }

    /// Offers `received` and `sent` by a wallet over the last 90 days.
    pub fn for_wallet(&self, address: &str) -> Result<WalletOffersResponse> {
        self.0
            .json(Req::get(format!("/market/offers/wallet/{}", seg(address))))
    }

    /// Re-checks in-flight broadcasts for an offer. Pass `txid` to record a
    /// refund the buyer broadcast alone via the timelock leaf.
    pub fn reconcile(&self, offer_id: &str, txid: Option<&str>) -> Result<ReconcileOfferResponse> {
        self.0.json(
            Req::get(format!("/market/offers/{}/reconcile", seg(offer_id))).query_opt("txid", txid),
        )
    }
}
