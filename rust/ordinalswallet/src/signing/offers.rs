//! Client-side checks and signing for Offers v1 PSBTs (port of
//! `@ow-cli/core` `offers-verify.ts`).
//!
//! The server builds every PSBT; these helpers rebuild what each one must
//! look like from values the caller already trusts (their own keys and
//! addresses, the agreed price, the pinned co-signer key) and refuse to sign
//! anything else. `verify_*` return every broken rule (empty = OK); `sign_*`
//! verify first and refuse with [`SigningError::problems`] set.
//!
//! Escrow: `tr(NUMS, {multi_a(2, buyer, OW), and(older(delay), pk(buyer))})`
//! with sale leaf `<buyer> CHECKSIG <OW> CHECKSIGADD 2 NUMEQUAL`.

use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::XOnlyPublicKey;
use bitcoin::taproot::TaprootBuilder;
use bitcoin::{Address, Network, ScriptBuf};

use super::keys::{secp, SigningKey};
use super::psbt::{
    finalize_idx, leaf_version_byte, outpoint_string, parse_hex_or_base64, script_for_address,
    sighash_field, sign_idx, to_psbt_hex, SIGHASH_ALL, SIGHASH_DEFAULT, TAPSCRIPT_LEAF_VERSION,
};
use super::util::from_hex;
use super::SigningError;

/// Ordinals Wallet's escrow co-signer (x-only). Pinned so a compromised API cannot swap it.
pub const OW_COSIGNER_XONLY: &str =
    "1d08b7c71f6f1e97a0a4cf005db7a977c85e34652a0c9365842aee25997c7dee";
/// Where the marketplace fee is paid.
pub const OW_MARKET_FEE_ADDRESS: &str =
    "bc1p6yd49679azsaxqgtr52ff6jjvj2wv5dlaqwhaxarkamevgle2jaqs8vlnr";
/// BIP-341 provably unspendable internal key `H`.
pub const NUMS_INTERNAL_KEY: &str =
    "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

const SIGHASH_NONE_ANYONECANPAY: u8 = 0x82;

/// `item`, `collection` or `trait`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfferScope {
    Item,
    Collection,
    Trait,
}

impl OfferScope {
    /// Parses the API's `scope` string.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "item" => Some(Self::Item),
            "collection" => Some(Self::Collection),
            "trait" => Some(Self::Trait),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Item => "item",
            Self::Collection => "collection",
            Self::Trait => "trait",
        }
    }
}

/// An offer escrow: both leaves and the P2TR output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OfferEscrow {
    pub sale_leaf: Vec<u8>,
    pub recovery_leaf: Vec<u8>,
    pub script: Vec<u8>,
    pub address: String,
}

fn invalid(code: &str, message: impl Into<String>) -> SigningError {
    SigningError::new(code, message)
}

fn x_only_bytes(key: &[u8]) -> Result<[u8; 32], SigningError> {
    let slice = match key.len() {
        33 => &key[1..],
        32 => key,
        n => {
            return Err(invalid(
                "invalid_public_key",
                format!("Invalid public key length {n}"),
            ))
        }
    };
    Ok(slice.try_into().expect("32 bytes"))
}

/// Minimal script-number push, as `Script.encode` writes a number.
pub(crate) fn push_script_number(out: &mut Vec<u8>, n: u32) {
    match n {
        0 => out.push(0x00),
        1..=16 => out.push(0x50 + n as u8),
        _ => {
            let mut bytes = Vec::new();
            let mut v = n;
            while v > 0 {
                bytes.push((v & 0xff) as u8);
                v >>= 8;
            }
            if bytes.last().is_some_and(|b| b & 0x80 != 0) {
                bytes.push(0);
            }
            out.push(bytes.len() as u8);
            out.extend_from_slice(&bytes);
        }
    }
}

pub(crate) fn nums_key() -> XOnlyPublicKey {
    XOnlyPublicKey::from_slice(&from_hex(NUMS_INTERNAL_KEY).expect("constant")).expect("valid")
}

