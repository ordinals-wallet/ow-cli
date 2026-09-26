//! Signing vectors shared with the TypeScript SDK, in the repo-root
//! `fixtures/` directory (generated from `@ow-cli/core` by
//! `packages/core/__tests__/shared-vectors/generate.ts`, replayed there by
//! `shared-vectors.test.ts`). Schnorr signatures use all-zero aux randomness,
//! so every signed PSBT and transaction must match byte for byte.

#![cfg(feature = "signing")]

mod common;

use bitcoin::hashes::Hash;
use common::fixture;
use ordinalswallet::signing::bip39::{
    entropy_to_mnemonic, mnemonic_to_entropy, mnemonic_to_seed, validate_mnemonic,
};
use ordinalswallet::signing::cancel_proof::{build_cancel_proof, inspect_cancel_proof};
use ordinalswallet::signing::listing::{
    assert_listing_templates, assert_recovery_template, assert_signed_sale_template,
    sign_listing_templates, sign_recovery, tap_leaf_hash, ListingTemplateCheck, RecoveryCheck,
    SignedSaleTemplateExpectation,
};
use ordinalswallet::signing::offers::{
    offer_escrow, sign_accept_psbt, sign_offer_cancel, sign_offer_funding, sign_offer_presign,
    verify_accept_psbt, verify_cancel_psbt, verify_funding_psbt, verify_presign_psbt,
    AcceptExpectations, CancelParams, FundingExpectations, OfferScope, PresignParams,
};
use ordinalswallet::signing::passthrough::{
    assert_quote_fresh, parse_passthrough_leaf, passthrough_escrow, sign_own_inputs,
    verify_passthrough_purchase, verify_sale, verify_setup, PurchaseCheck, QuoteExpiry,
    SaleChainLink, SaleListing, SaleParent, SaleVerification, SetupTx, VerifySaleInput,
    PINNED_COSIGNER_XONLY_HEX,
};
use ordinalswallet::signing::{bip322, SigningError, SigningKey};
use serde_json::{json, Value};

const ZERO_AUX: [u8; 32] = [0; 32];

fn s(v: &Value) -> &str {
    v.as_str()
        .unwrap_or_else(|| panic!("expected string, got {v}"))
}
fn opt_s(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}
fn u(v: &Value) -> u64 {
    v.as_u64()
        .unwrap_or_else(|| panic!("expected u64, got {v}"))
}
fn f(v: &Value) -> f64 {
    v.as_f64()
        .unwrap_or_else(|| panic!("expected number, got {v}"))
}
fn hex(v: &Value) -> Vec<u8> {
    let t = s(v);
    (0..t.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&t[i..i + 2], 16).unwrap())
        .collect()
}
fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn cases<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is not an array"))
}
fn wif(w: &Value) -> SigningKey {
    SigningKey::from_wif(s(w)).unwrap().with_aux_rand(ZERO_AUX)
}
fn key_hex(k: &Value) -> SigningKey {
    SigningKey::from_secret_bytes(&hex(k))
        .unwrap()
        .with_aux_rand(ZERO_AUX)
}

/// The signing fields of every input of a PSBT, shaped like the TS test's `signedInputs`.
fn signed_inputs(psbt_hex: &str) -> Value {
    let bytes: Vec<u8> = (0..psbt_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&psbt_hex[i..i + 2], 16).unwrap())
        .collect();
    let psbt = bitcoin::psbt::Psbt::deserialize(&bytes).unwrap();
    Value::Array(
        psbt.inputs
            .iter()
            .map(|i| {
                json!({
                    "tap_key_sig": i.tap_key_sig.map(|s| to_hex(&s.to_vec())),
                    "tap_script_sigs": i.tap_script_sigs.iter().map(|((pk, lh), sig)| json!({
                        "public_key": to_hex(&pk.serialize()),
                        "leaf_hash": to_hex(&lh.to_byte_array()),
                        "signature": to_hex(&sig.to_vec()),
                    })).collect::<Vec<_>>(),
                    "partial_sigs": i.partial_sigs.iter().map(|(pk, sig)| json!({
                        "public_key": to_hex(&pk.to_bytes()),
                        "signature": to_hex(&sig.to_vec()),
                    })).collect::<Vec<_>>(),
                    "final_script_witness": i.final_script_witness.as_ref().map(|w| w.iter().map(to_hex).collect::<Vec<_>>()),
                })
            })
            .collect(),
    )
}

