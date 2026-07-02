// `@dignetwork/dig-sdk/dig-client` — the clean read-crypto subpath (#16).
//
// WHAT THIS IS. A focused entry that exposes ONLY the DIG read-crypto: derive a URN's keys, verify
// inclusion against an on-chain root, and decrypt content — the `DigClient`, its wasm loader, the
// SRI digest, and the pure URN helpers. It carries full `.d.ts` (tsup emits them) and the same
// SRI-pinned, fail-closed integrity guarantee as the main entry. Consumers that want JUST the read
// path (e.g. `dig-embed.js`, a worker) import from here instead of the whole SDK.
//
// WHERE THE WASM COMES FROM. The canonical read-crypto wasm (`dig_client`) is built from digstore's
// `dig-client-wasm` crate and published as `@dignetwork/dig-client` — so nobody vendors it. This SDK
// depends on that package; `src/loader.ts` resolves the wasm from it (Node: the sync `nodejs` build;
// browser: the `web` build) and SRI-verifies it against the pinned `DIG_CLIENT_WASM_SHA256` (the
// same digest the package publishes in its `integrity.json`). This entry is a re-export of that
// SRI-verified loader/client, not a reimplementation — its public surface is stable.

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
