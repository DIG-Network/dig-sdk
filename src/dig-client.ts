// DigClient — the read side of the SDK. It fetches a resource's served ciphertext from the dig RPC,
// derives the URN's keys CLIENT-SIDE via the read-crypto wasm, verifies inclusion against an
// on-chain root, and decrypts — so the serving host stays BLIND (it only ever relays opaque
// ciphertext + proofs). Genericized from hub.dig.net/apps/web/lib/dig-client.js, with the hub-app
// coupling removed (no Vite import.meta.env, no window.location origin; the RPC endpoint and the
// trust root are explicit inputs).
//
// HARD BOUNDARY (read sources). Everything read from a .dig — ciphertext, inclusion proofs, the
// public manifest, metadata — comes ONLY from the dig RPC. The trust ROOT it is verified against
// comes from the chain (the caller resolves it from coinset.org and passes it in). The host can
// never become the trust anchor: every content read REQUIRES a caller-supplied root.
//
// OBLIVIOUS model. The host returns indistinguishable ciphertext for any retrieval key, so
// presence is UNKNOWABLE. A read therefore NEVER concludes "not found": it returns plaintext when
// the URN key decrypts the bytes, otherwise the raw ciphertext (a decoy is just opaque bytes). The
// only thrown error is a transport failure.

import { loadDigClientWasm } from "./loader.js";
import type { DigClientWasm } from "./wasm.js";
import { parseUrn } from "./urn.js";
import type { ReadOptions, ReadResult, UrnKeys } from "./types.js";
import { DigSdkError } from "./errors.js";

/** The default public dig RPC endpoint. */
export const DEFAULT_RPC = "https://rpc.dig.net";

// The backend caps each dig.getContent chunk at 3 MiB (Lambda/APIGW response ceiling); the client
// loops chunks until `complete`.
const RPC_CHUNK_BYTES = 3 * 1024 * 1024;

/** Options to construct a DigClient. */
export interface DigClientOptions {
  /** dig RPC endpoint. Defaults to the public `https://rpc.dig.net`. */
  rpc?: string;
  /** Override `fetch` (e.g. an instrumented one). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

interface GetContentResult {
  total_length: number;
  offset: number;
  next_offset?: number | null;
  complete?: boolean;
  ciphertext?: string;
  inclusion_proof?: string;
  chunk_lens?: number[];
}

/** Decode a standard-base64 string (the RPC ciphertext encoding) to bytes — no DOM dependency. */
function b64ToBytes(b64: string): Uint8Array {
  // atob exists in browsers and modern Node; fall back to Buffer in older Node.
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Uint8Array((globalThis as any).Buffer.from(b64, "base64"));
}

/**
 * The read-crypto client. Construct once and reuse — the wasm is loaded + SRI-verified lazily on
 * the first read and memoized process/page-wide.
 *
 * @example
 * const dig = new DigClient();
 * const { bytes, decrypted } = await dig.read({
 *   urn: "urn:dig:chia:<storeId>/index.html",
 *   root: "<onchain-root-hex>",
 * });
 * if (decrypted) console.log(new TextDecoder().decode(bytes));
 */
export class DigClient {
  private readonly rpc: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DigClientOptions = {}) {
    this.rpc = options.rpc ?? DEFAULT_RPC;
    this.fetchImpl =
      options.fetch ??
      (typeof fetch === "function" ? fetch.bind(globalThis) : undefinedFetch());
  }

  /** Load (and SRI-verify) the read-crypto wasm. Exposed for callers that want the raw functions. */
  async wasm(): Promise<DigClientWasm> {
    return loadDigClientWasm();
  }

  /** `retrieval_key = SHA-256(canonical rootless URN)`, lowercase hex. */
  async retrievalKey(storeId: string, resourceKey: string): Promise<string> {
    return (await this.wasm()).retrievalKey(storeId, resourceKey);
  }

  /** Derive the per-URN AES-256-GCM-SIV key, lowercase hex. `salt` for a private store. */
  async deriveKey(
    storeId: string,
    resourceKey: string,
    salt?: string | null,
  ): Promise<string> {
    return (await this.wasm()).deriveKey(storeId, resourceKey, salt ?? undefined);
  }

  /** Verify served `ciphertext` is included under `root` via the base64 merkle `proof`. */
  async verifyInclusion(
    ciphertext: Uint8Array,
    proof: string,
    root: string,
  ): Promise<boolean> {
    return (await this.wasm()).verifyInclusion(ciphertext, proof, root);
  }

