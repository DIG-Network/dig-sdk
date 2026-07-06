// @dignetwork/dig-sdk — the typed front door for building dapps on the DIG Network.
//
// Three pillars:
//   1. ChiaProvider  — a wallet abstraction that PREFERS the injected DIG Browser wallet
//                      (window.chia) and FALLS BACK to WalletConnect→Sage, exposing one normalized
//                      CHIP-0002 surface (getAddress, signMessage, signCoinSpends, takeOffer, …).
//   2. DigClient     — read-crypto: derive a URN's keys, verify inclusion against an on-chain root,
//                      and decrypt content fetched from the dig RPC — the host stays blind.
//   3. spend         — re-export of the canonical CHIP-0035 spend builder
//                      (@dignetwork/chip35-dl-coin-wasm), imported via "@dignetwork/dig-sdk/spend".
//                      Spends are NEVER hand-rolled (SYSTEM.md).
//   4. Paywall       — a high-level pay-to-unlock helper (#46) that composes a ChiaProvider with the
//                      canonical chip35 monetization spends (payment / receipt verify / NFT+
//                      collection gating). It orchestrates only; the wasm builds every coin spend.

// ---- Wallet (ChiaProvider) ----
export {
  ChiaProvider,
  connectWallet,
  type ConnectOptions,
  type ConnectorId,
  type ConnectorInfo,
} from "./provider/chia-provider.js";
export {
  InjectedTransport,
  INJECTED_TOPIC,
  getInjectedProvider,
  isInjectedAvailable,
} from "./provider/injected.js";
export {
  WalletConnectTransport,
  type WalletConnectOptions,
  type WalletConnectMetadata,
} from "./provider/walletconnect.js";
export { isTransientPublishError } from "./provider/wc-retry.js";
export type { WalletTransport } from "./provider/transport.js";

// ---- Monetization (Paywall, #46) ----
export {
  Paywall,
  type PaywallOptions,
  type MonetizationSpends,
  type PaymentAssetSpec,
  type RequestPaymentArgs,
  type PaymentResult,
  type VerifyReceiptArgs,
  type ProveAccessArgs,
} from "./paywall.js";

// ---- Read-crypto (DigClient) ----
export { DigClient, DEFAULT_RPC, type DigClientOptions } from "./dig-client.js";
export {
  loadDigClientWasm,
  configureWasm,
  DIG_CLIENT_WASM_SHA256,
  type WasmConfig,
} from "./loader.js";
export type { DigClientWasm } from "./wasm.js";

// ---- URN helpers (pure) ----
export {
  parseUrn,
  isUrn,
  reconstructUrn,
  reconstructUrnWithRoot,
  type ParsedUrn,
} from "./urn.js";

// ---- CHIP-0002 method surface ----
export {
  WALLET_METHODS,
  SIGN_METHODS,
  DEFAULT_CHAIN,
  type WalletMethod,
} from "./methods.js";

// ---- Shared public types ----
export type {
  SignResult,
  InjectedChiaProvider,
  WalletBackend,
  WalletSession,
  ReadOptions,
  ReadResult,
  UrnKeys,
  CollectionItem,
  CollectionItemMetadata,
  CollectionItemsPage,
  CollectionMeta,
} from "./types.js";

// ---- Typed error taxonomy (stable machine codes) ----
export {
  DigSdkError,
  DIG_SDK_ERROR_CODES,
  isDigSdkError,
  type DigSdkErrorCode,
  type DigSdkErrorContext,
} from "./errors.js";

// ---- Runtime self-description (introspection) ----
export {
  SDK_VERSION,
  capabilities,
  describe,
  type SdkCapabilities,
  type ModuleDescriptor,
} from "./capabilities.js";
