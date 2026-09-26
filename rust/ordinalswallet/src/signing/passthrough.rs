//! Passthrough v4 (snipe-protected listings), buyer side. Port of
//! `@ow-cli/core` `passthrough.ts`.
//!
//! Nothing here trusts the API. Before the wallet signs anything, the sale is
//! checked against the listings the buyer chose, the co-signer key pinned in
//! this build, and the buyer's own address. The buyer then signs ONLY its own
//! inputs, with SIGHASH_DEFAULT or SIGHASH_ALL, and leaves the PSBT
//! unfinalized so the marketplace can co-sign the escrow input.

use std::collections::HashSet;

use bitcoin::psbt::{Input, Psbt};
use bitcoin::taproot::LeafVersion;
use bitcoin::{ScriptBuf, Transaction};

use super::keys::{secp, SigningKey};
use super::offers::two_leaf_output;
use super::psbt::{
    leaf_version_byte, outpoint_string, parse_hex, script_for_address, sighash_field, sign_idx,
    to_psbt_hex, txid_of, witness_items, SIGHASH_ALL, SIGHASH_DEFAULT, TAPSCRIPT_LEAF_VERSION,
};
use super::util::from_hex;
use super::{fail, SigningError};

/// The Ordinals Wallet co-signer key, pinned in the build. Rotating it requires a release.
pub const PINNED_COSIGNER_XONLY_HEX: &str =
    "1d08b7c71f6f1e97a0a4cf005db7a977c85e34652a0c9365842aee25997c7dee";
/// BIP-341's provably unspendable internal key: the escrow has no key path.
pub const NUMS_INTERNAL_KEY_HEX: &str =
    "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
/// Where the marketplace fee is paid. Pinned for the same reason as the co-signer.
pub const MARKET_FEE_ADDRESS: &str =
    "bc1p6yd49679azsaxqgtr52ff6jjvj2wv5dlaqwhaxarkamevgle2jaqs8vlnr";
/// The only escrow policy this SDK speaks.
pub const PASSTHROUGH_POLICY: &str = "passthrough_v4";
/// SIGHASH_SINGLE|ANYONECANPAY: the seller's sale pre-signature.
pub const SIGHASH_SINGLE_ANYONECANPAY: u8 = 0x83;
/// The API refuses longer chains; so do we, before asking.
pub const MAX_PROTECTED_ITEMS_PER_PURCHASE: usize = 12;
/// Ceiling on creator royalties, as a share of the listed prices (basis points).
pub const MAX_CREATOR_ROYALTY_BPS: u64 = 1000;

/// Sighash types the buyer will sign with: DEFAULT and ALL. Nothing else.
const BUYER_SIGHASHES: [u8; 2] = [SIGHASH_DEFAULT, SIGHASH_ALL];
/// Ceiling on one sale's size when capping its network fee.
const MAX_SALE_VBYTES: f64 = 1500.0;
/// 144, minimally encoded.
const RECOVERY_DELAY_BLOCKS_LE: [u8; 2] = [0x90, 0x00];
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

pub(crate) fn parse_psbt(hex: &str, what: &str) -> Result<Psbt, SigningError> {
    parse_hex(hex)
        .ok_or_else(|| SigningError::new("invalid_psbt", format!("{what} is not a valid PSBT")))
}

pub(crate) fn script_for(address: &str) -> Result<ScriptBuf, SigningError> {
    script_for_address(address).ok_or_else(|| {
        SigningError::new(
            "invalid_address",
            format!("Not a valid mainnet address: {address}"),
        )
    })
}

pub(crate) fn outpoint_of(tx: &Transaction, index: usize) -> String {
    outpoint_string(&tx.input[index].previous_output)
}

/// The txid a PSBT will have once signed (every accepted input is native segwit).
pub fn unsigned_txid(psbt_hex: &str) -> Result<String, SigningError> {
    Ok(txid_of(&parse_psbt(psbt_hex, "Transaction")?.unsigned_tx))
}

// ---- escrow -------------------------------------------------------------------

/// A protected listing's escrow, rebuilt locally.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassthroughEscrow {
    /// Sale leaf: `<S> OP_CHECKSIG <C> OP_CHECKSIGADD OP_2 OP_NUMEQUAL`
    pub leaf: Vec<u8>,
    /// Recovery leaf: `<144> OP_CHECKSEQUENCEVERIFY OP_DROP <S> OP_CHECKSIG`
    pub recovery_leaf: Vec<u8>,
    /// scriptPubKey of `tr(NUMS, {leaf, recovery_leaf})`
    pub script: Vec<u8>,
    pub address: String,
    /// Serialized control block for spending `leaf`.
    pub leaf_control_block: Vec<u8>,
    /// Serialized control block for spending `recovery_leaf`.
    pub recovery_control_block: Vec<u8>,
}

