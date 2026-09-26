// Config
export { loadConfig, saveConfig, getConfigDir, getWalletsDir } from './config.js'
export type { Config } from './config.js'

// Keystore
export {
  saveKeystore,
  loadKeystore,
  getKeypair,
  getPublicInfo,
  requirePublicInfo,
  unlockKeypair,
  hasKeystore,
  listWallets,
  renameWallet,
  migrateKeystore,
  getKeystorePath,
} from './keystore.js'
export type { WalletInfo } from './keystore.js'

// Validation
export {
  validateInscriptionId,
  validateOutpoint,
  validateAddress,
  validateFeeRate,
  validatePrice,
  validateSats,
  validateRuneId,
  validateAmount,
  validateSplits,
  validateOutpointWithSats,
  validateOutpointWithSatsShort,
  validateOutputPair,
  parseOutpoints,
  ValidationError,
} from './validate.js'

// Formatting
export { formatSats } from './format.js'

// Transaction
export { signAndBroadcast } from './tx.js'

// Market
export {
  executePurchaseRune,
  executePurchaseAlkane,
  executeListInscriptions,
  executeDelist,
} from './market.js'
export type {
  PurchaseRuneParams,
  PurchaseAlkaneParams,
  ListInscriptionsParams,
  DelistParams,
} from './market.js'

// Purchase (legacy escrow + passthrough v4)
export {
  executePurchase,
  planPurchase,
  buildPassthroughPurchase,
  signPassthroughPurchase,
  submitPassthroughPurchase,
  requirePassthroughSupport,
  isProtectedListing,
  canonicalOutpoint,
  securePurchaseFailureMessage,
} from './purchase.js'
export type {
  ListingKind,
  PlannedItem,
  PurchasePlan,
  PassthroughQuote,
  SignedPassthroughPurchase,
  PurchaseParams,
  PurchaseOutcome,
} from './purchase.js'

// Protected (passthrough v4) listing and typed errors
export {
  protectedListingAvailability,
  planListing,
  buildProtectedListings,
  signProtectedListings,
  authorizeProtectedListings,
  executeProtectedListing,
  recoverProtectedListing,
} from './protected-listing.js'
export type {
  ListingItemInput,
  PlannedListing,
  ListingPlan,
  ProtectedListingFailure,
  BuiltProtectedListing,
  ProtectedListingOutcome,
  RecoveryResult,
} from './protected-listing.js'
export { ProtectedTradeError, protectedErrorMessage, toProtectedError } from './protected-errors.js'
export type { ProtectedTradeStage, ProtectedErrorCode } from './protected-errors.js'

// Rune
export { buildSplitEdicts } from './rune.js'

// BRC-20
export { buildBrc20Payload, splitAmount } from './brc20.js'

// TAP
export { buildTapPayload } from './tap.js'

// Wallet sign-in
export { keypairAddress, keypairMessageSigner, signInWithKey, sessionManagerForKey } from './auth.js'
