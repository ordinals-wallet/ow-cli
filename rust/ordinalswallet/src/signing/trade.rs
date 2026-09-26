//! End-to-end flows over the client, ported from `@ow-cli/shared`: sign-in
//! with a key, snipe-protected (passthrough v4) purchase and listing,
//! recovery and delisting. Every PSBT is verified locally before it is
//! signed; each step that talks to the API is a separate call, so a caller
//! can show the verified amounts before anything is signed or sent.
//!
//! Local refusals are [`crate::Error::Signing`] with a stable code
//! (`cosigner_key_unpinned`, `invalid_sale`, `quote_expired`, …); API
//! failures pass through as [`crate::Error::Api`]. Nothing here broadcasts:
//! [`recover_protected_listing`] returns the signed transaction for the
//! caller to broadcast.

use crate::auth::AuthSession;
use crate::market::{
    BuildSecurePurchaseRequest, BuildSecurePurchaseResponse, CancelEscrowRequest,
    CancelEscrowResponse, MarketListing, SecureListingAuthorizeItem, SecureListingBuildBulkRequest,
    SecureListingBuildItem, SecureListingRecoverRequest, SecureListingRow,
    SecurePurchaseCapabilities, SubmitSecurePurchaseLink, SubmitSecurePurchaseRequest,
    SubmitSecurePurchaseResponse,
};
use crate::{outpoint_to_txid_vout, Client, Error, Result};

use super::listing::{
    sign_listing_templates, sign_recovery, ListingTemplateCheck, RecoveryCheck, SignedRecovery,
    MIN_ESCROW_VALUE_SATS,
};
use super::passthrough::{
    assert_quote_fresh, parse_iso8601_ms, sign_own_inputs, verify_passthrough_purchase,
    PurchaseCheck, QuoteExpiry, SaleChainLink, SaleChainVerification, SaleListing, SaleParent,
    SetupTx, MAX_PROTECTED_ITEMS_PER_PURCHASE, PASSTHROUGH_POLICY, PINNED_COSIGNER_XONLY_HEX,
};
use super::{SigningError, SigningKey};

const WALLET_TYPE: &str = "ow-cli";
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn refuse<T>(code: &str, message: impl Into<String>) -> Result<T> {
    Err(Error::Signing(SigningError::new(code, message)))
}

/// Sign in with a key the SDK holds. Defaults to the key's taproot address.
pub fn sign_in_with_key(
    client: &Client,
    key: &SigningKey,
    address: Option<&str>,
) -> Result<AuthSession> {
    let address = address.map_or_else(|| key.p2tr_address(), str::to_string);
    client.auth().sign_in(&address, key, None, None)
}

fn policy_of(caps: &SecurePurchaseCapabilities) -> Option<&str> {
    [&caps.escrow_policy, &caps.policy, &caps.mode]
        .into_iter()
        .find_map(|p| p.as_deref().filter(|s| !s.is_empty()))
}

fn cosigner_pinned(key: Option<&str>) -> bool {
    key.unwrap_or_default().to_lowercase() == PINNED_COSIGNER_XONLY_HEX
}

// ─── purchase ───────────────────────────────────────────────────────

/// Refuse to go further unless the API speaks passthrough v4 with the
/// co-signer pinned in this build and protected purchases are enabled.
pub fn require_passthrough_support(client: &Client) -> Result<SecurePurchaseCapabilities> {
    let caps = client.secure_purchase().capabilities()?;
    let policy = policy_of(&caps);
    if policy != Some(PASSTHROUGH_POLICY) {
        return refuse(
            "policy_unsupported",
            format!(
                "The marketplace reports protection policy \"{}\"; this SDK only speaks {PASSTHROUGH_POLICY}",
                policy.unwrap_or("none")
            ),
        );
    }
    if [
        caps.build_enabled,
        caps.submit_enabled,
        caps.customer_enabled,
    ]
    .contains(&Some(false))
    {
        return refuse(
            "secure_purchase_disabled",
            "Protected purchases are temporarily unavailable.",
        );
    }
    if let Some(status) = caps.protocol_status.as_ref().and_then(|s| s.get("ordinal")) {
        if !status.is_empty() && status != "enabled" {
            return refuse(
                "secure_purchase_disabled",
                format!("Protected inscription purchases are unavailable ({status})."),
            );
        }
    }
    if !cosigner_pinned(caps.cosigner_public_key.as_deref()) {
        return refuse(
            "cosigner_key_unpinned",
            "The marketplace co-signer key does not match the key built into this SDK; refusing to buy.",
        );
    }
    Ok(caps)
}