/// Rebuild a listing's escrow from the seller key and the pinned co-signer.
pub fn passthrough_escrow(seller_x_only: &[u8]) -> Result<PassthroughEscrow, SigningError> {
    let cosigner = from_hex(PINNED_COSIGNER_XONLY_HEX).expect("constant");
    passthrough_escrow_with(seller_x_only, &cosigner)
}

/// [`passthrough_escrow`] with an explicit co-signer key (verification of a leaf's own keys).
pub fn passthrough_escrow_with(
    seller_x_only: &[u8],
    cosigner_x_only: &[u8],
) -> Result<PassthroughEscrow, SigningError> {
    if seller_x_only.len() != 32 || cosigner_x_only.len() != 32 {
        return fail("invalid_public_key", "Escrow keys must be x-only");
    }
    if seller_x_only == cosigner_x_only {
        return fail(
            "escrow_keys_identical",
            "Seller and co-signer keys must be distinct",
        );
    }
    let mut leaf = vec![0x20];
    leaf.extend_from_slice(seller_x_only);
    leaf.extend_from_slice(&[0xac, 0x20]);
    leaf.extend_from_slice(cosigner_x_only);
    leaf.extend_from_slice(&[0xba, 0x52, 0x9c]);
    let mut recovery = vec![RECOVERY_DELAY_BLOCKS_LE.len() as u8];
    recovery.extend_from_slice(&RECOVERY_DELAY_BLOCKS_LE);
    recovery.extend_from_slice(&[0xb2, 0x75, 0x20]);
    recovery.extend_from_slice(seller_x_only);
    recovery.push(0xac);
    let Some((script, address, info)) = two_leaf_output(&leaf, &recovery) else {
        return fail(
            "invalid_public_key",
            "Seller key is not a valid Taproot key",
        );
    };
    let control = |s: &[u8]| {
        info.control_block(&(ScriptBuf::from_bytes(s.to_vec()), LeafVersion::TapScript))
            .map(|cb| cb.serialize())
    };
    let (Some(leaf_cb), Some(recovery_cb)) = (control(&leaf), control(&recovery)) else {
        return fail(
            "invalid_public_key",
            "Seller key is not a valid Taproot key",
        );
    };
    Ok(PassthroughEscrow {
        leaf,
        recovery_leaf: recovery,
        script: script.into_bytes(),
        address,
        leaf_control_block: leaf_cb,
        recovery_control_block: recovery_cb,
    })
}

/// Both x-only keys of a `multi_a(2, S, C)` leaf, or None if the script is not exactly one.
pub fn parse_passthrough_leaf(leaf: &[u8]) -> Option<([u8; 32], [u8; 32])> {
    if leaf.len() != 70 || leaf[0] != 0x20 || leaf[33] != 0xac || leaf[34] != 0x20 {
        return None;
    }
    if leaf[67] != 0xba || leaf[68] != 0x52 || leaf[69] != 0x9c {
        return None;
    }
    Some((
        leaf[1..33].try_into().expect("32"),
        leaf[35..67].try_into().expect("32"),
    ))
}

// ---- verification -------------------------------------------------------------

/// The passthrough a sale spends: seller-signed or witness-stripped (only its
/// txid, input outpoint and output are read).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SaleParent {
    pub txid: String,
    /// Raw transaction hex.
    pub raw: String,
    pub source_outpoint: Option<String>,
}

/// The listing the buyer chose, from `GET /market/escrow/:id`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SaleListing {
    /// The outpoint the buyer chose (`txid:vout`).
    pub outpoint: String,
    pub seller_address: String,
    pub creator_address: Option<String>,
    /// Buyer-facing price: seller payout + marketplace fee must not exceed it.
    pub satoshi_price: u64,
    /// What the seller listed for (`escrow_price`). When known, the payout
    /// must equal it exactly.
    pub escrow_price_sat: Option<u64>,
}

/// What one verified sale pays and which inputs are the buyer's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaleVerification {
    pub seller_proceeds_sat: u64,
    pub market_fee_sat: u64,
    pub creator_royalty_sat: u64,
    pub network_fee_sat: u64,
    pub change_sat: u64,
    /// Input index of the passthrough (escrow) input. Never signed by the buyer.
    pub passthrough_input: usize,
    /// Output index where the item lands in the buyer's wallet.
    pub asset_output: usize,
    /// The only inputs the buyer signs.
    pub buyer_inputs: Vec<usize>,
    /// Outputs paying the buyer's change; the next link spends these.
    pub change_outputs: Vec<usize>,
    pub sale_txid: String,
}

