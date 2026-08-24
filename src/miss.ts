// dig-node's MISS CONTRACT, client side — the one place the SDK understands what a node means when
// it does not hold the content that was asked for.
//
// WHY THIS MODULE EXISTS. A node that misses does not simply 404. It answers with one of a small set
// of codes that carry OPPOSITE instructions, and a client that collapses them into "failed" turns a
// recoverable miss into a dead end for a real person:
//
//   -32008 CONTENT_REDIRECT           the content exists; these holders have it — ask again
//   -32003 CONTENT_MISS_RATE_LIMITED  this node's miss lookups are being driven too fast — back off
//   -32017 CONTENT_MISS_INCONCLUSIVE  absence was NOT established; a retry is meaningful
//   -32004 RESOURCE_UNAVAILABLE       settled: not held at that root — stop
//
// The numbers, the `data.redirect` shape and the hop bound are dig-node's, read from
// `dig-node/crates/dig-node-core/src/download.rs` and pinned by the `dig-rpc-protocol` `ErrorCode`
// taxonomy (0.10.1). Rust clients decode this from `dig-rpc-protocol` itself; this module is its
// TypeScript twin, and it is the SINGLE place any DIG JS/TS client decodes the contract.
//
// This module is PURE: it parses and it decides. It performs no I/O, so both the wire decoding and
// the termination bound are unit-testable against the real error shape with no sockets.

/** The miss-contract JSON-RPC codes, exactly as `dig-rpc-protocol` 0.10.1 numbers them. */
export const MISS_RPC_CODES = Object.freeze({
  /** The miss-lookup budget for THIS requestor is spent. Back off from this node. */
  CONTENT_MISS_RATE_LIMITED: -32003,
  /** Not held here, but the node located holders — `error.data.redirect` names them. */
  CONTENT_REDIRECT: -32008,
  /** Absence was not ESTABLISHED (a leg timed out/refused). Not a not-found; a retry is meaningful. */
  CONTENT_MISS_INCONCLUSIVE: -32017,
  /** Settled: the resource is not available at the requested root. Stop looking. */
  RESOURCE_UNAVAILABLE: -32004,
} as const);

/**
 * The client's OWN hard ceiling on redirect hops, equal to dig-node's `REDIRECT_HOP_CAP`.
 *
 * It is stated here rather than read from the node's answer on purpose: a node's advertised
 * `max_redirects` may only LOWER this bound, never raise it (see {@link RedirectBudget}). A client
 * whose only bound is a number the untrusted peer supplies has no bound at all.
 */
export const REDIRECT_HOP_CAP = 4;

/**
 * The base back-off after a `-32003`, in milliseconds.
 *
 * DERIVED, not chosen: dig-node's miss limiter refills at `DEFAULT_MISS_LOOKUP_REFILL_PER_SEC = 4`
 * tokens per second, so one token becomes available every 250 ms. Waiting less than that guarantees
 * a second refusal. The node states no interval on the wire — the `-32003` frame is a bare
 * `{code, message}` with no `data` — so the honest client-side interval is the one the node's own
 * published refill rate implies.
 */
export const MISS_BACKOFF_BASE_MS = 250;

/** How many times a `-32003` is waited out before the client gives up on that node. */
export const MAX_MISS_BACKOFF_ATTEMPTS = 3;

/**
 * WHAT `-32003` SCOPES TO: the NODE, for all content — never the content, for all nodes.
 *
 * dig-node's limiter is a per-REQUESTOR token bucket on that node's miss-to-DHT-lookup path
 * (`MissRateLimiter`), so the refusal is a statement about how fast this client is asking THIS node
 * and says nothing whatever about the resource. Scoping the back-off to the content instead would
 * blacklist a resource that was never unavailable; scoping it to neither would hammer a node that
 * explicitly asked the client to stop.
 */
export const MISS_RATE_LIMIT_SCOPE = "node" as const;

/** One candidate address of a holder — dig-dht's `{host, port, kind}` shape. */
export interface RedirectAddress {
  readonly host: string;
  readonly port: number;
  readonly kind?: string;
}

/** One holder named by a redirect: its peer id and where it might be reachable. */
export interface RedirectProvider {
  readonly peerId: string;
  readonly addresses: readonly RedirectAddress[];
}

/**
 * The decoded `error.data.redirect` payload of a `-32008`.
 *
 * The providers are a HINT, never an authority (NC-12: every dialled peer is untrusted). A holder
 * named here may not hold the content, may not answer, or may serve something else entirely.
 * Content is accepted because it verifies against the on-chain merkle root — never because a peer
 * named the peer that served it.
 */
export interface MissRedirect {
  /** The holders the node located. */
  readonly providers: readonly RedirectProvider[];
  /** The hop count already consumed, which the caller echoes as `params.redirect_depth`. */
  readonly redirectDepth: number;
  /** The budget the SERVING node advertises. Only ever lowers the client's own cap. */
  readonly maxRedirects: number;
}

/**
 * How a client must treat a miss answer. These are deliberately not one bucket: retryable and
 * settled are opposite instructions, and a client that cannot tell them apart either hammers a node
 * that asked it to stop or reports "not found" for content that is merely momentarily unreachable.
 */
export type MissKind =
  "redirect" | "rate-limited" | "inconclusive" | "not-found";

