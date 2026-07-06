// ChiaProvider — the wallet abstraction at the front of the SDK. It owns ONE WalletTransport
// (injected window.chia, or WalletConnect→Sage) and exposes the normalized CHIP-0002 surface on
// top of it, so a dapp writes the same `provider.signMessage(...)` regardless of how the user's
// wallet is connected.
//
// Selection policy (the "wallet your dapp gets for free"): PREFER the injected DIG Browser wallet
// when present (no QR, no relay, instant), and FALL BACK to WalletConnect→Sage otherwise. This is
// exactly the dual-transport policy hub.dig.net runs (apps/web/lib/wallet-transport.js +
// walletconnect.js), packaged so any dapp gets it in a few lines.

import type { SignResult, WalletBackend, WalletSession } from "../types.js";
import { DEFAULT_CHAIN } from "../methods.js";
import type { WalletTransport } from "./transport.js";
import {
  InjectedTransport,
  getInjectedProvider,
  isInjectedAvailable,
} from "./injected.js";
import {
  WalletConnectTransport,
  type WalletConnectOptions,
} from "./walletconnect.js";
import * as M from "./methods.js";
import { DigSdkError } from "../errors.js";

/**
 * A connector id for the 'Browser Wallet vs WalletConnect' chooser (#63) — the discoverable,
 * user-facing counterpart of the lower-level {@link WalletBackend}. `"browser-wallet"` is an alias
 * for the `"injected"` backend, named to match the chooser UI label every DIG frontend uses.
 */
export type ConnectorId = "browser-wallet" | "walletconnect";

/**
 * One entry in {@link ChiaProvider.listConnectors}: a connector a chooser UI can offer, and
 * whether it's currently usable.
 */
export interface ConnectorInfo {
  /** The id to pass as `ConnectOptions.mode` once the user picks this connector. */
  id: ConnectorId;
  /** The underlying transport backend this connector selects. */
  backend: WalletBackend;
  /** Human-facing label ("Browser Wallet" / "WalletConnect") — the canonical chooser copy. */
  label: string;
  /**
   * True iff this connector can be connected right now. Browser Wallet requires a detected
   * injected `window.chia`; WalletConnect is always offered (its relay has no presence to detect).
   */
  available: boolean;
}

/** Options for `ChiaProvider.connect()`. */
export interface ConnectOptions {
  /**
   * Connection mode:
   *   • "auto" (default)     — prefer the injected DIG wallet; fall back to WalletConnect if
   *                            absent. A convenience for callers that don't want to present a
   *                            chooser; it never asks the user, so if BOTH a Browser Wallet and
   *                            WalletConnect are viable it silently picks Browser Wallet — kept
   *                            for backward compatibility with existing single-shot integrations.
   *   • "browser-wallet"      — require the injected Browser Wallet (throws if absent). The
   *                            explicit-preference value for a Connect chooser (see
   *                            {@link ChiaProvider.listConnectors}); an alias of "injected".
   *   • "injected"           — same as "browser-wallet" (kept for backward compatibility).
   *   • "walletconnect"      — force the WalletConnect→Sage pairing.
   *
   * To offer the user a real choice — never auto-binding to whichever wallet happens to be
   * injected — call {@link ChiaProvider.listConnectors} to enumerate what's available, let the
   * user pick, then pass their pick's `id` (`"browser-wallet"` or `"walletconnect"`) as `mode`.
   */
  mode?: "auto" | WalletBackend | ConnectorId;
  /**
   * WalletConnect options, required for the WalletConnect fallback/force path (projectId +
   * metadata + onUri). Omit if you only target the injected DIG Browser wallet.
   */
  walletConnect?: WalletConnectOptions;
  /** CAIP-2 chain id. Defaults to "chia:mainnet". */
  chain?: string;
  /** Accept any `window.chia` (not just the DIG Browser's `isDIG` provider) for the injected path. */
  acceptAnyInjected?: boolean;
}

/**
 * A connected Chia wallet. Construct it via `ChiaProvider.connect(...)` (or the convenience
 * `connectWallet(...)`), then call the normalized methods.
 *
 * @example
 * const provider = await ChiaProvider.connect({
 *   mode: "auto",
 *   walletConnect: { projectId, metadata, onUri: (uri) => showQr(uri) },
 * });
 * const { signature } = await provider.signMessage("Login to my dapp", await provider.getAddress());
 */
export class ChiaProvider {
  private readonly transport: WalletTransport;
  private cachedAddress: string | null | undefined;

  private constructor(transport: WalletTransport) {
    this.transport = transport;
  }

  /** Which transport is backing this provider. */
  get backend(): WalletBackend {
    return this.transport.backend;
  }

  /** The connected session descriptor. */
  get session(): WalletSession {
    return {
      backend: this.transport.backend,
      chain: this.transport.chain,
      topic: this.transport.topic,
      address: this.cachedAddress ?? null,
    };
  }

  /** True iff a method is granted by the active session/transport. */
  supports(method: string): boolean {
    return this.transport.supports(method);
  }

  /** Escape hatch: issue a raw CHIP-0002 request through the active transport. */
  request(method: string, params: unknown = {}): Promise<unknown> {
    return this.transport.request(method, params);
  }