/// Arguments of [`verify_sale`].
#[derive(Clone, Debug, Default)]
pub struct VerifySaleInput {
    pub sale_psbt_hex: String,
    pub parent: SaleParent,
    pub listing: SaleListing,
    pub buyer_address: String,
    pub fee_rate_sat_vb: f64,
    pub market_fee_address: Option<String>,
    /// Chained sale: every buyer input must spend this earlier transaction…
    pub funding_txid: Option<String>,
    /// …and only these of its outputs (its change).
    pub funding_vouts: Option<Vec<u32>>,
    /// Where the item must land; defaults to `buyer_address`.
    pub recipient_address: Option<String>,
    /// The first link of a chain carries the marketplace fee (default true).
    pub carries_market_fee: Option<bool>,
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

fn max_network_fee(fee_rate: f64) -> f64 {
    (MAX_SALE_VBYTES * fee_rate.max(1.0)).ceil()
}

fn has_final(input: &Input) -> bool {
    input.final_script_witness.is_some()
        || input
            .final_script_sig
            .as_ref()
            .is_some_and(|s| !s.is_empty())
}

fn fmt_rate(rate: f64) -> String {
    format!("{rate}")
}

/// Verify one single-item sale before the buyer signs anything: a parent
/// that spends exactly the chosen outpoint into an escrow whose leaf names
/// the pinned co-signer; a sale input spending that parent's output 0; the
/// output at the same index paying the seller (exactly `escrow_price` when
/// known); an asset output paying the recipient the escrow value at the same
/// sat offset; buyer inputs only at the ends; every other output the
/// marketplace fee, the listed creator's royalty or buyer change; a network
/// fee within cap.
pub fn verify_sale(input: &VerifySaleInput) -> Result<SaleVerification, SigningError> {
    let sale = parse_psbt(&input.sale_psbt_hex, "Sale")?;
    let buyer_script = script_for(&input.buyer_address)?;
    let recipient_script = match non_empty(&input.recipient_address) {
        Some(a) => script_for(a)?,
        None => buyer_script.clone(),
    };
    let market_script =
        script_for(non_empty(&input.market_fee_address).unwrap_or(MARKET_FEE_ADDRESS))?;
    let seller_script = script_for(&input.listing.seller_address)?;
    let creator_script = match non_empty(&input.listing.creator_address) {
        Some(a) => Some(script_for(a)?),
        None => None,
    };
    let cosigner = from_hex(PINNED_COSIGNER_XONLY_HEX).expect("constant");
    let owned_by_buyer = |s: Option<&ScriptBuf>| s == Some(&buyer_script);
    let tx = &sale.unsigned_tx;

    if sale.inputs.len() < 3 {
        return fail(
            "sale_input_count",
            "Sale must spend the passthrough plus at least two of your funding inputs",
        );
    }

    let parent: Transaction = from_hex(&input.parent.raw)
        .and_then(|b| bitcoin::consensus::deserialize(&b).ok())
        .ok_or_else(|| {
            SigningError::new(
                "invalid_parent",
                "Passthrough transaction could not be parsed",
            )
        })?;
    let parent_txid = txid_of(&parent);
    if parent_txid != input.parent.txid.to_lowercase() {
        return fail(
            "parent_txid_mismatch",
            "The passthrough does not hash to its declared txid",
        );
    }

    let mut input_values = Vec::with_capacity(sale.inputs.len());
    for (i, data) in sale.inputs.iter().enumerate() {
        match &data.witness_utxo {
            Some(u) => input_values.push(u.value.to_sat()),
            None => {
                return fail(
                    "missing_witness_utxo",
                    format!("Sale input {i} is missing its prevout"),
                )
            }
        }
    }
    let outputs: Vec<(&ScriptBuf, u64)> = tx
        .output
        .iter()
        .map(|o| (&o.script_pubkey, o.value.to_sat()))
        .collect();

    // Layout: leading buyer inputs, the passthrough, trailing buyer inputs.
    let index = tx
        .input
        .iter()
        .position(|i| i.previous_output.txid.to_string() == parent_txid);
    let index = match index {
        Some(i) if i >= 1 => i,
        _ => {
            return fail(
                "sale_input_count",
                "Sale must start with at least one of your funding inputs",
            )
        }
    };
    if index + 1 >= sale.inputs.len() {
        return fail(
            "sale_input_count",
            "Sale must end with at least one of your fee inputs",
        );
    }
    let buyer_inputs: Vec<usize> = (0..sale.inputs.len()).filter(|&i| i != index).collect();
    for &i in &buyer_inputs {
        let data = &sale.inputs[i];
        if !owned_by_buyer(data.witness_utxo.as_ref().map(|u| &u.script_pubkey)) {
            return fail(
                "funding_not_yours",
                format!("Sale input {i} is not one of your UTXOs"),
            );
        }
        if has_final(data) {
            return fail(
                "funding_prefilled",
                "Your funding input already carries a witness",
            );
        }
        if let Some(t) = sighash_field(data) {
            if t > 0xff || !BUYER_SIGHASHES.contains(&(t as u8)) {
                return fail(
                    "buyer_sighash",
                    format!(
                        "Asked to sign input {i} with sighash 0x{t:02x}; a purchase only ever uses SIGHASH_ALL"
                    ),
                );
            }
        }
        if let Some(funding) = &input.funding_txid {
            let prev = tx.input[i].previous_output;
            let vout_ok = input
                .funding_vouts
                .as_ref()
                .map_or(true, |v| v.contains(&prev.vout));
            if prev.txid.to_string() != funding.to_lowercase() || !vout_ok {
                return fail(
                    "chain_funding_mismatch",
                    format!(
                        "Sale input {i} does not spend the previous transaction's change in this purchase"
                    ),
                );
            }
        }
    }

    // The passthrough input.
    let data = &sale.inputs[index];
    if outpoint_of(tx, index) != format!("{parent_txid}:0") {
        return fail(
            "sale_input_not_passthrough",
            format!("Sale input {index} does not spend a passthrough"),
        );
    }
    if parent.input.len() != 1
        || parent.output.len() != 1
        || outpoint_of(&parent, 0) != input.listing.outpoint.to_lowercase()
    {
        return fail(
            "parent_source_mismatch",
            "The passthrough does not move the item you selected",
        );
    }
    let escrow_out = &parent.output[0];
    let escrow_value = escrow_out.value.to_sat();
    match &data.witness_utxo {
        Some(u)
            if u.script_pubkey == escrow_out.script_pubkey && u.value.to_sat() == escrow_value => {}
        _ => {
            return fail(
                "sale_prevout_mismatch",
                format!("Sale input {index} misstates its passthrough prevout"),
            )
        }
    }
    // Either already co-signed (complete 2-of-2 witness) or carrying the leaf
    // for the marketplace to co-sign at submit.
    let leaf: Vec<u8> = if let Some(witness) = &data.final_script_witness {
        let w = witness_items(witness);
        if w.len() != 4 {
            return fail(
                "sale_witness_shape",
                format!("Sale input {index} witness is not a 2-of-2 script path"),
            );
        }
        if w[0].len() != 64 || w[1].len() != 65 || w[1][64] != SIGHASH_SINGLE_ANYONECANPAY {
            return fail(
                "sale_witness_sighash",
                format!("Sale input {index} signatures have unexpected sighash types"),
            );
        }
        w[2].clone()
    } else {
        let entry = data.tap_scripts.values().find(|(script, ver)| {
            leaf_version_byte(*ver) == TAPSCRIPT_LEAF_VERSION
                && parse_passthrough_leaf(script.as_bytes()).is_some()
        });
        let Some((script, _)) = entry else {
            return fail(
                "sale_not_cosigned",
                format!(
                    "Sale input {index} carries neither a co-signed witness nor its escrow leaf"
                ),
            );
        };
        let nums = from_hex(NUMS_INTERNAL_KEY_HEX).expect("constant");
        if data.tap_internal_key.map(|k| k.serialize().to_vec()) != Some(nums) {
            return fail(
                "sale_template_internal_key",
                format!("Sale input {index} does not use the unspendable escrow key"),
            );
        }
        script.to_bytes()
    };
    let keys = parse_passthrough_leaf(&leaf).filter(|(_, c)| c.as_slice() == cosigner.as_slice());
    let Some((seller_key, cosigner_key)) = keys else {
        return fail(
            "sale_leaf_unpinned",
            format!("Sale input {index} is not co-signed by Ordinals Wallet's pinned key"),
        );
    };
    if passthrough_escrow_with(&seller_key, &cosigner_key)?.script
        != escrow_out.script_pubkey.as_bytes()
    {
        return fail(
            "sale_escrow_mismatch",
            "The passthrough escrow does not match its leaf",
        );
    }

    // Payout at the same index as the passthrough input.
    let payout = outputs.get(index);
    let Some(&(_, payout_value)) = payout.filter(|(s, _)| **s == seller_script) else {
        return fail(
            "sale_payout_mismatch",
            format!("Sale output {index} does not pay the seller of the item"),
        );
    };
    if let Some(listed) = input.listing.escrow_price_sat {
        if payout_value != listed {
            return fail(
                "sale_payout_mismatch",
                format!(
                    "Sale pays the seller {payout_value} sats, not the {listed} sats they listed for"
                ),
            );
        }
    }
    // Asset output at the same sat offset as the passthrough's first sat.
    let in_offset: u64 = input_values[..index].iter().sum();
    let mut running = 0u64;
    let mut asset_output = None;
    for (oi, (_, value)) in outputs.iter().enumerate() {
        if running == in_offset && oi > 1 && asset_output.is_none() {
            asset_output = Some(oi);
        }
        running += value;
    }
    let asset_ok = asset_output.is_some_and(|a| {
        let (script, value) = outputs[a];
        value == escrow_value && *script == recipient_script
    });
    let Some(asset_output) = asset_output.filter(|_| asset_ok) else {
        return fail(
            "sale_asset_mismatch",
            "The item would not land in your wallet on its own sats",
        );
    };

    // Every remaining output: marketplace fee, the listed creator's royalty, or our change.
    let buyer_is_market = owned_by_buyer(Some(&market_script));
    let carries_market_fee = input.carries_market_fee.unwrap_or(true);
    let (mut market_fee_sat, mut creator_royalty_sat, mut change_sat) = (0u64, 0u64, 0u64);
    let mut market_seen = false;
    let mut change_outputs = Vec::new();
    for (oi, &(script, value)) in outputs.iter().enumerate() {
        if oi == asset_output || oi == index {
            continue;
        }
        if oi == 0 {
            if !owned_by_buyer(Some(script)) {
                return fail("sale_change_mismatch", "Sale output 0 is not your change");
            }
            change_sat += value;
            change_outputs.push(oi);
            continue;
        }
        let is_market = *script == market_script;
        let is_fee = is_market && (!buyer_is_market || (carries_market_fee && !market_seen));
        if is_fee {
            market_fee_sat += value;
            market_seen = true;
        } else if creator_script.as_ref() == Some(script) && !owned_by_buyer(Some(script)) {
            creator_royalty_sat += value;
        } else if owned_by_buyer(Some(script)) {
            change_sat += value;
            change_outputs.push(oi);
        } else {
            return fail(
                "sale_unknown_output",
                format!("Sale output {oi} pays an unexpected party"),
            );
        }
    }

    let total_in: i128 = input_values.iter().map(|&v| i128::from(v)).sum();
    let total_out: i128 = outputs.iter().map(|&(_, v)| i128::from(v)).sum();
    let network_fee = total_in - total_out;
    if network_fee <= 0 {
        return fail("sale_fee", "Sale outputs exceed its inputs");
    }
    let cap = max_network_fee(input.fee_rate_sat_vb);
    if network_fee as f64 > cap {
        return fail(
            "sale_fee",
            format!(
                "Sale network fee of {network_fee} sats is above the {cap} sat cap for {} sat/vB",
                fmt_rate(input.fee_rate_sat_vb)
            ),
        );
    }

    Ok(SaleVerification {
        seller_proceeds_sat: payout_value,
        market_fee_sat,
        creator_royalty_sat,
        network_fee_sat: network_fee as u64,
        change_sat,
        passthrough_input: index,
        asset_output,
        buyer_inputs,
        change_outputs,
        sale_txid: txid_of(tx),
    })
}

/// A verified setup transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetupVerification {
    pub txid: String,
    pub fee_sat: u64,
    pub buyer_inputs: Vec<usize>,
    /// Both outputs are the buyer's; the first sale spends them.
    pub change_outputs: Vec<usize>,
}

