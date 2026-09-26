//! `signing::trade` flows end to end against an in-process server, using
//! the shared vectors' transactions. Nothing here touches the network.

#![cfg(feature = "signing")]

mod common;

use common::{fixture, Reply, Server};
use ordinalswallet::auth::sign_in_message;
use ordinalswallet::signing::bip322;
use ordinalswallet::signing::passthrough::PINNED_COSIGNER_XONLY_HEX;
use ordinalswallet::signing::trade::*;
use ordinalswallet::signing::SigningKey;
use serde_json::{json, Value};

const ABANDON: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

fn key() -> SigningKey {
    SigningKey::from_mnemonic(ABANDON)
        .unwrap()
        .with_aux_rand([0; 32])
}

fn caps(cosigner: &str) -> Reply {
    Reply::json(
        200,
        &json!({"secure_purchase": {
            "version": 4, "mode": "passthrough_v4", "escrow_policy": "passthrough_v4",
            "customer_enabled": true, "listing_enabled": true, "build_enabled": true, "submit_enabled": true,
            "cosigner_public_key": cosigner, "min_postage_sats": 330, "protocol_status": {"ordinal": "enabled"}
        }}),
    )
}

fn purchase_case(name: &str) -> Value {
    let v = fixture("purchase-verify.json");
    v["purchases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["description"] == name)
        .unwrap_or_else(|| panic!("no purchase case {name}"))
        .clone()
}

fn planned(case: &Value) -> Vec<PlannedItem> {
    case["input"]["links"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, l)| PlannedItem {
            inscription_id: format!("i{i}"),
            protected: true,
            price_sat: l["listing"]["satoshi_price"].as_u64().unwrap(),
            escrow_price_sat: l["listing"]["escrow_price_sat"].as_u64(),
            seller_address: l["listing"]["seller_address"].as_str().unwrap().into(),
            creator_address: l["listing"]["creator_address"].as_str().map(Into::into),
            outpoint: l["listing"]["outpoint"].as_str().unwrap().into(),
        })
        .collect()
}

fn build_body(case: &Value, total: u64) -> Value {
    let links = case["input"]["links"].as_array().unwrap();
    json!({
        "version": 4, "policy": "passthrough_v4", "sale_txid": links[0]["sale_txid"],
        "setup": case["input"]["setup"],
        "sales": links.iter().map(|l| json!({"sale_txid": l["sale_txid"], "psbt": l["sale_psbt"], "parent": {"txid": l["parent"]["txid"], "raw": l["parent"]["raw"], "source_outpoint": l["listing"]["outpoint"]}})).collect::<Vec<_>>(),
        "economics": {"buyer_total_sats": total},
        "cosigner_public_key": PINNED_COSIGNER_XONLY_HEX,
        "expires_at": "2099-01-01T00:00:00Z",
    })
}

fn psbt_inputs(hex: &str) -> Vec<bitcoin::psbt::Input> {
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    bitcoin::psbt::Psbt::deserialize(&bytes).unwrap().inputs
}

