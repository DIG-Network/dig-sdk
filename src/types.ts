// Public, hand-authored types for the SDK surface. Kept separate from implementation so consumers
// can import types without pulling the wasm/transport code.

/** A normalized `{ publicKey, signature }` pair from a wallet sign, both as `0x`-prefixed hex. */
export interface SignResult {
  /** The signing public key (synthetic BLS key), `0x`-prefixed hex. */
  publicKey: string | null;
  /** The BLS signature, `0x`-prefixed hex (or the raw wallet string). */
  signature: string | null;
}

/**
 * The minimal injected-provider contract the SDK detects on `window.chia` (the DIG Browser's
 * in-process wallet, or a compatible CHIP-0002 extension). Mirrors the DIG Browser provider:
 * `request({ method, params })` returns the wallet's `data`; `connect(eager)` blocks on per-origin
 * approval; `on`/`off` are EIP-1193-style event hooks.
 */
export interface InjectedChiaProvider {
  /** Unspoofable marker the DIG Browser provider sets; the SDK prefers a provider that has it. */
  isDIG?: boolean;
  /** Some providers expose a connected flag. */
  isConnected?: boolean;
  /** One CHIP-0002 RPC. Bare names auto-prefix to `chip0002_`; `chia_*` passes through. */
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  /** Ask the wallet to approve this origin. Blocks until approved/rejected. */
  connect?(eager?: boolean): Promise<unknown>;
  on?(event: string, fn: (data: unknown) => void): void;
  off?(event: string, fn: (data: unknown) => void): void;
}

declare global {
  // eslint-disable-next-line no-var
  var chia: InjectedChiaProvider | undefined;
  interface Window {
    chia?: InjectedChiaProvider;
  }
}

/** Which wallet transport is backing a `ChiaProvider`. */
export type WalletBackend = "injected" | "walletconnect";

/** A connected wallet session, returned by `ChiaProvider.connect()`. */
export interface WalletSession {
  /** The transport backing this session. */
  backend: WalletBackend;
  /** The CAIP-2 chain id (e.g. "chia:mainnet"). */
  chain: string;
  /**
   * The session topic. For WalletConnect this is the real relay topic; for the injected backend
   * it is a stable sentinel ("injected") — callers do not need to inspect it.
   */
  topic: string;
  /** The wallet's receive address, when known at connect time. */
  address?: string | null;
}

/** Options for `DigClient.read*` calls — chiefly which dig RPC endpoint to use. */
export interface ReadOptions {
  /** dig RPC endpoint. Defaults to the public `https://rpc.dig.net`. */
  rpc?: string;
}

/** The result of reading a resource by URN. */
export interface ReadResult {
  /** Store identity (64-hex). */
  storeId: string;
  /** The on-chain generation root the content was verified against (or null if none supplied). */
  root: string | null;
  /** The resource path within the store. */
  resourceKey: string;
  /** Private-store salt used (or null). */
  salt: string | null;
  /**
   * The resource bytes. When `decrypted` is true these are the authenticated plaintext; when
   * false they are the RAW served ciphertext (a decoy / wrong-key / wrong-salt response is just
   * opaque bytes — the model is oblivious, so this is never a "not found" verdict).
   */
  bytes: Uint8Array;
  /** Advisory: did the served bytes' inclusion proof verify against `root`? */
  verified: boolean;
  /** Did the bytes decrypt+authenticate under this URN's derived key? */
  decrypted: boolean;
}

/** The two root-independent keys a URN maps to (derived client-side, nothing sent to the network). */
export interface UrnKeys {
  storeId: string;
  root: string | null;
  resourceKey: string;
  salt: string | null;
  /** `SHA-256(canonical rootless URN)`, lowercase hex — what the dig RPC is addressed by. */
  retrievalKey: string;
  /** The per-URN AES-256-GCM-SIV decryption key, lowercase hex. */
  decryptionKey: string;
}