/// The buyer's setup transaction: their own inputs into exactly two outputs
/// at their own address. Nothing leaves the wallet except the miner fee.
pub fn verify_setup(
    setup_psbt_hex: &str,
    buyer_address: &str,
    fee_rate_sat_vb: f64,
) -> Result<SetupVerification, SigningError> {
    let setup = parse_psbt(setup_psbt_hex, "Setup transaction")?;
    let buyer_script = script_for(buyer_address)?;
    if setup.inputs.is_empty() {
        return fail("setup_input_not_yours", "Setup transaction has no inputs");
    }
    let mut total_in: i128 = 0;
    let mut buyer_inputs = Vec::new();
    for (i, data) in setup.inputs.iter().enumerate() {
        let Some(utxo) = data
            .witness_utxo
            .as_ref()
            .filter(|u| u.script_pubkey == buyer_script)
        else {
            return fail(
                "setup_input_not_yours",
                format!("Setup input {i} is not one of your UTXOs"),
            );
        };
        if has_final(data) {
            return fail("funding_prefilled", "Setup input already carries a witness");
        }
        if let Some(t) = sighash_field(data) {
            if t > 0xff || !BUYER_SIGHASHES.contains(&(t as u8)) {
                return fail(
                    "buyer_sighash",
                    format!("Asked to sign setup input {i} with a sighash other than SIGHASH_ALL"),
                );
            }
        }
        total_in += i128::from(utxo.value.to_sat());
        buyer_inputs.push(i);
    }
    let outs = &setup.unsigned_tx.output;
    if outs.len() != 2 {
        return fail(
            "setup_output_shape",
            "Setup transaction must have exactly two outputs",
        );
    }
    let mut total_out: i128 = 0;
    for o in outs {
        if o.script_pubkey != buyer_script {
            return fail(
                "setup_output_not_yours",
                "Setup transaction pays someone other than you",
            );
        }
        total_out += i128::from(o.value.to_sat());
    }
    let fee = total_in - total_out;
    // ~58 vB per input + ~100 vB base, at the buyer's rate, with headroom.
    let max_fee =
        ((100 + 58 * setup.inputs.len()) as f64 * fee_rate_sat_vb.max(1.0) * 1.5).ceil() + 50.0;
    if fee <= 0 || fee as f64 > max_fee {
        return fail(
            "setup_fee",
            format!("Setup transaction fee of {fee} sats is out of range (cap {max_fee})"),
        );
    }
    Ok(SetupVerification {
        txid: txid_of(&setup.unsigned_tx),
        fee_sat: fee as u64,
        buyer_inputs,
        change_outputs: vec![0, 1],
    })
}