/// Two-leaf taproot output over the NUMS key: (script, address, spend info).
pub(crate) fn two_leaf_output(
    a: &[u8],
    b: &[u8],
) -> Option<(ScriptBuf, String, bitcoin::taproot::TaprootSpendInfo)> {
    let info = TaprootBuilder::new()
        .add_leaf(1, ScriptBuf::from_bytes(a.to_vec()))
        .ok()?
        .add_leaf(1, ScriptBuf::from_bytes(b.to_vec()))
        .ok()?
        .finalize(secp(), nums_key())
        .ok()?;
    let output_key = info.output_key();
    let script = ScriptBuf::new_p2tr_tweaked(output_key);
    let address = Address::p2tr_tweaked(output_key, Network::Bitcoin).to_string();
    Some((script, address, info))
}

/// The offer escrow's sale leaf and recovery leaf, and its P2TR output.
/// `buyer_public_key` is 33-byte compressed or 32-byte x-only.
pub fn offer_escrow(
    buyer_public_key: &[u8],
    recovery_delay_blocks: u32,
) -> Result<OfferEscrow, SigningError> {
    offer_escrow_with(buyer_public_key, recovery_delay_blocks, OW_COSIGNER_XONLY)
}

fn offer_escrow_with(
    buyer_public_key: &[u8],
    recovery_delay_blocks: u32,
    cosigner_hex: &str,
) -> Result<OfferEscrow, SigningError> {
    let buyer = x_only_bytes(buyer_public_key)?;
    let cosigner = from_hex(cosigner_hex)
        .filter(|c| c.len() == 32)
        .ok_or_else(|| invalid("invalid_public_key", "Invalid co-signer key"))?;
    let mut sale = vec![0x20];
    sale.extend_from_slice(&buyer);
    sale.extend_from_slice(&[0xac, 0x20]);
    sale.extend_from_slice(&cosigner);
    sale.extend_from_slice(&[0xba, 0x52, 0x9c]);
    let mut recovery = Vec::new();
    push_script_number(&mut recovery, recovery_delay_blocks);
    recovery.extend_from_slice(&[0xb2, 0x75, 0x20]);
    recovery.extend_from_slice(&buyer);
    recovery.push(0xac);
    let (script, address, _) = two_leaf_output(&sale, &recovery)
        .ok_or_else(|| invalid("invalid_public_key", "Could not build the offer escrow"))?;
    Ok(OfferEscrow {
        sale_leaf: sale,
        recovery_leaf: recovery,
        script: script.into_bytes(),
        address,
    })
}

/// Expected pre-sign sighash per scope: 0x01 for item offers, 0x82 for collection/trait.
pub fn expected_presign_sighash(scope: OfferScope) -> u8 {
    match scope {
        OfferScope::Item => SIGHASH_ALL,
        _ => SIGHASH_NONE_ANYONECANPAY,
    }
}

fn parse(psbt: &str) -> Result<Psbt, SigningError> {
    parse_hex_or_base64(psbt).ok_or_else(|| invalid("invalid_psbt", "Not a valid PSBT"))
}

fn address_script(address: &str) -> Result<ScriptBuf, SigningError> {
    script_for_address(address).ok_or_else(|| {
        invalid(
            "invalid_address",
            format!("Not a valid mainnet address: {address}"),
        )
    })
}

fn opt_amount(v: Option<u64>) -> String {
    v.map_or_else(|| "undefined".to_string(), |v| v.to_string())
}

fn opt_u32(v: Option<u32>) -> String {
    v.map_or_else(|| "undefined".to_string(), |v| v.to_string())
}