/// One listing to buy, from `GET /market/escrow/:id`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedItem {
    pub inscription_id: String,
    /// True for a snipe-protected (passthrough v4) listing.
    pub protected: bool,
    /// What the buyer pays, marketplace fee included.
    pub price_sat: u64,
    /// What the seller listed for; the sale must pay exactly this.
    pub escrow_price_sat: Option<u64>,
    pub seller_address: String,
    pub creator_address: Option<String>,
    /// `txid:vout` of the listed UTXO.
    pub outpoint: String,
}

/// The wallet frontend's test for the protected purchase path.
pub fn is_protected_listing(listing: &MarketListing) -> bool {
    if listing.protected == Some(true) {
        return true;
    }
    let state = listing.secure_purchase_state.clone().or_else(|| {
        listing
            .extra
            .get("state")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    });
    listing.secure_purchase_version == Some(2) && state.as_deref() == Some("listed")
}

/// Plan one item from its live listing (`None` when not listed).
pub fn plan_item(inscription_id: &str, listing: Option<&MarketListing>) -> Result<PlannedItem> {
    let listing = match listing {
        Some(l)
            if l.buyer_address.as_deref().map_or(true, str::is_empty) && l.satoshi_price > 0 =>
        {
            l
        }
        _ => {
            return refuse(
                "listing_not_found",
                format!("{inscription_id} is not listed for sale"),
            )
        }
    };
    let outpoint = outpoint_to_txid_vout(&listing.outpoint.to_lowercase()).ok();
    let (Some(outpoint), false) = (outpoint, listing.seller_address.is_empty()) else {
        return refuse(
            "listing_malformed",
            format!("Could not read the listing for {inscription_id}; try again"),
        );
    };
    Ok(PlannedItem {
        inscription_id: inscription_id.into(),
        protected: is_protected_listing(listing),
        price_sat: listing.satoshi_price,
        escrow_price_sat: listing.escrow_price.filter(|&p| p > 0),
        seller_address: listing.seller_address.clone(),
        creator_address: listing.creator_address.clone().filter(|s| !s.is_empty()),
        outpoint,
    })
}