/// One link of a protected purchase, as the build returned it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SaleChainLink {
    pub sale_txid: String,
    pub sale_psbt_hex: String,
    pub parent: SaleParent,
    pub listing: SaleListing,
}

/// The build's setup transaction.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SetupTx {
    pub txid: String,
    pub psbt: String,
}

/// A quote's `expires_at`: RFC 3339 text or unix milliseconds.
#[derive(Clone, Debug, PartialEq)]
pub enum QuoteExpiry {
    Text(String),
    EpochMs(f64),
}

/// Arguments of [`verify_passthrough_purchase`].
#[derive(Clone, Debug, Default)]
pub struct PurchaseCheck {
    pub links: Vec<SaleChainLink>,
    pub setup: Option<SetupTx>,
    pub buyer_address: String,
    pub fee_rate_sat_vb: f64,
    pub market_fee_address: Option<String>,
    /// Where the items must land; defaults to `buyer_address`.
    pub recipient_address: Option<String>,
    /// The quote's `expires_at`. At or past it nothing is signed.
    pub expires_at: Option<QuoteExpiry>,
    /// The most the whole purchase may cost (normally the build's
    /// `economics.buyer_total_sats` plus a tolerance). Re-derived from the
    /// transactions, never taken from the API.
    pub max_total_sat: Option<u64>,
    /// Clock override (unix ms); default now.
    pub now_ms: Option<f64>,
}

