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
// presence is UNKNOWABLE. The oblivious primitives `read` / `readResource` therefore NEVER conclude
// "not found": they return plaintext when the URN key decrypts the bytes, otherwise the raw
// ciphertext (a decoy is just opaque bytes), with advisory `{ verified, decrypted }` flags. The only
// error they throw is a transport failure — the trust decision is left entirely to the caller.
//
// SECURE-BY-DEFAULT siblings. Anything that RENDERS or SERVES read bytes must fail closed, so the
// oblivious primitives have fail-closed companions: `readVerified` (and the render-class `readText`)
// throw `DECRYPT_FAILED` on undecryptable bytes and `INCLUSION_UNVERIFIED` when the bytes are read
// under a PINNED root (anything but an explicit unpinned sentinel — see {@link rootIsPinned}) yet fail their
// on-chain inclusion proof — never returning chain-unbacked bytes to a renderer. Under an UNPINNED
// / "latest" root inclusion cannot be proven in the blind model, so it stays advisory (the
// blind-model exception): the secure readers gate on decryption only. Renderers use `readVerified` /
// `readText`; deliberate decoy/self-verified handling uses the oblivious `read` / `readResource`.

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

// Hard ceiling on a single resource's declared `total_length`, enforced BEFORE allocating the
// reassembly buffer. The §5.3 ladder makes an unauthenticated local node the default endpoint, so a
// ~200-byte response declaring a multi-GiB `total_length` would otherwise force a giant allocation
// before any verification — a cheap DoS. A DIG resource is a single addressable web asset (one file
// within a store), for which 512 MiB is far above any plausible real size yet safely allocatable.
// NOTE: this bound is chosen by the SDK, not yet a normative protocol constant — see SPEC.md.
const MAX_RESOURCE_BYTES = 512 * 1024 * 1024;

// Ceiling on the ciphertext carried by a SINGLE `dig.getContent` response, enforced before the
// base64 decode allocates (#2517). The aggregate `MAX_RESOURCE_BYTES` ceiling above bounds the
// reassembly buffer but says nothing about one response, so an untrusted node could declare a
// 100-byte resource and answer with hundreds of megabytes.
//
// Be precise about WHAT this bounds. `rpcCall` already did `await res.json()`, so the hostile body
// has been read and parsed: the base64 string (~1.33x the ciphertext) is resident before this check
// runs. What the check prevents is the ADDITIONAL decoded `Uint8Array` — roughly the smaller half of
// the cost. Bounding the response body itself belongs in `rpcCall` (a streaming/size-limited read)
// and is deliberately deferred to its own change, since it has its own blast radius across every
// `dig.*` method.
//
// The client ASKS for `RPC_CHUNK_BYTES`, so a conforming node never exceeds it and the honest
// bound is 3 MiB. Doubling it is deliberate slack in the SAFE direction: refusing content a
// legitimate node serves would break real reads, while 6 MiB is still ~85x below the aggregate
// ceiling and small enough that repeated hostile responses cannot exhaust a tab. A node needing
// more per response is misbehaving by its own protocol.
const MAX_RESPONSE_CIPHERTEXT_BYTES = 2 * RPC_CHUNK_BYTES;

