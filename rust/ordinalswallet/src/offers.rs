//! Offers v1 reads (`/market/offers`): funded bids on an item, a collection
//! or a trait. Placing, accepting and cancelling offers (which need signing)
//! come in stage 2.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{seg, Client, Req};
use crate::error::Result;

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

/// Offer reads. Get one with [`Client::offers`].
#[derive(Clone, Copy, Debug)]
pub struct OffersApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Offers v1 reads.
    pub fn offers(&self) -> OffersApi<'_> {
        OffersApi(self)
    }
}

impl OffersApi<'_> {
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