/** The minimal JSON-RPC error shape this module reads. */
export interface RpcErrorLike {
  readonly code?: unknown;
  readonly data?: unknown;
}

/**
 * Classify a JSON-RPC error object against the miss contract, or `null` when it is not a miss at all
 * (a parse error, an auth refusal, anything else — those are not this module's business).
 */
export function classifyMissError(
  error: RpcErrorLike | null | undefined,
): MissKind | null {
  const code = typeof error?.code === "number" ? error.code : null;
  switch (code) {
    case MISS_RPC_CODES.CONTENT_REDIRECT:
      return "redirect";
    case MISS_RPC_CODES.CONTENT_MISS_RATE_LIMITED:
      return "rate-limited";
    case MISS_RPC_CODES.CONTENT_MISS_INCONCLUSIVE:
      return "inconclusive";
    case MISS_RPC_CODES.RESOURCE_UNAVAILABLE:
      return "not-found";
    default:
      return null;
  }
}

/**
 * Decode the `data.redirect` payload of a `-32008`, or `null` when the error is not a redirect or
 * carries no readable payload.
 *
 * EVERY field is treated as hostile input: the frame arrives from a node the client has not
 * authenticated as truthful (the §5.3 ladder makes an unauthenticated loopback node the default
 * endpoint), so a missing, mistyped or absurd field degrades to a safe default rather than
 * propagating. An unreadable `redirect_depth` reads as zero hops consumed, which is safe precisely
 * because {@link RedirectBudget} counts its own hops and never relies on the served number to
 * advance.
 */
export function parseMissRedirect(
  error: RpcErrorLike | null | undefined,
): MissRedirect | null {
  if (classifyMissError(error) !== "redirect") return null;
  const redirect = asRecord(asRecord(error?.data)?.redirect);
  if (!redirect) return null;
  return {
    providers: parseProviders(redirect.providers),
    redirectDepth: asCount(redirect.redirect_depth, 0),
    maxRedirects: asCount(redirect.max_redirects, REDIRECT_HOP_CAP),
  };
}

/**
 * The client's redirect budget — the thing that makes "follow the redirect" terminate.
 *
 * # Why the client counts its own hops
 *
 * The wire counter (`redirect_depth`) is supplied by the node being followed. A ring of nodes that
 * each answer `-32008` with `redirect_depth: 0` is a perfectly well-formed conversation, and a
 * client that advances only when the SERVED number advances follows it forever. So this budget
 * increments on every redirect it is shown, and the served depth can only push it FURTHER along:
 *
 *     consumed = max(consumed + 1, servedDepth)
 *
 * Termination therefore does not depend on the peer's honesty at all — it is monotone in the number
 * of redirects observed, whatever they claim.
 *
 * The advertised `max_redirects` is applied the same way round: it may LOWER the ceiling (a node
 * asking for less budget is respected) but never raise it above {@link REDIRECT_HOP_CAP}.
 */
export class RedirectBudget {
  private consumed = 0;
  private ceiling: number;

  constructor(cap: number = REDIRECT_HOP_CAP) {
    this.ceiling = clampCap(cap);
  }

  /** Hops consumed so far. */
  get used(): number {
    return this.consumed;
  }

  /**
   * Record one observed redirect and return the `redirect_depth` to echo on the re-request, or
   * `null` when the budget is exhausted and the caller must stop.
   */
  advance(redirect: MissRedirect): number | null {
    this.ceiling = Math.min(this.ceiling, clampCap(redirect.maxRedirects));
    this.consumed = Math.max(this.consumed + 1, redirect.redirectDepth);
    return this.consumed >= this.ceiling ? null : this.consumed;
  }
}

/**
 * The delay to wait before re-asking a node that answered `-32003`, for a zero-based `attempt`.
 *
 * Exponential from {@link MISS_BACKOFF_BASE_MS}: the first wait is one refill period, and each
 * further refusal doubles it, because a node still refusing after a full refill period is telling
 * the client that its estimate of the budget is wrong.
 */
export function missBackoffMs(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return MISS_BACKOFF_BASE_MS * 2 ** Math.min(n, MAX_MISS_BACKOFF_ATTEMPTS);
}

function parseProviders(value: unknown): readonly RedirectProvider[] {
  if (!Array.isArray(value)) return [];
  const out: RedirectProvider[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const peerId = typeof record?.peer_id === "string" ? record.peer_id : "";
    if (!peerId) continue;
    out.push({ peerId, addresses: parseAddresses(record?.addresses) });
  }
  return out;
}

function parseAddresses(value: unknown): readonly RedirectAddress[] {
  if (!Array.isArray(value)) return [];
  const out: RedirectAddress[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const host = typeof record?.host === "string" ? record.host : "";
    const port = typeof record?.port === "number" ? record.port : NaN;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const kind = typeof record?.kind === "string" ? record.kind : undefined;
    out.push(kind === undefined ? { host, port } : { host, port, kind });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-negative integer, or `fallback` for anything else a hostile frame might carry. */
function asCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

/** Confine any advertised cap to the range `0..=REDIRECT_HOP_CAP`. */
function clampCap(value: number): number {
  if (!Number.isFinite(value) || value < 0) return REDIRECT_HOP_CAP;
  return Math.min(Math.floor(value), REDIRECT_HOP_CAP);
}
