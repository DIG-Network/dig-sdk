// Internal hex/byte codecs — the single source of truth for the SDK's hex and base64 conversions.
//
// These helpers were previously duplicated across `provider/methods.ts`, `paywall.ts`,
// `dig-client.ts`, and `loader.ts` (a DRY hazard flagged by the #1156 arch-audit). They are an
// INTERNAL module: NOT re-exported from `index.ts`, so they are free to evolve without a public
// API bump. Keep them dependency-free and DOM-agnostic so every entry point (browser bundle,
// Node build, wasm loader) can share them.

import { DigSdkError } from "./errors.js";

/**
 * Strip a leading `0x`/`0X` and lowercase a hex string.
 *
 * Tolerant of non-string input: `null`/`undefined` (and anything else) coerce through
 * `String(x ?? "")` first, so a missing value yields `""` rather than throwing. For a plain hex
 * string the result is identical to a strict `hex.replace(/^0x/i, "").toLowerCase()`.
 */
export function strip0x(hex: unknown): string {
  return String(hex ?? "")
    .replace(/^0x/i, "")
    .toLowerCase();
}

/** Ensure a hex string is `0x`-prefixed. Passes `null`/empty through as `null`. */
export function with0x(hex: string | null | undefined): string | null {
  if (!hex) return hex ?? null;
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

/** Hex (with or without `0x`) → bytes. Throws `INVALID_ARGUMENT` on odd-length / non-hex input. */
export function hexToBytes(hex: string): Uint8Array {
  const h = strip0x(hex);
  if (h.length % 2 !== 0 || /[^0-9a-f]/.test(h)) {
    throw new DigSdkError("INVALID_ARGUMENT", `invalid hex string: ${hex}`, {
      value: hex,
    });
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Bytes → lowercase hex (no `0x`). */
export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Decode a standard-base64 string (the RPC ciphertext encoding) to bytes — no DOM dependency.
 * Prefers the global `atob` (browsers, modern Node) and falls back to `Buffer` on older Node.
 */
export function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Uint8Array((globalThis as any).Buffer.from(b64, "base64"));
}
