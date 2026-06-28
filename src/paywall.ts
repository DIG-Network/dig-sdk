// Paywall — the high-level monetization helper (#46). It composes a connected `ChiaProvider` (the
// user's wallet) with the CANONICAL chip35 monetization spends so a dapp can charge for access in a
// few lines: `await paywall.requestPayment({ amount, owner })` pays the dapp owner and returns a
// receipt; `paywall.verifyReceipt(...)` and `paywall.proveAccess({ nft | collection })` gate access.
//
// HARD RULE (SYSTEM.md → Change-impact guide): spend bundles are NEVER hand-rolled. Every coin spend
// is built by `@dignetwork/chip35-dl-coin-wasm` (the single source of truth for CHIP-0035 spends).
// The Paywall only ORCHESTRATES: it sources the buyer's coins from the wallet, asks the wasm to build
// the coin spends, and pushes those exact coin spends back to the wallet for signing
// (`ChiaProvider.signCoinSpends`). It contains zero spend-assembly logic of its own — if the wasm
// builder is unavailable, it throws rather than fabricate a spend.
//
// The chip35 wasm is wasm-bindgen "bundler"-target glue (a top-level `import * as wasm from
// "./..._bg.wasm"`), which bundlers/browsers load but plain Node's ESM loader cannot. So the spends
// are obtained via an injectable `spends` provider that defaults to a lazy
// `import("@dignetwork/chip35-dl-coin-wasm")` — apps in a bundler get it for free; tests (and exotic
// runtimes) inject the builder. Either way the builder is the canonical wasm, never a reimplementation.

import type { ChiaProvider } from "./provider/chia-provider.js";

/** A payment asset: XCH, or a CAT identified by its tail hash (e.g. DIG). */
export type PaymentAssetSpec =
  | { xch: true; assetId?: undefined }
  | { xch?: false; assetId: string };

/**
 * The subset of `@dignetwork/chip35-dl-coin-wasm` the Paywall drives. The full wasm module satisfies
 * this shape, so `import("@dignetwork/chip35-dl-coin-wasm")` (or the SDK's "./spend" re-export) can
 * be passed directly. Declared as a structural type so the SDK does not statically import the
 * (bundler-only) wasm and tests can inject a spy.
 */
export interface MonetizationSpends {
  /** wasm-bindgen init. Called once before building spends (a no-op if the runtime needs none). */
  init?: () => unknown;
  /** SHA-256-derive a 32-byte unlock nonce from request bytes. */
  paymentNonce?: (requestBytes: Uint8Array) => Uint8Array;
  /** Build the coin spends for an XCH payment. Returns `{ coinSpends, receipt }`. */
  buildPayment?: (
    buyerSyntheticKey: Uint8Array,
    selectedCoins: unknown,
    ownerPuzzleHash: Uint8Array,
    amount: bigint,
    nonce: Uint8Array,
    fee: bigint,
  ) => { coinSpends: unknown; receipt: unknown };
  /** Build the coin spends for a CAT (incl. DIG) payment. Returns `{ coinSpends, receipt }`. */
  buildCatPayment?: (
    buyerSyntheticKey: Uint8Array,
    selectedCats: unknown,
    ownerPuzzleHash: Uint8Array,
    amount: bigint,
    nonce: Uint8Array,
  ) => { coinSpends: unknown; receipt: unknown };
  /** Verify an observed payment unlocks the paywall. Returns `{ ok, error? }`. */
  verifyPaymentReceipt?: (
    observed: unknown,
    ownerPuzzleHash: Uint8Array,
    minAmount: bigint,
    requiredAsset: unknown,
    requireNonce?: Uint8Array | null,
  ) => { ok: boolean; error?: string };
  /** Prove NFT ownership (optionally gating on a launcher id). Returns `{ ok, proof?, error? }`. */
  proveNftOwnership?: (
    parentSpend: unknown,
    claimedOwnerPuzzleHash: Uint8Array,
    requiredNft?: Uint8Array | null,
  ) => { ok: boolean; proof?: unknown; error?: string };
  /** Prove collection/creator membership for an owner. Returns `{ ok, proof?, error? }`. */
  proveCollectionMembership?: (
    parentSpend: unknown,
    claimedOwnerPuzzleHash: Uint8Array,
    requiredDid: Uint8Array,
  ) => { ok: boolean; proof?: unknown; error?: string };
}

