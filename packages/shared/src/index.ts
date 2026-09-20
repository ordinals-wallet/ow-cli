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

// Rune
export { buildSplitEdicts } from './rune.js'

// BRC-20
export { buildBrc20Payload, splitAmount } from './brc20.js'

// TAP
export { buildTapPayload } from './tap.js'
