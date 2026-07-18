// Cross-target loader for the `dig_client` read-crypto WASM.
//
// The wasm is consumed from the published `@dignetwork/dig-capsule-wasm` package (the installable form of
// digstore's dig-client-wasm crate) — the SAME artifact the DIG Browser, extension, node, and hub
// run. We NEVER run it unverified: we obtain the package's raw wasm bytes, SHA-256 them, compare
// against the pinned digest, and only then let the module's crypto run. A mismatch (tampered / wrong
// artifact) throws — the reader FAILS CLOSED rather than running unverified crypto.
//
// Two targets are consumed from the one package, auto-detected, with an escape hatch
// (`configureWasm`):
//   • Node / Bun          — `@dignetwork/dig-capsule-wasm/node`, the wasm-bindgen `nodejs` build. It reads
//                            + instantiates the wasm synchronously on import; we independently
//                            SHA-256-verify the shipped `dig_client_bg.wasm` and fail closed on a
//                            mismatch.
//   • Browser (bundler)   — `@dignetwork/dig-capsule-wasm/web`, the `--target web` build. We fetch the
//                            package's `dig_client_bg.wasm`, SRI-verify the bytes, and hand them to
//                            the module's async init.
//   • Browser (no bundler) — `configureWasm` with a URL/bytes you serve yourself.
//
// Memoized: the wasm initializes at most once per process/page.

import type { DigClientWasm } from "./wasm.js";
import { DigSdkError } from "./errors.js";

/**
 * SHA-256 (lowercase hex) of `@dignetwork/dig-capsule-wasm`'s `dig_client_bg.wasm` — the SRI digest. It
 * is the canonical trust anchor (pinned regardless of the npm semver), mirrored by the package's
 * `integrity.json` `sha256`. Fail closed on a mismatch.
 */
export const DIG_CLIENT_WASM_SHA256 =
  "a186fd2d6b348a7caa3112c51b666a6618fe7cf8bb56ad395a1fab4323f6ae7e";

/** Optional explicit wasm inputs, for environments where package resolution can't reach the wasm. */
export interface WasmConfig {
  /**
   * The wasm bytes (already loaded). When provided, SRI is still enforced unless `skipIntegrity`.
   * Pass this in CSP-strict browsers where you fetch + verify the bytes yourself.
   */
  wasmBytes?: BufferSource;
  /**
   * URL to the wasm-bindgen `web` glue module for browser dynamic import. When omitted in a browser,
   * the loader imports `@dignetwork/dig-capsule-wasm/web` (the bundler resolves it).
   */
  glueUrl?: string;
  /**
   * URL to fetch the wasm bytes from (browser) when `wasmBytes` is not supplied. The fetched bytes
   * are SRI-verified before init. Defaults to the package's `dig_client_bg.wasm`.
   */
  wasmUrl?: string;
  /** Skip the SRI check. Only for tests / trusted custom builds — NOT recommended. */
  skipIntegrity?: boolean;
}

let _config: WasmConfig = {};
let _ready: Promise<DigClientWasm> | null = null;

/**
 * Override how the read-crypto wasm is located/loaded. Call BEFORE the first `DigClient` read.
 * Mainly for browsers without a bundler that resolves package files, or CSP-strict apps that fetch
 * + verify the wasm bytes themselves and hand them in. Resets any cached instance.
 */
export function configureWasm(config: WasmConfig): void {
  _config = { ...config };
  _ready = null;
}

const isNode =
  typeof process !== "undefined" &&
  !!(process as { versions?: { node?: string } }).versions?.node;

