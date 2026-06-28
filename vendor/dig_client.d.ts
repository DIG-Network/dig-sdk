/* tslint:disable */
/* eslint-disable */

/**
 * Decrypt a SINGLE GCM-SIV chunk under an explicit 32-byte `key` (hex). Returns
 * the plaintext bytes. A failed tag check (tamper / wrong key) is an error.
 * Low-level escape hatch; most callers want `decryptResource`.
 */
export function decryptChunk(key_hex: string, ciphertext: Uint8Array): Uint8Array;

/**
 * Full read pipeline for a resource's served ciphertext (Digstore §9.3 + §11),
 * returning the decrypted plaintext bytes. Steps, in order (gate-then-decrypt):
 *
 * 1. **Integrity gate** — verify the served bytes' merkle inclusion against the
 *    chain-anchored `trusted_root_hex` (proof base64 from `X-Dig-Inclusion-Proof`).
 * 2. **Confidentiality** — derive the URN key, split the PLAIN-concatenated
 *    chunk ciphertexts by `chunk_lens` (the per-chunk CIPHERTEXT byte lengths in
 *    order; D5/C9 — NO length framing on the wire), and AES-256-GCM-SIV-open
 *    each, concatenating plaintext in order.
 *
 * `chunk_lens` may be empty for the common single-chunk resource (the whole blob
 * is one GCM-SIV ciphertext). They MUST sum to `ciphertext.len()`.
 */
export function decryptResource(store_id_hex: string, resource_key: string, ciphertext: Uint8Array, proof_b64: string, trusted_root_hex: string, salt_hex?: string | null, chunk_lens?: Uint32Array | null): Uint8Array;

/**
 * Convenience wrapper around [`decrypt_resource`] returning the plaintext as a
 * UTF-8 string (for HTML/text resources rendered into the sandbox iframe).
 */
export function decryptResourceToText(store_id_hex: string, resource_key: string, ciphertext: Uint8Array, proof_b64: string, trusted_root_hex: string, salt_hex?: string | null, chunk_lens?: Uint32Array | null): string;

/**
 * Derive the 32-byte AES-256 content key for a resource (Digstore §11.1/§11.4),
 * returned as lowercase hex. `salt_hex` is the 32-byte private-store secret salt
 * (omit / pass `null` for public stores). Mixing in a wrong/missing salt yields
 * a wrong key whose GCM-SIV tag will not verify.
 */
export function deriveKey(store_id_hex: string, resource_key: string, salt_hex?: string | null): string;

/**
 * Seal a resource's plaintext as ONE AES-256-GCM-SIV blob under its per-URN key — the inverse of
 * the read path's chunk decrypt. The browser uses this to PRE-ENCRYPT a file before upload so the
 * server compiles the `.dig` from ciphertext alone (it never sees plaintext or any key). The
 * output is the resource's whole-file ciphertext; `digstore compile --pre-encrypted` stores it
 * verbatim as the single chunk, and `decryptResource`/`decryptChunk` under the same URN reverses
 * it. `salt_hex` is the store's secret salt for a private store (omit for a public store).
 */
export function encryptResource(store_id_hex: string, resource_key: string, plaintext: Uint8Array, salt_hex?: string | null): Uint8Array;

/**
 * On module load, install a `globalThis.digClient` object exposing the read
 * API, so non-bundler consumers (the standalone usercontent loader) can call
 * `globalThis.digClient.verifyInclusion(...)` / `.decryptResourceToText(...)`
 * after the wasm initializes. ES-module consumers can instead import the named
 * functions directly. Idempotent and best-effort (no-op if `globalThis` lacks
 * `Object`, e.g. in a non-browser host).
 */
export function install_global(): void;

/**
 * Reconstruct the canonical ROOT-INDEPENDENT resource URN string for a store +
 * resource key: `urn:dig:chia:<store_id>[/<resource_key>]`. An empty resource
 * key resolves to the §8.5 default view `index.html`. This is the form whose
 * SHA-256 is the retrieval key and whose bytes seed the AES key.
 */
export function reconstructUrn(store_id_hex: string, resource_key: string): string;

/**
 * Reconstruct a ROOT-PINNED display URN: `urn:dig:chia:<store_id>:<root>/<key>`.
 * Useful for sharing a URN bound to a specific generation; the retrieval/AES
 * keys still use the rootless form (`reconstructUrn`).
 */
export function reconstructUrnWithRoot(store_id_hex: string, root_hex: string, resource_key: string): string;

/**
 * `retrieval_key = SHA-256(canonical_rootless_urn)`, lowercase hex (Digstore
 * §7.3; API §17). The CDN is addressed by this hash; the URN itself is never
 * sent. An empty resource key resolves to `index.html`.
 */
export function retrievalKey(store_id_hex: string, resource_key: string): string;

/**
 * Verify that `ciphertext` is included under `trusted_root_hex` via the base64
 * merkle `proof_b64` (Digstore §9.3; API §18). Returns `true` on success and
 * `false` on ANY verification failure (tampered bytes, non-chaining path, or a
 * root mismatch / decoy) — a decoy or wrong-store response returns `false`
 * rather than throwing, so a caller can treat it as "not found in this store".
 * Throws only on malformed inputs (bad base64 / hex / proof encoding).
 */
export function verifyInclusion(ciphertext: Uint8Array, proof_b64: string, trusted_root_hex: string): boolean;

/**
 * Library version (matches the crate version), for SRI / compatibility checks.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decryptChunk: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly decryptResource: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number, number];
    readonly decryptResourceToText: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number, number];
    readonly deriveKey: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly encryptResource: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly install_global: () => void;
    readonly reconstructUrn: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly reconstructUrnWithRoot: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly retrievalKey: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly verifyInclusion: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly version: () => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__hc605e6b36f32dd24: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h58cab831a65fd6c8: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h68a3f7e1b7047a46: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h36771739d8dc18ae: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly wasm_bindgen__convert__closures_____invoke__hd4233470ad4ef59f: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h61ffc6ac64470c43: (a: number, b: number) => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