/// A built protected purchase, verified from its transactions.
#[derive(Clone, Debug)]
pub struct PassthroughQuote {
    pub items: Vec<PlannedItem>,
    pub fee_rate: f64,
    pub buyer_address: String,
    pub links: Vec<SaleChainLink>,
    pub setup: Option<SetupTx>,
    /// Amounts re-derived from the transactions, not the API's figures.
    pub verified: SaleChainVerification,
    /// The build's `expires_at`; nothing is signed or submitted at or past it.
    pub expires_at: String,
    /// The build's own total (`economics.buyer_total_sats`).
    pub quoted_total_sat: u64,
    /// The quoted total plus the caller's tolerance.
    pub max_total_sat: u64,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Turn a build response into a verified quote (no network). Refuses a
/// build that is not passthrough v4, names another co-signer, has the wrong
/// number of sales, delivers elsewhere, lacks an expiry or total, or whose
/// transactions fail [`verify_passthrough_purchase`] within `max_total_sat`.
pub fn quote_from_build(
    built: &BuildSecurePurchaseResponse,
    items: &[PlannedItem],
    buyer_address: &str,
    fee_rate: f64,
    budget_tolerance_sat: u64,
) -> Result<PassthroughQuote> {
    let invalid =
        |m: &str| refuse::<PassthroughQuote>("invalid_sale", format!("{m}; refusing to sign"));
    if built.policy.as_deref() != Some(PASSTHROUGH_POLICY) {
        return invalid("The build did not return a passthrough v4 sale");
    }
    if built
        .cosigner_public_key
        .as_deref()
        .is_some_and(|k| !k.is_empty())
        && !cosigner_pinned(built.cosigner_public_key.as_deref())
    {
        return refuse(
            "cosigner_key_unpinned",
            "The build names a co-signer other than the one built into this SDK; refusing to sign",
        );
    }
    if built.sales.len() != items.len() {
        return invalid("The build returned the wrong number of sales");
    }
    if built
        .recipient_address
        .as_deref()
        .is_some_and(|r| !r.is_empty() && r != buyer_address)
    {
        return invalid("The build would deliver to an address other than this wallet");
    }
    let mut links = Vec::with_capacity(items.len());
    for (row, item) in built.sales.iter().zip(items) {
        if !is_hex64(&row.sale_txid) || !is_hex64(&row.parent.txid) {
            return invalid("The build returned a malformed sale");
        }
        links.push(SaleChainLink {
            sale_txid: row.sale_txid.to_lowercase(),
            sale_psbt_hex: row.psbt.clone(),
            parent: SaleParent {
                txid: row.parent.txid.to_lowercase(),
                raw: row.parent.raw.clone(),
                source_outpoint: row.parent.source_outpoint.clone(),
            },
            listing: SaleListing {
                outpoint: item.outpoint.clone(),
                seller_address: item.seller_address.clone(),
                creator_address: item.creator_address.clone(),
                satoshi_price: item.price_sat,
                escrow_price_sat: item.escrow_price_sat,
            },
        });
    }
    let setup = match &built.setup {
        Some(s) if is_hex64(&s.txid) => Some(SetupTx {
            txid: s.txid.to_lowercase(),
            psbt: s.psbt.clone(),
        }),
        Some(_) => return invalid("The build returned a malformed setup transaction"),
        None => None,
    };
    let Some(expires_at) = built
        .expires_at
        .clone()
        .filter(|e| parse_iso8601_ms(e).is_some())
    else {
        return invalid("The build did not say when its quote expires");
    };
    let quoted_total_sat = built
        .economics
        .as_ref()
        .and_then(|e| e.buyer_total_sats)
        .filter(|&t| t > 0 && t <= MAX_SAFE_INTEGER);
    let Some(quoted_total_sat) = quoted_total_sat else {
        return invalid("The build did not state what the purchase costs");
    };
    let max_total_sat = quoted_total_sat + budget_tolerance_sat;
    let verified = verify_passthrough_purchase(&PurchaseCheck {
        links: links.clone(),
        setup: setup.clone(),
        buyer_address: buyer_address.into(),
        fee_rate_sat_vb: fee_rate,
        expires_at: Some(QuoteExpiry::Text(expires_at.clone())),
        max_total_sat: Some(max_total_sat),
        ..Default::default()
    })?;
    Ok(PassthroughQuote {
        items: items.to_vec(),
        fee_rate,
        buyer_address: buyer_address.into(),
        links,
        setup,
        verified,
        expires_at,
        quoted_total_sat,
        max_total_sat,
    })
}

/// Build a protected purchase of `items` (all protected listings) for the
/// key's taproot address and verify every transaction in it. Signs nothing.
/// `budget_tolerance_sat`: how far the verified total may exceed the build's
/// quoted total (0 refuses any excess).
pub fn quote_protected_purchase(
    client: &Client,
    items: &[PlannedItem],
    fee_rate: f64,
    key: &SigningKey,
    budget_tolerance_sat: u64,
) -> Result<PassthroughQuote> {
    if items.is_empty() {
        return refuse("no_outpoints", "Select at least one item");
    }
    if items.len() > MAX_PROTECTED_ITEMS_PER_PURCHASE {
        return refuse(
            "too_many_items",
            format!(
                "Up to {MAX_PROTECTED_ITEMS_PER_PURCHASE} protected items can be bought together"
            ),
        );
    }
    require_passthrough_support(client)?;
    let address = key.p2tr_address();
    let built = client
        .secure_purchase()
        .build(&BuildSecurePurchaseRequest {
            outpoints: items.iter().map(|i| i.outpoint.clone()).collect(),
            protocol: "ordinal".into(),
            from: address.clone(),
            public_key: key.public_key_hex(),
            to: None,
            fee_rate,
            wallet_type: Some(WALLET_TYPE.into()),
        })?;
    quote_from_build(&built, items, &address, fee_rate, budget_tolerance_sat)
}

/// Sales signed by the buyer, ready for [`submit_protected_purchase`].
#[derive(Clone, Debug, PartialEq)]
pub struct SignedPassthroughPurchase {
    /// Carried from the quote: submit refuses at or past it.
    pub expires_at: String,
    pub request: SubmitSecurePurchaseRequest,
}

/// Verify the quote again, then sign the setup (if any) and, in every sale,
/// only the inputs verification identified as the buyer's. Sends nothing.
pub fn sign_protected_purchase(
    quote: &PassthroughQuote,
    key: &SigningKey,
) -> Result<SignedPassthroughPurchase> {
    let verified = verify_passthrough_purchase(&PurchaseCheck {
        links: quote.links.clone(),
        setup: quote.setup.clone(),
        buyer_address: quote.buyer_address.clone(),
        fee_rate_sat_vb: quote.fee_rate,
        expires_at: Some(QuoteExpiry::Text(quote.expires_at.clone())),
        max_total_sat: Some(quote.max_total_sat),
        ..Default::default()
    })?;
    let signed_setup = match (&quote.setup, &verified.setup) {
        (Some(s), Some(v)) => Some(sign_own_inputs(&s.psbt, &v.buyer_inputs, key)?),
        _ => None,
    };
    let mut sales = Vec::with_capacity(quote.links.len());
    for (i, link) in quote.links.iter().enumerate() {
        sales.push(SubmitSecurePurchaseLink {
            sale_txid: link.sale_txid.clone(),
            psbt: sign_own_inputs(&link.sale_psbt_hex, &verified.links[i].buyer_inputs, key)?,
            setup_psbt: if i == 0 { signed_setup.clone() } else { None },
        });
    }
    Ok(SignedPassthroughPurchase {
        expires_at: quote.expires_at.clone(),
        request: SubmitSecurePurchaseRequest { sales },
    })
}

/// Hand the signed sales to the marketplace, which co-signs the escrow
/// inputs and broadcasts. Refuses a quote at or past its expiry.
pub fn submit_protected_purchase(
    client: &Client,
    signed: &SignedPassthroughPurchase,
) -> Result<SubmitSecurePurchaseResponse> {
    assert_quote_fresh(Some(&QuoteExpiry::Text(signed.expires_at.clone())), None)?;
    let result = client.secure_purchase().submit(&signed.request)?;
    if !result.accepted {
        return refuse(
            "submit_rejected",
            "The marketplace did not accept the protected purchase",
        );
    }
    Ok(result)
}

// ─── listing ────────────────────────────────────────────────────────

/// Whether protected listing is on for inscriptions right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListingAvailability {
    pub available: bool,
    pub reason: Option<String>,
    /// Smallest postage protection accepts (at least 330).
    pub min_postage_sat: u64,
}