// Ceiling on how many `dig.getContent` pages one resource may take (#2517). The strict
// forward-progress check below already stops a node that repeats an offset forever; this bounds
// the remaining spin — a node that advances by a single byte per page would otherwise make half a
// billion round trips while satisfying "progress". At the requested 3 MiB per page a 512 MiB
// resource needs 171 pages, so 4096 tolerates a node chunking 24x finer than asked before it is
// treated as hostile: generous to slow-but-honest nodes, still a hard bound.
const MAX_CONTENT_PAGES = 4096;

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
   * Fetch + (advisory) verify + decrypt one resource by URN — the OBLIVIOUS read primitive. `root`
   * is the on-chain generation root to verify against (resolved by the caller from the chain); when
   * omitted, the root embedded in the URN is used. A `root` is always REQUIRED (the host can never
   * be the trust anchor); it throws `ROOT_REQUIRED` when none is supplied or derivable.
   *
   * OBLIVIOUS (never throws on content). Because the host returns indistinguishable ciphertext for
   * any key, this NEVER concludes "not found" and NEVER throws on unverified/undecryptable content:
   * it returns `{ bytes, verified, decrypted }` and leaves the trust decision to the caller.
   * `decrypted === false` hands back the raw served ciphertext (a decoy / wrong key/salt);
   * `verified === false` means the bytes are NOT bound to the on-chain root. Beyond a transport
   * failure the only thrown error is `ROOT_REQUIRED`.
   *
   * DO NOT render or serve these bytes without a trust check. Anything that displays/serves read
   * content MUST use the secure-by-default {@link readVerified} (or {@link readText}), which fail
   * closed on a decrypt failure and on a pinned-root inclusion failure. Use `read` only when you
   * deliberately handle unverified bytes (a decoy, or content whose inclusion you verify yourself).
   */
  async read(
    input: { urn: string; root?: string | null; salt?: string | null },
    opts: ReadOptions = {},
  ): Promise<ReadResult> {
    const parsed = parseUrn(input.urn);
    const effSalt = input.salt ?? parsed.salt ?? null;
    // Canonicalise ONCE here: the predicate, the RPC parameter and the wasm verifier downstream all
    // receive this single form, so they can never disagree about what the caller's root is.
    const effRoot = canonicalizeRoot(input.root ?? parsed.root ?? "");
    if (!effRoot) {
      throw new DigSdkError(
        "ROOT_REQUIRED",
        "a confirmed on-chain root is required to read content (pass { root } or use a root-pinned URN)",
        { urn: input.urn },
      );
    }
    return this.readResource(
      {
        storeId: parsed.storeId,
        resourceKey: parsed.resourceKey,
        root: effRoot,
        salt: effSalt,
      },
      opts,
    );
  }

  /**
   * The SECURE-BY-DEFAULT read: fetch + decrypt + trust-gate one resource by URN, throwing rather
   * than ever returning bytes a renderer must not trust. This is what anything that RENDERS or SERVES
   * content should call (the oblivious {@link read} is the escape hatch for deliberate decoy /
   * self-verified handling).
   *
   * Trust gate (why it throws):
   * - `DECRYPT_FAILED` when the served bytes do not decrypt+authenticate under this URN (wrong
   *   store/key/salt, or a decoy) — a renderer must never show undecryptable bytes.
   * - `INCLUSION_UNVERIFIED` when the effective root is PINNED — anything but an explicit unpinned
   *   sentinel, {@link rootIsPinned} — and the inclusion proof did not verify: decryption alone proves only
   *   "knows a public key", so a spoofed node could serve `Enc(publicKey, malicious)` that decrypts
   *   fine — only the on-chain proof binds content to the chain.
   * - BLIND-MODEL EXCEPTION: under an UNPINNED / "latest" root inclusion cannot be proven in the
   *   oblivious model, so it is advisory and NOT fatal — the gate is decryption-only. The returned
   *   result still carries `verified` so the caller can see the advisory outcome.
   *
   * On success returns the same {@link ReadResult} as {@link read} (with `decrypted === true`).
   */
  async readVerified(
    input: { urn: string; root?: string | null; salt?: string | null },
    opts: ReadOptions = {},
  ): Promise<ReadResult> {
    const r = await this.read(input, opts);
    if (!r.decrypted) {
      throw new DigSdkError(
        "DECRYPT_FAILED",
        "resource did not decrypt under this URN — wrong store/key/salt, or a decoy response",
        { urn: input.urn },
      );
    }
    if (rootIsPinned(r.root) && r.verified === false) {
      throw new DigSdkError(
        "INCLUSION_UNVERIFIED",
        "served content did not verify against the pinned on-chain root — refusing to return chain-unbacked bytes to a renderer (use read() to handle unverified content deliberately)",
        { urn: input.urn, root: r.root },
      );
    }
    return r;
  }

  /**
   * As {@link readVerified} — the render-class reader — but decoding the trusted plaintext to a
   * UTF-8 string. Throws `DECRYPT_FAILED` on undecryptable bytes and `INCLUSION_UNVERIFIED` under a
   * pinned root whose inclusion proof failed (the blind-model exception applies for unpinned roots).
   */
  async readText(
    input: { urn: string; root?: string | null; salt?: string | null },
    opts: ReadOptions = {},
  ): Promise<string> {
    const r = await this.readVerified(input, opts);
    return new TextDecoder().decode(r.bytes);
  }

  /**
   * Read by explicit (storeId, resourceKey, root, salt) rather than a URN string — the oblivious
   * download primitive the URN read is built on, and the ADVISORY escape hatch.
   *
   * Like {@link read} and unlike the fail-closed {@link readVerified}/{@link readText}, this NEVER
   * throws on unverified or undecryptable content: it returns `{ bytes, verified, decrypted }` and leaves the trust decision
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
    for (let page = 0; ; page++) {
      if (page >= MAX_CONTENT_PAGES) {
        // RESOURCE_TOO_LARGE, not RPC_MALFORMED_RESPONSE: every response here was well-formed. This
        // is the client's own paging ceiling, and a consumer can act on the difference between "this
        // node lies about its wire format" and "this node is uselessly slow".
        throw new DigSdkError(
          "RESOURCE_TOO_LARGE",
          `The content network did not finish serving this resource within ${MAX_CONTENT_PAGES} chunks; refusing to keep paging.`,
          {
            rpcMethod: "dig.getContent",
            pages: page,
            maxPages: MAX_CONTENT_PAGES,
          },
        );
      }
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
        // Bound the UNTRUSTED declared length against the protocol ceiling BEFORE allocating. Check
        // the raw number (not `>>> 0`, which would wrap a >2^32 value down under the ceiling).
        const declared = Number(r.total_length);
        if (!Number.isFinite(declared) || declared < 0) {
          throw new DigSdkError(
            "RPC_MALFORMED_RESPONSE",
            "The content network declared an invalid total_length.",
            { rpcMethod: "dig.getContent", declaredLength: r.total_length },
          );
        }
        if (declared > MAX_RESOURCE_BYTES) {
          throw new DigSdkError(
            "RESOURCE_TOO_LARGE",
            `The content network declared a resource of ${declared} bytes, above the ${MAX_RESOURCE_BYTES}-byte ceiling; refusing to allocate.`,
            {
              rpcMethod: "dig.getContent",
              declaredLength: declared,
              maxLength: MAX_RESOURCE_BYTES,
            },
          );
        }
        total = declared >>> 0; // safe: declared <= ceiling (< 2^31)
        try {
          buf = new Uint8Array(total);
        } catch (cause) {
          // A length under the ceiling can still exceed what THIS host can allocate — fail loudly
          // with a typed refusal rather than letting a RangeError abort the process.
          throw new DigSdkError(
            "RESOURCE_TOO_LARGE",
            `Failed to allocate a ${total}-byte buffer for the resource.`,
            { rpcMethod: "dig.getContent", declaredLength: total },
            { cause },
          );
        }
      }
      if (chunkLens === null && Array.isArray(r.chunk_lens)) {
        chunkLens = r.chunk_lens.map((n) => n >>> 0);
      }
      const b64 = r.ciphertext ?? "";
      // The ceiling below measures `b64.length`, so it is only a bound if `b64` IS a string.
      // `b64ToBytes` reaches `atob`, which coerces its argument with ToString — so a JSON array
      // `["<64 MiB of base64>"]` has `.length === 1` (passing the ceiling) yet stringifies to its
      // element and decodes in full, and a value with no `.length` at all (a number, `true`, `{}`)
      // makes the comparison `NaN > MAX`, which is FALSE — the guard fails OPEN. `JSON.parse`
      // produces every one of those shapes from an untrusted node. Reject the type first so the
      // guard's predicate is never narrower than what it claims to bound.
      if (typeof b64 !== "string") {
        throw new DigSdkError(
          "RPC_MALFORMED_RESPONSE",
          "The content network returned a non-string ciphertext.",
          { rpcMethod: "dig.getContent", ciphertextType: typeof b64 },
        );
      }
      // Bound the DECODE, not just the aggregate: base64 carries 3 bytes per 4 characters, so the
      // encoded length tells us the allocation size before we make it (#2517).
      const decodedBytes = Math.floor((b64.length * 3) / 4);
      if (decodedBytes > MAX_RESPONSE_CIPHERTEXT_BYTES) {
        throw new DigSdkError(
          "RESOURCE_TOO_LARGE",
          `The content network returned a ${decodedBytes}-byte chunk, above the ${MAX_RESPONSE_CIPHERTEXT_BYTES}-byte per-response ceiling; refusing to decode.`,
          {
            rpcMethod: "dig.getContent",
            chunkLength: decodedBytes,
            maxChunkLength: MAX_RESPONSE_CIPHERTEXT_BYTES,
          },
        );
      }
      // `atob` throws a raw `DOMException` on any string that is not valid base64 — an illegal
      // character, or a length that is not a whole number of quanta. Ordinary truncation or
      // corruption produces both, so this fires far more often than a crafted response, and an
      // uncoded throw escaping `read()` breaks the SDK's contract that every failure it surfaces
      // is a `DigSdkError` (#2518).
      let chunk: Uint8Array;
      try {
        chunk = b64ToBytes(b64);
      } catch (cause) {
        throw new DigSdkError(
          "RPC_MALFORMED_RESPONSE",
          "The content network returned a ciphertext that is not valid base64.",
          { rpcMethod: "dig.getContent", chunkLength: b64.length },
          { cause },
        );
      }
      // Validate the WRITE offset before it reaches `TypedArray.set`, which throws a raw
      // `RangeError` when `targetOffset > targetLength` — even for an empty source. A ~60-byte
      // response declaring `offset: 5000` into a 100-byte resource would otherwise escape `read()`
      // as an uncoded error, breaking the SDK's contract that every failure it surfaces is a
      // `DigSdkError`. `>>> 0` cannot substitute for this: it silently wraps a huge or negative
      // offset into a plausible one rather than refusing it.
      const at = r.offset;
      if (!Number.isInteger(at) || at < 0 || at > total) {
        throw new DigSdkError(
          "RPC_MALFORMED_RESPONSE",
          `The content network returned an out-of-range chunk offset (${String(r.offset)} into a ${total}-byte resource).`,
          {
            rpcMethod: "dig.getContent",
            chunkOffset: r.offset,
            totalLength: total,
          },
        );
      }
      buf!.set(
        chunk.subarray(0, Math.max(0, Math.min(chunk.length, total - at))),
        at,
      );
      if (r.inclusion_proof) proof = r.inclusion_proof;
      if (r.complete || r.next_offset == null) break;
      // Require STRICT forward progress. A node repeating (or rewinding) an offset while holding
      // `complete: false` would otherwise spin the client forever on a well-formed-looking reply
      // (#2517) — the cheapest possible hang, and the §5.3 ladder makes an unauthenticated local
      // node the default endpoint for a Node consumer.
      const next = r.next_offset >>> 0;
      if (next <= offset) {
        throw new DigSdkError(
          "RPC_MALFORMED_RESPONSE",
          `The content network returned a non-advancing next_offset (${next} after ${offset}); refusing to loop.`,
          { rpcMethod: "dig.getContent", offset, nextOffset: next },
        );
      }
      offset = next;
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
    // A 200 whose body is not JSON — `{{{`, an empty body, an HTML captive-portal page — makes
    // `res.json()` throw a raw `SyntaxError`. This is the shared transport for EVERY `dig.*`
    // method, so an uncoded throw here escapes the whole public surface (#2518).
    let json: {
      result?: T;
      error?: { message?: string; code?: number };
    };
    try {
      json = (await res.json()) as typeof json;
    } catch (cause) {
      throw new DigSdkError(
        "RPC_MALFORMED_RESPONSE",
        `dig RPC ${method} returned a body that is not valid JSON.`,
        { rpcMethod: method, httpStatus: res.status },
        { cause },
      );
    }
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

/**
 * The only root values that mean "no generation is pinned" — compared against the canonical form,
 * so `LATEST` and `" latest "` are the same sentinel. Everything else is a root.
 */
