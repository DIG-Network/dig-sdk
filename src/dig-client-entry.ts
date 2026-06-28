// `@dignetwork/dig-sdk/dig-client` — the clean, publishable read-crypto subpath (#16).
//
// WHAT THIS IS. A focused entry that exposes ONLY the DIG read-crypto: derive a URN's keys, verify
// inclusion against an on-chain root, and decrypt content — the `DigClient`, its wasm loader, the
// SRI digest, and the pure URN helpers. It carries full `.d.ts` (tsup emits them) and the same
// SRI-pinned, fail-closed integrity guarantee as the main entry. Consumers that want JUST the read
// path (e.g. `dig-embed.js`, a worker) import from here instead of the whole SDK.
//
// WHY IT EXISTS (the #16 publish story). The canonical read-crypto wasm (`dig_client`) is built in
// chip35_dl_coin's `dig-client-wasm` crate and is currently VENDORED across the ecosystem (this SDK
// under vendor/, plus the extension/companion/hub). "Publishing `@dignetwork/dig-client`" means
// publishing that wasm + glue + `.d.ts` from the canonical repo so nobody vendors it again.
//
//   • Until that package exists, this subpath IS the consumable read-crypto: the SDK ships the
//     SRI-pinned wasm under vendor/ and this entry re-exports the loader/client over it. This
//     already lets hub/dig-embed.js depend on `@dignetwork/dig-sdk/dig-client` instead of copying
//     the wasm — the immediate win.
//   • Once `@dignetwork/dig-client` is published from chip35_dl_coin, the ONLY change here is that
//     `src/loader.ts` resolves the wasm from that package instead of vendor/ (the SRI digest stays
//     the source of truth, in lock-step). This entry's public surface does NOT change, so consumers
//     are unaffected. See vendor/PROVENANCE.md → "Publishing the read-crypto wasm" for the exact
//     cross-repo steps and the versioning story.
//
// The vendored fallback is never broken by this entry — it is a re-export of the existing,
// SRI-verified loader/client, not a reimplementation.

// ---- Read-crypto client + loader ----
export { DigClient, DEFAULT_RPC, type DigClientOptions } from "./dig-client.js";
export {
  loadDigClientWasm,
  configureWasm,
  DIG_CLIENT_WASM_SHA256,
  type WasmConfig,
} from "./loader.js";
export type { DigClientWasm } from "./wasm.js";

// ---- URN helpers (pure) — needed to address what you read ----
export {
  parseUrn,
  isUrn,
  reconstructUrn,
  reconstructUrnWithRoot,
  type ParsedUrn,
} from "./urn.js";

// ---- Read-side public types ----
export type { ReadOptions, ReadResult, UrnKeys } from "./types.js";