/// Whether protected listing is available. Fails, rather than falling back,
/// when the API names a co-signer other than the pinned one.
pub fn protected_listing_availability(client: &Client) -> Result<ListingAvailability> {
    let caps = client.secure_purchase().capabilities()?;
    let min_postage_sat = MIN_ESCROW_VALUE_SATS.max(caps.min_postage_sats.unwrap_or(0));
    let unavailable = |reason: String| {
        Ok(ListingAvailability {
            available: false,
            reason: Some(reason),
            min_postage_sat,
        })
    };
    let policy = policy_of(&caps);
    if policy != Some(PASSTHROUGH_POLICY) {
        return unavailable(format!(
            "the marketplace reports protection policy \"{}\"",
            policy.unwrap_or("none")
        ));
    }
    if !cosigner_pinned(caps.cosigner_public_key.as_deref()) {
        return refuse(
            "cosigner_key_unpinned",
            "The marketplace co-signer key does not match the key built into this SDK; refusing to list.",
        );
    }
    if caps.listing_enabled == Some(false) {
        return unavailable("protected listing is turned off".into());
    }
    if let Some(status) = caps.protocol_status.as_ref().and_then(|s| s.get("ordinal")) {
        if !status.is_empty() && status != "enabled" {
            return unavailable(format!("protection for inscriptions is {status}"));
        }
    }
    Ok(ListingAvailability {
        available: true,
        reason: None,
        min_postage_sat,
    })
}