/// Totals re-derived from a whole protected purchase.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaleChainVerification {
    pub seller_proceeds_sat: u64,
    pub market_fee_sat: u64,
    pub creator_royalty_sat: u64,
    /// Sales' network fees plus the setup fee.
    pub network_fee_sat: u64,
    pub setup_fee_sat: u64,
    /// Everything the purchase costs.
    pub total_sat: u64,
    pub links: Vec<SaleVerification>,
    pub setup: Option<SetupVerification>,
}

/// A protected purchase is a chain of single-item sales: each spends one
/// passthrough plus buyer inputs, which for every link after the first are
/// the previous link's change. The marketplace fee and royalties sit in the
/// first link; listed prices are checked against the whole chain.
pub fn verify_passthrough_purchase(
    input: &PurchaseCheck,
) -> Result<SaleChainVerification, SigningError> {
    if input.links.is_empty() {
        return fail("invalid_sale", "Sale has no items");
    }
    assert_quote_fresh(input.expires_at.as_ref(), input.now_ms)?;
    if input.links.len() > MAX_PROTECTED_ITEMS_PER_PURCHASE {
        return fail(
            "too_many_items",
            format!(
                "Up to {MAX_PROTECTED_ITEMS_PER_PURCHASE} protected items can be bought together"
            ),
        );
    }
    if !input.fee_rate_sat_vb.is_finite() || input.fee_rate_sat_vb <= 0.0 {
        return fail(
            "invalid_fee_rate",
            "Fee rate must be a positive sat/vB value",
        );
    }
    let mut chosen = HashSet::new();
    for link in &input.links {
        let price = link.listing.satoshi_price;
        if price == 0 || price > MAX_SAFE_INTEGER {
            return fail(
                "listing_price_unknown",
                "Every item needs its listed price before a sale can be checked",
            );
        }
        if !chosen.insert(link.listing.outpoint.to_lowercase()) {
            return fail(
                "invalid_sale",
                "The same listing appears twice in this purchase",
            );
        }
    }

    let setup = match &input.setup {
        Some(s) => {
            let v = verify_setup(&s.psbt, &input.buyer_address, input.fee_rate_sat_vb)?;
            if v.txid != s.txid.to_lowercase() {
                return fail(
                    "invalid_sale",
                    "Setup transaction does not hash to its declared txid",
                );
            }
            Some(v)
        }
        None => None,
    };

    let mut links: Vec<SaleVerification> = Vec::new();
    let mut previous = setup.as_ref().map(|s| s.txid.clone());
    let mut previous_change = setup
        .as_ref()
        .map(|s| s.change_outputs.iter().map(|&v| v as u32).collect());
    for link in &input.links {
        let v = verify_sale(&VerifySaleInput {
            sale_psbt_hex: link.sale_psbt_hex.clone(),
            parent: link.parent.clone(),
            listing: link.listing.clone(),
            buyer_address: input.buyer_address.clone(),
            fee_rate_sat_vb: input.fee_rate_sat_vb,
            market_fee_address: input.market_fee_address.clone(),
            funding_txid: previous.clone(),
            funding_vouts: previous_change.clone(),
            recipient_address: input.recipient_address.clone(),
            carries_market_fee: Some(links.is_empty()),
        })?;
        if v.sale_txid != link.sale_txid.to_lowercase() {
            return fail(
                "invalid_sale",
                format!(
                    "Sale {} does not hash to its declared txid",
                    links.len() + 1
                ),
            );
        }
        previous = Some(v.sale_txid.clone());
        previous_change = Some(v.change_outputs.iter().map(|&o| o as u32).collect());
        links.push(v);
    }

    let sum = |f: fn(&SaleVerification) -> u64| links.iter().map(f).sum::<u64>();
    let seller_proceeds_sat = sum(|v| v.seller_proceeds_sat);
    let market_fee_sat = sum(|v| v.market_fee_sat);
    let creator_royalty_sat = sum(|v| v.creator_royalty_sat);
    let network_fee_sat = sum(|v| v.network_fee_sat);
    let listed_sat: u64 = input.links.iter().map(|l| l.listing.satoshi_price).sum();
    if seller_proceeds_sat + market_fee_sat > listed_sat {
        return fail(
            "sale_overcharge",
            format!(
                "Sale charges {} sats for items listed at {listed_sat} sats",
                seller_proceeds_sat + market_fee_sat
            ),
        );
    }
    let max_royalty = (listed_sat * MAX_CREATOR_ROYALTY_BPS).div_ceil(10_000);
    if creator_royalty_sat > max_royalty {
        return fail(
            "sale_royalty",
            format!(
                "Creator royalties of {creator_royalty_sat} sats are above the {max_royalty} sat cap"
            ),
        );
    }
    let setup_fee_sat = setup.as_ref().map_or(0, |s| s.fee_sat);
    let total_sat = seller_proceeds_sat
        + market_fee_sat
        + creator_royalty_sat
        + network_fee_sat
        + setup_fee_sat;
    if let Some(max) = input.max_total_sat {
        if max == 0 || max > MAX_SAFE_INTEGER {
            return fail(
                "invalid_budget",
                "The spend cap must be a positive number of sats",
            );
        }
        if total_sat > max {
            return fail(
                "over_budget",
                format!(
                    "This purchase costs {total_sat} sats, above the {max} sat cap for the quote"
                ),
            );
        }
    }
    Ok(SaleChainVerification {
        seller_proceeds_sat,
        market_fee_sat,
        creator_royalty_sat,
        network_fee_sat: network_fee_sat + setup_fee_sat,
        setup_fee_sat,
        total_sat,
        links,
        setup,
    })
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Refuse a quote at or past its `expires_at`. An unreadable expiry counts as
/// expired. Text is read as RFC 3339 / ISO 8601 (`YYYY-MM-DD`, or a date-time
/// with `Z` or a `±HH:MM` offset); anything else is unreadable.
pub fn assert_quote_fresh(
    expires_at: Option<&QuoteExpiry>,
    now: Option<f64>,
) -> Result<(), SigningError> {
    let Some(expires_at) = expires_at else {
        return Ok(());
    };
    let at = match expires_at {
        QuoteExpiry::EpochMs(ms) => Some(*ms).filter(|m| m.is_finite()),
        QuoteExpiry::Text(s) => parse_iso8601_ms(s),
    };
    let Some(at) = at else {
        return fail(
            "quote_expired",
            "The quote has no readable expiry; build it again",
        );
    };
    if now.unwrap_or_else(now_ms) >= at {
        return fail(
            "quote_expired",
            "The quote has expired; build the purchase again",
        );
    }
    Ok(())
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok())?
}

