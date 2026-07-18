// The read-crypto WASM surface (the `dig_client` module built from digstore's dig-client-wasm
// crate). These signatures mirror the published `@dignetwork/dig-capsule-wasm` `dig_client.d.ts`. The SDK
// loads this wasm lazily from that package and SRI-verifies it before use (see loader.ts).

/** The read-crypto functions the SDK uses from the dig_client WASM. */
export interface DigClientWasm {
  /** `retrieval_key = SHA-256(canonical rootless urn)`, lowercase hex. Empty key ⇒ index.html. */
  retrievalKey(storeIdHex: string, resourceKey: string): string;
  /** Derive the 32-byte AES-256 content key (lowercase hex). `saltHex` for a private store. */
  deriveKey(storeIdHex: string, resourceKey: string, saltHex?: string | null): string;
  /**
   * Verify `ciphertext` is included under `trustedRootHex` via the base64 merkle `proofB64`.
   * Returns true on success, false on ANY verification failure (a decoy returns false rather than
   * throwing). Throws only on malformed inputs.
   */
  verifyInclusion(
    ciphertext: Uint8Array,
    proofB64: string,
    trustedRootHex: string,
  ): boolean;
  /** AES-256-GCM-SIV-open a single chunk under an explicit 32-byte `keyHex`. Throws on tag fail. */
  decryptChunk(keyHex: string, ciphertext: Uint8Array): Uint8Array;
  /**
   * Full read pipeline: gate (inclusion) then decrypt (URN key, split by `chunkLens`), returning
   * plaintext bytes. `chunkLens` may be null/empty for a single-chunk resource.
   */
  decryptResource(
    storeIdHex: string,
    resourceKey: string,
    ciphertext: Uint8Array,
    proofB64: string,
    trustedRootHex: string,
    saltHex?: string | null,
    chunkLens?: Uint32Array | null,
  ): Uint8Array;
  /** As `decryptResource`, returning UTF-8 text. */
  decryptResourceToText(
    storeIdHex: string,
    resourceKey: string,
    ciphertext: Uint8Array,
    proofB64: string,
    trustedRootHex: string,
    saltHex?: string | null,
    chunkLens?: Uint32Array | null,
  ): string;
  /** Seal a resource's plaintext as one GCM-SIV blob under its per-URN key (the encrypt inverse). */
  encryptResource(
    storeIdHex: string,
    resourceKey: string,
    plaintext: Uint8Array,
    saltHex?: string | null,
  ): Uint8Array;
  /** Reconstruct the canonical rootless URN string. */
  reconstructUrn(storeIdHex: string, resourceKey: string): string;
  /** Reconstruct a root-pinned display URN string. */
  reconstructUrnWithRoot(
    storeIdHex: string,
    rootHex: string,
    resourceKey: string,
  ): string;
  /** Library version (matches the crate version). */
  version(): string;
}