fn inputs_of(psbt: &str) -> Value {
    signed_inputs(psbt)
}

fn expect_code<T: std::fmt::Debug>(
    got: Result<T, SigningError>,
    expected: &Value,
    what: &str,
) -> Option<T> {
    if expected["ok"].as_bool().unwrap() {
        match got {
            Ok(v) => Some(v),
            Err(e) => panic!("{what}: expected success, got {} ({})", e.code, e.message),
        }
    } else {
        match got {
            Ok(v) => panic!("{what}: expected {}, got Ok({v:?})", expected["code"]),
            Err(e) => {
                assert_eq!(e.code, s(&expected["code"]), "{what}: {}", e.message);
                None
            }
        }
    }
}

// ─── bip39 / derivation ─────────────────────────────────────────────

#[test]
fn bip39_vectors() {
    let v = fixture("bip39.json");
    for c in cases(&v, "vectors") {
        let m = s(&c["mnemonic"]);
        assert_eq!(entropy_to_mnemonic(&hex(&c["entropy"])).unwrap(), m);
        assert_eq!(to_hex(&mnemonic_to_entropy(m).unwrap()), s(&c["entropy"]));
        assert!(validate_mnemonic(m));
        let seed = mnemonic_to_seed(m, s(&c["passphrase"])).unwrap();
        assert_eq!(to_hex(&seed), s(&c["seed"]), "{m}");
        let root = bitcoin::bip32::Xpriv::new_master(bitcoin::Network::Bitcoin, &seed).unwrap();
        assert_eq!(root.to_string(), s(&c["xprv"]));
    }
    for c in cases(&v, "no_passphrase") {
        assert_eq!(
            to_hex(&mnemonic_to_seed(s(&c["mnemonic"]), "").unwrap()),
            s(&c["seed"])
        );
    }
    for c in cases(&v, "invalid") {
        assert!(!validate_mnemonic(s(&c["mnemonic"])), "{}", c["reason"]);
    }
}

#[test]
fn derivation_vectors() {
    let v = fixture("derivation.json");
    assert_eq!(s(&v["path"]), ordinalswallet::signing::DERIVATION_PATH);
    let fields = |k: &SigningKey| {
        json!({
            "private_key": to_hex(&k.secret_bytes()),
            "public_key": to_hex(&k.public_key()),
            "x_only_public_key": to_hex(&k.x_only_public_key()),
            "p2tr_address": k.p2tr_address(),
            "p2wpkh_address": k.p2wpkh_address(),
        })
    };
    let official = SigningKey::from_mnemonic(s(&v["bip86_official"]["mnemonic"])).unwrap();
    assert_eq!(
        official.p2tr_address(),
        s(&v["bip86_official"]["p2tr_address"])
    );
    for c in cases(&v, "mnemonics") {
        let mut expected = c.clone();
        expected.as_object_mut().unwrap().remove("mnemonic");
        assert_eq!(
            fields(&SigningKey::from_mnemonic(s(&c["mnemonic"])).unwrap()),
            expected
        );
    }
    for c in cases(&v, "wif") {
        let mut expected = c.clone();
        expected.as_object_mut().unwrap().remove("wif");
        assert_eq!(
            fields(&SigningKey::from_wif(s(&c["wif"])).unwrap()),
            expected
        );
    }
    for m in cases(&v, "invalid_mnemonics") {
        assert_eq!(
            SigningKey::from_mnemonic(s(m)).unwrap_err().code,
            "invalid_mnemonic"
        );
    }
}

// ─── bip322 ─────────────────────────────────────────────────────────