/// Unix milliseconds of an ISO 8601 date or date-time with an explicit zone,
/// the subset of `Date.parse` the API uses (V8 rules: `T`, `t` or a space
/// between date and time, `Z`/`z` or `±HH:MM`/`±HHMM`, any number of
/// fraction digits truncated to milliseconds, day 1-31 rolling over like V8).
/// A date-time without a zone (local time in JavaScript) is unreadable here.
pub(crate) fn parse_iso8601_ms(s: &str) -> Option<f64> {
    let (date, rest) = match s.find(['T', 't', ' ']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let dp: Vec<&str> = date.split('-').collect();
    if dp.len() != 3 || dp[0].len() != 4 || dp[1].len() != 2 || dp[2].len() != 2 {
        return None;
    }
    let (y, mo, d) = (digits(dp[0])?, digits(dp[1])?, digits(dp[2])?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = days_from_civil(y, mo, d) * 86_400_000;
    let Some(rest) = rest else {
        return Some(ms as f64);
    };
    let (time, offset_ms) = if let Some(t) = rest.strip_suffix(['Z', 'z']) {
        (t, 0)
    } else {
        let i = rest.rfind(['+', '-'])?;
        let (t, off) = (&rest[..i], &rest[i..]);
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let body = &off[1..];
        let (oh, om) = match body.len() {
            5 if body.as_bytes()[2] == b':' => (&body[..2], &body[3..]),
            4 => (&body[..2], &body[2..]),
            _ => return None,
        };
        let (oh, om) = (digits(oh)?, digits(om)?);
        if oh > 23 || om > 59 {
            return None;
        }
        (t, sign * (oh * 3_600_000 + om * 60_000))
    };
    let (hms, frac) = match time.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (time, None),
    };
    let tp: Vec<&str> = hms.split(':').collect();
    if !(2..=3).contains(&tp.len()) || tp.iter().any(|p| p.len() != 2) {
        return None;
    }
    if frac.is_some() && tp.len() != 3 {
        return None;
    }
    let h = digits(tp[0])?;
    let mi = digits(tp[1])?;
    let sec = if tp.len() == 3 { digits(tp[2])? } else { 0 };
    if h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi, sec) != (0, 0)) {
        return None;
    }
    let milli = match frac {
        Some(f) => {
            digits(f)?;
            let padded = format!("{f:0<3}");
            padded[..3].parse::<i64>().ok()?
        }
        None => 0,
    };
    if h == 24 && milli != 0 {
        return None;
    }
    ms += h * 3_600_000 + mi * 60_000 + sec * 1000 + milli - offset_ms;
    Some(ms as f64)
}

