//! Passthrough v4 (snipe-protected listings), seller side. Port of
//! `@ow-cli/core` `passthrough-listing.ts`.
//!
//! Listing signs two templates the API builds: the passthrough (the item's
//! UTXO into the seller's own escrow, key path, SIGHASH_ALL/DEFAULT) and the
//! sale template (that escrow paying the seller their price, script path,
//! SIGHASH_SINGLE|ANYONECANPAY). Both are checked against an escrow rebuilt
//! here from the seller's key and the pinned co-signer before anything is
//! signed. Nothing is broadcast by listing.

use bitcoin::hashes::Hash;
use bitcoin::psbt::Psbt;
use bitcoin::taproot::{LeafVersion, TapLeafHash};
use bitcoin::{Amount, ScriptBuf, TxOut, Witness};

use super::bip322::tagged_hash;
use super::keys::{verify_schnorr, SigningKey};
use super::passthrough::{
    outpoint_of, parse_psbt, passthrough_escrow, script_for, PassthroughEscrow,
    NUMS_INTERNAL_KEY_HEX, SIGHASH_SINGLE_ANYONECANPAY,
};
use super::psbt::{
    leaf_version_byte, sighash_field, sign_idx, taproot_digest, to_psbt_hex, txid_of, SIGHASH_ALL,
    SIGHASH_DEFAULT, TAPSCRIPT_LEAF_VERSION,
};
use super::util::{from_hex, to_hex};
use super::{fail, SigningError};

/// Taproot dust floor: protection needs at least this much postage.
pub const MIN_ESCROW_VALUE_SATS: u64 = 330;
/// A passthrough may shave exactly this (0.1 sat/vB relay floor) off the postage.
pub const PASSTHROUGH_PARENT_FEE_SATS: u64 = 12;
/// The recovery leaf's relative timelock.
pub const RECOVERY_DELAY_BLOCKS: u32 = 144;
/// Size of the recovery transaction (one script-path input, one P2TR output).
const RECOVERY_VBYTES: f64 = 141.0;
const SELLER_PASSTHROUGH_SIGHASHES: [u8; 2] = [SIGHASH_DEFAULT, SIGHASH_ALL];
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// BIP-341 leaf hash of a tapscript (leaf version 0xc0).
pub fn tap_leaf_hash(script: &[u8]) -> [u8; 32] {
    let mut data = vec![TAPSCRIPT_LEAF_VERSION];
    let mut len = Vec::new();
    bitcoin::consensus::Encodable::consensus_encode(
        &bitcoin::VarInt(script.len() as u64),
        &mut len,
    )
    .expect("vec write");
    data.extend_from_slice(&len);
    data.extend_from_slice(script);
    tagged_hash("TapLeaf", &data)
}

// ---- listing templates ---------------------------------------------------------

/// The two templates a seller signs, and what they must do.
#[derive(Clone, Debug, Default)]
pub struct ListingTemplateCheck {
    pub passthrough_psbt_hex: String,
    pub sale_psbt_hex: String,
    /// `txid:vout` of the item the seller chose to list.
    pub expected_outpoint: String,
    /// Where the sale must pay the seller.
    pub seller_address: String,
    /// The price the seller typed: the sale pays exactly this.
    pub expected_seller_sats: u64,
    /// When given, the passthrough must spend an output at this address.
    pub asset_address: Option<String>,
}

/// What [`assert_listing_templates`] derived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListingTemplates {
    pub escrow: PassthroughEscrow,
    pub escrow_value: u64,
    pub passthrough_txid: String,
}

fn same_key(a: Option<bitcoin::XOnlyPublicKey>, b: &[u8]) -> bool {
    a.is_some_and(|k| k.serialize().as_slice() == b)
}

