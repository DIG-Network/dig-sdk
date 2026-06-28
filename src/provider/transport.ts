// The transport contract a ChiaProvider talks through. Both backends (injected window.chia and
// WalletConnect→Sage) implement it, so the single ChiaProvider surface (getAddress, signMessage,
// signCoinSpends, …) never forks per backend — exactly the indirection hub.dig.net uses
// (apps/web/lib/wallet-transport.js) to avoid duplicating its sage.js calls across transports.

import type { WalletBackend } from "../types.js";

/** A wallet transport: connect, then `request` CHIP-0002 methods through it. */
export interface WalletTransport {
  /** Which backend this transport is. */
  readonly backend: WalletBackend;
  /** The CAIP-2 chain id this transport is bound to. */
  readonly chain: string;
  /** The session topic (a real WC topic, or the injected sentinel "injected"). */
  readonly topic: string;
  /** True iff the active session grants `method` (empty/unknown ⇒ treated as granted). */
  supports(method: string): boolean;
  /** Issue one CHIP-0002 RPC, resolving to the wallet's data (Sage-shaped) or rejecting. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Tear down the session (best-effort). */
  disconnect(): Promise<void>;
}
