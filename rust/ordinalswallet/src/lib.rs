//! Rust SDK for the [Ordinals Wallet API](https://turbo.ordinalswallet.com).
//!
//! A blocking client (no async runtime) that mirrors the TypeScript SDK
//! (`@ow-cli/api`) in the same repository. Both SDKs are tested against the
//! same language-neutral vectors and recorded API responses in `fixtures/`.
//!
//! ```no_run
//! use ordinalswallet::Client;
//!
//! let client = Client::builder().app_name("my-bot/1.0").build()?;
//!
//! let fair = client.charts().valuation("bitcoin-puppets")?;
//! println!("fair value: {:?} sats", fair.fair_sats);
//!
//! for sale in client.sales().iter_sales("bitcoin-puppets", Default::default()).take(5) {
//!     let sale = sale?;
//!     println!("{} sold for {} sats on {}", sale.inscription_id, sale.price_sats,
//!         ordinalswallet::marketplace_name(Some(sale.marketplace)));
//! }
//! # Ok::<(), ordinalswallet::Error>(())
//! ```
//!
//! Every request carries `x-ow-client: <app_name> ordinalswallet-rs/<version>`
//! and `User-Agent: ordinalswallet-rs/<version>`. GETs retry network errors,
//! 429 and 5xx with exponential backoff and jitter, honouring `Retry-After`
//! up to `max_delay`; POSTs are never retried unless a call opts in.
//!
//! Streams ([`feeds::FeedsApi::stream_collection_feed`], [`quotes::QuotesApi::stream`],
//! [`stream::subscribe`]) are blocking iterators that reconnect on their own;
//! run them on a dedicated thread.

#![forbid(unsafe_code)]
#![warn(missing_debug_implementations)]
// `Error::Api { status, code, message, body, .. }` is matched by field, as the
// API spec asks; errors are the cold path, so its size is not worth a Box.
#![allow(clippy::result_large_err)]

pub mod auth;
pub mod charts;
mod client;
pub mod collection;
mod de;
mod error;
pub mod feeds;
pub mod market;
pub mod network;
pub mod offers;
mod outpoint;
pub mod quotes;
pub mod retry;
pub mod sales;
pub mod search;
pub mod stream;
pub mod wallet;

pub use client::{
    build_client_header, Client, ClientBuilder, CLIENT_HEADER, DEFAULT_BASE_URL, DEFAULT_TIMEOUT,
    SDK_CLIENT_TOKEN, VERSION,
};
pub use error::{extract_error_message, Error, Result};
pub use outpoint::{
    is_serialized_outpoint, outpoint_to_txid_vout, parse_serialized_outpoint,
    txid_vout_to_serialized, OutPoint,
};
pub use retry::{RetryConfig, RetryMode};
pub use sales::{marketplace_name, MARKETPLACES};