/// Check that input `idx` is the offer escrow spent on its sale leaf with the pinned co-signer.
fn check_escrow_input(
    tx: &Psbt,
    idx: usize,
    buyer_public_key: &[u8],
    recovery_delay_blocks: u32,
    escrow_value: Option<u64>,
    problems: &mut Vec<String>,
) -> Result<(), SigningError> {
    if idx >= tx.inputs.len() {
        problems.push(format!("sign_input_index {idx} out of range"));
        return Ok(());
    }
    let input = &tx.inputs[idx];
    let escrow = offer_escrow(buyer_public_key, recovery_delay_blocks)?;
    let utxo = input.witness_utxo.as_ref();
    if utxo.map(|u| u.script_pubkey.as_bytes()) != Some(escrow.script.as_slice()) {
        problems.push(format!(
            "input {idx} is not this offer's escrow (co-signer must be {}…)",
            &OW_COSIGNER_XONLY[..8]
        ));
    }
    if let Some(value) = escrow_value {
        let amount = utxo.map(|u| u.value.to_sat());
        if amount != Some(value) {
            problems.push(format!(
                "escrow input value {} != expected {value}",
                opt_amount(amount)
            ));
        }
    }
    let leaves: Vec<_> = input.tap_scripts.values().collect();
    if leaves.len() != 1 {
        problems.push(format!(
            "escrow input must carry exactly the sale leaf (found {} leaves)",
            leaves.len()
        ));
    } else {
        let (script, ver) = leaves[0];
        if leaf_version_byte(*ver) != TAPSCRIPT_LEAF_VERSION
            || script.as_bytes() != escrow.sale_leaf.as_slice()
        {
            problems.push(
                "escrow input leaf is not the 2-of-2 sale leaf with the pinned co-signer".into(),
            );
        }
    }
    Ok(())
}

// ─── Buyer: funding ─────────────────────────────────────────────────

/// What a funding PSBT must do.
#[derive(Clone, Debug)]
pub struct FundingExpectations {
    /// Buyer key that owns the escrow (33-byte compressed or x-only).
    pub buyer_public_key: Vec<u8>,
    /// Address funding the offer; all inputs must be from it, change may only return to it.
    pub payment_address: String,
    /// From the build response.
    pub escrow_value: u64,
    pub recovery_delay_blocks: u32,
    /// Refuse if the funding transaction's miner fee exceeds this.
    pub max_miner_fee_sats: Option<u64>,
}

/// Verify a funding PSBT pays exactly `escrow_value` into this offer's escrow
/// and nothing else leaves the wallet.
pub fn verify_funding_psbt(
    psbt: &str,
    expect: &FundingExpectations,
) -> Result<Vec<String>, SigningError> {
    let tx = parse(psbt)?;
    verify_funding(&tx, expect)
}

fn verify_funding(tx: &Psbt, expect: &FundingExpectations) -> Result<Vec<String>, SigningError> {
    let mut problems = Vec::new();
    let escrow = offer_escrow(&expect.buyer_public_key, expect.recovery_delay_blocks)?;
    let mine = address_script(&expect.payment_address)?;
    let mut in_sum: i128 = 0;
    for (i, inp) in tx.inputs.iter().enumerate() {
        let utxo = inp.witness_utxo.as_ref();
        if utxo.map(|u| &u.script_pubkey) != Some(&mine) {
            problems.push(format!(
                "funding input {i} is not from {}",
                expect.payment_address
            ));
        }
        in_sum += i128::from(utxo.map_or(0, |u| u.value.to_sat()));
    }
    let mut escrow_outputs = 0;
    let mut out_sum: i128 = 0;
    for (i, out) in tx.unsigned_tx.output.iter().enumerate() {
        out_sum += i128::from(out.value.to_sat());
        if out.script_pubkey.as_bytes() == escrow.script.as_slice() {
            escrow_outputs += 1;
            if out.value.to_sat() != expect.escrow_value {
                problems.push(format!(
                    "escrow output {} != escrow_value {}",
                    out.value.to_sat(),
                    expect.escrow_value
                ));
            }
        } else if out.script_pubkey != mine {
            problems.push(format!("funding output {i} pays an unexpected script"));
        }
    }
    if escrow_outputs != 1 {
        problems.push(format!(
            "expected exactly one escrow output, found {escrow_outputs}"
        ));
    }
    let fee = in_sum - out_sum;
    if fee < 0 {
        problems.push("funding outputs exceed inputs".into());
    }
    if let Some(max) = expect.max_miner_fee_sats {
        if fee > i128::from(max) {
            problems.push(format!("funding miner fee {fee} exceeds max {max}"));
        }
    }
    Ok(problems)
}

