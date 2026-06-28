// Cross-target loader for the vendored `dig_client` read-crypto WASM.
//
// The wasm is the SAME artifact the DIG Browser, extension, companion, and hub all run — vendored
// under vendor/ with a PROVENANCE note and pinned SRI (see vendor/PROVENANCE.md). We NEVER run it
// unverified: we obtain the raw bytes, SHA-256 them, compare against the pinned digest, and only
// then hand the verified bytes to wasm-bindgen's init. A mismatch (tampered / wrong artifact)
// throws — the reader FAILS CLOSED rather than running unverified crypto.
//
// Three runtimes are supported, auto-detected, with an escape hatch (`configureWasm`):
//   • Node / Bun        — read vendor/ files from the package directory (fs + node:crypto).
//   • Browser (bundled)  — the consumer's bundler can resolve the vendor files; if it can't, the
//                         consumer supplies bytes via `configureWasm({ wasmBytes, glueUrl })`.
//   • Browser (no bundler) — `configureWasm` with a URL/bytes you serve yourself.
//
// Memoized: the wasm initializes at most once per process/page.

import type { DigClientWasm } from "./wasm.js";

/** SHA-256 (lowercase hex) of vendor/dig_client_bg.wasm — the SRI digest. Fail closed on mismatch. */
export const DIG_CLIENT_WASM_SHA256 =
  "ff486be806f908a2a90780e499a04dbd34e10e3b97be0470cb9ee841a1e49e77";

/** Optional explicit wasm inputs, for environments where auto-resolution can't find vendor/. */
export interface WasmConfig {
  /**
   * The wasm bytes (already loaded). When provided, SRI is still enforced unless `skipIntegrity`.
   * Pass this in CSP-strict browsers where you fetch + verify the bytes yourself.
   */
  wasmBytes?: BufferSource;
  /**
   * URL to the wasm-bindgen glue module (vendor/dig_client.mjs) for browser dynamic import. When
   * omitted in a browser, the loader tries to import the glue relative to this module.
   */
  glueUrl?: string;
  /**
   * URL to fetch the wasm bytes from (browser) when `wasmBytes` is not supplied. The fetched bytes
   * are SRI-verified before init.
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
    throw new Error(
      "dig-client wasm integrity check failed — refusing to run unverified crypto " +
        `(expected ${DIG_CLIENT_WASM_SHA256}, got ${hex}).`,
    );
  }
}

// Read the vendored glue URL + wasm bytes for Node from the package's vendor/ directory.
async function loadNode(): Promise<{ glueHref: string; bytes: BufferSource }> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  // This module lives in dist/; vendor/ sits at the package root, one level up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const vendorDir = path.resolve(here, "..", "vendor");
  const wasmPath = path.join(vendorDir, "dig_client_bg.wasm");
  const gluePath = path.join(vendorDir, "dig_client.mjs");
  const buf = await readFile(wasmPath);
  // Copy into a fresh ArrayBuffer-backed view so the type is a plain BufferSource (not the
  // ArrayBufferLike/SharedArrayBuffer union the Node Buffer type widens to).
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  return { glueHref: pathToFileURL(gluePath).href, bytes };
}

// Resolve the glue URL + wasm bytes for a browser. Prefers explicit config; otherwise resolves
// the vendored files relative to this module (works when the bundler copies vendor/ alongside).
async function loadBrowser(): Promise<{ glueHref: string; bytes: BufferSource }> {
  const glueHref =
    _config.glueUrl ?? new URL("../vendor/dig_client.mjs", import.meta.url).href;
  let bytes: BufferSource;
  if (_config.wasmBytes) {
    bytes = _config.wasmBytes;
  } else {
    const wasmUrl =
      _config.wasmUrl ?? new URL("../vendor/dig_client_bg.wasm", import.meta.url).href;
    const res = await fetch(wasmUrl);
    if (!res.ok) throw new Error(`dig-client wasm fetch failed (${res.status})`);
    bytes = await res.arrayBuffer();
  }
  return { glueHref, bytes };
}

/**
 * Load, SRI-verify, and instantiate the read-crypto wasm, returning its functions. Memoized — at
 * most one init per process/page. Fails closed on an integrity mismatch.
 */
export function loadDigClientWasm(): Promise<DigClientWasm> {
  if (_ready) return _ready;
  _ready = (async () => {
    const { glueHref, bytes } = isNode ? await loadNode() : await loadBrowser();
    assertIntegrity(await sha256Hex(bytes));
    const mod = (await import(/* @vite-ignore */ glueHref)) as {
      default: (input: { module_or_path: BufferSource }) => Promise<unknown>;
    } & Partial<DigClientWasm>;
    // wasm-bindgen default export = async init; accepts raw bytes via { module_or_path }.
    await mod.default({ module_or_path: bytes });
    return mod as unknown as DigClientWasm;
  })().catch((e) => {
    _ready = null; // allow a retry on transient load failure
    throw e;
  });
  return _ready;
}
