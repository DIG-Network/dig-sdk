// Runtime self-description — the SDK's introspection surface, so an agent can discover the SDK's
// version, modules, methods, supported chains, and error codes WITHOUT reading source.
//
// `SDK_VERSION` is replaced at build time by tsup's `define` (see tsup.config.ts) with the value
// from package.json, so it can never drift from the published version. In a non-built/test context
// the `declare const` falls back to "0.0.0-dev".

import { WALLET_METHODS, SIGN_METHODS, DEFAULT_CHAIN } from "./methods.js";
import { DIG_CLIENT_WASM_SHA256 } from "./loader.js";
import { DEFAULT_RPC } from "./dig-client.js";
import { DIG_SDK_ERROR_CODES, type DigSdkErrorCode } from "./errors.js";

// Injected by tsup `define` ({ __SDK_VERSION__: JSON.stringify(pkg.version) }). The `declare`
// keeps TypeScript happy; the fallback covers `ts-node`/unbundled execution.
declare const __SDK_VERSION__: string | undefined;

/** The SDK's semver version, from package.json (injected at build time). */
export const SDK_VERSION: string =
  typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0-dev";

/** The machine-readable description of one SDK module. */
export interface ModuleDescriptor {
  /** The module's public name (the class/helper a consumer imports). */
  readonly name: string;
  /** One-line summary of what it does. */
  readonly summary: string;
  /** The import path it's reachable from (the package subpath). */
  readonly entry: string;
}

/** The full machine-readable description of the SDK surface — what `capabilities()` returns. */
export interface SdkCapabilities {
  /** Always `"@dignetwork/dig-sdk"`. */
  readonly name: string;
  /** The SDK semver (= {@link SDK_VERSION}). */
  readonly version: string;
  /** The modules the SDK exposes (ChiaProvider, DigClient, Paywall, spend builders, adapters). */
  readonly modules: readonly ModuleDescriptor[];
  /** The canonical CHIP-0002 wallet method surface both transports negotiate. */
  readonly walletMethods: readonly string[];
  /** The message-signing methods, in preference order. */
  readonly signMethods: readonly string[];
  /** The wallet transports the SDK can connect through. */
  readonly transports: readonly ("injected" | "walletconnect")[];
  /** The CAIP-2 chains supported (mainnet only — there is no testnet flow). */
  readonly chains: readonly string[];
  /** The default dig RPC endpoint `DigClient` reads from. */
  readonly defaultRpc: string;
  /** The SRI digest of the read-crypto wasm from @dignetwork/dig-client (fail-closed on mismatch). */
  readonly readCryptoWasmSha256: string;
  /** The stable error-code catalogue (UPPER_SNAKE) consumers can branch on. */
  readonly errorCodes: readonly DigSdkErrorCode[];
}

const MODULES: readonly ModuleDescriptor[] = Object.freeze([
  {
    name: "ChiaProvider",
    summary:
      "Unified Chia wallet surface — prefers the injected DIG Browser wallet, falls back to WalletConnect→Sage.",
    entry: "@dignetwork/dig-sdk",
  },
  {
    name: "DigClient",
    summary:
      "Read-crypto: derive URN keys, verify inclusion against an on-chain root, and decrypt content from the dig RPC.",
    entry: "@dignetwork/dig-sdk",
  },
  {
    name: "Paywall",
    summary:
      "Pay-to-unlock helper composing ChiaProvider with the canonical chip35 monetization spends (payment / receipt / NFT+collection gating).",
    entry: "@dignetwork/dig-sdk",
  },
  {
    name: "spend",
    summary:
      "The canonical CHIP-0035 spend builder (@dignetwork/chip35-dl-coin-wasm), re-exported verbatim.",
    entry: "@dignetwork/dig-sdk/spend",
  },
  {
    name: "adapters",
    summary:
      "Framework deploy glue (Vite + Next): dev window.chia shim and `digstore deploy` runner.",
    entry: "@dignetwork/dig-sdk/adapters",
  },
] as const);

/**
 * Describe the SDK's surface as machine-readable data: version, modules, methods, transports,
 * chains, the default RPC, the read-crypto wasm digest, and the error-code catalogue. An agent can
 * call this to introspect the SDK without reading source.
 *
 * @example
 * import { capabilities } from "@dignetwork/dig-sdk";
 * const cap = capabilities();
 * cap.version;        // "0.2.0"
 * cap.walletMethods;  // ["chip0002_connect", …]
 * cap.errorCodes;     // ["WC_OPTIONS_REQUIRED", …]
 */
export function capabilities(): SdkCapabilities {
  return {
    name: "@dignetwork/dig-sdk",
    version: SDK_VERSION,
    modules: MODULES,
    walletMethods: [...WALLET_METHODS],
    signMethods: [...SIGN_METHODS],
    transports: ["injected", "walletconnect"],
    chains: [DEFAULT_CHAIN],
    defaultRpc: DEFAULT_RPC,
    readCryptoWasmSha256: DIG_CLIENT_WASM_SHA256,
    errorCodes: Object.values(DIG_SDK_ERROR_CODES),
  };
}

/** Alias for {@link capabilities} — the conventional `describe()` introspection name. */
export const describe = capabilities;