/// Verify and sign an offer's funding PSBT (key path or P2WPKH; every input
/// is the buyer's) and finalize it. Returns PSBT hex for `offers.prepare` /
/// `offers.activate`.
pub fn sign_offer_funding(
    psbt: &str,
    key: &SigningKey,
    expect: &FundingExpectations,
) -> Result<String, SigningError> {
    let mut tx = parse(psbt)?;
    let problems = verify_funding(&tx, expect)?;
    if !problems.is_empty() {
        return Err(SigningError::offer(problems));
    }
    let taproot = address_script(&expect.payment_address)?.is_p2tr();
    for i in 0..tx.inputs.len() {
        if taproot {
            tx.inputs[i].tap_internal_key = Some(key.xonly());
        }
        sign_idx(&mut tx, i, key, &[SIGHASH_DEFAULT, SIGHASH_ALL])
            .map_err(|e| invalid("sign_failed", e))?;
        finalize_idx(&mut tx, i).map_err(|e| invalid("sign_failed", e))?;
    }
    Ok(to_psbt_hex(&tx))
}

// ─── Buyer: pre-signature on the escrow leaf ────────────────────────

/// What the acceptance template from `offers.prepare` (or `batch_accept`) must be.
#[derive(Clone, Debug)]
pub struct PresignParams {
    pub scope: OfferScope,
    /// From the prepare response.
    pub sign_input_index: usize,
    pub sighash: u32,
    pub recovery_delay_blocks: u32,
    pub escrow_value: u64,
    /// Item offers only: the template must deliver the item here…
    pub buyer_address: Option<String>,
    /// …pay exactly this much to the seller…
    pub price_sats: Option<u64>,
    /// …and exactly this to the marketplace.
    pub market_fee_sats: Option<u64>,
}

/// Check the acceptance template the buyer pre-signs (the buyer key is `key`).
pub fn verify_presign_psbt(
    psbt: &str,
    key: &SigningKey,
    p: &PresignParams,
) -> Result<Vec<String>, SigningError> {
    let tx = parse(psbt)?;
    verify_presign(&tx, key, p)
}