/// Passthrough: one input, exactly the item; one output, the escrow rebuilt
/// from the seller key and the pinned co-signer; the postage moved whole or
/// less exactly 12 sats; escrow at least 330 sats; key path only,
/// SIGHASH_ALL/DEFAULT. Sale template: that escrow as the only input, one
/// output paying the seller exactly their price, the NUMS internal key, the
/// sale leaf and nothing else, SIGHASH_SINGLE|ANYONECANPAY.
pub fn assert_listing_templates(
    input: &ListingTemplateCheck,
    seller_x_only: &[u8],
) -> Result<ListingTemplates, SigningError> {
    let escrow = passthrough_escrow(seller_x_only)?;
    let seller_script = script_for(&input.seller_address)?;
    if input.expected_seller_sats > MAX_SAFE_INTEGER
        || input.expected_seller_sats < MIN_ESCROW_VALUE_SATS
    {
        return fail(
            "price_below_dust",
            format!("Price must be at least {MIN_ESCROW_VALUE_SATS} sats"),
        );
    }

    let passthrough = parse_psbt(&input.passthrough_psbt_hex, "Passthrough")?;
    if passthrough.inputs.len() != 1 {
        return fail(
            "listing_input_count",
            "Passthrough must spend exactly the item",
        );
    }
    if outpoint_of(&passthrough.unsigned_tx, 0) != input.expected_outpoint.to_lowercase() {
        return fail(
            "listing_input_mismatch",
            "Passthrough spends a different UTXO than the item you selected",
        );
    }
    let source = &passthrough.inputs[0];
    let Some(utxo) = &source.witness_utxo else {
        return fail(
            "missing_witness_utxo",
            "Passthrough input is missing its prevout",
        );
    };
    if let Some(asset) = input.asset_address.as_deref().filter(|a| !a.is_empty()) {
        if utxo.script_pubkey != script_for(asset)? {
            return fail(
                "listing_input_not_yours",
                "Passthrough spends an output that is not at your address",
            );
        }
    }
    if !source.tap_scripts.is_empty() || source.tap_merkle_root.is_some() {
        return fail(
            "listing_script_path",
            "Passthrough asks for a script-path signature on your item",
        );
    }
    if source.tap_internal_key.is_some() && !same_key(source.tap_internal_key, seller_x_only) {
        return fail(
            "listing_internal_key",
            "Passthrough names an internal key other than your wallet key",
        );
    }
    if let Some(t) = sighash_field(source) {
        if t > 0xff || !SELLER_PASSTHROUGH_SIGHASHES.contains(&(t as u8)) {
            return fail(
                "listing_sighash",
                "Passthrough must be signed with SIGHASH_ALL",
            );
        }
    }
    if source.final_script_witness.is_some() || source.tap_key_sig.is_some() {
        return fail(
            "listing_prefilled",
            "Passthrough already carries a signature",
        );
    }
    let postage = utxo.value.to_sat();
    if passthrough.unsigned_tx.output.len() != 1 {
        return fail(
            "listing_output_shape",
            "Passthrough has an unexpected output",
        );
    }
    let escrow_out = &passthrough.unsigned_tx.output[0];
    if escrow_out.script_pubkey.as_bytes() != escrow.script.as_slice() {
        return fail(
            "listing_escrow_mismatch",
            "Passthrough does not send the item to your own passthrough escrow",
        );
    }
    let escrow_value = escrow_out.value.to_sat();
    let shaved = i128::from(postage) - i128::from(escrow_value);
    if (shaved != 0 && shaved != i128::from(PASSTHROUGH_PARENT_FEE_SATS))
        || escrow_value < MIN_ESCROW_VALUE_SATS
    {
        return fail(
            "listing_postage_mismatch",
            format!(
                "Passthrough must move the postage whole (or shave exactly {PASSTHROUGH_PARENT_FEE_SATS} sats); it moves {escrow_value} of {postage} sats"
            ),
        );
    }
    let passthrough_txid = txid_of(&passthrough.unsigned_tx);

    let sale = parse_psbt(&input.sale_psbt_hex, "Sale template")?;
    assert_sale_template_shape(
        &sale,
        &escrow,
        escrow_value,
        &passthrough_txid,
        &seller_script,
        input.expected_seller_sats,
    )?;
    let sale_input = &sale.inputs[0];
    if !sale_input.tap_script_sigs.is_empty()
        || sale_input.tap_key_sig.is_some()
        || sale_input.final_script_witness.is_some()
    {
        return fail(
            "sale_template_prefilled",
            "Sale template already carries a signature",
        );
    }
    Ok(ListingTemplates {
        escrow,
        escrow_value,
        passthrough_txid,
    })
}

