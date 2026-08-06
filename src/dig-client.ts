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
import { b64ToBytes } from "./hex.js";
import type {
  CollectionItemsPage,
  CollectionMeta,
  ReadOptions,
  ReadResult,
  UrnKeys,
} from "./types.js";
import { DigSdkError } from "./errors.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  GATEWAY_URL,
  isBrowserEnv,
  makeHealthProbe,
  readEnvNodeUrl,
  resolveNodeEndpoint,
  type NodeProbe,
  type ResolvedNode,
} from "./node-resolver.js";

/**
 * The public gateway endpoint — the §5.3 ladder's TERMINAL fallback, NOT a privileged primary. It is
 * exported for back-compat and as `capabilities().defaultRpc`; a `DigClient` with no explicit `rpc`
 * now resolves the endpoint through the §5.3 ladder (local node first), falling back to this only when
 * no local node answers. Do NOT read this as "the default endpoint" — it is the last resort.
 */
export const DEFAULT_RPC = GATEWAY_URL;

// The backend caps each dig.getContent chunk at 3 MiB (Lambda/APIGW response ceiling); the client
// loops chunks until `complete`.
const RPC_CHUNK_BYTES = 3 * 1024 * 1024;

/** Options to construct a DigClient. */
export interface DigClientOptions {
  /**
   * An explicit dig node/RPC endpoint. When set it OVERRIDES the §5.3 resolution ladder entirely
   * (no probing). When omitted, the endpoint is resolved through the ladder: `DIG_NODE_URL` env
   * override › `dig.local` › `localhost` › the `https://rpc.dig.net` gateway (terminal fallback) —
   * so the user's OWN local node is preferred and the public gateway is only the last resort.
   */
  rpc?: string;
  /** Override `fetch` (e.g. an instrumented one). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Override the §5.3 local-node health probe. Injected mainly for tests (deterministic, no network);
   * defaults to a cheap `GET /health` on a short timeout using this client's `fetch`.
   */
  nodeProbe?: NodeProbe;
  /** Per-rung probe timeout (ms) for the §5.3 ladder. Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
  /**
   * Force the browser/Node resolution mode. Defaults to auto-detection ({@link isBrowserEnv}); a
   * browser client skips the local rungs and uses explicit › env › gateway (mixed-content / cert
   * constraints forbid probing a plaintext-loopback or self-signed-localhost node from a page).
   */
  isBrowser?: boolean;
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

/**
 * The read-crypto client. Construct once and reuse — the wasm is loaded lazily on the first read
 * and memoized process/page-wide. Its integrity anchor depends on the load path (see loader.ts):
 * byte-level SRI on Node and on the `configureWasm({ wasmBytes | wasmUrl })` path; the pinned
 * exact-version package artifact on the default browser (bundler) path.
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
  private readonly fetchImpl: typeof fetch;
  /** The explicit endpoint override (constructor `rpc`), or null to resolve via the §5.3 ladder. */
  private readonly explicitRpc: string | null;
  private readonly nodeProbe: NodeProbe;
  private readonly probeTimeoutMs: number;
  private readonly isBrowser: boolean;
  /** Memoized §5.3 resolution — resolved once per instance and reused for its lifetime. */
  private resolvedNode: Promise<ResolvedNode> | null = null;

  constructor(options: DigClientOptions = {}) {
    this.fetchImpl =
      options.fetch ??
      (typeof fetch === "function" ? fetch.bind(globalThis) : undefinedFetch());
    this.explicitRpc = options.rpc ?? null;
    this.nodeProbe = options.nodeProbe ?? makeHealthProbe(this.fetchImpl);
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.isBrowser = options.isBrowser ?? isBrowserEnv();
  }

  /**
   * The dig node endpoint this client reads from, resolved through the §5.3 ladder (explicit ›
   * `DIG_NODE_URL` › `dig.local` › `localhost` › gateway) and MEMOIZED for the instance's lifetime.
   * A per-call `opts.rpc` still overrides it. Exposed so callers can learn which node was chosen.
   */
  async resolveEndpoint(): Promise<ResolvedNode> {
    if (!this.resolvedNode) {
      this.resolvedNode = resolveNodeEndpoint({
        explicit: this.explicitRpc,
        env: readEnvNodeUrl(),
        isBrowser: this.isBrowser,
        probe: this.nodeProbe,
        timeoutMs: this.probeTimeoutMs,
      });
    }
    return this.resolvedNode;
  }

