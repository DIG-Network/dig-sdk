// Injected-provider transport — the DIG Browser's in-process wallet (and compatible CHIP-0002
// extensions), exposed on every page as `window.chia`. When present the SDK PREFERS it over
// WalletConnect: no QR, no relay, no pairing. The native provider returns the SAME response shapes
// Sage returns over WalletConnect, so the normalizers in provider/methods.ts are unchanged — only
// the TRANSPORT differs. Genericized from hub.dig.net/apps/web/lib/injected-wallet.js.
//
// Detection: we key on the explicit, unspoofable `isDIG` marker the DIG Browser provider sets, not
// merely the presence of `window.chia` (a different Chia provider could also define that).

import type { InjectedChiaProvider, WalletBackend } from "../types.js";
import { WALLET_METHODS, DEFAULT_CHAIN } from "../methods.js";
import type { WalletTransport } from "./transport.js";

/** The injected provider on the current global, or undefined when not running in a DIG Browser. */
export function getInjectedProvider(): InjectedChiaProvider | undefined {
  const g = globalThis as { chia?: InjectedChiaProvider };
  return typeof g !== "undefined" ? g.chia : undefined;
}

/**
 * True iff an injected DIG wallet is available. Detects on the unspoofable `isDIG` marker. Pass
 * `{ anyChia: true }` to accept any `window.chia` that implements `request` (e.g. a non-DIG
 * CHIP-0002 extension).
 */
export function isInjectedAvailable(opts: { anyChia?: boolean } = {}): boolean {
  const p = getInjectedProvider();
  if (!p) return false;
  if (opts.anyChia) return typeof p.request === "function";
  return !!p.isDIG;
}

/** Sentinel topic for the injected backend (it has no per-session relay topic). */
export const INJECTED_TOPIC = "injected";

/** A WalletTransport backed by the injected window.chia provider. */
export class InjectedTransport implements WalletTransport {
  readonly backend: WalletBackend = "injected";
  readonly topic = INJECTED_TOPIC;
  readonly chain: string;
  private readonly provider: InjectedChiaProvider;

  constructor(provider: InjectedChiaProvider, chain: string = DEFAULT_CHAIN) {
    this.provider = provider;
    this.chain = chain;
  }

  /** Connect: ask the native wallet to approve this origin. Blocks until approved/rejected. */
  async connect(eager = false): Promise<void> {
    if (typeof this.provider.connect === "function") {
      await this.provider.connect(eager);
    }
    // A provider without connect() (older build) is tolerated — request() will gate per-method.
  }

  // The native wallet implements the full canonical set (it returns Sage-shaped responses), so
  // support is a static allowlist — no per-session negotiation as with WalletConnect.
  supports(method: string): boolean {
    return (WALLET_METHODS as readonly string[]).includes(method);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.supports(method)) {
      throw new Error(`The DIG Browser wallet does not support "${method}".`);
    }
    return this.provider.request({ method, params });
  }

  async disconnect(): Promise<void> {
    // The injected wallet has no per-session teardown; per-origin consent is managed in the wallet.
  }
}