fn assert_sale_template_shape(
    sale: &Psbt,
    escrow: &PassthroughEscrow,
    escrow_value: u64,
    passthrough_txid: &str,
    seller_script: &ScriptBuf,
    price_sats: u64,
) -> Result<(), SigningError> {
    if sale.inputs.len() != 1 || sale.unsigned_tx.output.len() != 1 {
        return fail(
            "sale_template_shape",
            "Sale template must have one input and one output",
        );
    }
    if outpoint_of(&sale.unsigned_tx, 0) != format!("{passthrough_txid}:0") {
        return fail(
            "sale_template_input",
            "Sale template does not spend the passthrough output",
        );
    }
    let input = &sale.inputs[0];
    match &input.witness_utxo {
        Some(u)
            if u.script_pubkey.as_bytes() == escrow.script.as_slice()
                && u.value.to_sat() == escrow_value => {}
        _ => {
            return fail(
                "sale_template_prevout",
                "Sale template prevout is not the passthrough escrow",
            )
        }
    }
    if sighash_field(input) != Some(u32::from(SIGHASH_SINGLE_ANYONECANPAY)) {
        return fail(
            "sale_template_sighash",
            "Sale template must be signed with SIGHASH_SINGLE|ANYONECANPAY (0x83)",
        );
    }
    // Exactly the sale leaf, with the control block this escrow implies.
    let only_sale_leaf = input.tap_scripts.len() == 1
        && input.tap_scripts.iter().all(|(cb, (script, ver))| {
            leaf_version_byte(*ver) == TAPSCRIPT_LEAF_VERSION
                && script.as_bytes() == escrow.leaf.as_slice()
                && cb.serialize() == escrow.leaf_control_block
        });
    if !only_sale_leaf {
        return fail(
            "sale_template_leaf",
            "Sale template does not carry exactly your escrow sale leaf",
        );
    }
    let nums = from_hex(NUMS_INTERNAL_KEY_HEX).expect("constant");
    if !same_key(input.tap_internal_key, &nums) {
        return fail(
            "sale_template_internal_key",
            "Sale template internal key is not the unspendable escrow key",
        );
    }
    let payout = &sale.unsigned_tx.output[0];
    if payout.script_pubkey != *seller_script {
        return fail(
            "listing_payout_mismatch",
            "Sale template pays someone other than your wallet",
        );
    }
    if payout.value.to_sat() != price_sats {
        return fail(
            "listing_price_mismatch",
            format!(
                "Sale template pays {} sats, not the {price_sats} you asked for",
                payout.value.to_sat()
            ),
        );
    }
    Ok(())
}

fn escrow_prevout(escrow: &PassthroughEscrow, value: u64) -> TxOut {
    TxOut {
        value: Amount::from_sat(value),
        script_pubkey: ScriptBuf::from_bytes(escrow.script.clone()),
    }
}

fn leaf_digest(
    tx: &Psbt,
    escrow: &PassthroughEscrow,
    escrow_value: u64,
    leaf: &[u8],
    sighash: u8,
) -> Result<[u8; 32], SigningError> {
    taproot_digest(
        &tx.unsigned_tx,
        &[escrow_prevout(escrow, escrow_value)],
        0,
        sighash,
        Some((
            &ScriptBuf::from_bytes(leaf.to_vec()),
            LeafVersion::TapScript,
        )),
    )
    .map_err(|e| SigningError::new("sign_failed", e))
}