#[test]
fn bip322_vectors() {
    let v = fixture("bip322.json");
    for c in cases(&v["official"], "tx_hashes") {
        let msg = s(&c["message"]).as_bytes();
        assert_eq!(to_hex(&bip322::message_hash(msg)), s(&c["message_hash"]));
        let (_, script) = bip322::address_script(s(&c["address"])).unwrap();
        assert_eq!(
            bip322::to_spend_txid(&script, msg),
            s(&c["to_spend_tx_hash"])
        );
    }
    for c in cases(&v["official"], "simple") {
        for sig in cases(c, "bip322_signatures") {
            assert!(bip322::verify_simple(
                s(&c["address"]),
                s(&c["message"]).as_bytes(),
                s(sig)
            ));
        }
        if c["type"] == "p2wpkh" {
            let key = SigningKey::from_wif(s(&c["private_keys"][0])).unwrap();
            let sig =
                bip322::sign_simple(s(&c["address"]), s(&c["message"]).as_bytes(), &key).unwrap();
            let official: Vec<String> = cases(c, "bip322_signatures")
                .iter()
                .map(|x| s(x).trim_start_matches("smp").to_string())
                .collect();
            assert!(
                official.contains(&sig),
                "RFC 6979 P2WPKH signature reproduces an official one"
            );
        }
    }
    for c in cases(&v["official"], "error") {
        assert!(
            !bip322::verify_simple(
                s(&c["address"]),
                s(&c["message"]).as_bytes(),
                s(&c["signature"])
            ),
            "{}",
            c["description"]
        );
    }
    for c in cases(&v, "sign") {
        let key = wif(&c["wif"]);
        let msg = s(&c["message"]);
        assert_eq!(
            bip322::sign_simple(s(&c["address"]), msg.as_bytes(), &key).unwrap(),
            s(&c["signature"]),
            "{}",
            c["description"]
        );
        assert_eq!(
            key.sign_message(s(&c["address"]), msg).unwrap(),
            s(&c["signature"])
        );
        assert!(bip322::verify_simple(
            s(&c["address"]),
            msg.as_bytes(),
            s(&c["signature"])
        ));
    }
    for c in cases(&v, "verify") {
        assert_eq!(
            bip322::verify_simple(
                s(&c["address"]),
                s(&c["message"]).as_bytes(),
                s(&c["signature"])
            ),
            c["valid"].as_bool().unwrap(),
            "{}",
            c["description"]
        );
    }
    for c in cases(&v, "sign_errors") {
        let err = bip322::sign_simple(
            s(&c["address"]),
            s(&c["message"]).as_bytes(),
            &wif(&c["wif"]),
        )
        .unwrap_err();
        assert_eq!(err.code, s(&c["code"]), "{}", c["description"]);
    }
}

#[test]
fn signing_key_is_a_message_signer_for_sign_in() {
    use ordinalswallet::auth::{sign_in_message, MessageSigner};
    let key = SigningKey::from_mnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    )
    .unwrap();
    let address = key.p2tr_address();
    let msg = sign_in_message(&address, "00ff00ff00ff00ff", 1_790_424_300_000);
    let sig = MessageSigner::sign_message(&key, &address, &msg).unwrap();
    assert!(bip322::verify_simple(&address, msg.as_bytes(), &sig));
    let err = MessageSigner::sign_message(&key, "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", &msg)
        .unwrap_err();
    assert_eq!(err.code(), Some("key_mismatch"));
    assert!(!format!("{key:?}").contains(&to_hex(&key.secret_bytes())));
}

// ─── escrows ────────────────────────────────────────────────────────

#[test]
fn escrow_vectors() {
    let v = fixture("escrow.json");
    assert_eq!(
        s(&v["cosigner_x_only"]),
        ordinalswallet::signing::offers::OW_COSIGNER_XONLY
    );
    assert_eq!(
        s(&v["nums_internal_key"]),
        ordinalswallet::signing::offers::NUMS_INTERNAL_KEY
    );
    assert_eq!(
        s(&v["market_fee_address"]),
        ordinalswallet::signing::offers::OW_MARKET_FEE_ADDRESS
    );
    for c in cases(&v, "offer") {
        let e = offer_escrow(
            &hex(&c["buyer_public_key"]),
            u(&c["recovery_delay_blocks"]) as u32,
        )
        .unwrap();
        assert_eq!(
            json!({"sale_leaf": to_hex(&e.sale_leaf), "recovery_leaf": to_hex(&e.recovery_leaf), "script": to_hex(&e.script), "address": e.address}),
            json!({"sale_leaf": c["sale_leaf"], "recovery_leaf": c["recovery_leaf"], "script": c["script"], "address": c["address"]}),
            "delay {}",
            c["recovery_delay_blocks"]
        );
    }
    for c in cases(&v, "protected") {
        let e = passthrough_escrow(&hex(&c["seller_x_only"])).unwrap();
        let mut expected = c.clone();
        expected.as_object_mut().unwrap().remove("seller_x_only");
        assert_eq!(
            json!({
                "leaf": to_hex(&e.leaf),
                "recovery_leaf": to_hex(&e.recovery_leaf),
                "script": to_hex(&e.script),
                "address": e.address,
                "leaf_control_block": to_hex(&e.leaf_control_block),
                "recovery_control_block": to_hex(&e.recovery_control_block),
                "leaf_hash": to_hex(&tap_leaf_hash(&e.leaf)),
            }),
            expected
        );
    }
    for c in cases(&v, "protected_errors") {
        if let Some(e) = expect_code(
            passthrough_escrow(&hex(&c["seller_x_only"])),
            c,
            s(&c["description"]),
        ) {
            assert_eq!(to_hex(&e.script), s(&c["script"]));
        }
    }
    for c in cases(&v, "passthrough_leaf_parse") {
        let got = parse_passthrough_leaf(&hex(&c["leaf"]))
            .map(|(a, b)| json!({"seller": to_hex(&a), "cosigner": to_hex(&b)}))
            .unwrap_or(Value::Null);
        assert_eq!(got, c["keys"], "{}", c["description"]);
    }
}