/** SHA-256 a buffer to lowercase hex, using node:crypto or WebCrypto. */
async function sha256Hex(bytes: BufferSource): Promise<string> {
  if (isNode) {
    const { createHash } = await import("node:crypto");
    const view =
      bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(
            (bytes as ArrayBufferView).buffer,
            (bytes as ArrayBufferView).byteOffset,
            (bytes as ArrayBufferView).byteLength,
          );
    return createHash("sha256").update(view).digest("hex");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function assertIntegrity(hex: string): void {
  if (_config.skipIntegrity) return;
  if (hex !== DIG_CLIENT_WASM_SHA256) {
    throw new DigSdkError(
      "WASM_INTEGRITY",
      "dig-client wasm integrity check failed — refusing to run unverified crypto " +
        `(expected ${DIG_CLIENT_WASM_SHA256}, got ${hex}).`,
      { expected: DIG_CLIENT_WASM_SHA256, actual: hex },
    );
  }
}

// The read-crypto function surface the SDK uses (a subset of the package's exports). Both the node
// and web builds export these camelCase functions at the module top level.
type DigClientModule = DigClientWasm & {
  default?: (input: { module_or_path: BufferSource }) => Promise<unknown>;
};

// Node: consume the `--target nodejs` build. It reads `dig_client_bg.wasm` from the package and
// instantiates SYNCHRONOUSLY on import, so its functions are ready immediately (no init call). We
// independently SHA-256-verify the shipped wasm and fail closed on a mismatch — so a tampered
// package binary refuses to run even though wasm-bindgen already loaded it.
async function loadNode(): Promise<DigClientWasm> {
  const { createRequire } = await import("node:module");
  const { readFile } = await import("node:fs/promises");
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("@dignetwork/dig-capsule-wasm/dig_client_bg.wasm");
  const buf = await readFile(wasmPath);
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  assertIntegrity(await sha256Hex(bytes));
  const mod = (await import("@dignetwork/dig-capsule-wasm/node")) as unknown as DigClientModule;
  return mod as unknown as DigClientWasm;
}

// Browser: consume the `--target web` build (`@dignetwork/dig-capsule-wasm/web`).
//
// Two modes:
//   • Caller-supplied bytes/URL (`configureWasm`) — the fail-closed path for CSP-strict apps or an
//     untrusted CDN. We fetch (if a URL) the bytes, SHA-256-VERIFY them against the pinned digest,
//     and hand the very bytes we checked to the glue's async init — so nothing runs unverified.
//   • Default — call the glue's `init()` with no args. The `--target web` build resolves its
//     sibling `dig_client_bg.wasm` relative to its OWN module URL (the bundler-correct way to
//     locate a package asset) and instantiates it. Those bytes are the pinned package artifact
//     (the SDK depends on an exact `@dignetwork/dig-capsule-wasm` version). Apps that need byte-level SRI
//     over an untrusted delivery path use `configureWasm({ wasmUrl })` above.
async function loadBrowser(): Promise<DigClientWasm> {
  const glueHref = _config.glueUrl ?? "@dignetwork/dig-capsule-wasm/web";
  const mod = (await import(/* @vite-ignore */ glueHref)) as unknown as DigClientModule;
  if (typeof mod.default !== "function") {
    throw new DigSdkError(
      "WASM_LOAD_FAILED",
      "dig-client web build exposed no init function (unexpected module shape)",
      {},
    );
  }
  if (_config.wasmBytes || _config.wasmUrl) {
    let bytes: BufferSource;
    if (_config.wasmBytes) {
      bytes = _config.wasmBytes;
    } else {
      const wasmUrl = _config.wasmUrl!;
      const res = await fetch(wasmUrl);
      if (!res.ok)
        throw new DigSdkError("WASM_LOAD_FAILED", `dig-client wasm fetch failed (${res.status})`, {
          httpStatus: res.status,
          wasmUrl,
        });
      bytes = await res.arrayBuffer();
    }
    assertIntegrity(await sha256Hex(bytes));
    await mod.default({ module_or_path: bytes });
  } else {
    // The glue resolves + instantiates its own sibling wasm (the pinned package artifact).
    await (mod.default as unknown as () => Promise<unknown>)();
  }
  return mod as unknown as DigClientWasm;
}

/**
 * Load, SRI-verify, and instantiate the read-crypto wasm, returning its functions. Memoized — at
 * most one init per process/page. Fails closed on an integrity mismatch.
 */
export function loadDigClientWasm(): Promise<DigClientWasm> {
  if (_ready) return _ready;
  _ready = (isNode ? loadNode() : loadBrowser()).catch((e) => {
    _ready = null; // allow a retry on transient load failure
    throw e;
  });
  return _ready;
}