fn verify_presign(
    tx: &Psbt,
    key: &SigningKey,
    p: &PresignParams,
) -> Result<Vec<String>, SigningError> {
    let mut problems = Vec::new();
    let expected = u32::from(expected_presign_sighash(p.scope));
    if p.sighash != u32::from(SIGHASH_ALL) && p.sighash != u32::from(SIGHASH_NONE_ANYONECANPAY) {
        problems.push(format!("sighash 0x{:x} is not 0x01 or 0x82", p.sighash));
    } else if p.sighash != expected {
        problems.push(format!(
            "sighash 0x{:x} does not match {} scope (0x{expected:x})",
            p.sighash,
            p.scope.name()
        ));
    }
    let buyer = key.x_only_public_key();
    check_escrow_input(
        tx,
        p.sign_input_index,
        &buyer,
        p.recovery_delay_blocks,
        Some(p.escrow_value),
        &mut problems,
    )?;
    if let Some(input) = tx.inputs.get(p.sign_input_index) {
        let requested = sighash_field(input);
        if requested != Some(expected) {
            problems.push(format!(
                "escrow input requests sighash {}, expected 0x{expected:x}",
                opt_u32(requested)
            ));
        }
    }
    if p.scope == OfferScope::Item {
        let (Some(buyer_address), Some(price), Some(market_fee)) =
            (&p.buyer_address, p.price_sats, p.market_fee_sats)
        else {
            problems.push(
                "item offers need buyerAddress, priceSats and marketFeeSats to check the sale"
                    .into(),
            );
            return Ok(problems);
        };
        if tx.inputs.len() != 2 || p.sign_input_index != 1 {
            problems.push("item sale must be [item, escrow]".into());
        }
        let outs = &tx.unsigned_tx.output;
        if outs.len() != 3 {
            problems.push(format!(
                "item sale must have 3 outputs, found {}",
                outs.len()
            ));
        } else {
            let (item, seller, fee) = (&outs[0], &outs[1], &outs[2]);
            let item_in = tx.inputs.first().and_then(|i| i.witness_utxo.as_ref());
            if item.script_pubkey != address_script(buyer_address)? {
                problems.push("output 0 does not deliver the item to you".into());
            }
            if let Some(item_in) = item_in {
                if item.value != item_in.value {
                    problems.push("output 0 does not carry the whole item output".into());
                }
            }
            if seller.value.to_sat() != price {
                problems.push(format!(
                    "seller output {} != price {price}",
                    seller.value.to_sat()
                ));
            }
            if fee.script_pubkey != address_script(OW_MARKET_FEE_ADDRESS)? {
                problems.push("output 2 is not the marketplace fee".into());
            }
            if fee.value.to_sat() != market_fee {
                problems.push(format!("fee output {} != {market_fee}", fee.value.to_sat()));
            }
        }
    } else if tx.inputs.len() != 1 || p.sign_input_index != 0 {
        problems.push("collection/trait pre-sign template must spend only the escrow".into());
    }
    Ok(problems)
}

fn sign_leaf_input(
    tx: &mut Psbt,
    idx: usize,
    key: &SigningKey,
    sighash: u8,
) -> Result<(), SigningError> {
    sign_idx(tx, idx, key, &[sighash]).map_err(|e| invalid("sign_failed", e))?;
    let ours = key.xonly();
    if !tx.inputs[idx]
        .tap_script_sigs
        .keys()
        .any(|(k, _)| *k == ours)
    {
        return Err(invalid(
            "sign_failed",
            "escrow leaf signature missing after signing",
        ));
    }
    Ok(())
}

/// Verify and pre-sign the escrow input of the acceptance template from
/// `offers.prepare` (or `batch_accept`): that one input, on the sale leaf,
/// with the scope's sighash. Returns PSBT hex for `offers.activate`.
pub fn sign_offer_presign(
    psbt: &str,
    key: &SigningKey,
    p: &PresignParams,
) -> Result<String, SigningError> {
    let mut tx = parse(psbt)?;
    let problems = verify_presign(&tx, key, p)?;
    if !problems.is_empty() {
        return Err(SigningError::offer(problems));
    }
    sign_leaf_input(&mut tx, p.sign_input_index, key, p.sighash as u8)?;
    Ok(to_psbt_hex(&tx))
}

// ─── Seller: accept / fill ──────────────────────────────────────────

/// What a `build-accept` / `build-fill` PSBT must do for the seller.
#[derive(Clone, Debug)]
pub struct AcceptExpectations {
    /// The seller's address holding the item (receives the price).
    pub my_address: String,
    /// `txid:vout` of the item being sold.
    pub inscription_outpoint: String,
    /// Minimum the seller must receive.
    pub price_sats: u64,
    /// If known, the item must go exactly here (`offer.buyer_address`).
    pub buyer_address: Option<String>,
    /// If known, change may only go here (`offer.buyer_payment_address`).
    pub buyer_payment_address: Option<String>,
}

/// Seller-side rules for `build-accept` / `build-fill` PSBTs: input 0 is the
/// seller's item and no other input is the seller's; output 0 carries the
/// whole item to the buyer; one output pays the seller at least the price;
/// exactly one output pays the marketplace fee; at most one other output
/// (buyer change); input 0 signs with SIGHASH_ALL. Returns every problem.
pub fn verify_accept_psbt(
    psbt: &str,
    expect: &AcceptExpectations,
) -> Result<Vec<String>, SigningError> {
    let tx = parse(psbt)?;
    verify_accept(&tx, expect)
}