  /** Reconstruct the canonical rootless URN whose SHA-256 is the retrieval key. */
  async reconstructUrn(storeId: string, resourceKey: string): Promise<string> {
    return (await this.wasm()).reconstructUrn(storeId, resourceKey);
  }

  /**
   * Derive, client-side, the two root-independent keys a URN maps to (retrieval + decryption).
   * Nothing is sent to the network — pure local derivation via the wasm.
   */
  async deriveUrnKeys(input: { urn: string; salt?: string | null }): Promise<UrnKeys> {
    const parsed = parseUrn(input.urn);
    const wasm = await this.wasm();
    const effSalt = input.salt ?? parsed.salt ?? undefined;
    return {
      storeId: parsed.storeId,
      root: parsed.root,
      resourceKey: parsed.resourceKey,
      salt: effSalt ?? null,
      retrievalKey: wasm.retrievalKey(parsed.storeId, parsed.resourceKey),
      decryptionKey: wasm.deriveKey(parsed.storeId, parsed.resourceKey, effSalt),
    };
  }

  /**
   * Fetch + verify + decrypt one resource by URN. `root` is the on-chain generation root to verify
   * against (resolved by the caller from the chain); when omitted, the root embedded in the URN is
   * used. Returns the bytes plus advisory `verified`/`decrypted` flags. NEVER throws "not found"
   * (presence is unknowable) — it throws only on a transport failure.
   */
  async read(
    input: { urn: string; root?: string | null; salt?: string | null },
    opts: ReadOptions = {},
  ): Promise<ReadResult> {
    const parsed = parseUrn(input.urn);
    const effSalt = input.salt ?? parsed.salt ?? null;
    const effRoot = input.root ?? parsed.root ?? null;
    if (!effRoot) {
      throw new DigSdkError(
        "ROOT_REQUIRED",
        "a confirmed on-chain root is required to read content (pass { root } or use a root-pinned URN)",
        { urn: input.urn },
      );
    }
    return this.readResource(
      { storeId: parsed.storeId, resourceKey: parsed.resourceKey, root: effRoot, salt: effSalt },
      opts,
    );
  }

  /** As `read`, but decoding the plaintext to a UTF-8 string when it decrypts (else throws). */
  async readText(
    input: { urn: string; root?: string | null; salt?: string | null },
    opts: ReadOptions = {},
  ): Promise<string> {
    const r = await this.read(input, opts);
    if (!r.decrypted) {
      throw new DigSdkError(
        "DECRYPT_FAILED",
        "resource did not decrypt under this URN — wrong store/key/salt, or a decoy response",
        { urn: input.urn },
      );
    }
    return new TextDecoder().decode(r.bytes);
  }

  /**
   * Read by explicit (storeId, resourceKey, root, salt) rather than a URN string. The oblivious
   * download primitive the URN read is built on.
   */
  async readResource(
    input: { storeId: string; resourceKey: string; root: string; salt?: string | null },
    opts: ReadOptions = {},
  ): Promise<ReadResult> {
    const rpc = opts.rpc ?? this.rpc;
    const wasm = await this.wasm();
    const rk = wasm.retrievalKey(input.storeId, input.resourceKey);
    const { ciphertext, proof, chunkLens } = await this.fetchCiphertext(
      input.storeId,
      rk,
      input.root,
      rpc,
    );
    let verified = false;
    try {
      verified = !!wasm.verifyInclusion(ciphertext, proof, input.root);
    } catch {
      verified = false;
    }
    const keyHex = wasm.deriveKey(input.storeId, input.resourceKey, input.salt ?? undefined);
    try {
      const bytes = decryptResourceChunks(wasm, keyHex, ciphertext, chunkLens);
      return {
        storeId: input.storeId,
        root: input.root,
        resourceKey: input.resourceKey,
        salt: input.salt ?? null,
        bytes,
        verified,
        decrypted: true,
      };
    } catch {
      // Not decryptable with this URN/salt — hand back the raw bytes; never a "not present" verdict.
      return {
        storeId: input.storeId,
        root: input.root,
        resourceKey: input.resourceKey,
        salt: input.salt ?? null,
        bytes: ciphertext,
        verified,
        decrypted: false,
      };
    }
  }