// ─── offers ─────────────────────────────────────────────────────────

fn offer_replay(
    file: &str,
    verify: &dyn Fn(&Value) -> Result<Vec<String>, SigningError>,
    sign: &dyn Fn(&Value) -> Result<String, SigningError>,
) {
    let v = fixture(file);
    for c in cases(&v, "cases") {
        let what = format!("{file}: {}", s(&c["description"]));
        if !c["error"].is_null() {
            assert!(verify(c).is_err(), "{what}: verify must fail");
            assert!(sign(c).is_err(), "{what}: sign must fail");
            continue;
        }
        let problems: Vec<String> = cases(c, "problems")
            .iter()
            .map(|p| s(p).to_string())
            .collect();
        assert_eq!(verify(c).unwrap(), problems, "{what}");
        if !c["signed"].is_null() {
            let psbt = sign(c).unwrap_or_else(|e| panic!("{what}: {}", e.message));
            assert_eq!(
                inputs_of(&psbt),
                c["signed"]["inputs"],
                "{what}: signatures"
            );
            assert_eq!(psbt, s(&c["signed"]["psbt"]), "{what}: PSBT bytes");
        } else if !c["sign_problems"].is_null() {
            let err = sign(c).unwrap_err();
            let expected: Vec<String> = cases(c, "sign_problems")
                .iter()
                .map(|p| s(p).to_string())
                .collect();
            assert_eq!(err.code, "offer_verification_failed", "{what}");
            assert_eq!(err.problems, expected, "{what}");
        } else {
            assert!(sign(c).is_err(), "{what}: {}", c["sign_error"]);
        }
    }
}

#[test]
fn offer_funding_vectors() {
    let v = fixture("offer-funding.json");
    let buyer = wif(&v["buyer_wif"]);
    let ex = |c: &Value| {
        let e = &c["expect"];
        FundingExpectations {
            buyer_public_key: hex(&e["buyer_public_key"]),
            payment_address: s(&e["payment_address"]).into(),
            escrow_value: u(&e["escrow_value"]),
            recovery_delay_blocks: u(&e["recovery_delay_blocks"]) as u32,
            max_miner_fee_sats: e["max_miner_fee_sats"].as_u64(),
        }
    };
    offer_replay(
        "offer-funding.json",
        &|c| verify_funding_psbt(s(&c["psbt"]), &ex(c)),
        &|c| sign_offer_funding(s(&c["psbt"]), &buyer, &ex(c)),
    );
}

#[test]
fn offer_presign_vectors() {
    let v = fixture("offer-presign.json");
    let buyer = wif(&v["buyer_wif"]);
    let p = |c: &Value| {
        let x = &c["params"];
        PresignParams {
            scope: OfferScope::parse(s(&x["scope"])).unwrap(),
            sign_input_index: u(&x["sign_input_index"]) as usize,
            sighash: u(&x["sighash"]) as u32,
            recovery_delay_blocks: u(&x["recovery_delay_blocks"]) as u32,
            escrow_value: u(&x["escrow_value"]),
            buyer_address: opt_s(&x["buyer_address"]),
            price_sats: x["price_sats"].as_u64(),
            market_fee_sats: x["market_fee_sats"].as_u64(),
        }
    };
    offer_replay(
        "offer-presign.json",
        &|c| verify_presign_psbt(s(&c["psbt"]), &buyer, &p(c)),
        &|c| sign_offer_presign(s(&c["psbt"]), &buyer, &p(c)),
    );
}

