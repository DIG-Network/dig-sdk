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
// Exposed builders (see @dignetwork/chip35-dl-coin-wasm for full signatures):
//   • mintStore / meltStore / updateStoreMetadata / updateStoreOwnership / oracleSpend
//   • addFee / buildDigPayment
//   • dataStoreFromSpend / hexSpendBundleToCoinSpends / spendBundleToHex
//   • digCatPuzzleHash / digTreasuryInnerPuzzleHash / digstoreOwnerHint
//   • init (call once before building spends)

export * from "@dignetwork/chip35-dl-coin-wasm";