  // Stream the FULL ciphertext for a resource from the RPC by retrieval key, reassembling 3-MiB
  // chunks. A null result is a TRANSPORT failure, never a presence judgment.
  private async fetchCiphertext(
    storeId: string,
    rk: string,
    root: string,
    rpc: string,
  ): Promise<{ ciphertext: Uint8Array; proof: string; chunkLens: number[] | null }> {
    let offset = 0;
    let total: number | null = null;
    let buf: Uint8Array | null = null;
    let proof = "";
    let chunkLens: number[] | null = null;
    for (;;) {
      const r = await this.rpcCall<GetContentResult>(rpc, "dig.getContent", {
        store_id: storeId,
        root,
        retrieval_key: rk,
        offset,
        length: RPC_CHUNK_BYTES,
      });
      if (!r)
        throw new DigSdkError(
          "RPC_MALFORMED_RESPONSE",
          "The content network returned no data for this request.",
          { rpcMethod: "dig.getContent" },
        );
      if (total === null) {
        total = r.total_length >>> 0;
        buf = new Uint8Array(total);
      }
      if (chunkLens === null && Array.isArray(r.chunk_lens)) {
        chunkLens = r.chunk_lens.map((n) => n >>> 0);
      }
      const chunk = b64ToBytes(r.ciphertext ?? "");
      const at = r.offset >>> 0;
      buf!.set(chunk.subarray(0, Math.max(0, Math.min(chunk.length, total - at))), at);
      if (r.inclusion_proof) proof = r.inclusion_proof;
      if (r.complete || r.next_offset == null) break;
      offset = r.next_offset >>> 0;
    }
    return { ciphertext: buf ?? new Uint8Array(0), proof, chunkLens };
  }

  // One JSON-RPC 2.0 call. Throws a coded DigSdkError on transport failure (RPC_TRANSPORT) or a
  // JSON-RPC/HTTP error (RPC_ERROR, carrying rpcMethod/httpStatus/rpcCode context); returns `result`.
  private async rpcCall<T>(rpc: string, method: string, params: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (e) {
      throw new DigSdkError(
        "RPC_TRANSPORT",
        "Could not reach the content network. Check your connection and try again.",
        { rpcMethod: method },
        { cause: e },
      );
    }
    if (!res.ok)
      throw new DigSdkError("RPC_ERROR", `dig RPC ${method} failed (${res.status})`, {
        rpcMethod: method,
        httpStatus: res.status,
      });
    const json = (await res.json()) as {
      result?: T;
      error?: { message?: string; code?: number };
    };
    if (json && json.error)
      throw new DigSdkError(
        "RPC_ERROR",
        `dig RPC ${method}: ${json.error.message ?? "error"}`,
        { rpcMethod: method, rpcCode: json.error.code },
      );
    return json ? (json.result ?? null) : null;
  }
}

// AES-256-GCM-SIV-open a resource's served ciphertext under `keyHex`, splitting the PLAIN-
// concatenated chunk ciphertexts by `chunkLens` (per-chunk CIPHERTEXT byte lengths) and opening
// each. Empty/absent chunkLens ⇒ single-chunk resource. Throws if any chunk's tag fails.
function decryptResourceChunks(
  wasm: DigClientWasm,
  keyHex: string,
  ciphertext: Uint8Array,
  chunkLens: number[] | null,
): Uint8Array {
  const lens = chunkLens && chunkLens.length ? chunkLens : [ciphertext.length];
  const total = lens.reduce((a, n) => a + n, 0);
  if (total !== ciphertext.length) {
    throw new DigSdkError(
      "RPC_MALFORMED_RESPONSE",
      "served ciphertext length does not match chunk lengths",
      { rpcMethod: "dig.getContent", expected: String(total), actual: String(ciphertext.length) },
    );
  }
  if (lens.length === 1) return wasm.decryptChunk(keyHex, ciphertext);
  const parts: Uint8Array[] = [];
  let p = 0;
  for (const len of lens) {
    parts.push(wasm.decryptChunk(keyHex, ciphertext.subarray(p, p + len)));
    p += len;
  }
  const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let q = 0;
  for (const part of parts) {
    out.set(part, q);
    q += part.length;
  }
  return out;
}

function undefinedFetch(): typeof fetch {
  return (() => {
    throw new DigSdkError(
      "INVALID_ARGUMENT",
      "No global fetch available. Pass { fetch } to DigClient (Node < 18 needs a fetch polyfill).",
    );
  }) as unknown as typeof fetch;
}