const UNPINNED_ROOT_SENTINELS: ReadonlySet<string> = new Set(["", "latest"]);

/**
 * The one canonical rendering of a root: trimmed, lowercased, without a `0x` prefix. The wasm
 * verifier, the RPC parameter and {@link rootIsPinned} must all see the SAME string — two layers
 * disagreeing about what a root IS is how a verifiable root came to read as unpinned.
 */
export function canonicalizeRoot(root: string): string {
  return root.trim().toLowerCase().replace(/^0x/, "");
}

/**
 * True iff `root` PINS an on-chain generation, and therefore MUST satisfy the inclusion gate in the
 * secure readers ({@link readVerified} / {@link readText}). FAIL-CLOSED BY DEFAULT: only the narrow
 * set of unpinned sentinels (`""`, `latest`, in any casing/padding) and an absent root are ungated
 * — every other value is treated as a pinned root and is gated.
 *
 * The polarity is deliberate and load-bearing. This predicate decides WHETHER content is checked
 * against the chain, so its failure modes are asymmetric: over-recognising is safe (an unusable
 * root simply cannot verify, producing a loud `INCLUSION_UNVERIFIED`), while under-recognising is
 * silent (the gate is skipped and a spoofed node's plaintext is returned with no symptom). A
 * `[0-9a-f]{64}` allowlist under-recognises every rendering the wasm verifier accepts but does not
 * emit — uppercase and whitespace-padded roots verify correctly yet would read as unpinned.
 *
 * Stricter than hub.dig.net's `rootIsPinned` (`/^[0-9a-f]{64}$/i`), which gates the same canonical
 * and uppercase roots but leaves padded/prefixed renderings ungated; every root the hub gates, this
 * gates too.
 *
 * Under an unpinned root inclusion cannot be proven in the blind model, so it is advisory only (the
 * blind-model exception).
 */
export function rootIsPinned(root: string | null | undefined): boolean {
  if (typeof root !== "string") return false;
  return !UNPINNED_ROOT_SENTINELS.has(canonicalizeRoot(root));
}

function undefinedFetch(): typeof fetch {
  return (() => {
    throw new DigSdkError(
      "INVALID_ARGUMENT",
      "No global fetch available. Pass { fetch } to DigClient (Node < 18 needs a fetch polyfill).",
    );
  }) as unknown as typeof fetch;
}
