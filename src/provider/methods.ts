// CHIP-0002 response-shape normalizers — the tolerant adapters that turn wallet-specific casing
// (with/without 0x, snake_case/camelCase, string-vs-object) into one canonical shape. Extracted
// from hub.dig.net/apps/web/lib/sage.js and made transport-agnostic: each takes a `request`
// function and a `supports` predicate, so the SAME normalizers serve both the injected and
// WalletConnect transports.

import type { SignResult } from "../types.js";

/** A function that issues one CHIP-0002 RPC through some transport. */
export type RequestFn = (method: string, params: unknown) => Promise<unknown>;
/** A predicate: does the active session grant `method`? */
export type SupportsFn = (method: string) => boolean;

/** Ensure a hex string is `0x`-prefixed (or pass through null/empty). */
export function with0x(hex: string | null | undefined): string | null {
  if (!hex) return hex ?? null;
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function strip0x(h: unknown): string {
  return String(h ?? "").replace(/^0x/i, "").toLowerCase();
}

/** The wallet's receive address (tolerant of string / {address} / {data:{address}}). */
export async function getAddress(request: RequestFn): Promise<string | null> {
  const resp = await request("chia_getAddress", {});
  if (typeof resp === "string") return resp;
  const r = resp as { address?: string; data?: { address?: string } } | null;
  return r?.address ?? r?.data?.address ?? null;
}

/** The wallet's (synthetic) public keys. */
export async function getPublicKeys(request: RequestFn): Promise<string[]> {
  const resp = await request("chip0002_getPublicKeys", { limit: 500, offset: 0 });
  if (Array.isArray(resp)) return resp as string[];
  const r = resp as { publicKeys?: string[]; public_keys?: string[]; keys?: string[] } | null;
  return r?.publicKeys ?? r?.public_keys ?? r?.keys ?? [];
}

/** Normalize a wallet sign response into `{ publicKey, signature }` (0x-normalized). */
function normalizeSig(resp: unknown): SignResult {
  const r = resp as
    | { publicKey?: string; public_key?: string; pubkey?: string;
        signature?: string; aggregatedSignature?: string; aggregated_signature?: string }
    | string
    | null;
  const publicKey =
    typeof r === "object" && r ? (r.publicKey ?? r.public_key ?? r.pubkey ?? null) : null;
  const signature =
    typeof r === "string"
      ? r
      : r
        ? (r.signature ?? r.aggregatedSignature ?? r.aggregated_signature ?? null)
        : null;
  return { publicKey: with0x(publicKey), signature };
}

/**
 * Sign a UTF-8 message with the wallet BLS key. Prefers `chia_signMessageByAddress` (sign by
 * address — the login-challenge path); falls back to `chip0002_signMessage` (sign by public key)
 * when the active session didn't grant the by-address method, so a real signature request still
 * reaches the wallet. Returns `{ publicKey, signature }`.
 */
export async function signMessage(
  request: RequestFn,
  supports: SupportsFn,
  message: string,
  address: string,
): Promise<SignResult> {
  if (supports("chia_signMessageByAddress")) {
    return normalizeSig(await request("chia_signMessageByAddress", { message, address }));
  }
  const keys = await getPublicKeys(request);
  const publicKey = keys[0];
  if (!publicKey) throw new Error("Wallet returned no keys to sign with.");
  const sig = normalizeSig(await request("chip0002_signMessage", { message, publicKey }));
  return { publicKey: sig.publicKey ?? with0x(publicKey), signature: sig.signature };
}

/** Sign raw CHIP-0035 coin spends (partialSign) — the mint/commit/update path. Returns hex sig. */
export async function signCoinSpends(
  request: RequestFn,
  coinSpends: unknown,
): Promise<string> {
  const resp = await request("chip0002_signCoinSpends", { coinSpends, partialSign: true });
  if (typeof resp === "string") return resp;
  const r = resp as
    | { signature?: string; aggregatedSignature?: string; aggregated_signature?: string }
    | null;
  return r?.signature ?? r?.aggregatedSignature ?? r?.aggregated_signature ?? "";
}

/** Accept a Chia offer string (e.g. a MintGarden NFT offer). Returns whatever the wallet returns. */
export async function takeOffer(
  request: RequestFn,
  supports: SupportsFn,
  offer: string,
  fee = 0,
): Promise<unknown> {
  if (!supports("chia_takeOffer")) {
    throw new Error("Your wallet session does not support taking offers. Reconnect your wallet.");
  }
  return request("chia_takeOffer", { offer, fee });
}

/** A mojo balance string, tolerant of the common casing shapes; null if unsupported. */
function balanceFrom(resp: unknown): string | null {
  const raw =
    resp == null
      ? null
      : typeof resp === "object"
        ? ((resp as Record<string, unknown>).confirmed ??
            (resp as Record<string, unknown>).spendable ??
            (resp as Record<string, unknown>).confirmedWalletBalance ??
            (resp as Record<string, unknown>).confirmed_wallet_balance ??
            (resp as Record<string, unknown>).balance ??
            (resp as { data?: { confirmed?: unknown } }).data?.confirmed ??
            null)
        : resp;
  if (raw == null) return null;
  try {
    return BigInt(raw as string | number | bigint).toString();
  } catch {
    return null;
  }
}

/** The wallet's spendable XCH balance (mojos, string). Null if the wallet doesn't surface it. */
export async function getXchBalance(request: RequestFn): Promise<string | null> {
  return balanceFrom(await request("chip0002_getAssetBalance", { type: null, assetId: null }));
}

/** The wallet's spendable balance (base units, string) for a CAT `assetIdHex`. */
export async function getCatBalance(
  request: RequestFn,
  assetIdHex: string,
): Promise<string | null> {
  return balanceFrom(
    await request("chip0002_getAssetBalance", { type: "cat", assetId: strip0x(assetIdHex) }),
  );
}

/** Unspent XCH coins for funding a spend. */
export async function getXchCoins(request: RequestFn, limit = 100): Promise<unknown[]> {
  const resp = await request("chip0002_getAssetCoins", {
    type: null,
    assetId: null,
    includedLocked: false,
    offset: 0,
    limit,
  });
  return Array.isArray(resp) ? resp : ((resp as { coins?: unknown[] })?.coins ?? []);
}

/** Unspent CAT coins for `assetIdHex` (the tail hash, plain hex). */
export async function getCatCoins(
  request: RequestFn,
  assetIdHex: string,
  limit = 200,
): Promise<unknown[]> {
  const resp = await request("chip0002_getAssetCoins", {
    type: "cat",
    assetId: strip0x(assetIdHex),
    includedLocked: false,
    offset: 0,
    limit,
  });
  return Array.isArray(resp) ? resp : ((resp as { coins?: unknown[] })?.coins ?? []);
}