/// An item to list with protection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListingItem {
    /// `txid:vout` the item sits on.
    pub outpoint: String,
    /// What the seller receives.
    pub price_sats: u64,
    pub inscription_id: Option<String>,
}

/// A per-item refusal from building, signing or authorizing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListingFailure {
    pub outpoint: String,
    pub inscription_id: Option<String>,
    pub code: String,
    pub message: String,
}

/// Templates for one item, ready to verify and sign.
#[derive(Clone, Debug, PartialEq)]
pub struct BuiltListing {
    pub item: ListingItem,
    pub row: SecureListingRow,
}

fn failure(item: &ListingItem, code: &str, message: impl Into<String>) -> ListingFailure {
    ListingFailure {
        outpoint: item.outpoint.clone(),
        inscription_id: item.inscription_id.clone(),
        code: code.into(),
        message: message.into(),
    }
}

/// Build templates for protected items. Rows are matched by outpoint, never
/// by position; per-item refusals come back as failures.
pub fn build_protected_listings(
    client: &Client,
    items: &[ListingItem],
    key: &SigningKey,
) -> Result<(Vec<BuiltListing>, Vec<ListingFailure>)> {
    if items.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let res = client
        .secure_listing()
        .build_bulk(&SecureListingBuildBulkRequest {
            protocol: "ordinal".into(),
            seller_address: key.p2tr_address(),
            seller_public_key: key.public_key_hex(),
            items: items
                .iter()
                .map(|i| SecureListingBuildItem {
                    outpoint: i.outpoint.clone(),
                    escrow_price_sats: i.price_sats,
                })
                .collect(),
            attempt_id: None,
        })?;
    let (mut built, mut failures) = (Vec::new(), Vec::new());
    for item in items {
        let row = res
            .items
            .iter()
            .find(|r| r.outpoint.to_lowercase() == item.outpoint.to_lowercase());
        let Some(row) = row else {
            failures.push(failure(
                item,
                "invalid_listing_build",
                "The build returned no templates for this item",
            ));
            continue;
        };
        if row.is_error() {
            let code = row
                .code
                .clone()
                .unwrap_or_else(|| "secure_listing_rejected".into());
            failures.push(failure(
                item,
                &code,
                format!("The listing build was refused ({code})"),
            ));
        } else if row.state.as_deref() != Some("authorization_required")
            || row.psbt.is_none()
            || row.sale_psbt.is_none()
        {
            failures.push(failure(
                item,
                "invalid_listing_build",
                "The build did not return both templates",
            ));
        } else if row.policy.as_deref() != Some(PASSTHROUGH_POLICY) {
            failures.push(failure(
                item,
                "unsafe_listing_policy",
                format!(
                    "Listing policy \"{}\" is not supported",
                    row.policy.as_deref().unwrap_or("")
                ),
            ));
        } else if !cosigner_pinned(row.cosigner_public_key.as_deref()) {
            failures.push(failure(
                item,
                "cosigner_key_unpinned",
                "The template names a co-signer other than the pinned one",
            ));
        } else if row.escrow_price_sats != Some(item.price_sats) {
            failures.push(failure(
                item,
                "listing_price_mismatch",
                format!(
                    "The template is for {:?} sats, not {}",
                    row.escrow_price_sats, item.price_sats
                ),
            ));
        } else {
            built.push(BuiltListing {
                item: item.clone(),
                row: row.clone(),
            });
        }
    }
    Ok((built, failures))
}