/** Options for constructing a `Paywall`. */
export interface PaywallOptions {
  /**
   * The canonical chip35 monetization spends. Defaults to a lazy
   * `import("@dignetwork/chip35-dl-coin-wasm")` (and calls its `init()`), so a bundled dapp needs to
   * pass nothing. Inject a builder for non-bundler runtimes or tests.
   */
  spends?: MonetizationSpends;
}

/** Arguments for `Paywall.requestPayment`. */
export interface RequestPaymentArgs {
  /** Amount to pay, in mojos (XCH) or base units (CAT). Number or bigint. */
  amount: number | bigint;
  /** The dapp owner's puzzle hash to pay (hex, with or without `0x`). */
  owner: string;
  /** Pay in this CAT (tail hash hex). Omit for XCH. */
  assetId?: string;
  /**
   * A free-form unlock identifier (e.g. `dappId|resource|user`). When given without an explicit
   * `nonce`, the Paywall derives the 32-byte nonce from it via the wasm `paymentNonce` (deterministic
   * convenience). Ignored when `nonce` is supplied.
   */
  memo?: string;
  /** An explicit 32-byte unlock nonce (hex). Overrides `memo`. Random 32 bytes are used if neither. */
  nonce?: string;
  /** Network fee in mojos (XCH payments only; CAT rings net to zero). Defaults to 0. */
  fee?: number | bigint;
  /** Cap on the number of buyer coins to source from the wallet. */
  coinLimit?: number;
}

/** The result of a successful `requestPayment`: the wallet signature + the wasm receipt + spends. */
export interface PaymentResult {
  /** The aggregated BLS signature the wallet returned for the coin spends. */
  signature: string;
  /** The `PaymentReceipt` the wasm produced — persist it; `verifyReceipt` later checks the chain. */
  receipt: unknown;
  /** The exact coin spends the wasm built and the wallet signed. */
  coinSpends: unknown;
  /** The 32-byte unlock nonce embedded in the payment (hex). */
  nonce: string;
}

/** Arguments for `Paywall.verifyReceipt`. */
export interface VerifyReceiptArgs {
  /** The `ObservedPayment` the dapp filled in after reading the owner's coin from the chain. */
  observed: unknown;
  /** The owner puzzle hash that must have been paid (hex). */
  owner: string;
  /** The minimum amount that must have been paid (mojos / base units). */
  minAmount: number | bigint;
  /** The required asset. Defaults to XCH; pass `{ assetId }` to require a CAT. */
  asset?: PaymentAssetSpec;
  /** Require this exact 32-byte nonce (hex) to be present in the payment. */
  nonce?: string;
}

/** Arguments for `Paywall.proveAccess` — gate on NFT ownership XOR collection membership. */
export interface ProveAccessArgs {
  /** The coin spend that created the NFT's current coin (the wasm `CoinSpend` shape). */
  parentSpend: unknown;
  /** The puzzle hash claiming ownership (hex). */
  owner: string;
  /** Gate on this specific NFT launcher id (hex). Mutually exclusive with `collection`. */
  nft?: string;
  /** Gate on membership of this collection/creator DID (hex). Mutually exclusive with `nft`. */
  collection?: string;
}

/** Strip a leading `0x`/`0X` and lowercase a hex string. */
function strip0x(hex: string): string {
  return hex.replace(/^0x/i, "").toLowerCase();
}