/// What a signed sale template must match.
#[derive(Clone, Debug, Default)]
pub struct SignedSaleTemplateExpectation {
    pub passthrough_txid: String,
    pub escrow_value: u64,
    pub seller_address: String,
    pub price_sats: u64,
}

/// Check a signed sale template and return the form the API accepts: the
/// seller's 65-byte 0x83 script-path signature over the sale leaf, valid for
/// the key, and no key-path signature (a stray one is dropped). Returns the
/// input unchanged when nothing had to be dropped.
pub fn assert_signed_sale_template(
    signed_sale_psbt_hex: &str,
    seller_x_only: &[u8],
    e: &SignedSaleTemplateExpectation,
) -> Result<String, SigningError> {
    let escrow = passthrough_escrow(seller_x_only)?;
    let mut sale = parse_psbt(signed_sale_psbt_hex, "Signed sale template")?;
    assert_sale_template_shape(
        &sale,
        &escrow,
        e.escrow_value,
        &e.passthrough_txid.to_lowercase(),
        &script_for(&e.seller_address)?,
        e.price_sats,
    )?;
    let input = &sale.inputs[0];
    let leaf_hash = tap_leaf_hash(&escrow.leaf);
    let mine: Vec<_> = input
        .tap_script_sigs
        .iter()
        .filter(|((pk, lh), _)| {
            pk.serialize().as_slice() == seller_x_only && lh.to_byte_array() == leaf_hash
        })
        .collect();
    if mine.len() != 1 {
        let code = if input.tap_key_sig.is_some() {
            "sale_signed_on_key_path"
        } else {
            "sale_unsigned"
        };
        return fail(
            code,
            "Sale template carries no script-path signature from your key",
        );
    }
    if input.tap_script_sigs.len() != 1 {
        return fail(
            "sale_template_mutated",
            "Sale template carries signatures other than yours",
        );
    }
    let signature = mine[0].1.to_vec();
    if signature.len() != 65 || signature[64] != SIGHASH_SINGLE_ANYONECANPAY {
        return fail(
            "sale_template_sighash",
            "Sale signature does not commit with SIGHASH_SINGLE|ANYONECANPAY",
        );
    }
    let digest = leaf_digest(
        &sale,
        &escrow,
        e.escrow_value,
        &escrow.leaf,
        SIGHASH_SINGLE_ANYONECANPAY,
    )?;
    if !verify_schnorr(&signature[..64], digest, seller_x_only) {
        return fail(
            "sale_presignature_invalid",
            "Sale signature does not verify for your key",
        );
    }
    if input.final_script_witness.is_some() {
        return fail(
            "sale_template_mutated",
            "Sale template must not be finalized",
        );
    }
    if input.tap_key_sig.is_some() {
        sale.inputs[0].tap_key_sig = None;
        return Ok(to_psbt_hex(&sale));
    }
    Ok(signed_sale_psbt_hex.to_string())
}

/// Both templates, signed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedListingTemplates {
    /// Passthrough PSBT with the key-path signature, unfinalized.
    pub psbt: String,
    /// Sale template PSBT with the script-path pre-signature.
    pub sale_psbt: String,
    pub passthrough_txid: String,
    pub escrow_value: u64,
}

