// WalletConnect v2 → Sage transport. Genericized from hub.dig.net/apps/web/lib/walletconnect.js,
// keeping the production-proven patterns and removing the hub-app specifics:
//   • optionalNamespaces ONLY (Sage rejects requiredNamespaces),
//   • the canonical CHIP-0002 method set (src/methods.ts),
//   • a per-request response timeout (a backgrounded mobile Sage can hang forever),
//   • bounded retries for transient relay-PUBLISH failures only (never double-prompts),
//   • session restore gated on a sign method being granted.
//
// `@walletconnect/sign-client` is an OPTIONAL peer dependency — it's imported dynamically so the
// rest of the SDK (DigClient, injected transport) loads without it. Apps that use the WC fallback
// install it; apps that only target the DIG Browser don't pay for it.

import { WALLET_METHODS, SIGN_METHODS, DEFAULT_CHAIN } from "../methods.js";
import type { WalletBackend } from "../types.js";
import type { WalletTransport } from "./transport.js";
import { isTransientPublishError } from "./wc-retry.js";

/** App metadata shown to the wallet during pairing. */
export interface WalletConnectMetadata {
  name: string;
  description: string;
  url: string;
  icons: string[];
}

/** Options to start a WalletConnect connection. */
export interface WalletConnectOptions {
  /** WalletConnect Cloud project id (required by the relay). */
  projectId: string;
  /** App metadata shown in the wallet. */
  metadata: WalletConnectMetadata;
  /** CAIP-2 chain id. Defaults to "chia:mainnet". */
  chain?: string;
  /** Per-request response timeout (ms). Default 60_000. */
  requestTimeoutMs?: number;
  /**
   * Called with the pairing URI so the app can render a QR / copy-link. The returned/awaited
   * approval resolves to the session once the user approves in the wallet.
   */
  onUri?: (uri: string) => void;
}

// Minimal structural types for the parts of SignClient we use (avoids a hard type dependency).
interface WcSession {
  topic: string;
  namespaces?: { chia?: { methods?: string[] } };
}
interface WcSignClient {
  connect(args: {
    optionalNamespaces: Record<string, { methods: string[]; chains: string[]; events: string[] }>;
  }): Promise<{ uri?: string; approval: () => Promise<WcSession> }>;
  request(args: {
    topic: string;
    chainId: string;
    request: { method: string; params: unknown };
  }): Promise<unknown>;
  disconnect(args: { topic: string; reason: { code: number; message: string } }): Promise<void>;
  session: {
    get(topic: string): WcSession | undefined;
    getAll(): WcSession[];
  };
}

/** A WalletTransport backed by WalletConnect → Sage. */
export class WalletConnectTransport implements WalletTransport {
  readonly backend: WalletBackend = "walletconnect";
  readonly chain: string;
  readonly topic: string;
  private readonly client: WcSignClient;
  private readonly requestTimeoutMs: number;