/** Hex (with or without `0x`) → bytes. Throws on odd-length / non-hex input. */
function hexToBytes(hex: string): Uint8Array {
  const h = strip0x(hex);
  if (h.length % 2 !== 0 || /[^0-9a-f]/.test(h)) {
    throw new Error(`invalid hex string: ${hex}`);
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Bytes → lowercase hex (no `0x`). */
function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** 32 random bytes (WebCrypto, available in browsers and Node 18+). */
function randomNonce(): Uint8Array {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

/**
 * High-level pay-to-unlock helper. Construct it from a connected `ChiaProvider`; it builds payment
 * spends via the canonical chip35 wasm and pushes them to the wallet for signing.
 *
 * @example
 * const provider = await ChiaProvider.connect({ mode: "auto", walletConnect });
 * const paywall = new Paywall(provider); // chip35 wasm loaded lazily under a bundler
 * // Charge 0.25 XCH to unlock a resource:
 * const { receipt } = await paywall.requestPayment({
 *   amount: 250_000_000_000n,
 *   owner: dappOwnerPuzzleHashHex,
 *   memo: `unlock:${resourceId}:${userId}`,
 * });
 * // Later, gate access by re-checking the receipt against the chain:
 * const { ok } = await paywall.verifyReceipt({ observed, owner: dappOwnerPuzzleHashHex, minAmount: 250_000_000_000n });
 */
export class Paywall {
  private readonly provider: ChiaProvider;
  private readonly injectedSpends?: MonetizationSpends;
  private spendsReady?: Promise<MonetizationSpends>;

  constructor(provider: ChiaProvider, options: PaywallOptions = {}) {
    this.provider = provider;
    this.injectedSpends = options.spends;
  }

  /**
   * Resolve the canonical monetization spends (injected, or lazily imported + `init()`ed). Memoized.
   * This is the ONLY source of coin-spend construction in the Paywall — there is no fallback that
   * hand-rolls a spend.
   */
  private spends(): Promise<MonetizationSpends> {
    if (this.injectedSpends) {
      if (typeof this.injectedSpends.init === "function") this.injectedSpends.init();
      return Promise.resolve(this.injectedSpends);
    }
    if (!this.spendsReady) {
      this.spendsReady = (async () => {
        const mod = (await import(
          /* @vite-ignore */ "@dignetwork/chip35-dl-coin-wasm"
        )) as unknown as MonetizationSpends;
        if (typeof mod.init === "function") mod.init();
        return mod;
      })().catch((e) => {
        this.spendsReady = undefined; // allow retry on transient load failure
        throw e;
      });
    }
    return this.spendsReady;
  }

  /** The wallet's first synthetic public key, as bytes (the buyer key the spends are built against). */
  private async buyerKey(): Promise<Uint8Array> {
    const keys = await this.provider.getPublicKeys();
    const key = keys?.[0];
    if (!key) throw new Error("Wallet returned no public keys to build the payment against.");
    return hexToBytes(key);
  }

  /** Resolve the 32-byte unlock nonce: explicit hex, else derived from `memo`, else random. */
  private async resolveNonce(spends: MonetizationSpends, args: RequestPaymentArgs): Promise<Uint8Array> {
    if (args.nonce) return hexToBytes(args.nonce);
    if (args.memo) {
      if (typeof spends.paymentNonce !== "function") {
        throw new Error(
          "Cannot derive a nonce from `memo`: the chip35 wasm `paymentNonce` is unavailable.",
        );
      }
      return spends.paymentNonce(new TextEncoder().encode(args.memo));
    }
    return randomNonce();
  }

  /**
   * Charge the buyer (the connected wallet) `amount` to pay the dapp `owner`, then push the
   * wasm-built coin spends to the wallet for signing. Returns the wallet signature + the receipt.
   * Builds via the canonical wasm `buildPayment` (XCH) or `buildCatPayment` (CAT) — never hand-rolled.
   */
  async requestPayment(args: RequestPaymentArgs): Promise<PaymentResult> {
    const spends = await this.spends();
    const ownerPh = hexToBytes(args.owner);
    const amount = BigInt(args.amount);
    const nonce = await this.resolveNonce(spends, args);
    const buyerKey = await this.buyerKey();

    let built: { coinSpends: unknown; receipt: unknown };
    if (args.assetId) {
      if (typeof spends.buildCatPayment !== "function") {
        throw new Error(
          "chip35 wasm `buildCatPayment` is unavailable — cannot build a CAT payment " +
            "(the Paywall never hand-rolls spends).",
        );
      }
      const cats = await this.provider.getCatCoins(strip0x(args.assetId), args.coinLimit);
      built = spends.buildCatPayment(buyerKey, cats, ownerPh, amount, nonce);
    } else {
      if (typeof spends.buildPayment !== "function") {
        throw new Error(
          "chip35 wasm `buildPayment` is unavailable — cannot build an XCH payment " +
            "(the Paywall never hand-rolls spends).",
        );
      }
      const coins = await this.provider.getXchCoins(args.coinLimit);
      built = spends.buildPayment(buyerKey, coins, ownerPh, amount, nonce, BigInt(args.fee ?? 0));
    }

    // Push the EXACT coin spends the wasm produced to the wallet for signing — unchanged.
    const signature = await this.provider.signCoinSpends(built.coinSpends);
    return {
      signature,
      receipt: built.receipt,
      coinSpends: built.coinSpends,
      nonce: bytesToHex(nonce),
    };
  }

  /**
   * Verify an observed on-chain payment unlocks the paywall (pay-to-unlock). Delegates to the wasm
   * `verifyPaymentReceipt`; returns its `{ ok, error? }` verdict. `ok:true` grants access.
   */
  async verifyReceipt(args: VerifyReceiptArgs): Promise<{ ok: boolean; error?: string }> {
    const spends = await this.spends();
    if (typeof spends.verifyPaymentReceipt !== "function") {
      throw new Error("chip35 wasm `verifyPaymentReceipt` is unavailable.");
    }
    const asset = args.asset ?? { xch: true };
    const requiredAsset =
      "assetId" in asset && asset.assetId
        ? { assetId: hexToBytes(asset.assetId) }
        : { xch: true };
    const requireNonce = args.nonce ? hexToBytes(args.nonce) : null;
    return spends.verifyPaymentReceipt(
      args.observed,
      hexToBytes(args.owner),
      BigInt(args.minAmount),
      requiredAsset,
      requireNonce,
    );
  }

  /**
   * Prove the `owner` holds access: gate on a specific NFT (`nft` launcher id) via the wasm
   * `proveNftOwnership`, or on collection/creator membership (`collection` DID) via
   * `proveCollectionMembership`. Returns `{ ok, proof?, error? }`. The caller still confirms the
   * proof's coin is unspent on-chain for liveness.
   */
  async proveAccess(args: ProveAccessArgs): Promise<{ ok: boolean; proof?: unknown; error?: string }> {
    if (args.nft && args.collection) {
      throw new Error("proveAccess: pass either `nft` or `collection`, not both.");
    }
    const spends = await this.spends();
    const owner = hexToBytes(args.owner);
    if (args.collection) {
      if (typeof spends.proveCollectionMembership !== "function") {
        throw new Error("chip35 wasm `proveCollectionMembership` is unavailable.");
      }
      return spends.proveCollectionMembership(args.parentSpend, owner, hexToBytes(args.collection));
    }
    if (typeof spends.proveNftOwnership !== "function") {
      throw new Error("chip35 wasm `proveNftOwnership` is unavailable.");
    }
    const requiredNft = args.nft ? hexToBytes(args.nft) : null;
    return spends.proveNftOwnership(args.parentSpend, owner, requiredNft);
  }
}