#[test]
fn protected_purchase_quote_sign_submit() {
    for name in ["with setup", "two chained items"] {
        let case = purchase_case(name);
        let total = case["expect"]["total_sat"].as_u64().unwrap();
        let body = build_body(&case, total);
        let server = Server::start(move |r, _| match r.path.as_str() {
            "/market/secure-purchase/capabilities" => caps(PINNED_COSIGNER_XONLY_HEX),
            "/wallet/secure-purchase/build" => Reply::json(200, &body),
            "/market/secure-purchase/submit" => {
                Reply::json(200, &json!({"accepted": true, "txid": "t"}))
            }
            _ => Reply::empty(404),
        });
        let client = server.client().build().unwrap();
        let items = planned(&case);
        let quote = quote_protected_purchase(&client, &items, 5.0, &key(), 0).unwrap();
        assert_eq!(quote.verified.total_sat, total, "{name}");
        let signed = sign_protected_purchase(&quote, &key()).unwrap();
        let result = submit_protected_purchase(&client, &signed).unwrap();
        assert!(result.accepted);

        let reqs = server.requests();
        let build = reqs
            .iter()
            .find(|r| r.path == "/wallet/secure-purchase/build")
            .unwrap()
            .json();
        assert_eq!(build["from"], key().p2tr_address());
        assert_eq!(build["public_key"], key().public_key_hex());
        assert_eq!(build["outpoints"].as_array().unwrap().len(), items.len());
        let submit = reqs
            .iter()
            .find(|r| r.path == "/market/secure-purchase/submit")
            .unwrap()
            .json();
        for (i, link) in submit["sales"].as_array().unwrap().iter().enumerate() {
            let expected = &case["expect"]["links"][i];
            let inputs = psbt_inputs(link["psbt"].as_str().unwrap());
            for (idx, input) in inputs.iter().enumerate() {
                let buyer = expected["buyer_inputs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|b| b.as_u64() == Some(idx as u64));
                assert_eq!(
                    input.tap_key_sig.is_some(),
                    buyer,
                    "{name}: link {i} input {idx}"
                );
                assert!(input.final_script_witness.is_none(), "nothing finalized");
            }
            assert_eq!(
                link.get("setup_psbt").is_some(),
                i == 0 && !case["input"]["setup"].is_null()
            );
        }
    }
}

#[test]
fn protected_purchase_refusals_happen_before_signing() {
    let case = purchase_case("single item");
    let total = case["expect"]["total_sat"].as_u64().unwrap();
    // A co-signer other than the pinned one: refused before the build.
    let server = Server::start(|r, _| match r.path.as_str() {
        "/market/secure-purchase/capabilities" => caps(&"11".repeat(32)),
        _ => Reply::empty(500),
    });
    let err = quote_protected_purchase(
        &server.client().build().unwrap(),
        &planned(&case),
        5.0,
        &key(),
        0,
    )
    .unwrap_err();
    assert_eq!(err.code(), Some("cosigner_key_unpinned"));
    assert_eq!(server.count(), 1);

    // A build quoting less than the transactions spend: over budget.
    let body = build_body(&case, total - 1);
    let err = quote_from_build(
        &serde_json::from_value(body).unwrap(),
        &planned(&case),
        &key().p2tr_address(),
        5.0,
        0,
    )
    .unwrap_err();
    assert_eq!(err.code(), Some("over_budget"));
    let body = build_body(&case, total - 1);
    assert!(
        quote_from_build(
            &serde_json::from_value(body).unwrap(),
            &planned(&case),
            &key().p2tr_address(),
            5.0,
            1
        )
        .is_ok(),
        "within tolerance"
    );

    // Delivery elsewhere, an unpinned co-signer in the build, no expiry, an expired quote.
    let mutations: [(&str, Value, &str); 4] = [
        (
            "recipient_address",
            json!("bc1p9p69rydnar06wt0m25axjv0fy2a06wkdgzpwftc62yzx56u3ta5ssxklk7"),
            "invalid_sale",
        ),
        (
            "cosigner_public_key",
            json!("22".repeat(32)),
            "cosigner_key_unpinned",
        ),
        ("expires_at", Value::Null, "invalid_sale"),
        ("expires_at", json!("2020-01-01T00:00:00Z"), "quote_expired"),
    ];
    for (field, value, code) in mutations {
        let mut body = build_body(&case, total);
        body[field] = value;
        let err = quote_from_build(
            &serde_json::from_value(body).unwrap(),
            &planned(&case),
            &key().p2tr_address(),
            5.0,
            0,
        )
        .unwrap_err();
        assert_eq!(err.code(), Some(code), "{field}");
    }
}

#[test]
fn protected_listing_build_sign_authorize() {
    let v = fixture("listing-templates.json");
    let honest = v["templates"][0].clone();
    let tampered = v["templates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["expect"]["code"] == "listing_escrow_mismatch")
        .unwrap()
        .clone();
    let item = v["item"].as_str().unwrap().to_string();
    let row = |outpoint: &str, c: &Value, cosigner: &str| {
        json!({"outpoint": outpoint, "version": 4, "state": "authorization_required", "protocol": "ordinal",
               "policy": "passthrough_v4", "template_digest": "digest", "psbt": c["check"]["passthrough_psbt"],
               "sale_psbt": c["check"]["sale_psbt"], "passthrough_txid": c["expect"]["passthrough_txid"],
               "escrow_value": 546, "escrow_price_sats": 50000, "cosigner_public_key": cosigner})
    };
    let rows = json!({"items": [
        row(&item, &honest, PINNED_COSIGNER_XONLY_HEX),
        row("cd00000000000000000000000000000000000000000000000000000000000000:0", &tampered, PINNED_COSIGNER_XONLY_HEX),
        row("ee00000000000000000000000000000000000000000000000000000000000000:0", &honest, &"33".repeat(32)),
        {"outpoint": "ff00000000000000000000000000000000000000000000000000000000000000:0", "error": true, "code": "postage_too_small"},
    ]});
    let server = Server::start(move |r, _| match r.path.as_str() {
        "/market/secure-listing/build-bulk" => Reply::json(200, &rows),
        "/market/secure-listing/authorize-bulk" => {
            let first = r.json()["items"][0]["outpoint"].clone();
            Reply::json(
                200,
                &json!({"version": 4, "state": "listed", "outpoint": first, "protocol": "ordinal", "policy": "passthrough_v4", "template_digest": "digest", "passthrough_txid": "t", "escrow_value": 546}),
            )
        }
        _ => Reply::empty(404),
    });
    let client = server.client().build().unwrap();
    let items: Vec<ListingItem> = [
        item.as_str(),
        "cd00000000000000000000000000000000000000000000000000000000000000:0",
        "ee00000000000000000000000000000000000000000000000000000000000000:0",
        "ff00000000000000000000000000000000000000000000000000000000000000:0",
        "aa00000000000000000000000000000000000000000000000000000000000000:0",
    ]
    .iter()
    .map(|o| ListingItem {
        outpoint: o.to_string(),
        price_sats: 50_000,
        inscription_id: None,
    })
    .collect();
    let (built, failures) = build_protected_listings(&client, &items, &key()).unwrap();
    assert_eq!(built.len(), 2);
    let codes: Vec<&str> = failures.iter().map(|f| f.code.as_str()).collect();
    assert_eq!(
        codes,
        [
            "cosigner_key_unpinned",
            "postage_too_small",
            "invalid_listing_build"
        ]
    );
    let (payloads, failures) = sign_protected_listings(&built, &key());
    assert_eq!(failures.len(), 1);
    assert_eq!(
        failures[0].code, "listing_input_mismatch",
        "template for another item is refused"
    );
    assert_eq!(payloads.len(), 1);
    assert_eq!(payloads[0].psbt, honest["sign"]["psbt"].as_str().unwrap());
    assert_eq!(
        payloads[0].sale_psbt,
        honest["sign"]["sale_psbt"].as_str().unwrap()
    );
    let (listed, failures) = authorize_protected_listings(&client, &payloads).unwrap();
    assert!(failures.is_empty());
    assert_eq!(listed[0].outpoint, item);
    let build = server.requests()[0].json();
    assert_eq!(build["seller_address"], key().p2tr_address());
    assert_eq!(build["seller_public_key"], key().public_key_hex());
}

#[test]
fn recovery_and_delist_never_broadcast() {
    let rec = fixture("recovery.json");
    let honest = rec["cases"][0].clone();
    let psbt = honest["psbt"].clone();
    let outpoint = format!("{}:3", "ab".repeat(32));
    let listed_outpoint = outpoint.clone();
    let address = key().p2tr_address();
    let server = Server::start(move |r, _| match r.path.as_str() {
        "/market/secure-listing/recover" => {
            Reply::json(200, &json!({"psbt": psbt, "sequence": 144}))
        }
        "/auth/session" => Reply::json(
            200,
            &json!({"token": "ows1.session", "address": r.json()["address"], "expires_at": 4_000_000_000u64}),
        ),
        "/market/escrow/i0" => Reply::json(
            200,
            &json!({
                "inscription_id": "i0", "outpoint": listed_outpoint, "seller_address": address, "satoshi_price": 51350,
                "protected": true, "secure_purchase_version": 2
            }),
        ),
        "/market/escrow/i1" => Reply::json(
            200,
            &json!({
                "inscription_id": "i1", "outpoint": format!("{}:0", "cd".repeat(32)), "seller_address": address, "satoshi_price": 1000
            }),
        ),
        "/inscription/i1/outpoint" => Reply::json(
            200,
            &json!({
                "inscription": {"id": "i1", "sat_offset": 0, "outpoint": format!("{}:1", "ee".repeat(32)), "address": address, "sats": 546},
                "owner": address, "sats": 546
            }),
        ),
        p if p.starts_with("/market/secure-listing/") && p.contains("abab") => Reply::json(
            200,
            &json!({"secure_listing": {"version": 4, "state": "listed", "outpoint": "x", "protocol": "ordinal", "policy": "passthrough_v4"}}),
        ),
        p if p.starts_with("/market/secure-listing/") => Reply::empty(404),
        "/market/cancel-escrow" => {
            let secure = r.json().get("outpoint").is_some();
            Reply::json(
                200,
                &json!({"success": true, "transition": "cancelled", "listing": {"escrow_id": "e", "secure_v2": secure, "state": "cancelled"}}),
            )
        }
        _ => Reply::empty(404),
    });
    let client = server.client().build().unwrap();
    let signed = recover_protected_listing(
        &client,
        honest["passthrough_txid"].as_str().unwrap(),
        2.0,
        &key(),
        None,
    )
    .unwrap();
    assert_eq!(signed.rawtx, honest["sign"]["rawtx"].as_str().unwrap());
    assert_eq!(
        server.requests()[0].json()["destination"],
        key().p2tr_address()
    );

    // Protected: signs in, then cancels by outpoint with the session token.
    let out = delist(
        &client,
        &key(),
        &DelistTarget::Inscription("i0".into()),
        None,
    )
    .unwrap();
    assert!(out.protected);
    assert_eq!(
        (out.routed_by, out.outpoint.as_str()),
        ("outpoint", outpoint.as_str())
    );
    let reqs = server.requests();
    let session = reqs
        .iter()
        .find(|r| r.path == "/auth/session")
        .unwrap()
        .json();
    let msg = sign_in_message(
        &key().p2tr_address(),
        session["nonce"].as_str().unwrap(),
        session["issued_at"].as_u64().unwrap(),
    );
    assert!(bip322::verify_simple(
        &key().p2tr_address(),
        msg.as_bytes(),
        session["signature"].as_str().unwrap()
    ));
    let cancel = reqs
        .iter()
        .rev()
        .find(|r| r.path == "/market/cancel-escrow")
        .unwrap()
        .json();
    assert_eq!(
        cancel,
        json!({"outpoint": outpoint, "signature": "ows1.session"})
    );

    // Standard, with a session the caller already has: no second sign-in.
    let out = delist(
        &client,
        &key(),
        &DelistTarget::Inscription("i1".into()),
        Some("ows1.mine"),
    )
    .unwrap();
    assert!(!out.protected);
    assert_eq!(out.routed_by, "inscription_id");
    let reqs = server.requests();
    assert_eq!(reqs.iter().filter(|r| r.path == "/auth/session").count(), 1);
    let cancel = reqs
        .iter()
        .rev()
        .find(|r| r.path == "/market/cancel-escrow")
        .unwrap()
        .json();
    assert_eq!(
        cancel,
        json!({"inscription_id": "i1", "signature": "ows1.mine"})
    );
    assert!(reqs.iter().all(|r| !r.path.contains("broadcast")));
}

#[test]
fn sign_in_with_key_sends_a_valid_bip322_signature() {
    let server = Server::start(|r, _| {
        let b = r.json();
        Reply::json(
            200,
            &json!({"token": "ows1.t", "address": b["address"], "expires_at": 4_000_000_000u64}),
        )
    });
    let client = server.client().build().unwrap();
    for address in [None, Some(key().p2wpkh_address())] {
        let session = sign_in_with_key(&client, &key(), address.as_deref()).unwrap();
        let body = server.requests().last().unwrap().json();
        let expected_address = address.clone().unwrap_or_else(|| key().p2tr_address());
        assert_eq!(session.address, expected_address);
        let msg = sign_in_message(
            &expected_address,
            body["nonce"].as_str().unwrap(),
            body["issued_at"].as_u64().unwrap(),
        );
        assert!(bip322::verify_simple(
            &expected_address,
            msg.as_bytes(),
            body["signature"].as_str().unwrap()
        ));
    }
}