/// Verify every template against an escrow rebuilt from the key and the
/// pinned co-signer, then sign. A template that fails verification is
/// reported, never signed. Sends nothing.
pub fn sign_protected_listings(
    built: &[BuiltListing],
    key: &SigningKey,
) -> (Vec<SecureListingAuthorizeItem>, Vec<ListingFailure>) {
    let address = key.p2tr_address();
    let (mut payloads, mut failures) = (Vec::new(), Vec::new());
    for b in built {
        let check = ListingTemplateCheck {
            passthrough_psbt_hex: b.row.psbt.clone().unwrap_or_default(),
            sale_psbt_hex: b.row.sale_psbt.clone().unwrap_or_default(),
            expected_outpoint: b.item.outpoint.clone(),
            seller_address: address.clone(),
            expected_seller_sats: b.item.price_sats,
            asset_address: Some(address.clone()),
        };
        match sign_listing_templates(&check, key) {
            Ok(signed) => {
                if b.row
                    .passthrough_txid
                    .as_deref()
                    .is_some_and(|t| !t.is_empty() && t.to_lowercase() != signed.passthrough_txid)
                {
                    failures.push(failure(
                        &b.item,
                        "stale_listing",
                        "Passthrough txid does not match its template",
                    ));
                    continue;
                }
                payloads.push(SecureListingAuthorizeItem {
                    outpoint: b.item.outpoint.clone(),
                    protocol: "ordinal".into(),
                    seller_public_key: key.public_key_hex(),
                    template_digest: b.row.template_digest.clone().unwrap_or_default(),
                    psbt: signed.psbt,
                    sale_psbt: signed.sale_psbt,
                    escrow_price_sats: Some(b.item.price_sats),
                    attempt_id: None,
                });
            }
            Err(e) => failures.push(failure(&b.item, &e.code, e.message)),
        }
    }
    (payloads, failures)
}

/// A listing that went live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedItem {
    pub outpoint: String,
    pub passthrough_txid: Option<String>,
}

/// Publish signed templates. Returns the outpoints now listed (with their
/// passthrough txids) and the per-item refusals.
pub fn authorize_protected_listings(
    client: &Client,
    payloads: &[SecureListingAuthorizeItem],
) -> Result<(Vec<ListedItem>, Vec<ListingFailure>)> {
    if payloads.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let res = client.secure_listing().authorize_bulk(payloads)?;
    let (mut listed, mut failures) = (Vec::new(), Vec::new());
    for p in payloads {
        let item = ListingItem {
            outpoint: p.outpoint.clone(),
            price_sats: p.escrow_price_sats.unwrap_or(0),
            inscription_id: None,
        };
        let row = res
            .items
            .iter()
            .find(|r| r.outpoint.to_lowercase() == p.outpoint.to_lowercase());
        match row {
            None => failures.push(failure(
                &item,
                "secure_listing_rejected",
                "No answer for this item",
            )),
            Some(r) if r.is_error() => {
                let code = r
                    .code
                    .clone()
                    .unwrap_or_else(|| "secure_listing_rejected".into());
                failures.push(failure(
                    &item,
                    &code,
                    format!("The listing was refused ({code})"),
                ));
            }
            Some(r) if r.state.as_deref().is_some_and(|s| s != "listed") => {
                failures.push(failure(
                    &item,
                    "listing_not_public",
                    "The listing did not become public",
                ));
            }
            Some(r) => listed.push(ListedItem {
                outpoint: p.outpoint.clone(),
                passthrough_txid: r.passthrough_txid.clone(),
            }),
        }
    }
    Ok((listed, failures))
}

// ─── recovery ───────────────────────────────────────────────────────

/// Ask the API for the recovery of an escrow that confirmed without its sale,
/// verify it against the key's escrow (pinned co-signer) and sign the
/// `<144> CSV` leaf. Never broadcasts: broadcast `rawtx` yourself once the
/// escrow has 144 confirmations.
pub fn recover_protected_listing(
    client: &Client,
    passthrough_txid: &str,
    fee_rate: f64,
    key: &SigningKey,
    destination: Option<&str>,
) -> Result<SignedRecovery> {
    if !is_hex64(passthrough_txid) {
        return refuse(
            "invalid_passthrough_txid",
            "That is not a valid passthrough txid",
        );
    }
    let destination = destination.map_or_else(|| key.p2tr_address(), str::to_string);
    let template = client
        .secure_listing()
        .recover(&SecureListingRecoverRequest {
            passthrough_txid: passthrough_txid.to_lowercase(),
            fee_rate,
            destination: Some(destination.clone()),
        })?;
    Ok(sign_recovery(
        &RecoveryCheck {
            psbt_hex: template.psbt,
            passthrough_txid: passthrough_txid.into(),
            destination_address: destination,
            fee_rate_sat_vb: fee_rate,
        },
        key,
    )?)
}

// ─── delist ───────────────────────────────────────────────────────