/// Verify both templates, then sign: the passthrough on the key path (the
/// wallet's usual tweaked key) with SIGHASH_DEFAULT/ALL, the sale on the sale
/// leaf only, untweaked, with SIGHASH_SINGLE|ANYONECANPAY. Nothing else is
/// signed and nothing is finalized.
pub fn sign_listing_templates(
    input: &ListingTemplateCheck,
    key: &SigningKey,
) -> Result<SignedListingTemplates, SigningError> {
    let seller = key.x_only_public_key();
    let checked = assert_listing_templates(input, &seller)?;

    // Passthrough: key path, our own P2TR output.
    let mut passthrough = parse_psbt(&input.passthrough_psbt_hex, "Passthrough")?;
    passthrough.inputs[0].tap_internal_key = Some(key.xonly());
    sign_idx(&mut passthrough, 0, key, &SELLER_PASSTHROUGH_SIGHASHES).map_err(|e| {
        SigningError::new(
            "sign_failed",
            format!("Could not sign the passthrough: {e}"),
        )
    })?;
    let key_sig = passthrough.inputs[0].tap_key_sig.map(|s| s.to_vec());
    let Some(key_sig) = key_sig.filter(|_| passthrough.inputs[0].tap_script_sigs.is_empty()) else {
        return fail(
            "sign_failed",
            "Could not sign the passthrough on the key path; is the item at this wallet's address?",
        );
    };
    if key_sig.len() != 64 && !(key_sig.len() == 65 && key_sig[64] == SIGHASH_ALL) {
        return fail(
            "listing_sighash",
            "Passthrough was signed with an unexpected sighash",
        );
    }
    if txid_of(&passthrough.unsigned_tx) != checked.passthrough_txid {
        return fail(
            "signed_template_mutated",
            "Passthrough changed while signing",
        );
    }

    // Sale template: script path, sale leaf only, no tweak.
    let mut sale = parse_psbt(&input.sale_psbt_hex, "Sale template")?;
    let digest = leaf_digest(
        &sale,
        &checked.escrow,
        checked.escrow_value,
        &checked.escrow.leaf,
        SIGHASH_SINGLE_ANYONECANPAY,
    )?;
    let mut sig = key.sign_schnorr(digest)?.to_vec();
    sig.push(SIGHASH_SINGLE_ANYONECANPAY);
    let sig = bitcoin::taproot::Signature::from_slice(&sig)
        .map_err(|e| SigningError::new("sign_failed", e.to_string()))?;
    let leaf_hash =
        TapLeafHash::from_slice(&tap_leaf_hash(&checked.escrow.leaf)).expect("32 bytes");
    sale.inputs[0]
        .tap_script_sigs
        .insert((key.xonly(), leaf_hash), sig);
    let sale_psbt = assert_signed_sale_template(
        &to_psbt_hex(&sale),
        &seller,
        &SignedSaleTemplateExpectation {
            passthrough_txid: checked.passthrough_txid.clone(),
            escrow_value: checked.escrow_value,
            seller_address: input.seller_address.clone(),
            price_sats: input.expected_seller_sats,
        },
    )?;
    Ok(SignedListingTemplates {
        psbt: to_psbt_hex(&passthrough),
        sale_psbt,
        passthrough_txid: checked.passthrough_txid,
        escrow_value: checked.escrow_value,
    })
}

// ---- recovery -------------------------------------------------------------------

/// What the recovery template from `secure_listing.recover` must do.
#[derive(Clone, Debug, Default)]
pub struct RecoveryCheck {
    pub psbt_hex: String,
    pub passthrough_txid: String,
    pub destination_address: String,
    pub fee_rate_sat_vb: f64,
}

/// What [`assert_recovery_template`] derived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryTemplate {
    pub escrow: PassthroughEscrow,
    pub escrow_value: u64,
    pub value_sat: u64,
    pub fee_sat: u64,
}