  private constructor(
    client: WcSignClient,
    session: WcSession,
    chain: string,
    requestTimeoutMs: number,
  ) {
    this.client = client;
    this.topic = session.topic;
    this.chain = chain;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Initialize SignClient, open a pairing (emitting the URI via `onUri`), and resolve to a
   * connected transport once the user approves in Sage. Requires `@walletconnect/sign-client`.
   */
  static async connect(options: WalletConnectOptions): Promise<WalletConnectTransport> {
    const chain = options.chain ?? DEFAULT_CHAIN;
    const timeout = options.requestTimeoutMs ?? 60_000;
    const SignClient = await loadSignClient();
    const client = (await SignClient.init({
      logger: "error",
      projectId: options.projectId,
      metadata: options.metadata,
    })) as unknown as WcSignClient;
    const { uri, approval } = await client.connect({
      // optionalNamespaces ONLY — Sage rejects requiredNamespaces.
      optionalNamespaces: {
        chia: { methods: WALLET_METHODS as unknown as string[], chains: [chain], events: [] },
      },
    });
    if (uri && options.onUri) options.onUri(uri);
    const session = await approval();
    return new WalletConnectTransport(client, session, chain, timeout);
  }

  /**
   * Restore an existing session that grants a sign method (so message signing actually reaches
   * Sage). Returns a transport or null if none qualifies. Requires `@walletconnect/sign-client`.
   */
  static async restore(options: {
    projectId: string;
    metadata: WalletConnectMetadata;
    chain?: string;
    requestTimeoutMs?: number;
  }): Promise<WalletConnectTransport | null> {
    const chain = options.chain ?? DEFAULT_CHAIN;
    const timeout = options.requestTimeoutMs ?? 60_000;
    const SignClient = await loadSignClient();
    const client = (await SignClient.init({
      logger: "error",
      projectId: options.projectId,
      metadata: options.metadata,
    })) as unknown as WcSignClient;
    const sessions = client.session.getAll();
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i]!;
      const methods = s.namespaces?.chia?.methods ?? [];
      if ((SIGN_METHODS as readonly string[]).some((m) => methods.includes(m))) {
        return new WalletConnectTransport(client, s, chain, timeout);
      }
    }
    return null;
  }

  private sessionMethods(): string[] {
    try {
      return this.client.session.get(this.topic)?.namespaces?.chia?.methods ?? [];
    } catch {
      return [];
    }
  }

  // True iff the active session granted `method` (empty list = unknown ⇒ treated as granted).
  supports(method: string): boolean {
    const m = this.sessionMethods();
    return m.length === 0 || m.includes(method);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.supports(method)) {
      throw new Error(
        `Your wallet session does not grant "${method}". Disconnect and reconnect your wallet ` +
          "to refresh the session (and make sure Sage is up to date).",
      );
    }
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        return await this.attempt(method, params);
      } catch (e) {
        lastErr = e;
        // Only retry transient relay-publish failures (request never reached Sage). Timeouts and
        // wallet/user rejections fall through and throw immediately.
        if (i < MAX_ATTEMPTS - 1 && isTransientPublishError(e)) {
          await sleep(1200 * (i + 1));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  private attempt(method: string, params: unknown): Promise<unknown> {
    let t: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, rej) => {
      t = setTimeout(
        () => rej(new Error("Sage did not respond — open the Sage app and try again.")),
        this.requestTimeoutMs,
      );
    });
    return Promise.race([
      this.client.request({ topic: this.topic, chainId: this.chain, request: { method, params } }),
      timeout,
    ]).finally(() => clearTimeout(t));
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.disconnect({
        topic: this.topic,
        reason: { code: 6000, message: "bye" },
      });
    } catch {
      /* best-effort */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Dynamically import the optional peer dep, with a clear error if it isn't installed.
async function loadSignClient(): Promise<{ init(opts: unknown): Promise<unknown> }> {
  try {
    // Optional peer dependency — may not be installed (e.g. an injected-only dapp). The dynamic
    // import is wrapped so a missing module surfaces as the actionable error below, and the
    // specifier is suppressed for type resolution since the package is not a hard dependency.
    // @ts-ignore -- optional peer dependency, not resolvable when uninstalled
    const mod = (await import("@walletconnect/sign-client")) as {
      default?: { init(opts: unknown): Promise<unknown> };
      init?(opts: unknown): Promise<unknown>;
    };
    const SignClient = mod.default ?? (mod as { init(opts: unknown): Promise<unknown> });
    if (!SignClient || typeof SignClient.init !== "function") {
      throw new Error("unexpected @walletconnect/sign-client shape");
    }
    return SignClient;
  } catch {
    throw new Error(
      "WalletConnect fallback requires the optional peer dependency '@walletconnect/sign-client'. " +
        "Install it (npm i @walletconnect/sign-client) to use the WalletConnect→Sage transport.",
    );
  }
}
