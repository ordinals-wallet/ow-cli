//! Write endpoints (offers, protected listing/purchase, cancel-escrow)
//! against an in-process server: method, path, body, no retries.

mod common;

use common::{Reply, Server};
use ordinalswallet::market::{
    BuildSecurePurchaseRequest, CancelEscrowRequest, SecureListingAuthorizeItem,
    SecureListingBuildBulkRequest, SecureListingBuildItem, SecureListingRecoverRequest,
    SubmitSecurePurchaseLink, SubmitSecurePurchaseRequest,
};
use ordinalswallet::offers::*;
use ordinalswallet::Error;
use serde_json::{json, Value};

fn offer_json() -> Value {
    json!({
        "id": "o1", "scope": "item", "buyer_address": "bc1pbuyer", "price_sats": 250000,
        "state": "active", "expires_at": "2026-10-01T00:00:00Z", "created_at": "2026-09-24T00:00:00Z"
    })
}

#[test]
fn offer_writes_post_to_their_routes_and_are_never_retried() {
    let server = Server::start(|r, _| {
        let offer = offer_json();
        match (r.method.as_str(), r.path.as_str()) {
            ("POST", "/market/offers/build") => Reply::json(
                200,
                &json!({
                    "offer_id": "o1", "scope": "item", "funding_psbt": "70736274ff", "batch_accept": null,
                    "escrow_address": "bc1pescrow", "escrow_value": 262000, "price_sats": 250000,
                    "market_fee_sats": 6750, "network_fee_sats": 5250, "validity_days": 7,
                    "recovery_delay_blocks": 1008, "expires_at": "2026-10-01T00:00:00Z"
                }),
            ),
            ("POST", "/market/offers/o%201/prepare") => Reply::json(
                200,
                &json!({
                    "offer_id": "o1", "scope": "item", "funding_txid": "ab", "accept_psbt": "70", "sign_input_index": 1, "tapscript": true, "sighash": 1
                }),
            ),
            ("POST", "/market/offers/o1/activate") => {
                Reply::json(200, &json!({"offer": offer, "funding_txid": "ab"}))
            }
            ("POST", "/market/offers/o1/build-accept") => Reply::json(
                200,
                &json!({"offer": offer, "accept_psbt": "70", "sign_input_index": 0, "tapscript": false, "sighash": 1}),
            ),
            ("POST", "/market/offers/o1/accept")
            | ("POST", "/market/offers/o1/fill")
            | ("POST", "/market/offers/o1/cancel") => Reply::json(
                200,
                &json!({"offer_id": "o1", "txid": "cd", "state": "accepted"}),
            ),
            ("POST", "/market/offers/o1/build-fill") => Reply::json(
                200,
                &json!({"offer": offer, "inscription_id": "i0", "fill_psbt": "70", "sign_input_index": 0, "tapscript": false, "sighash": 1, "miner_fee_sats": 300}),
            ),
            ("POST", "/market/offers/o1/reject") => {
                Reply::json(200, &json!({"offer_id": "o1", "state": "rejected"}))
            }
            ("POST", "/market/offers/o1/build-cancel") => Reply::json(
                200,
                &json!({"offer_id": "o1", "cancel_psbt": "70", "sign_input_index": 0, "tapscript": true, "sighash": 1, "fee_rate": 2}),
            ),
            _ => Reply::json(404, &json!({"error": true, "message": "no route"})),
        }
    });
    let client = server.client().retries(3).build().unwrap();
    let offers = client.offers();
    let built = offers
        .build(&BuildOfferRequest {
            inscription_id: Some("i0".into()),
            buyer_address: "bc1pbuyer".into(),
            buyer_public_key: "02aa".into(),
            buyer_payment_address: "bc1pbuyer".into(),
            buyer_payment_public_key: "02aa".into(),
            price_sats: 250_000,
            fee_rate: 5.0,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        (built.escrow_value, built.recovery_delay_blocks),
        (262_000, 1008)
    );
    assert_eq!(offers.prepare("o 1", "signed-funding").unwrap().sighash, 1);
    offers
        .activate(
            "o1",
            &ActivateOfferRequest {
                funding_psbt: "f".into(),
                accept_psbt: "a".into(),
            },
        )
        .unwrap();
    offers
        .build_accept(
            "o1",
            &BuildAcceptRequest {
                seller_address: "bc1pseller".into(),
                seller_public_key: None,
            },
        )
        .unwrap();
    offers
        .accept(
            "o1",
            &AcceptOfferRequest {
                seller_address: "bc1pseller".into(),
                signed_psbt: "s".into(),
            },
        )
        .unwrap();
    assert_eq!(
        offers
            .build_fill(
                "o1",
                &BuildFillRequest {
                    seller_address: "bc1pseller".into(),
                    seller_public_key: None,
                    inscription_id: "i0".into()
                }
            )
            .unwrap()
            .miner_fee_sats,
        Some(300)
    );
    offers
        .fill(
            "o1",
            &FillOfferRequest {
                seller_address: "bc1pseller".into(),
                inscription_id: "i0".into(),
                signed_psbt: "s".into(),
            },
        )
        .unwrap();
    assert_eq!(
        offers
            .reject("o1", "bc1pseller", "ows1.token")
            .unwrap()
            .state,
        "rejected"
    );
    offers
        .build_cancel(
            "o1",
            &BuildCancelRequest {
                buyer_address: "bc1pbuyer".into(),
                fee_rate: None,
            },
        )
        .unwrap();
    offers
        .cancel(
            "o1",
            &CancelOfferRequest {
                buyer_address: "bc1pbuyer".into(),
                signed_psbt: "s".into(),
            },
        )
        .unwrap();

    let reqs = server.requests();
    assert!(reqs.iter().all(|r| r.method == "POST"));
    let body = |i: usize| reqs[i].json();
    assert_eq!(body(0)["inscription_id"], "i0");
    assert!(body(0).get("scope").is_none(), "unset options are omitted");
    assert_eq!(body(1), json!({"funding_psbt": "signed-funding"}));
    assert_eq!(body(2), json!({"funding_psbt": "f", "accept_psbt": "a"}));
    assert_eq!(body(3), json!({"seller_address": "bc1pseller"}));
    assert_eq!(
        body(7),
        json!({"address": "bc1pseller", "signature": "ows1.token"})
    );
    assert_eq!(body(8), json!({"buyer_address": "bc1pbuyer"}));
    assert_eq!(reqs.len(), 10);
}

#[test]
fn offer_write_failures_are_not_retried_and_keep_their_code() {
    let server = Server::start(|_, _| {
        Reply::json(
            503,
            &json!({"error": true, "code": "offer_attempt_pending", "message": "busy"}),
        )
    });
    let client = server.client().retries(3).build().unwrap();
    let err = client
        .offers()
        .cancel(
            "o1",
            &CancelOfferRequest {
                buyer_address: "b".into(),
                signed_psbt: "s".into(),
            },
        )
        .unwrap_err();
    assert_eq!(server.count(), 1, "POSTs are never retried");
    assert_eq!(err.status(), 503);
    assert_eq!(err.offer_kind(), Some(OfferErrorKind::AttemptPending));
}

fn authorize_item(outpoint: &str) -> SecureListingAuthorizeItem {
    SecureListingAuthorizeItem {
        outpoint: outpoint.into(),
        protocol: "ordinal".into(),
        seller_public_key: "02aa".into(),
        template_digest: "d".into(),
        psbt: "p".into(),
        sale_psbt: "s".into(),
        escrow_price_sats: Some(50_000),
        attempt_id: None,
    }
}

#[test]
fn secure_listing_writes() {
    let server = Server::start(|r, _| match r.path.as_str() {
        "/market/secure-listing/build-bulk" => Reply::json(
            200,
            &json!({"version": 4, "policy": "passthrough_v4", "items": [
                {"outpoint": "a:0", "error": true, "code": "postage_too_small"},
                {"outpoint": "b:1", "version": 4, "state": "authorization_required", "protocol": "ordinal", "policy": "passthrough_v4",
                 "template_digest": "d", "psbt": "p", "sale_psbt": "s", "passthrough_txid": "t", "escrow_value": 546,
                 "escrow_price_sats": 50000, "escrow_script": "5120", "cosigner_public_key": "1d08"}
            ]}),
        ),
        "/market/secure-listing/authorize-bulk" => {
            let items = r.json()["items"].as_array().unwrap().len();
            match (items, r.json()["items"][0]["outpoint"].as_str().unwrap()) {
                (1, "ok:0") => Reply::json(
                    200,
                    &json!({"version": 4, "state": "listed", "outpoint": "ok:0", "protocol": "ordinal", "policy": "passthrough_v4", "template_digest": "d", "passthrough_txid": "t", "escrow_value": 546}),
                ),
                (1, "refused:0") => Reply::json(
                    400,
                    &json!({"outpoint": "refused:0", "error": true, "code": "listing_changed"}),
                ),
                (1, _) => Reply::json(
                    400,
                    &json!({"error": true, "code": "invalid_request", "message": "bad items"}),
                ),
                _ => Reply::json(
                    200,
                    &json!({"items": [{"outpoint": "x:0", "state": "listed"}, {"outpoint": "y:0", "error": true, "code": "already_listed"}]}),
                ),
            }
        }
        "/market/secure-listing/recover" => Reply::json(
            200,
            &json!({"version": 4, "psbt": "70", "recovery_txid": "r", "escrow_outpoint": "t:0", "escrow_value": 1000, "value": 718, "fee": 282, "destination": "bc1p", "sequence": 144, "spendable_after_confirmations": 144}),
        ),
        _ => Reply::empty(404),
    });
    let client = server.client().build().unwrap();
    let sl = client.secure_listing();
    let built = sl
        .build_bulk(&SecureListingBuildBulkRequest {
            protocol: "ordinal".into(),
            seller_address: "bc1pseller".into(),
            seller_public_key: "02aa".into(),
            items: vec![SecureListingBuildItem {
                outpoint: "a:0".into(),
                escrow_price_sats: 50_000,
            }],
            attempt_id: None,
        })
        .unwrap();
    assert!(built.items[0].is_error());
    assert_eq!(built.items[1].sale_psbt.as_deref(), Some("s"));

    let one = sl.authorize_bulk(&[authorize_item("ok:0")]).unwrap();
    assert_eq!(
        (one.items.len(), one.items[0].state.as_deref()),
        (1, Some("listed"))
    );
    let refused = sl.authorize_bulk(&[authorize_item("refused:0")]).unwrap();
    assert_eq!(
        refused.items[0].code.as_deref(),
        Some("listing_changed"),
        "a one-item 400 is a row"
    );
    let err = sl.authorize_bulk(&[authorize_item("other:0")]).unwrap_err();
    assert_eq!((err.status(), err.code()), (400, Some("invalid_request")));
    let many = sl
        .authorize_bulk(&[authorize_item("x:0"), authorize_item("y:0")])
        .unwrap();
    assert!(many.items[1].is_error());

    let rec = sl
        .recover(&SecureListingRecoverRequest {
            passthrough_txid: "t".into(),
            fee_rate: 2.0,
            destination: None,
        })
        .unwrap();
    assert_eq!((rec.fee, rec.sequence), (Some(282), Some(144)));

    let reqs = server.requests();
    assert!(reqs
        .iter()
        .all(|r| r.method == "POST" && r.header("cache-control") == Some("no-store")));
    assert_eq!(reqs[1].json()["items"][0]["escrow_price_sats"], 50_000);
    assert_eq!(
        reqs.last().unwrap().json(),
        json!({"passthrough_txid": "t", "fee_rate": 2.0})
    );
}

#[test]
fn secure_purchase_and_cancel_escrow_writes() {
    let server = Server::start(|r, _| match r.path.as_str() {
        "/wallet/secure-purchase/build" => Reply::json(
            200,
            &json!({"version": 4, "policy": "passthrough_v4", "sale_txid": "s", "sales": [], "expires_at": "2026-09-26T12:05:00Z"}),
        ),
        "/market/secure-purchase/submit" => {
            Reply::json(200, &json!({"accepted": true, "txid": "s"}))
        }
        "/market/cancel-escrow" => Reply::json(
            200,
            &json!({"success": true, "transition": "cancelled", "listing": {"escrow_id": "e", "secure_v2": true, "state": "cancelled"}}),
        ),
        _ => Reply::empty(404),
    });
    let client = server.client().build().unwrap();
    let built = client
        .secure_purchase()
        .build(&BuildSecurePurchaseRequest {
            outpoints: vec!["a:0".into()],
            protocol: "ordinal".into(),
            from: "bc1pbuyer".into(),
            public_key: "02aa".into(),
            to: None,
            fee_rate: 5.0,
            wallet_type: Some("ow-cli".into()),
        })
        .unwrap();
    assert_eq!(built.policy.as_deref(), Some("passthrough_v4"));
    let submitted = client
        .secure_purchase()
        .submit(&SubmitSecurePurchaseRequest {
            sales: vec![SubmitSecurePurchaseLink {
                sale_txid: "s".into(),
                psbt: "p".into(),
                setup_psbt: None,
            }],
        })
        .unwrap();
    assert!(submitted.accepted);
    let cancelled = client
        .market()
        .cancel_escrow(&CancelEscrowRequest {
            outpoint: Some("a:0".into()),
            inscription_id: None,
            signature: "70".into(),
        })
        .unwrap();
    assert!(cancelled.listing.unwrap().secure_v2);
    for bad in [
        CancelEscrowRequest {
            outpoint: None,
            inscription_id: None,
            signature: "70".into(),
        },
        CancelEscrowRequest {
            outpoint: Some("a:0".into()),
            inscription_id: Some("i0".into()),
            signature: "70".into(),
        },
    ] {
        assert!(matches!(
            client.market().cancel_escrow(&bad),
            Err(Error::InvalidInput(_))
        ));
    }
    let reqs = server.requests();
    assert_eq!(reqs.len(), 3, "invalid cancels send nothing");
    assert_eq!(
        reqs[1].json(),
        json!({"sales": [{"sale_txid": "s", "psbt": "p"}]})
    );
    assert_eq!(
        reqs[2].json(),
        json!({"outpoint": "a:0", "signature": "70"})
    );
}