/// What to delist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DelistTarget {
    /// A listed inscription (standard or protected).
    Inscription(String),
    /// An outpoint-keyed listing (`txid:vout` or 72-hex).
    Outpoint(String),
}

/// Result of [`delist`].
#[derive(Clone, Debug, PartialEq)]
pub struct DelistResult {
    /// True when the API cancelled a snipe-protected listing.
    pub protected: bool,
    /// The protected listing's key, or the inscription's current location.
    pub outpoint: String,
    /// `outpoint` or `inscription_id`: how the cancel was routed.
    pub routed_by: &'static str,
    pub response: CancelEscrowResponse,
}

fn normalize_outpoint(value: &str) -> Result<String> {
    outpoint_to_txid_vout(value).map_err(|_| {
        Error::Signing(SigningError::new(
            "invalid_outpoint",
            format!("Invalid outpoint: {value}"),
        ))
    })
}

/// Cancel a listing, standard or protected. The API authorizes the cancel
/// with an `/auth/session` token for the address holding the listed item:
/// pass `session_token` (e.g. from a [`crate::auth::SessionManager`]) to
/// delist several items with one sign-in, or this signs in with `key`
/// (BIP-322). Nothing is signed that could be replayed as a transaction.
/// Protected listings route by outpoint, standard ones by inscription id.
pub fn delist(
    client: &Client,
    key: &SigningKey,
    target: &DelistTarget,
    session_token: Option<&str>,
) -> Result<DelistResult> {
    let address = key.p2tr_address();
    let (outpoint, routed_by, inscription_id) = match target {
        DelistTarget::Inscription(id) => {
            let Some(listing) = client.market().listing(id)? else {
                return refuse("not_listed", format!("{id} is not listed."));
            };
            let listing_outpoint = normalize_outpoint(&listing.outpoint)?;
            let status = client
                .secure_listing()
                .status(&listing_outpoint)
                .ok()
                .flatten();
            let is_protected = listing.protected == Some(true)
                || listing.secure_purchase_version == Some(2)
                || status.is_some();
            if !listing.seller_address.is_empty() && listing.seller_address != address {
                return if is_protected {
                    refuse("not_owner_protected", "This item is already listed with protection by another key; delist it from the wallet that listed it.")
                } else {
                    refuse("not_owner", "This wallet does not own this item.")
                };
            }
            if is_protected {
                // Protected rows are keyed by the outpoint the seller listed from.
                (listing_outpoint, "outpoint", Some(id.clone()))
            } else {
                // Standard: the API checks the session against the item's current location.
                let live = client.inscription().outpoint(id)?;
                let outpoint = normalize_outpoint(&live.inscription.outpoint).map_err(|_| {
                    Error::Signing(SigningError::new(
                        "listing_malformed",
                        format!("Could not find where {id} sits; try again."),
                    ))
                })?;
                let owner = if live.owner.is_empty() {
                    &live.inscription.address
                } else {
                    &live.owner
                };
                if !owner.is_empty() && *owner != address {
                    return refuse("not_owner", "This wallet does not own this item.");
                }
                (outpoint, "inscription_id", Some(id.clone()))
            }
        }
        DelistTarget::Outpoint(raw) => (normalize_outpoint(raw)?, "outpoint", None),
    };
    let signature = match session_token {
        Some(t) => t.to_string(),
        None => {
            sign_in_with_key(client, key, Some(&address))
                .map_err(|e| {
                    Error::Signing(SigningError::new(
                        "sign_in_failed",
                        format!("Sign-in failed: {e}"),
                    ))
                })?
                .token
        }
    };
    let req = if routed_by == "outpoint" {
        CancelEscrowRequest {
            outpoint: Some(outpoint.clone()),
            inscription_id: None,
            signature,
        }
    } else {
        CancelEscrowRequest {
            outpoint: None,
            inscription_id,
            signature,
        }
    };
    let response = client.market().cancel_escrow(&req)?;
    if !response.success {
        return refuse(
            "listing_cancellation_not_applied",
            "This listing changed and cannot be cancelled right now. Refresh and try again.",
        );
    }
    Ok(DelistResult {
        protected: response.listing.as_ref().is_some_and(|l| l.secure_v2),
        outpoint,
        routed_by,
        response,
    })
}
