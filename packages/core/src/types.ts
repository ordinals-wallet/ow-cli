export interface KeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
  xOnlyPublicKey: Uint8Array
}

export interface SignPsbtOptions {
  psbt: string
  privateKey: Uint8Array
  publicKey: Uint8Array
  disableExtract?: boolean
  skipSignIndex?: number
}

export interface PurchaseFlowResult {
  signedSetup: string
  signedPurchase: string
}

export interface AddressInfo {
  address: string
  script: Uint8Array
  tapInternalKey: Uint8Array
}