#[test]
fn offer_accept_vectors() {
    let v = fixture("offer-accept.json");
    let seller = wif(&v["seller_wif"]);
    let ex = |c: &Value| {
        let e = &c["expect"];
        AcceptExpectations {
            my_address: s(&e["my_address"]).into(),
            inscription_outpoint: s(&e["inscription_outpoint"]).into(),
            price_sats: u(&e["price_sats"]),
            buyer_address: opt_s(&e["buyer_address"]),
            buyer_payment_address: opt_s(&e["buyer_payment_address"]),
        }
    };
    offer_replay(
        "offer-accept.json",
        &|c| verify_accept_psbt(s(&c["psbt"]), &ex(c)),
        &|c| sign_accept_psbt(s(&c["psbt"]), &seller, &ex(c)),
    );
}

#[test]
fn offer_cancel_vectors() {
    let v = fixture("offer-cancel.json");
    let buyer = wif(&v["buyer_wif"]);
    let p = |c: &Value| {
        let x = &c["params"];
        CancelParams {
            buyer_payment_address: s(&x["buyer_payment_address"]).into(),
            escrow_value: u(&x["escrow_value"]),
            recovery_delay_blocks: u(&x["recovery_delay_blocks"]) as u32,
            max_miner_fee_sats: x["max_miner_fee_sats"].as_u64(),
        }
    };
    offer_replay(
        "offer-cancel.json",
        &|c| verify_cancel_psbt(s(&c["psbt"]), &buyer, &p(c)),
        &|c| sign_offer_cancel(s(&c["psbt"]), &buyer, &p(c)),
    );
}

// ─── protected listing ──────────────────────────────────────────────

#[test]
fn listing_template_vectors() {
    let v = fixture("listing-templates.json");
    let seller = key_hex(&v["seller"]["private_key"]);
    let seller_x = hex(&v["seller"]["x_only_public_key"]);
    assert_eq!(seller.x_only_public_key().to_vec(), seller_x);
    for c in cases(&v, "templates") {
        let what = s(&c["description"]);
        let k = &c["check"];
        let check = ListingTemplateCheck {
            passthrough_psbt_hex: s(&k["passthrough_psbt"]).into(),
            sale_psbt_hex: s(&k["sale_psbt"]).into(),
            expected_outpoint: s(&k["expected_outpoint"]).into(),
            seller_address: s(&k["seller_address"]).into(),
            expected_seller_sats: u(&k["expected_seller_sats"]),
            asset_address: opt_s(&k["asset_address"]),
        };
        if let Some(r) = expect_code(
            assert_listing_templates(&check, &seller_x),
            &c["expect"],
            what,
        ) {
            assert_eq!(r.escrow_value, u(&c["expect"]["escrow_value"]), "{what}");
            assert_eq!(
                r.passthrough_txid,
                s(&c["expect"]["passthrough_txid"]),
                "{what}"
            );
            assert_eq!(
                to_hex(&r.escrow.script),
                s(&c["expect"]["escrow_script"]),
                "{what}"
            );
        }
        if let Some(r) = expect_code(sign_listing_templates(&check, &seller), &c["sign"], what) {
            let e = &c["sign"];
            assert_eq!(
                inputs_of(&r.psbt),
                e["passthrough_inputs"],
                "{what}: passthrough signature"
            );
            assert_eq!(
                inputs_of(&r.sale_psbt),
                e["sale_inputs"],
                "{what}: sale signature"
            );
            assert_eq!(r.psbt, s(&e["psbt"]), "{what}: passthrough PSBT bytes");
            assert_eq!(r.sale_psbt, s(&e["sale_psbt"]), "{what}: sale PSBT bytes");
            assert_eq!(r.passthrough_txid, s(&e["passthrough_txid"]));
            assert_eq!(r.escrow_value, u(&e["escrow_value"]));
        }
    }
    for c in cases(&v, "signed_sale") {
        let what = s(&c["description"]);
        let x = &c["expectation"];
        let e = SignedSaleTemplateExpectation {
            passthrough_txid: s(&x["passthrough_txid"]).into(),
            escrow_value: u(&x["escrow_value"]),
            seller_address: s(&x["seller_address"]).into(),
            price_sats: u(&x["price_sats"]),
        };
        let psbt = s(&c["psbt"]);
        if let Some(out) = expect_code(
            assert_signed_sale_template(psbt, &seller_x, &e),
            &c["expect"],
            what,
        ) {
            assert_eq!(
                out == psbt,
                c["expect"]["unchanged"].as_bool().unwrap(),
                "{what}"
            );
            assert_eq!(inputs_of(&out), c["expect"]["inputs"], "{what}");
            let has_key_sig = inputs_of(&out)[0]["tap_key_sig"] != Value::Null;
            assert_eq!(
                has_key_sig,
                c["expect"]["has_key_sig"].as_bool().unwrap(),
                "{what}"
            );
        }
    }
}

