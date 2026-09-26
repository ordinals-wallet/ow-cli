# ordinalswallet (Rust)

Rust SDK for the Ordinals Wallet API (`https://turbo.ordinalswallet.com`). It mirrors the TypeScript SDK (`@ow-cli/api`) in this repository, and both are tested against the same vectors and recorded API responses in [`fixtures/`](../../fixtures).

- **Blocking.** No async runtime. Streams are iterators; run them on their own thread.
- **Few dependencies.** `ureq` (HTTP + rustls), `serde`, `serde_json`, `getrandom`. 34 crates in the runtime tree, all from crates.io, versions pinned exactly, `Cargo.lock` committed.
- **Stage 1: reads and sign-in.** PSBT and BIP-322 signing arrive in stage 2 behind the `signing` feature (currently empty).

## Install

The crate is not on crates.io yet. Use a git dependency:

```toml
[dependencies]
ordinalswallet = { git = "https://github.com/ordinals-wallet/ow-cli", package = "ordinalswallet" }
```

MSRV: Rust 1.76.

## Examples

```rust,no_run
use ordinalswallet::{Client, marketplace_name};
use ordinalswallet::charts::{OhlcvInterval, OhlcvParams};

let client = Client::builder().app_name("my-bot/1.0").build()?;

let stats = client.collection().stats("bitcoin-puppets")?;
let fair = client.charts().valuation("bitcoin-puppets")?;
println!("floor {:?}, fair {:?}", stats.floor_price, fair.fair_sats);

let candles = client.charts().ohlcv("bitcoin-puppets", &OhlcvParams {
    interval: Some(OhlcvInterval::D1),
    ..Default::default()
})?;

// Pages lazily through before_height until has_more is false.
for sale in client.sales().iter_sales("bitcoin-puppets", Default::default()).take(20) {
    let sale = sale?;
    println!("{} {} sats on {}", sale.inscription_id, sale.price_sats, marketplace_name(Some(sale.marketplace)));
}

// Serialized (72-hex) outpoints from wallet endpoints:
let op = ordinalswallet::outpoint_to_txid_vout(
    "73285fb379038569e574137912e14d312bfc9487fe96f9347683aa64b405c6f500000000",
)?;
# Ok::<(), ordinalswallet::Error>(())
```

Live streams reconnect by themselves (backoff with jitter, `Retry-After`, `Last-Event-ID`, 45s idle timeout; HTTP 4xx other than 408/429 is fatal):

```rust,no_run
use ordinalswallet::feeds::FeedStreamEvent;
use ordinalswallet::quotes::QuotesStreamEvent;

let client = ordinalswallet::Client::new();

let feed = client.feeds().stream_collection_feed("bitcoin-puppets", 200, Default::default());
let stop = feed.close_handle(); // call stop.close() from another thread
std::thread::spawn(move || {
    for ev in feed {
        match ev {
            FeedStreamEvent::Rows(u) => println!("{} rows (pending first)", u.rows.len()),
            FeedStreamEvent::Error { error, fatal } => eprintln!("{error} (fatal: {fatal})"),
            FeedStreamEvent::Open => {}
        }
    }
});

for ev in client.quotes().stream(&["bitcoin-puppets", "nodemonkes"], Default::default())? {
    if let QuotesStreamEvent::Mark(m) = ev {
        println!("{} fair {} sats", m.slug, m.fair_sats);
    }
}
# Ok::<(), ordinalswallet::Error>(())
```

Sign-in takes a signature from any wallet that implements `auth::MessageSigner`:

```rust,no_run
use ordinalswallet::auth::SessionManager;

let client = ordinalswallet::Client::new();
let sessions = SessionManager::new(client).with_signer(|_address: &str, message: &str| {
    // Return a base64 BIP-322 simple signature of `message`.
    Ok::<_, ordinalswallet::Error>(my_wallet_sign(message))
});
let token = sessions.get_token("bc1p…", None)?; // cached, refreshed 5 min before expiry
# fn my_wallet_sign(_: &str) -> String { String::new() }
# Ok::<(), ordinalswallet::Error>(())
```

## Behaviour

| | |
| --- | --- |
| Identification | `x-ow-client: <app_name> ordinalswallet-rs/<version>`, `User-Agent: ordinalswallet-rs/<version>` |
| Retries | GET/HEAD: network errors, 429, 5xx; 2 retries, 300ms base, equal jitter, 10s cap. `Retry-After` up to the cap is honoured; longer fails fast. POSTs are never retried unless a call passes `RetryMode::Always`. Feed and quote GETs retry 3 times. |
| Errors | `Error::Api { status, code, message, body, .. }` for HTTP errors (message from `{error:true,message}`, `{error:"…"}`, plain text; empty bodies fall back to `HTTP <status> …`), `Error::Network` (status 0), `Error::Decode`, `Error::Auth`, `Error::InvalidInput`. `Error::offer_kind()` classifies offers codes. |

## Modules

`collection`, `wallet` (+ `inscription`), `charts`, `sales`, `feeds`, `quotes`, `stream`, `market` (+ `secure_purchase`, `secure_listing`), `search`, `network`, `auth`, `offers`. Each is reached from the client: `client.collection().metadata(slug)`, `client.feeds().activity_feed(&params)`, and so on. `client.get_json(path, query)` and `client.post_json(path, body, retry)` cover endpoints the SDK does not wrap.

## Quality gates

This repository has no CI; run the gates locally from `rust/`:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo +1.76.0 test --locked                 # MSRV
cargo test --test live -- --ignored --nocapture   # optional: live GET smoke test, never POSTs
cargo audit                                  # RustSec advisories (cargo install --locked cargo-audit)
cargo deny check                             # licenses, sources, duplicate versions (cargo install --locked cargo-deny)
```

Tests use a small `std::net::TcpListener` server in `tests/common`; there are no dev-dependencies.

## Dependencies

| Crate | Why |
| --- | --- |
| `ureq` 2 (`tls` only) | Blocking HTTP/1.1 with rustls and bundled webpki roots; no async runtime, no OpenSSL. |
| `serde` (`derive`) | Typed response structs. |
| `serde_json` | JSON bodies and SSE payloads. |
| `getrandom` 0.2 | OS CSPRNG for sign-in nonces; already in the tree through `ring`. |
| `idna_adapter` =1.0.0 | Not used directly: pins `url`'s IDNA back end to the ASCII-only adapter, the documented opt-out from ICU4X, which removes about 25 crates. Base URLs must have ASCII hostnames. |

`rust/.cargo/config.toml` keeps `Cargo.lock` resolvable by the MSRV.