  /** The endpoint for a call: a per-call `opts.rpc` override, else the memoized §5.3 resolution. */
  private async endpoint(opts: ReadOptions): Promise<string> {
    return opts.rpc ?? (await this.resolveEndpoint()).url;
  }

  /** Load the read-crypto wasm (integrity per the loader path). Exposed for callers wanting the raw functions. */
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
    return (await this.wasm()).deriveKey(
      storeId,
      resourceKey,
      salt ?? undefined,
    );
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
  async deriveUrnKeys(input: {
    urn: string;
    salt?: string | null;
  }): Promise<UrnKeys> {
    const parsed = parseUrn(input.urn);
    const wasm = await this.wasm();
    const effSalt = input.salt ?? parsed.salt ?? undefined;
    return {
      storeId: parsed.storeId,
      root: parsed.root,
      resourceKey: parsed.resourceKey,
      salt: effSalt ?? null,
      retrievalKey: wasm.retrievalKey(parsed.storeId, parsed.resourceKey),
      decryptionKey: wasm.deriveKey(
        parsed.storeId,
        parsed.resourceKey,
        effSalt,
      ),
    };
  }

  /**
   * Fetch + verify + decrypt one resource by URN — the FAIL-CLOSED default reader. `root` is the
   * on-chain generation root to verify against (resolved by the caller from the chain); when omitted,
   * the root embedded in the URN is used.
   *
   * INTEGRITY (why this throws). Decryption success alone proves only "knows a public key": for a
   * public (saltless) store the content key is derivable from the public URN, so an untrusted or
   * spoofed node (e.g. a plaintext `localhost` under the §5.3 ladder) could serve `Enc(publicKey,
   * malicious)` bytes that decrypt fine. Only the on-chain inclusion proof binds content to the
   * chain. This reader therefore REQUIRES `verified === true` and throws `CONTENT_UNVERIFIED`
   * otherwise — it never returns chain-unbacked bytes. A caller that deliberately wants the advisory
   * (possibly-unverified) bytes uses {@link readResource}, which returns the `{ verified, decrypted }`
   * flags instead of throwing.
   *
   * NOTE — behaviour change vs 0.4.4: `read`/`readText` now throw on unverified content (a deliberate
   * secure default); the old advisory behaviour lives on in `readResource`. Still never a "not found"
   * (presence is unknowable) — beyond a transport failure it throws only when content fails to verify.
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
    const result = await this.readResource(
      {
        storeId: parsed.storeId,
        resourceKey: parsed.resourceKey,
        root: effRoot,
        salt: effSalt,
      },
      opts,
    );
    if (!result.verified) {
      throw new DigSdkError(
        "CONTENT_UNVERIFIED",
        "served content did not verify against the on-chain root — refusing to return chain-unbacked bytes (use readResource to handle unverified content deliberately)",
        { urn: input.urn, root: effRoot },
      );
    }
    return result;
  }

  /**
   * As {@link read} (fail-closed: throws `CONTENT_UNVERIFIED` on unverified content), but decoding the
   * verified plaintext to a UTF-8 string — throwing `DECRYPT_FAILED` when the bytes are chain-backed
   * yet do not decrypt under this URN (wrong store/key/salt, or a verified decoy).
   */
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
   * Read by explicit (storeId, resourceKey, root, salt) rather than a URN string — the oblivious
   * download primitive the URN read is built on, and the ADVISORY escape hatch.
   *
   * Unlike the fail-closed {@link read}/{@link readText}, this NEVER throws on unverified or
   * undecryptable content: it returns `{ bytes, verified, decrypted }` and leaves the trust decision
   * to the caller. Use it ONLY when you deliberately handle unverified bytes (e.g. rendering a decoy,
   * or inspecting content whose inclusion proof you check yourself). `verified === false` means the
   * bytes are NOT bound to the on-chain root — treat them as untrusted.
   */
  async readResource(
    input: {
      storeId: string;
      resourceKey: string;
      root: string;
      salt?: string | null;
    },
    opts: ReadOptions = {},
  ): Promise<ReadResult> {
    const rpc = await this.endpoint(opts);
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
    const keyHex = wasm.deriveKey(
      input.storeId,
      input.resourceKey,
      input.salt ?? undefined,
    );
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

  /**
   * Read a collection's public, owner-independent facts (creator DID, item count, uniform royalty)
   * from the dig RPC (`dig.getCollection`). The collection's item set is its NFT launcher ids — the
   * authoritative, owner-independent anchor the mint produced (a DID-attributed NFT is hinted to its
   * OWNER at mint, not to the creator DID, so launcher ids — not the DID — are the read key). Pass
   * the optional `did` to have it echoed back and recorded as the declared creator.
   *
   * No wallet, no read-crypto wasm — a plain JSON-RPC read. Throws a coded {@link DigSdkError} on a
   * transport/RPC failure (never a "not found": an empty/partly-confirmed set just resolves to fewer
   * items).
   *
   * @example
   * const meta = await dig.getCollection({ launcherIds: ["ab…", "cd…"], did: "ef…" });
   * console.log(meta.resolved_count, meta.royalty_basis_points);
   */
  async getCollection(
    input: { launcherIds: string[]; did?: string | null },
    opts: ReadOptions = {},
  ): Promise<CollectionMeta> {
    const rpc = await this.endpoint(opts);
    const params: Record<string, unknown> = { launcher_ids: input.launcherIds };
    if (input.did) params.did = input.did;
    const r = await this.rpcCall<CollectionMeta>(
      rpc,
      "dig.getCollection",
      params,
    );
    if (!r)
      throw new DigSdkError(
        "RPC_MALFORMED_RESPONSE",
        "The content network returned no collection facts for this request.",
        { rpcMethod: "dig.getCollection" },
      );
    return r;
  }

  /**
   * Read a deterministic, paginated page of a collection's items (`dig.listCollectionItems`), each
   * resolved to its CURRENT on-chain state — current owner, royalty, and CHIP-0007 metadata — by the
   * RPC walking the singleton lineage forward to the live tip (so the owner is never the stale
   * mint-time owner). Items come back in the input launcher-id order. `limit` is clamped to the
   * server cap (200); `offset` defaults to 0.
   *
   * Throws a coded {@link DigSdkError} on a transport/RPC failure.
   *
   * @example
   * let page = await dig.listCollectionItems({ launcherIds, limit: 50 });
   * for (const item of page.items) console.log(item.launcher_id, item.owner_puzzle_hash);
   * // page.next_offset is null on the last page.
   */
  async listCollectionItems(
    input: { launcherIds: string[]; offset?: number; limit?: number },
    opts: ReadOptions = {},
  ): Promise<CollectionItemsPage> {
    const rpc = await this.endpoint(opts);
    const params: Record<string, unknown> = { launcher_ids: input.launcherIds };
    if (input.offset !== undefined) params.offset = input.offset;
    if (input.limit !== undefined) params.limit = input.limit;
    const r = await this.rpcCall<CollectionItemsPage>(
      rpc,
      "dig.listCollectionItems",
      params,
    );
    if (!r)
      throw new DigSdkError(
        "RPC_MALFORMED_RESPONSE",
        "The content network returned no collection items for this request.",
        { rpcMethod: "dig.listCollectionItems" },
      );
    return r;
  }

  // Stream the FULL ciphertext for a resource from the RPC by retrieval key, reassembling 3-MiB
  // chunks. A null result is a TRANSPORT failure, never a presence judgment.
  private async fetchCiphertext(
    storeId: string,
    rk: string,
    root: string,
    rpc: string,
  ): Promise<{
    ciphertext: Uint8Array;
    proof: string;
    chunkLens: number[] | null;
  }> {
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
      buf!.set(
        chunk.subarray(0, Math.max(0, Math.min(chunk.length, total - at))),
        at,
      );
      if (r.inclusion_proof) proof = r.inclusion_proof;
      if (r.complete || r.next_offset == null) break;
      offset = r.next_offset >>> 0;
    }
    return { ciphertext: buf ?? new Uint8Array(0), proof, chunkLens };
  }

  // One JSON-RPC 2.0 call. Throws a coded DigSdkError on transport failure (RPC_TRANSPORT) or a
  // JSON-RPC/HTTP error (RPC_ERROR, carrying rpcMethod/httpStatus/rpcCode context); returns `result`.
  private async rpcCall<T>(
    rpc: string,
    method: string,
    params: unknown,
  ): Promise<T | null> {
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
      throw new DigSdkError(
        "RPC_ERROR",
        `dig RPC ${method} failed (${res.status})`,
        {
          rpcMethod: method,
          httpStatus: res.status,
        },
      );
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
      {
        rpcMethod: "dig.getContent",
        expected: String(total),
        actual: String(ciphertext.length),
      },
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
