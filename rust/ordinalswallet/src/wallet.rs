//! Wallet balances, holdings, UTXOs and inscription lookups.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{seg, Client, Req};
use crate::collection::IconInscription;
use crate::error::Result;
use crate::network::FeeEstimates;

/// Where an inscription sits, as returned by wallet endpoints.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SerializedOutpoint {
    /// 72 hex chars: txid little-endian + vout u32 little-endian. Convert with
    /// [`crate::outpoint_to_txid_vout`].
    pub outpoint: String,
    /// Offset of the inscribed sat inside the output.
    pub sat_offset: u64,
    /// Value of the output holding the inscription, in sats.
    pub sats: u64,
}

/// Collection summary embedded in inscription and wallet responses.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InscriptionCollectionRef {
    pub slug: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub creator_address: Option<String>,
    #[serde(default)]
    pub floor_price: Option<u64>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub icon_inscription: Option<IconInscription>,
}

/// Collection summary embedded in token balance rows (runes, BRC-20, alkanes).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TokenCollectionRef {
    pub slug: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub icon_inscription: Option<IconInscription>,
    #[serde(default)]
    pub floor_price_per: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InscriptionAttribute {
    pub trait_type: String,
    pub value: Value,
    #[serde(default)]
    pub percent: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InscriptionMeta {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub attributes: Option<Vec<InscriptionAttribute>>,
    #[serde(default)]
    pub rank: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Listing summary embedded in wallet inscriptions. Has no listing id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WalletInscriptionEscrow {
    pub satoshi_price: u64,
    #[serde(default)]
    pub seller_address: Option<String>,
    #[serde(default)]
    pub buyer_address: Option<String>,
    #[serde(default)]
    pub purchase_txid: Option<String>,
    /// `None` or `""` when unsold.
    #[serde(default)]
    pub bought_at: Option<String>,
    #[serde(default)]
    pub protected: Option<bool>,
    #[serde(default)]
    pub private_relay: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WalletInscription {
    pub id: String,
    pub num: i64,
    pub content_type: String,
    #[serde(default)]
    pub meta: Option<InscriptionMeta>,
    #[serde(default)]
    pub collection: Option<InscriptionCollectionRef>,
    #[serde(default)]
    pub collection_slugs: Option<Vec<String>>,
    #[serde(default)]
    pub escrow: Option<WalletInscriptionEscrow>,
    /// Serialized outpoint; see [`SerializedOutpoint`].
    #[serde(default)]
    pub outpoint: Option<SerializedOutpoint>,
    /// A sale of this item is in the mempool.
    #[serde(default)]
    pub pending_sale: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Brc20Balance {
    pub ticker: String,
    pub overall_balance: String,
    pub available_balance: String,
    pub transferable_balance: String,
    #[serde(default)]
    pub collection: Option<TokenCollectionRef>,
}

/// Balance fields shared by `/wallet/:address` and `/wallet/:address/balance`. All in sats.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WalletBalance {
    /// Confirmed balance.
    pub balance: i64,
    pub confirmed_balance: i64,
    /// Pending in the mempool.
    pub unconfirmed_balance: i64,
    /// Sats in outputs holding inscriptions.
    pub inscription_balance: i64,
    /// Sats in outputs holding inscriptions or runes. Not safe to spend as plain BTC.
    pub frozen_balance: i64,
    /// Spendable outputs.
    pub utxo_count: u64,
    #[serde(default)]
    pub private_pending_incoming: Option<i64>,
    #[serde(default)]
    pub private_pending_outgoing: Option<i64>,
    #[serde(default)]
    pub private_pending_net: Option<i64>,
}

/// `GET /wallet/:address`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WalletInfo {
    #[serde(flatten)]
    pub balance: WalletBalance,
    pub inscriptions: Vec<WalletInscription>,
    #[serde(default)]
    pub brc20: Vec<Brc20Balance>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UtxoStatus {
    pub confirmed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Utxo {
    pub txid: String,
    pub vout: u32,
    pub value: u64,
    pub status: UtxoStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RuneBalance {
    pub name: String,
    pub rune_id: String,
    /// Whole units.
    pub amount: String,
    pub symbol: String,
    pub divisibility: u32,
    #[serde(default)]
    pub collection: Option<TokenCollectionRef>,
}

/// One row of `GET /wallet/:address/alkanes-balance`. Balances are decimal strings in whole units.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AlkanesBalance {
    pub ticker: String,
    /// Alkane id, `block:tx`.
    pub rune_id: String,
    /// Always `alkanes` today.
    #[serde(rename = "type")]
    pub kind: String,
    pub divisibility: u32,
    pub overall_balance: String,
    pub available_balance: String,
    pub transferable_balance: String,
    #[serde(default)]
    pub collection: Option<TokenCollectionRef>,
}

/// One coin holding an alkane or rune.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TokenOutpoint {
    pub rune_id: String,
    /// `txid:vout`.
    pub outpoint: String,
    /// Whole units held in this output.
    pub amount: String,
    pub address: String,
    pub sats: u64,
    /// Partial listing when this coin is listed.
    #[serde(default)]
    pub escrow: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SatInfo {
    pub value: u64,
    pub rarity: String,
}

/// `GET /inscription/:id` (cached up to 24h; use [`InscriptionApi::outpoint`] for ownership).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InscriptionDetail {
    pub id: String,
    pub num: i64,
    pub content_type: String,
    pub content_length: u64,
    #[serde(default)]
    pub effective_content_type: Option<String>,
    #[serde(default)]
    pub delegate: Option<String>,
    /// Unix seconds.
    #[serde(default)]
    pub created: Option<i64>,
    pub genesis_height: u64,
    pub genesis_fee: u64,
    #[serde(default)]
    pub sat: Option<SatInfo>,
    /// Owner at the time of caching.
    #[serde(default)]
    pub address: Option<String>,
    /// Value of the output holding the inscription, in sats.
    #[serde(default)]
    pub value: Option<u64>,
    /// `<txid>:<vout>:<offset>`.
    #[serde(default)]
    pub satpoint: Option<String>,
    #[serde(default)]
    pub charms: Option<Vec<String>>,
    #[serde(default)]
    pub parents: Option<Vec<String>>,
    #[serde(default)]
    pub meta: Option<InscriptionMeta>,
    #[serde(default)]
    pub collection: Option<InscriptionCollectionRef>,
    #[serde(default)]
    pub collections: Option<Vec<InscriptionCollectionRef>>,
    #[serde(default)]
    pub escrow: Option<WalletInscriptionEscrow>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InscriptionLocation {
    pub id: String,
    pub sat_offset: u64,
    /// Serialized (72 hex). Use [`crate::outpoint_to_txid_vout`].
    pub outpoint: String,
    pub address: String,
    pub sats: u64,
}

/// `GET /inscription/:id/outpoint`: live location and owner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InscriptionOutpoint {
    pub inscription: InscriptionLocation,
    pub owner: String,
    pub sats: u64,
    /// Partial listing when the inscription is listed.
    #[serde(default)]
    pub escrow: Option<Map<String, Value>>,
}

/// `/wallet/:address` endpoints. Get one with [`Client::wallet`].
#[derive(Clone, Copy, Debug)]
pub struct WalletApi<'a>(pub(crate) &'a Client);

/// `/inscription/:id` endpoints. Get one with [`Client::inscription`].
#[derive(Clone, Copy, Debug)]
pub struct InscriptionApi<'a>(pub(crate) &'a Client);

impl Client {
    /// Wallet endpoints.
    pub fn wallet(&self) -> WalletApi<'_> {
        WalletApi(self)
    }

    /// Inscription endpoints.
    pub fn inscription(&self) -> InscriptionApi<'_> {
        InscriptionApi(self)
    }
}

