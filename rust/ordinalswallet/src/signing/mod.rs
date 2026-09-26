//! Keys, BIP-322 message signatures and PSBT verification/signing (feature
//! `signing`).
//!
//! This is a port of `@ow-cli/core`. Every PSBT the API hands out is checked
//! against values the caller already trusts (their own key and addresses, the
//! price they agreed, the co-signer key pinned in this build) before anything
//! is signed; a PSBT that breaks a rule is refused with a [`SigningError`] and
//! nothing is signed. The TypeScript and Rust implementations are held to the
//! same vectors in the repository's `fixtures/` directory.
//!
//! Only [`trade`] talks to the network (through a [`crate::Client`]); the
//! other modules are pure. The write endpoints live on the client
//! ([`crate::offers::OffersApi`], [`crate::market::SecureListingApi`],
//! [`crate::market::SecurePurchaseApi`], [`crate::market::MarketApi::cancel_escrow`]).
//!
//! | Module | TypeScript |
//! | --- | --- |
//! | [`bip39`], [`SigningKey`] | `keys.ts`, `address.ts` |
//! | [`bip322`] | `bip322.ts` |
//! | [`offers`] | `offers-verify.ts` |
//! | [`passthrough`] | `passthrough.ts` (protected purchase) |
//! | [`listing`] | `passthrough-listing.ts` (protected listing, recovery) |
//! | [`cancel_proof`] | `cancel-proof.ts` (deprecated legacy proof) |
//! | [`trade`] | `@ow-cli/shared`: `signInWithKey`, protected purchase/listing/recovery, `delistListing` |

//!
//! ```no_run
//! use ordinalswallet::signing::{trade, SigningKey};
//!
//! let client = ordinalswallet::Client::new();
//! let key = SigningKey::from_mnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")?;
//! let sessions = ordinalswallet::auth::SessionManager::new(client.clone()).with_signer(key.clone());
//!
//! let listing = client.market().listing("<inscription id>")?;
//! let item = trade::plan_item("<inscription id>", listing.as_ref())?;
//! let quote = trade::quote_protected_purchase(&client, &[item], 5.0, &key, 0)?;
//! println!("costs {} sats (verified from the transactions)", quote.verified.total_sat);
//! let signed = trade::sign_protected_purchase(&quote, &key)?;
//! trade::submit_protected_purchase(&client, &signed)?;
//! # let _ = sessions;
//! # Ok::<(), ordinalswallet::Error>(())
//! ```

pub mod bip322;
pub mod bip39;
pub mod cancel_proof;
mod keys;
pub mod listing;
pub mod offers;
pub mod passthrough;
mod psbt;
pub mod trade;
mod util;
mod wordlist;

use std::fmt;

pub use keys::{SigningKey, DERIVATION_PATH};
pub use util::{base64_decode, base64_encode};

/// A refusal or failure from the signing layer. `code` is stable and matches
/// the TypeScript SDK's `PassthroughError.code` for the protected-trading
/// checks (`listing_escrow_mismatch`, `sale_payout_mismatch`, …). Offer PSBT
/// checks report `offer_verification_failed` with every broken rule in
/// `problems`, like `OfferVerificationError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SigningError {
    pub code: String,
    pub message: String,
    /// Offer checks only: every rule the PSBT broke.
    pub problems: Vec<String>,
}

impl SigningError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        SigningError {
            code: code.into(),
            message: message.into(),
            problems: Vec::new(),
        }
    }

    pub(crate) fn offer(problems: Vec<String>) -> Self {
        SigningError {
            code: "offer_verification_failed".into(),
            message: format!("Refusing to sign offer PSBT: {}", problems.join("; ")),
            problems,
        }
    }
}

impl fmt::Display for SigningError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SigningError {}

impl From<SigningError> for crate::Error {
    fn from(e: SigningError) -> Self {
        crate::Error::Signing(e)
    }
}

pub(crate) fn fail<T>(code: &str, message: impl Into<String>) -> Result<T, SigningError> {
    Err(SigningError::new(code, message))
}
