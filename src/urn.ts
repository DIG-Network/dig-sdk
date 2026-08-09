// DIG URN parsing + canonicalization — PURE, dependency-free, and identical to the parser the
// hub (apps/web/lib/dig-client.js), the extension, and the companion use. Kept pure (no wasm) so
// it is trivially unit-testable under `node --test` and usable on any runtime.
//
// A DIG URN addresses one resource inside a store:
//
//     urn:dig:chia:<store_id>[:<root>]/<resource_key>[?salt=<hex>]
//
//   • <store_id>   — 64 hex chars, the singleton launcher id (the store identity).
//   • :<root>      — OPTIONAL 64 hex chars, pins a specific on-chain generation. Omit for the
//                    canonical, root-INDEPENDENT form. The root is only the trust anchor for
//                    inclusion verification; it is NOT a key input (retrieval/decryption keys are
//                    root-independent).
//   • <resource_key> — the path within the store (e.g. "index.html", "img/logo.png"). An empty
//                    key resolves to the §8.5 default view "index.html".
//   • ?salt=<hex>  — OPTIONAL out-of-band secret salt for a PRIVATE store.

import { DigSdkError } from "./errors.js";

/** The parts of a parsed DIG URN. `root`/`salt` are null when absent. */
export interface ParsedUrn {
  /** Store identity (64-hex launcher id), lowercased. */
  readonly storeId: string;
  /** Generation root (64-hex), lowercased — or null for the root-independent form. */
  readonly root: string | null;
  /** Resource path within the store (verbatim, not lowercased). */
  readonly resourceKey: string;
  /** Private-store secret salt (hex), lowercased — or null for a public store. */
  readonly salt: string | null;
}

const URN_RE =
  /^urn:dig:chia:([0-9a-fA-F]{64})(?::([0-9a-fA-F]{64}))?\/(.+?)(?:\?salt=([0-9a-fA-F]+))?$/;

/**
 * Parse a DIG URN into its parts. Throws on a malformed URN.
 *
 * @example
 * parseUrn("urn:dig:chia:" + "ab".repeat(32) + "/index.html")
 * // → { storeId: "abab…", root: null, resourceKey: "index.html", salt: null }
 */
export function parseUrn(raw: string): ParsedUrn {
  const s = String(raw ?? "").trim();
  const m = URN_RE.exec(s);
  if (!m) {
    throw new DigSdkError(
      "INVALID_ARGUMENT",
      "Not a valid dig URN (expected urn:dig:chia:<store-id>[:<root>]/<path>[?salt=<hex>]).",
      {
        value: s,
        expected: "urn:dig:chia:<store-id>[:<root>]/<path>[?salt=<hex>]",
      },
    );
  }
  return {
    storeId: m[1]!.toLowerCase(),
    root: m[2] ? m[2].toLowerCase() : null,
    resourceKey: m[3]!,
    salt: m[4] ? m[4].toLowerCase() : null,
  };
}

/** The placeholder a private-store salt is replaced with in any error/display string. */
export const REDACTED_SALT = "<redacted>";

// Fallback matcher for a `salt=<value>` occurrence in a string that is NOT a well-formed URN.
// Matches the value up to the next query/fragment delimiter or whitespace, so a bare
// `salt=<secret>` (no leading `?`/`&`, e.g. inside a malformed-URN error `value`) is still redacted.
// Module-scoped so it compiles once (no `i` flag — the class is already case-covering where hex).
const SALT_PARAM_RE = /(salt=)[^&#\s]+/g;

/**
 * Return `raw` with any private-store `salt=<secret>` replaced by {@link REDACTED_SALT}, so a URN
 * (or any string) can be put into a logged/serialized error without republishing the out-of-band
 * secret that makes a store private.
 *
 * PURE and NON-THROWING by design: it matches with the SAME {@link URN_RE} regex `parseUrn` uses
 * (so it is not a divergent parser) but NEVER calls `parseUrn` — calling the throwing parser here
 * would construct a `DigSdkError`, whose own context redaction would re-enter this function and
 * recurse without bound (a fatal, uncatchable crash). For a well-formed URN it rebuilds the string
 * with the salt group redacted; otherwise it strips any `salt=<value>` occurrence from the raw
 * string. It must never throw and never construct a `DigSdkError`.
 */
export function redactUrnSalt(raw: string): string {
  const s = String(raw ?? "");
  // A string with no `salt=` substring cannot carry a private-store salt — return it untouched
  // (also skips the regexes for the common case: rpcMethod, plain paths, non-URN values).
  if (!s.includes("salt=")) return s;
  const m = URN_RE.exec(s);
  if (m) {
    // A well-formed URN. m[4] is the salt group; absent → nothing to redact.
    if (!m[4]) return s;
    const storeId = m[1]!.toLowerCase();
    const root = m[2] ? m[2].toLowerCase() : null;
    const resourceKey = m[3]!;
    const base = root
      ? `urn:dig:chia:${storeId}:${root}/${resourceKey}`
      : `urn:dig:chia:${storeId}/${resourceKey}`;
    return `${base}?salt=${REDACTED_SALT}`;
  }
  // Not a well-formed URN — strip any `salt=<value>` occurrence from the raw string.
  return s.replace(SALT_PARAM_RE, `$1${REDACTED_SALT}`);
}

/** True iff `raw` is a syntactically valid DIG URN. Never throws. */
export function isUrn(raw: string): boolean {
  try {
    parseUrn(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconstruct the canonical, root-INDEPENDENT URN string for a store + resource key:
 * `urn:dig:chia:<store_id>/<resource_key>`. An empty resource key resolves to the default view
 * `index.html`. This is the form whose SHA-256 is the retrieval key and whose bytes seed the AES
 * key — matching the wasm's `reconstructUrn`.
 */
export function reconstructUrn(storeId: string, resourceKey: string): string {
  const key =
    resourceKey && resourceKey.length > 0 ? resourceKey : "index.html";
  return `urn:dig:chia:${storeId.toLowerCase()}/${key}`;
}

/**
 * Reconstruct a root-PINNED display URN: `urn:dig:chia:<store_id>:<root>/<resource_key>`. Useful
 * for sharing a URN bound to a specific generation; the retrieval/AES keys still use the rootless
 * form (`reconstructUrn`).
 */
export function reconstructUrnWithRoot(
  storeId: string,
  root: string,
  resourceKey: string,
): string {
  const key =
    resourceKey && resourceKey.length > 0 ? resourceKey : "index.html";
  return `urn:dig:chia:${storeId.toLowerCase()}:${root.toLowerCase()}/${key}`;
}