impl WalletApi<'_> {
    fn path(address: &str, rest: &str) -> String {
        format!("/wallet/{}{rest}", seg(address))
    }

    /// Balances, inscriptions and BRC-20. `GET /wallet/:address`.
    pub fn wallet(&self, address: &str) -> Result<WalletInfo> {
        self.0.json(Req::get(Self::path(address, "")))
    }

    /// Balance fields only. Cached ~30s server side. `GET /wallet/:address/balance`.
    pub fn balance(&self, address: &str) -> Result<WalletBalance> {
        self.0.json(Req::get(Self::path(address, "/balance")))
    }

    /// Every inscription the address holds. `GET /wallet/:address/inscriptions`.
    pub fn inscriptions(&self, address: &str) -> Result<Vec<WalletInscription>> {
        self.0.json(Req::get(Self::path(address, "/inscriptions")))
    }

    /// `GET /wallet/:address/utxos`.
    pub fn utxos(&self, address: &str) -> Result<Vec<Utxo>> {
        self.0.json(Req::get(Self::path(address, "/utxos")))
    }

    /// `GET /wallet/:address/rune-balance`.
    pub fn rune_balance(&self, address: &str) -> Result<Vec<RuneBalance>> {
        self.0.json(Req::get(Self::path(address, "/rune-balance")))
    }

    /// Coins holding a rune (`block:tx`). `GET /wallet/:address/rune-outpoints/:id`.
    pub fn rune_outpoints(&self, address: &str, rune_id: &str) -> Result<Vec<TokenOutpoint>> {
        self.0.json(Req::get(Self::path(
            address,
            &format!("/rune-outpoints/{}", seg(rune_id)),
        )))
    }

    /// `GET /wallet/:address/brc20-balance`.
    pub fn brc20_balance(&self, address: &str) -> Result<Vec<Brc20Balance>> {
        self.0.json(Req::get(Self::path(address, "/brc20-balance")))
    }

    /// Alkanes balances. A cold wallet may return `[]` while it is indexed; an
    /// empty result does not prove a zero balance. `GET /wallet/:address/alkanes-balance`.
    pub fn alkanes_balance(&self, address: &str) -> Result<Vec<AlkanesBalance>> {
        self.0
            .json(Req::get(Self::path(address, "/alkanes-balance")))
    }

    /// Coins holding an alkane (`block:tx`, e.g. `2:0`). `GET /wallet/:address/alkanes-outpoints/:id`.
    pub fn alkanes_outpoints(&self, address: &str, alkane_id: &str) -> Result<Vec<TokenOutpoint>> {
        self.0.json(Req::get(Self::path(
            address,
            &format!("/alkanes-outpoints/{}", seg(alkane_id)),
        )))
    }

    /// Same as [`crate::network::NetworkApi::fee_estimates`].
    pub fn fee_estimates(&self) -> Result<FeeEstimates> {
        self.0.network().fee_estimates()
    }
}

impl InscriptionApi<'_> {
    /// `GET /inscription/:id`.
    pub fn get(&self, id: &str) -> Result<InscriptionDetail> {
        self.0.json(Req::get(format!("/inscription/{}", seg(id))))
    }

    /// Live location and owner; prefer this over [`Self::get`] for ownership
    /// checks. `GET /inscription/:id/outpoint`.
    pub fn outpoint(&self, id: &str) -> Result<InscriptionOutpoint> {
        self.0
            .json(Req::get(format!("/inscription/{}/outpoint", seg(id))))
    }
}