fn verify_accept(tx: &Psbt, expect: &AcceptExpectations) -> Result<Vec<String>, SigningError> {
    let mut problems = Vec::new();
    let mine = address_script(&expect.my_address)?;
    let fee_script = address_script(OW_MARKET_FEE_ADDRESS)?;
    if tx.inputs.is_empty() {
        return Ok(vec!["no inputs".into()]);
    }
    let item = &tx.inputs[0];
    let item_outpoint = outpoint_string(&tx.unsigned_tx.input[0].previous_output);
    if item_outpoint != expect.inscription_outpoint {
        problems.push(format!(
            "input 0 is {item_outpoint}, not your item {}",
            expect.inscription_outpoint
        ));
    }
    let item_utxo = item.witness_utxo.as_ref();
    if item_utxo.map(|u| &u.script_pubkey) != Some(&mine) {
        problems.push("input 0 is not held by your address".into());
    }
    if let Some(t) = sighash_field(item) {
        if t != u32::from(SIGHASH_ALL) && t != u32::from(SIGHASH_DEFAULT) {
            problems.push(format!(
                "input 0 requests sighash {t}; only SIGHASH_ALL is allowed"
            ));
        }
    }
    for (i, input) in tx.inputs.iter().enumerate().skip(1) {
        if input.witness_utxo.as_ref().map(|u| &u.script_pubkey) == Some(&mine) {
            problems.push(format!("input {i} also spends from your address"));
        }
    }
    let outs = &tx.unsigned_tx.output;
    if outs.is_empty() {
        problems.push("no outputs".into());
        return Ok(problems);
    }
    let delivery = &outs[0];
    if delivery.script_pubkey == mine {
        problems.push("output 0 returns the item to you instead of the buyer".into());
    }
    if let Some(u) = item_utxo {
        if delivery.value != u.value {
            problems.push(
                "output 0 does not carry the whole item output (inscription could land elsewhere)"
                    .into(),
            );
        }
    }
    if let Some(buyer) = expect.buyer_address.as_deref().filter(|s| !s.is_empty()) {
        if delivery.script_pubkey != address_script(buyer)? {
            problems.push("output 0 does not deliver the item to the offer buyer".into());
        }
    }
    let rest = &outs[1..];
    if !rest
        .iter()
        .any(|o| o.script_pubkey == mine && o.value.to_sat() >= expect.price_sats)
    {
        problems.push(format!(
            "no output pays you at least {} sats",
            expect.price_sats
        ));
    }
    if rest.iter().filter(|o| o.script_pubkey == mine).count() > 1 {
        problems.push("more than one output pays you".into());
    }
    let fees = rest
        .iter()
        .filter(|o| o.script_pubkey == fee_script)
        .count();
    if fees != 1 {
        problems.push(format!(
            "expected exactly one marketplace fee output, found {fees}"
        ));
    }
    let others: Vec<_> = rest
        .iter()
        .filter(|o| o.script_pubkey != mine && o.script_pubkey != fee_script)
        .collect();
    if others.len() > 1 {
        problems.push(format!(
            "unexpected extra outputs ({}); only buyer change is allowed",
            others.len()
        ));
    }
    if let (1, Some(change)) = (
        others.len(),
        expect
            .buyer_payment_address
            .as_deref()
            .filter(|s| !s.is_empty()),
    ) {
        if others[0].script_pubkey != address_script(change)? {
            problems.push("extra output is not buyer change to the offer payment address".into());
        }
    }
    Ok(problems)
}