#[test]
fn recovery_vectors() {
    let v = fixture("recovery.json");
    let seller = key_hex(&v["seller"]["private_key"]);
    let seller_x = hex(&v["seller"]["x_only_public_key"]);
    for c in cases(&v, "cases") {
        let what = s(&c["description"]);
        let check = RecoveryCheck {
            psbt_hex: s(&c["psbt"]).into(),
            passthrough_txid: s(&c["passthrough_txid"]).into(),
            destination_address: s(&c["destination_address"]).into(),
            fee_rate_sat_vb: f(&c["fee_rate"]),
        };
        if let Some(r) = expect_code(
            assert_recovery_template(&check, &seller_x),
            &c["expect"],
            what,
        ) {
            assert_eq!(
                (r.escrow_value, r.value_sat, r.fee_sat),
                (
                    u(&c["expect"]["escrow_value"]),
                    u(&c["expect"]["value_sat"]),
                    u(&c["expect"]["fee_sat"])
                ),
                "{what}"
            );
        }
        if let Some(r) = expect_code(sign_recovery(&check, &seller), &c["sign"], what) {
            assert_eq!(r.rawtx, s(&c["sign"]["rawtx"]), "{what}: raw transaction");
            assert_eq!(r.txid, s(&c["sign"]["txid"]), "{what}");
            assert_eq!(
                (r.value_sat, r.fee_sat),
                (u(&c["sign"]["value_sat"]), u(&c["sign"]["fee_sat"]))
            );
        }
    }
}

// ─── protected purchase ─────────────────────────────────────────────

fn listing(l: &Value) -> SaleListing {
    SaleListing {
        outpoint: s(&l["outpoint"]).into(),
        seller_address: s(&l["seller_address"]).into(),
        creator_address: opt_s(&l["creator_address"]),
        satoshi_price: u(&l["satoshi_price"]),
        escrow_price_sat: l["escrow_price_sat"].as_u64(),
    }
}

fn parent(p: &Value) -> SaleParent {
    SaleParent {
        txid: s(&p["txid"]).into(),
        raw: s(&p["raw"]).into(),
        source_outpoint: None,
    }
}

fn sale_json(v: &SaleVerification) -> Value {
    json!({
        "seller_proceeds_sat": v.seller_proceeds_sat,
        "market_fee_sat": v.market_fee_sat,
        "creator_royalty_sat": v.creator_royalty_sat,
        "network_fee_sat": v.network_fee_sat,
        "change_sat": v.change_sat,
        "passthrough_input": v.passthrough_input,
        "asset_output": v.asset_output,
        "buyer_inputs": v.buyer_inputs,
        "change_outputs": v.change_outputs,
        "sale_txid": v.sale_txid,
    })
}

fn without_ok(v: &Value) -> Value {
    let mut v = v.clone();
    v.as_object_mut().unwrap().remove("ok");
    v
}

fn expiry(v: &Value) -> Option<QuoteExpiry> {
    match v {
        Value::Null => None,
        Value::String(t) => Some(QuoteExpiry::Text(t.clone())),
        n => Some(QuoteExpiry::EpochMs(f(n))),
    }
}