  /**
   * Connect a wallet using the selection policy. With `mode: "auto"` (default) it prefers an
   * injected DIG wallet and falls back to WalletConnect.
   */
  static async connect(options: ConnectOptions = {}): Promise<ChiaProvider> {
    // "browser-wallet" (the chooser-facing connector id, #63) is an alias of "injected" (the
    // transport/backend id) — normalize once so the rest of this method has one code path.
    const rawMode = options.mode ?? "auto";
    const mode = rawMode === "browser-wallet" ? "injected" : rawMode;
    const chain = options.chain ?? DEFAULT_CHAIN;

    const tryInjected = async (): Promise<ChiaProvider | null> => {
      if (!isInjectedAvailable({ anyChia: options.acceptAnyInjected })) return null;
      const provider = getInjectedProvider()!;
      const transport = new InjectedTransport(provider, chain);
      await transport.connect();
      return new ChiaProvider(transport);
    };

    const tryWalletConnect = async (): Promise<ChiaProvider> => {
      if (!options.walletConnect) {
        throw new DigSdkError(
          "WC_OPTIONS_REQUIRED",
          "WalletConnect options are required to connect via WalletConnect " +
            "(pass { walletConnect: { projectId, metadata, onUri } }).",
          { mode: rawMode },
        );
      }
      const transport = await WalletConnectTransport.connect({
        ...options.walletConnect,
        chain,
      });
      return new ChiaProvider(transport);
    };

    if (mode === "injected") {
      const injected = await tryInjected();
      if (!injected) {
        throw new DigSdkError(
          "NO_INJECTED_WALLET",
          "No injected DIG wallet found. Open this page in the DIG Browser, or use mode 'auto'.",
          { mode: rawMode, acceptAnyInjected: !!options.acceptAnyInjected },
        );
      }
      return injected;
    }
    if (mode === "walletconnect") return tryWalletConnect();
    // auto
    return (await tryInjected()) ?? (await tryWalletConnect());
  }

  /**
   * Enumerate the connectors a 'Browser Wallet vs WalletConnect' Connect chooser can offer (#63).
   * Pure and side-effect-free — it only DETECTS what's usable right now, it never connects to
   * anything — so a chooser UI built around it always surfaces the choice instead of silently
   * auto-binding to whichever wallet happens to be injected.
   *
   * @example
   * const connectors = ChiaProvider.listConnectors();
   * // render a button per connector, disabling any with `available: false`
   * const chosen = connectors.find((c) => c.id === userPick)!;
   * const provider = await ChiaProvider.connect({ mode: chosen.id, walletConnect });
   */
  static listConnectors(options: { acceptAnyInjected?: boolean } = {}): ConnectorInfo[] {
    return [
      {
        id: "browser-wallet",
        backend: "injected",
        label: "Browser Wallet",
        available: isInjectedAvailable({ anyChia: options.acceptAnyInjected }),
      },
      {
        id: "walletconnect",
        backend: "walletconnect",
        label: "WalletConnect",
        available: true,
      },
    ];
  }

  /** Wrap an already-constructed transport (advanced / restored sessions). */
  static fromTransport(transport: WalletTransport): ChiaProvider {
    return new ChiaProvider(transport);
  }

  // ---- normalized CHIP-0002 surface -------------------------------------------------------------

  /** The wallet's receive address (cached after first read). */
  async getAddress(): Promise<string | null> {
    if (this.cachedAddress === undefined) {
      this.cachedAddress = await M.getAddress((m, p) => this.transport.request(m, p));
    }
    return this.cachedAddress;
  }

  /** The wallet's (synthetic) public keys. */
  getPublicKeys(): Promise<string[]> {
    return M.getPublicKeys((m, p) => this.transport.request(m, p));
  }

  /**
   * Sign a UTF-8 message with the wallet BLS key. `address` defaults to the wallet's own address.
   * Returns `{ publicKey, signature }`.
   */
  async signMessage(message: string, address?: string): Promise<SignResult> {
    const addr = address ?? (await this.getAddress()) ?? "";
    return M.signMessage(
      (m, p) => this.transport.request(m, p),
      (m) => this.transport.supports(m),
      message,
      addr,
    );
  }

  /** Sign raw CHIP-0035 coin spends (partialSign). Returns the aggregated signature hex. */
  signCoinSpends(coinSpends: unknown): Promise<string> {
    return M.signCoinSpends((m, p) => this.transport.request(m, p), coinSpends);
  }

  /** Accept a Chia offer string (e.g. an NFT offer). */
  takeOffer(offer: string, fee = 0): Promise<unknown> {
    return M.takeOffer(
      (m, p) => this.transport.request(m, p),
      (m) => this.transport.supports(m),
      offer,
      fee,
    );
  }

  /** Spendable XCH balance (mojos, string) or null. */
  getXchBalance(): Promise<string | null> {
    return M.getXchBalance((m, p) => this.transport.request(m, p));
  }

  /** Spendable balance (base units, string) for a CAT `assetIdHex` (the tail hash), or null. */
  getCatBalance(assetIdHex: string): Promise<string | null> {
    return M.getCatBalance((m, p) => this.transport.request(m, p), assetIdHex);
  }

  /** Unspent XCH coins for funding a spend. */
  getXchCoins(limit?: number): Promise<unknown[]> {
    return M.getXchCoins((m, p) => this.transport.request(m, p), limit);
  }

  /** Unspent CAT coins for `assetIdHex`. */
  getCatCoins(assetIdHex: string, limit?: number): Promise<unknown[]> {
    return M.getCatCoins((m, p) => this.transport.request(m, p), assetIdHex, limit);
  }

  /** Disconnect the wallet (best-effort). */
  disconnect(): Promise<void> {
    return this.transport.disconnect();
  }
}

/** Convenience wrapper: `connectWallet(opts)` === `ChiaProvider.connect(opts)`. */
export function connectWallet(options?: ConnectOptions): Promise<ChiaProvider> {
  return ChiaProvider.connect(options);
}
