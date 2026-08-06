// Client → node endpoint resolution — CLAUDE.md §5.3's fixed ladder.
//
// WHY. A DIG client MUST prefer the user's OWN running node and use the public gateway only as a last
// resort — never hard-coding `rpc.dig.net` as the primary endpoint (privacy, speed, decentralization:
// the gateway is the safety net, not the default). This module is the pure, host-independent resolver:
// an ordered candidate list probed by an INJECTED probe function, first responder wins. It performs NO
// network itself (the probe is supplied), so precedence and probe-timeout fall-through are unit-testable
// with a deterministic fake and no sockets.
//
// §5.3 mTLS: node-class clients are meant to dial local nodes over mTLS. This resolver settles endpoint
// SELECTION only; the transport stays the SDK's existing HTTPS `fetch`, gated on the gateway's mTLS
// endpoint existing (out of scope here).

/** How the endpoint was chosen — a machine-branchable provenance tag. */
export type NodeResolutionVia =
  "explicit" | "env" | "dig.local" | "localhost" | "gateway";

/** One rung of the §5.3 ladder. */
export interface NodeCandidate {
  /** The provenance tag emitted when this rung wins. */
  readonly via: NodeResolutionVia;
  /** The base endpoint URL used (probed at `${url}/health`). */
  readonly url: string;
  /**
   * True when this rung is a LOCAL node reachable only from a Node (server) process. A browser page
   * cannot probe a plaintext-loopback (`http://localhost` from an https page is mixed content) nor a
   * self-signed `https://127.0.0.2` (cert/CSP) the way Node can — so these rungs are skipped in the
   * browser, which falls straight through to the gateway.
   */
  readonly localOnly: boolean;
}

/** dig.local — the installed local node, served PORTLESS over HTTPS on `127.0.0.2:443` (dig-node SPEC §4.1). */
export const DIG_LOCAL_URL = "https://127.0.0.2:443";

/** The loopback node's HTTP listener — PLAINTEXT on `:9778`, never TLS (dig-node SPEC §4.1a). */
export const LOOPBACK_URL = "http://localhost:9778";

/** The public gateway — the §5.3 terminal fallback, an ordinary well-known node (never privileged). */
export const GATEWAY_URL = "https://rpc.dig.net";

/** Default per-rung probe timeout (ms). Short: a rung that does not answer promptly falls through. */
export const DEFAULT_PROBE_TIMEOUT_MS = 300;

/**
 * The §5.3 ladder in fixed probe order: the user's local node first (`dig.local`, then the loopback),
 * the public gateway last. The gateway is the terminal fallback and is not itself probed.
 */
export const NODE_LADDER: readonly NodeCandidate[] = Object.freeze([
  { via: "dig.local", url: DIG_LOCAL_URL, localOnly: true },
  { via: "localhost", url: LOOPBACK_URL, localOnly: true },
  { via: "gateway", url: GATEWAY_URL, localOnly: false },
]);

/** Probe a candidate endpoint: resolve `true` iff a node answers there within `timeoutMs`. */
export type NodeProbe = (url: string, timeoutMs: number) => Promise<boolean>;

/** The resolved endpoint plus how it was chosen. */
export interface ResolvedNode {
  /** The endpoint the client will address. */
  readonly url: string;
  /** Which ladder rung supplied it. */
  readonly via: NodeResolutionVia;
}

/** Inputs to {@link resolveNodeEndpoint}. */
export interface ResolveNodeInput {
  /** An explicit endpoint (constructor `rpc`) — overrides the whole ladder, skips probing. */
  readonly explicit?: string | null;
  /** The `DIG_NODE_URL` env override — overrides the ladder, skips probing. */
  readonly env?: string | null;
  /** True in a browser page: the local rungs are skipped (only explicit › env › gateway). */
  readonly isBrowser: boolean;
  /** Probe for each local rung. Injected so resolution is deterministic + network-free in tests. */
  readonly probe: NodeProbe;
  /** Per-rung probe timeout (ms). */
  readonly timeoutMs: number;
}

/**
 * Resolve a DIG node endpoint through the §5.3 ladder (see the module header for the WHY).
 *
 * Precedence: an explicit endpoint wins outright, then `DIG_NODE_URL`, then the probed ladder
 * (`dig.local` → `localhost` → gateway). The FIRST local rung whose probe answers wins; a rung that
 * times out or errors falls through to the next. The gateway is the guaranteed terminal fallback,
 * returned when no earlier rung answers (and never itself probed — the real RPC call surfaces any
 * gateway transport failure with a coded error). In the browser the local rungs are skipped entirely.
 */
export async function resolveNodeEndpoint(
  input: ResolveNodeInput,
): Promise<ResolvedNode> {
  const explicit = nonEmpty(input.explicit);
  if (explicit) return { url: explicit, via: "explicit" };

  const env = nonEmpty(input.env);
  if (env) return { url: env, via: "env" };

  // The local rungs (probed, in order); the gateway is the terminal fallback, never itself probed.
  // The browser skips the local rungs entirely (mixed-content / cert constraints).
  const localRungs = input.isBrowser
    ? []
    : NODE_LADDER.filter((rung) => rung.localOnly);
  for (const rung of localRungs) {
    if (await probeSafely(input.probe, rung.url, input.timeoutMs)) {
      return { url: rung.url, via: rung.via };
    }
  }
  return { url: GATEWAY_URL, via: "gateway" };
}

/**
 * A default {@link NodeProbe}: a cheap `GET ${url}/health` on a short timeout, `true` iff the node
 * answers `2xx`. Any transport/abort/error is a non-answer (the caller treats it as fall-through).
 */
export function makeHealthProbe(fetchImpl: typeof fetch): NodeProbe {
  return async (url, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(healthUrl(url), {
        method: "GET",
        signal: controller.signal,
      });
      return res.ok === true;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** True in a browser page (a `window` with a `document`) — used to skip the local rungs. */
export function isBrowserEnv(): boolean {
  return (
    typeof window !== "undefined" && typeof window.document !== "undefined"
  );
}

/** Read `DIG_NODE_URL` where a Node `process.env` exists; `undefined` in a browser (no throw). */
export function readEnvNodeUrl(): string | undefined {
  try {
    if (typeof process !== "undefined" && process.env) {
      return nonEmpty(process.env.DIG_NODE_URL);
    }
  } catch {
    // No `process` binding (a strict browser bundle) — treat as "no env override".
  }
  return undefined;
}

function healthUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/health`;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : undefined;
}

// A probe must never abort the ladder: any rejection (timeout/abort/refused) is a non-answer.
async function probeSafely(
  probe: NodeProbe,
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    return await probe(url, timeoutMs);
  } catch {
    return false;
  }
}