#[test]
fn purchase_vectors() {
    let v = fixture("purchase-verify.json");
    for c in cases(&v, "sales") {
        let what = s(&c["description"]);
        let i = &c["input"];
        let got = verify_sale(&VerifySaleInput {
            sale_psbt_hex: s(&i["sale_psbt"]).into(),
            parent: parent(&i["parent"]),
            listing: listing(&i["listing"]),
            buyer_address: s(&i["buyer_address"]).into(),
            fee_rate_sat_vb: f(&i["fee_rate"]),
            market_fee_address: opt_s(&i["market_fee_address"]),
            recipient_address: opt_s(&i["recipient_address"]),
            ..Default::default()
        });
        if let Some(r) = expect_code(got, &c["expect"], what) {
            assert_eq!(sale_json(&r), without_ok(&c["expect"]), "{what}");
        }
    }
    for c in cases(&v, "setups") {
        let what = s(&c["description"]);
        let got = verify_setup(s(&c["psbt"]), s(&c["buyer_address"]), f(&c["fee_rate"]));
        if let Some(r) = expect_code(got, &c["expect"], what) {
            assert_eq!(
                json!({"txid": r.txid, "fee_sat": r.fee_sat, "buyer_inputs": r.buyer_inputs, "change_outputs": r.change_outputs}),
                without_ok(&c["expect"]),
                "{what}"
            );
        }
    }
    for c in cases(&v, "purchases") {
        let what = s(&c["description"]);
        let i = &c["input"];
        let links = cases(i, "links")
            .iter()
            .map(|l| SaleChainLink {
                sale_txid: s(&l["sale_txid"]).into(),
                sale_psbt_hex: s(&l["sale_psbt"]).into(),
                parent: parent(&l["parent"]),
                listing: listing(&l["listing"]),
            })
            .collect();
        let got = verify_passthrough_purchase(&PurchaseCheck {
            links,
            setup: (!i["setup"].is_null()).then(|| SetupTx {
                txid: s(&i["setup"]["txid"]).into(),
                psbt: s(&i["setup"]["psbt"]).into(),
            }),
            buyer_address: s(&i["buyer_address"]).into(),
            fee_rate_sat_vb: f(&i["fee_rate"]),
            market_fee_address: None,
            recipient_address: opt_s(&i["recipient_address"]),
            expires_at: expiry(&i["expires_at"]),
            max_total_sat: i["max_total_sat"].as_u64(),
            now_ms: Some(f(&i["now"])),
        });
        if let Some(r) = expect_code(got, &c["expect"], what) {
            let got = json!({
                "seller_proceeds_sat": r.seller_proceeds_sat,
                "market_fee_sat": r.market_fee_sat,
                "creator_royalty_sat": r.creator_royalty_sat,
                "network_fee_sat": r.network_fee_sat,
                "setup_fee_sat": r.setup_fee_sat,
                "total_sat": r.total_sat,
                "links": r.links.iter().map(sale_json).collect::<Vec<_>>(),
                "setup": r.setup.map(|s| json!({"txid": s.txid, "fee_sat": s.fee_sat, "buyer_inputs": s.buyer_inputs, "change_outputs": s.change_outputs})),
            });
            assert_eq!(got, without_ok(&c["expect"]), "{what}");
        }
    }
    let buyer = key_hex(&v["buyer"]["private_key"]);
    assert_eq!(buyer.p2tr_address(), s(&v["buyer"]["address"]));
    for c in cases(&v, "sign_own_inputs") {
        let what = s(&c["description"]);
        let indexes: Vec<usize> = cases(c, "indexes").iter().map(|i| u(i) as usize).collect();
        if let Some(out) = expect_code(
            sign_own_inputs(s(&c["psbt"]), &indexes, &buyer),
            &c["expect"],
            what,
        ) {
            assert_eq!(inputs_of(&out), c["expect"]["inputs"], "{what}: signatures");
            assert_eq!(out, s(&c["expect"]["psbt"]), "{what}: PSBT bytes");
        }
    }
    for c in cases(&v, "quote_fresh") {
        let what = format!("expires_at {} now {}", c["expires_at"], c["now"]);
        expect_code(
            assert_quote_fresh(expiry(&c["expires_at"]).as_ref(), Some(f(&c["now"]))),
            c,
            &what,
        );
    }
}

// ─── cancel proof ───────────────────────────────────────────────────

#[test]
fn cancel_proof_vectors() {
    let v = fixture("cancel-proof.json");
    let shape_json = |psbt: &str| {
        let s = inspect_cancel_proof(psbt).unwrap();
        json!({
            "inputs": s.inputs,
            "outputs": s.outputs,
            "sighash": s.sighash,
            "signature_length": s.signature_length,
            "outpoint": s.outpoint,
            "output_sats": s.output_sats,
        })
    };
    for c in cases(&v, "cases") {
        let what = s(&c["description"]);
        let key = key_hex(&c["private_key"]);
        let got = build_cancel_proof(
            s(&c["outpoint"]),
            u(&c["value_sats"]),
            &hex(&c["public_key"]),
            &key,
        );
        if let Some(psbt) = expect_code(got, &c["expect"], what) {
            assert_eq!(shape_json(&psbt), c["expect"]["shape"], "{what}");
            assert_eq!(
                inputs_of(&psbt)[0]["final_script_witness"][0],
                c["expect"]["signature"],
                "{what}"
            );
            assert_eq!(psbt, s(&c["expect"]["psbt"]), "{what}: PSBT bytes");
        }
    }
    for c in cases(&v, "inspect") {
        assert_eq!(
            shape_json(s(&c["psbt"])),
            c["shape"],
            "{}",
            c["description"]
        );
    }
}