// ---- signing ------------------------------------------------------------------

type SignatureState = (Option<Vec<u8>>, Vec<Vec<u8>>, Vec<Vec<u8>>, Vec<Vec<u8>>);

fn signature_state(input: &Input) -> SignatureState {
    (
        input.tap_key_sig.map(|s| s.to_vec()),
        input.tap_script_sigs.values().map(|s| s.to_vec()).collect(),
        input.partial_sigs.values().map(|s| s.to_vec()).collect(),
        input
            .final_script_witness
            .as_ref()
            .map(witness_items)
            .unwrap_or_default(),
    )
}

/// Sign exactly `indexes`, each of which must be the key's own key-path P2TR
/// input, with SIGHASH_DEFAULT or SIGHASH_ALL. Nothing is finalized; every
/// other input comes out as it went in. Returns PSBT hex.
pub fn sign_own_inputs(
    psbt: &str,
    indexes: &[usize],
    key: &SigningKey,
) -> Result<String, SigningError> {
    let mut tx = parse_psbt(psbt, "Transaction")?;
    let script = ScriptBuf::new_p2tr(secp(), key.xonly(), None);
    let txid_before = txid_of(&tx.unsigned_tx);
    if indexes.is_empty() {
        return fail(
            "missing_buyer_input",
            "Transaction spends none of this wallet's inputs; refusing to sign",
        );
    }
    let others: Vec<usize> = (0..tx.inputs.len())
        .filter(|i| !indexes.contains(i))
        .collect();
    let before: Vec<SignatureState> = others
        .iter()
        .map(|&i| signature_state(&tx.inputs[i]))
        .collect();

    for &i in indexes {
        let Some(data) = tx.inputs.get(i) else {
            return fail(
                "funding_not_yours",
                format!("Input {i} is not one of this wallet's UTXOs; refusing to sign it"),
            );
        };
        if data.witness_utxo.as_ref().map(|u| &u.script_pubkey) != Some(&script) {
            return fail(
                "funding_not_yours",
                format!("Input {i} is not one of this wallet's UTXOs; refusing to sign it"),
            );
        }
        if let Some(t) = sighash_field(data) {
            if t > 0xff || !BUYER_SIGHASHES.contains(&(t as u8)) {
                return fail(
                    "buyer_sighash",
                    format!(
                        "Input {i} asks for a sighash other than SIGHASH_ALL; refusing to sign it"
                    ),
                );
            }
        }
        if !data.tap_scripts.is_empty() {
            return fail(
                "buyer_script_path",
                format!("Input {i} asks for a script-path signature; refusing to sign it"),
            );
        }
        tx.inputs[i].tap_internal_key = Some(key.xonly());
        sign_idx(&mut tx, i, key, &BUYER_SIGHASHES).map_err(|e| {
            SigningError::new("sign_failed", format!("Could not sign input {i}: {e}"))
        })?;
        let Some(sig) = tx.inputs[i].tap_key_sig else {
            return fail("sign_failed", format!("Could not sign input {i}"));
        };
        let bytes = sig.to_vec();
        if bytes.len() == 65 && bytes[64] != SIGHASH_ALL {
            return fail(
                "buyer_sighash",
                format!("Input {i} was signed with an unexpected sighash"),
            );
        }
    }

    for (position, &i) in others.iter().enumerate() {
        if signature_state(&tx.inputs[i]) != before[position] {
            return fail(
                "foreign_input_changed",
                format!("Input {i} is not ours but changed while signing"),
            );
        }
    }
    if txid_of(&tx.unsigned_tx) != txid_before {
        return fail("sale_mismatch", "Transaction changed while signing");
    }
    Ok(to_psbt_hex(&tx))
}