/// Verify an accept/fill PSBT with [`verify_accept_psbt`], then sign input 0
/// only (P2TR key path, SIGHASH_ALL) and set its final witness. Returns PSBT
/// hex for `offers.accept` / `offers.fill`.
pub fn sign_accept_psbt(
    psbt: &str,
    key: &SigningKey,
    expect: &AcceptExpectations,
) -> Result<String, SigningError> {
    let mut tx = parse(psbt)?;
    let mut problems = verify_accept(&tx, expect)?;
    if !address_script(&expect.my_address)?.is_p2tr() {
        problems.push("signAcceptPsbt signs taproot (bc1p) items only".into());
    }
    if !problems.is_empty() {
        return Err(SigningError::offer(problems));
    }
    tx.inputs[0].tap_internal_key = Some(key.xonly());
    tx.inputs[0].sighash_type = Some(bitcoin::psbt::PsbtSighashType::from_u32(u32::from(
        SIGHASH_ALL,
    )));
    sign_idx(&mut tx, 0, key, &[SIGHASH_ALL]).map_err(|e| invalid("sign_failed", e))?;
    let sig = tx.inputs[0]
        .tap_key_sig
        .ok_or_else(|| invalid("sign_failed", "item input signature missing after signing"))?;
    tx.inputs[0].final_script_witness = Some(bitcoin::Witness::from_slice(&[sig.to_vec()]));
    Ok(to_psbt_hex(&tx))
}

// ─── Buyer: cancel ──────────────────────────────────────────────────

/// What the refund from `offers.build_cancel` must do.
#[derive(Clone, Debug)]
pub struct CancelParams {
    pub buyer_payment_address: String,
    pub escrow_value: u64,
    pub recovery_delay_blocks: u32,
    /// Refuse if the refund pays more than this in miner fee.
    pub max_miner_fee_sats: Option<u64>,
}

/// Check the refund: the escrow's sale leaf, SIGHASH_ALL, one output to the
/// buyer's payment address, fee within the cap. The buyer key is `key`.
pub fn verify_cancel_psbt(
    psbt: &str,
    key: &SigningKey,
    p: &CancelParams,
) -> Result<Vec<String>, SigningError> {
    let tx = parse(psbt)?;
    verify_cancel(&tx, key, p)
}

fn verify_cancel(
    tx: &Psbt,
    key: &SigningKey,
    p: &CancelParams,
) -> Result<Vec<String>, SigningError> {
    let mut problems = Vec::new();
    if tx.inputs.len() != 1 {
        problems.push("refund must spend only the escrow".into());
    }
    check_escrow_input(
        tx,
        0,
        &key.x_only_public_key(),
        p.recovery_delay_blocks,
        Some(p.escrow_value),
        &mut problems,
    )?;
    if let Some(input) = tx.inputs.first() {
        if sighash_field(input) != Some(u32::from(SIGHASH_ALL)) {
            problems.push("refund must be signed SIGHASH_ALL".into());
        }
    }
    let outs = &tx.unsigned_tx.output;
    if outs.len() != 1 {
        problems.push("refund must have exactly one output".into());
    } else {
        let out = &outs[0];
        if out.script_pubkey != address_script(&p.buyer_payment_address)? {
            problems.push("refund does not go to your payment address".into());
        }
        let fee = i128::from(p.escrow_value) - i128::from(out.value.to_sat());
        if fee < 0 {
            problems.push("refund exceeds escrow".into());
        }
        if let Some(max) = p.max_miner_fee_sats {
            if fee > i128::from(max) {
                problems.push(format!("refund miner fee {fee} exceeds max {max}"));
            }
        }
    }
    Ok(problems)
}

/// Verify and sign the refund from `offers.build_cancel` on the escrow leaf
/// (SIGHASH_ALL). Returns PSBT hex for `offers.cancel`.
pub fn sign_offer_cancel(
    psbt: &str,
    key: &SigningKey,
    p: &CancelParams,
) -> Result<String, SigningError> {
    let mut tx = parse(psbt)?;
    let problems = verify_cancel(&tx, key, p)?;
    if !problems.is_empty() {
        return Err(SigningError::offer(problems));
    }
    sign_leaf_input(&mut tx, 0, key, SIGHASH_ALL)?;
    Ok(to_psbt_hex(&tx))
}
