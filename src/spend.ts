// Spend builder re-export — the CANONICAL CHIP-0035 DataLayer store coin spend builder.
//
// Per the ecosystem rule (SYSTEM.md → Change-impact guide): on-chain spend bundles are NEVER
// hand-rolled. They are constructed by `@dignetwork/chip35-dl-coin-wasm`, the single source of
// truth for CHIP-0035 spends, which is released FIRST and then consumed downstream. The SDK
// re-exports it verbatim so a dapp builds store/NFT/CAT spends through ONE import and signs them
// with `ChiaProvider.signCoinSpends(...)`.
//
// Imported via the SDK's "./spend" entry:  import * as spend from "@dignetwork/dig-sdk/spend";
// The underlying wasm is a (non-optional) dependency, so it's always available.
//
// Exposed builders (see @dignetwork/chip35-dl-coin-wasm >= 0.8.0 for full signatures):
//   - Store coins:  mintStore / meltStore / updateStoreMetadata / updateStoreOwnership / oracleSpend
//   - Assets:       mintNft / bulkMint / createDid / issueCat
//   - CHIP-0007:    buildChip0007Metadata / validateChip0007 / generateItemMetadata
//   - Offers:       encodeOffer / decodeOffer
//   - Monetization (#46, chip35 >= 0.7.0): buildPayment / buildCatPayment / paymentNonce /
//                   verifyPaymentReceipt / proveNftOwnership / proveCollectionMembership
//                   (these back the high-level `Paywall` helper on the main SDK surface).
//   - Introspection (chip35 >= 0.8.0): version() (the loaded build's semver) and capabilities()
//                   ({ name, version, builders, errorCodes }) — runtime self-description so an agent
//                   can feature-gate on exactly which spend-builder build is loaded, with typed
//                   { code, message } errors. (The SDK's own top-level `capabilities()` describes the
//                   SDK surface; this re-exported pair describes the underlying wasm.)
//   - Helpers:      addFee / dataStoreFromSpend / hexSpendBundleToCoinSpends / spendBundleToHex
//   - Misc:         digstoreOwnerHint / sha256
//   - init (call once before building spends)

export * from "@dignetwork/chip35-dl-coin-wasm";