// ─── real mainnet sales ─────────────────────────────────────────────

#[test]
fn mainnet_protected_sales_match_local_escrow_and_sighash() {
    use bitcoin::consensus::deserialize;
    use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
    use bitcoin::taproot::{LeafVersion, TapLeafHash};
    use bitcoin::{Amount, ScriptBuf, Transaction, TxOut};

    let secp = bitcoin::secp256k1::Secp256k1::verification_only();
    let v = fixture("chain/protected-sales.json");
    for sale in cases(&v, "sales") {
        let tx: Transaction = deserialize(&hex(&sale["raw"])).unwrap();
        assert_eq!(tx.compute_txid().to_string(), s(&sale["txid"]));
        let prevouts: Vec<TxOut> = cases(sale, "prevouts")
            .iter()
            .map(|p| TxOut {
                value: Amount::from_sat(u(&p["value"])),
                script_pubkey: ScriptBuf::from_bytes(hex(&p["script"])),
            })
            .collect();
        let idx = tx
            .input
            .iter()
            .position(|i| i.witness.len() == 4)
            .expect("escrow input");
        let w: Vec<Vec<u8>> = tx.input[idx].witness.iter().map(<[u8]>::to_vec).collect();
        let (seller, cosigner) = parse_passthrough_leaf(&w[2]).expect("2-of-2 leaf");
        assert_eq!(
            to_hex(&cosigner),
            PINNED_COSIGNER_XONLY_HEX,
            "co-signed by the pinned key"
        );
        let escrow = passthrough_escrow(&seller).unwrap();
        assert_eq!(escrow.leaf, w[2]);
        assert_eq!(
            escrow.leaf_control_block, w[3],
            "control block rebuilt locally"
        );
        assert_eq!(
            escrow.script,
            prevouts[idx].script_pubkey.as_bytes(),
            "escrow script rebuilt locally"
        );
        let parent_txid = tx.input[idx].previous_output.txid.to_string();
        let parent = cases(sale, "parents")
            .iter()
            .find(|p| s(&p["txid"]) == parent_txid)
            .unwrap();
        let parent_tx: Transaction = deserialize(&hex(&parent["raw"])).unwrap();
        assert_eq!(parent_tx.compute_txid().to_string(), parent_txid);
        assert_eq!(
            parent_tx.output[0].script_pubkey.as_bytes(),
            escrow.script.as_slice()
        );

        let leaf_hash = TapLeafHash::from_script(
            &ScriptBuf::from_bytes(escrow.leaf.clone()),
            LeafVersion::TapScript,
        );
        let mut cache = SighashCache::new(&tx);
        let digest = |cache: &mut SighashCache<&Transaction>, ty| {
            cache
                .taproot_script_spend_signature_hash(idx, &Prevouts::All(&prevouts), leaf_hash, ty)
                .unwrap()
                .to_byte_array()
        };
        // witness = [cosigner sig (for the 2nd key, consumed first), seller sig, leaf, control block]
        assert_eq!(w[1].len(), 65);
        assert_eq!(w[1][64], 0x83);
        let seller_digest = digest(&mut cache, TapSighashType::SinglePlusAnyoneCanPay);
        let cosigner_digest = digest(&mut cache, TapSighashType::Default);
        let verify = |sig: &[u8], d: [u8; 32], key: &[u8]| {
            secp.verify_schnorr(
                &bitcoin::secp256k1::schnorr::Signature::from_slice(sig).unwrap(),
                &bitcoin::secp256k1::Message::from_digest(d),
                &bitcoin::XOnlyPublicKey::from_slice(key).unwrap(),
            )
            .is_ok()
        };
        assert!(
            verify(&w[1][..64], seller_digest, &seller),
            "seller 0x83 signature"
        );
        assert!(
            verify(&w[0], cosigner_digest, &cosigner),
            "co-signer signature"
        );
    }
}