/// The seller's unilateral recovery of an escrow that confirmed without its
/// sale: `passthrough:0` back to the seller through the `<144> CSV` leaf.
/// One input, sequence 144, prevout = our escrow; one output to our
/// destination; the fee within the requested rate.
pub fn assert_recovery_template(
    input: &RecoveryCheck,
    seller_x_only: &[u8],
) -> Result<RecoveryTemplate, SigningError> {
    let escrow = passthrough_escrow(seller_x_only)?;
    let tx = parse_psbt(&input.psbt_hex, "Recovery")?;
    if tx.inputs.len() != 1 || tx.unsigned_tx.output.len() != 1 {
        return fail(
            "recovery_shape",
            "Recovery must have one input and one output",
        );
    }
    if tx.unsigned_tx.version.0 < 2 {
        return fail(
            "recovery_version",
            "Recovery must be a version 2 transaction for its timelock to apply",
        );
    }
    if outpoint_of(&tx.unsigned_tx, 0) != format!("{}:0", input.passthrough_txid.to_lowercase()) {
        return fail(
            "recovery_input",
            "Recovery does not spend this passthrough's escrow",
        );
    }
    let data = &tx.inputs[0];
    let Some(utxo) = data
        .witness_utxo
        .as_ref()
        .filter(|u| u.script_pubkey.as_bytes() == escrow.script.as_slice())
    else {
        return fail("recovery_prevout", "Recovery does not spend your escrow");
    };
    if tx.unsigned_tx.input[0].sequence.0 != RECOVERY_DELAY_BLOCKS {
        return fail(
            "recovery_sequence",
            format!("Recovery input must wait {RECOVERY_DELAY_BLOCKS} blocks"),
        );
    }
    if let Some(t) = sighash_field(data) {
        if t != u32::from(SIGHASH_DEFAULT) && t != u32::from(SIGHASH_ALL) {
            return fail(
                "recovery_sighash",
                "Recovery must be signed with SIGHASH_DEFAULT",
            );
        }
    }
    let out = &tx.unsigned_tx.output[0];
    if out.script_pubkey != script_for(&input.destination_address)? {
        return fail(
            "recovery_destination",
            "Recovery pays somewhere other than your destination",
        );
    }
    let escrow_value = utxo.value.to_sat();
    let value_sat = out.value.to_sat();
    let fee = i128::from(escrow_value) - i128::from(value_sat);
    let max_fee = (input.fee_rate_sat_vb.max(1.0) * RECOVERY_VBYTES).ceil() + 1.0;
    if fee <= 0 || fee as f64 > max_fee {
        return fail(
            "recovery_fee",
            format!("Recovery fee of {fee} sats is out of range (cap {max_fee})"),
        );
    }
    if value_sat < MIN_ESCROW_VALUE_SATS {
        return fail("recovery_below_dust", "Recovery output would be dust");
    }
    Ok(RecoveryTemplate {
        escrow,
        escrow_value,
        value_sat,
        fee_sat: fee as u64,
    })
}

/// A signed recovery, ready to broadcast once the escrow has 144 confirmations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedRecovery {
    pub rawtx: String,
    pub txid: String,
    pub value_sat: u64,
    pub fee_sat: u64,
}

/// Verify and sign a recovery on the `<144> CSV` leaf (SIGHASH_DEFAULT) and
/// finalize it. Nothing is broadcast; the network refuses it before the
/// escrow has 144 confirmations.
pub fn sign_recovery(
    input: &RecoveryCheck,
    key: &SigningKey,
) -> Result<SignedRecovery, SigningError> {
    let seller = key.x_only_public_key();
    let checked = assert_recovery_template(input, &seller)?;
    let tx = parse_psbt(&input.psbt_hex, "Recovery")?;
    let digest = leaf_digest(
        &tx,
        &checked.escrow,
        checked.escrow_value,
        &checked.escrow.recovery_leaf,
        SIGHASH_DEFAULT,
    )?;
    let sig = key.sign_schnorr(digest)?;
    let mut final_tx = tx.unsigned_tx.clone();
    final_tx.input[0].witness = Witness::from_slice(&[
        sig.to_vec(),
        checked.escrow.recovery_leaf.clone(),
        checked.escrow.recovery_control_block.clone(),
    ]);
    Ok(SignedRecovery {
        rawtx: to_hex(&bitcoin::consensus::serialize(&final_tx)),
        txid: final_tx.compute_txid().to_string(),
        value_sat: checked.value_sat,
        fee_sat: checked.fee_sat,
    })
}
