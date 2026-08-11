// DIG URN parsing + canonicalization — PURE, dependency-free, and usable on any runtime (no wasm,
// so it is trivially unit-testable under `node --test`).
//
// CROSS-REPO STATUS (measured, not asserted — #2518). The parsed `resourceKey` and `salt` feed
// retrieval-key and decryption-key derivation, so two implementations that parse the same URN
// differently derive DIFFERENT keys and read different bytes. This file therefore states what is
// TRUE of the sibling parsers rather than claiming they agree:
//
//   • dig-chrome-extension (`src/lib/dig-urn.ts:153-159`) extracts `salt=` at a `[?&]` boundary in
//     ANY position. This module AGREES on that — the #2518 fix — and on the value semantics, and
//     still differs in two measured ways: the extension matches the parameter NAME case-insensitively
//     (`?SALT=ff00ff00` is a salt there, not here), and after removing the salt it strips any
//     remaining query UNCONDITIONALLY (`\?.*$`), so it truncates `data?desalt=9.json` to `data` and
//     `report?year=2024.csv` to `report`. Those are real, working keys with no salt and no secret, so
//     on that class the extension is the one that is wrong: it destroys a key for content already
//     published on chain. The fixture encodes THIS module's behaviour as the contract, the extension
//     case is expected to fail against it, and fixing it is that repo's leg (#2725). Converging by
//     copying a data-losing behaviour is not the byte-identity §4.1 protects.
//   • hub.dig.net (`apps/web/lib/dig-client.ts:490`) still captures `salt=` only in FINAL position, so
//     it derives a wrong key (with `salt: null`) for every non-final-position salt. It adopts this
//     behaviour after this release; until then the two diverge on exactly those URNs — none of
//     which can decrypt under either parser, so no working read is affected.
//
// The authority for that agreement is the machine-readable conformance table in
// `conformance/urn-parse.json`, which any implementation can be run against. Verify against the
// fixture; never against this comment.
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

// The URN structure, matched against a string whose QUERY has already been removed: store id,
// optional root, resource key. The key is greedy and may contain a `#` — a fragment is NOT a URN
// concept here, and a store key literally named `notes#1.md` is a real, working key. There is
// deliberately ONE parse regex in this module: a second one that also knew where a salt lives was
// the shape that let the parser and the redactor drift apart (#2518).
const URN_PATH_RE =
  /^urn:dig:chia:([0-9a-fA-F]{64})(?::([0-9a-fA-F]{64}))?\/(.+)$/;

// THE ONE BOUNDARY RULE. A `salt=` counts only at the start of the query or immediately after an
// `&` — never inside another parameter's value. Both decisions this module makes about a query tail
// are derived from this single source: whether the tail IS a query at all, and what salt it carries.
//
// They were once two predicates on one concept — an UNANCHORED `query.includes("salt=")` for the
// split, this anchored one for the value — and the broader one destroyed working keys. A key such as
// `…/data?desalt=9.json` contains the substring `salt=` at no parameter boundary: it carries no salt,
// no secret, and nothing to protect, yet it lost its entire query and derived a different retrieval
// key than 0.6.3 — an unmigratable regression, since the content is already on chain. Sharing the
// source makes "the split decision is exactly as strict as the salt decision" structural rather than
// a comment that the two can drift away from.
const SALT_PARAM_AT_BOUNDARY = "(?:^|&)salt=";

// Does this tail carry a salt PARAMETER, making it a query rather than part of the resource key?
const SALT_QUERY_MARKER_RE = new RegExp(SALT_PARAM_AT_BOUNDARY);

// The salt VALUE, once the marker has matched. The hex class terminates the value at the first
// non-hex character, so a trailing `&next=…` or `#fragment` ends it.
const SALT_QUERY_VALUE_RE = new RegExp(
  `${SALT_PARAM_AT_BOUNDARY}([0-9a-fA-F]+)`,
);

/**
 * Split a URN into its query-free base and the `salt` its query carried, if any.
 *
 * The salt is a QUERY PARAMETER, so it is read as one: at any position, and with the rest of the
 * query discarded because no other parameter addresses a resource. Reading it only in FINAL position
 * (as this module and the hub did) left the secret sitting inside `resourceKey`, which then leaked
 * onto every returned read result AND derived a key that could not decrypt anything (#2518).
 *
 * Only the query is removed. Everything before the first `?` — INCLUDING a `#` — is the resource
 * key, because a store key may literally contain `#`.
 */
function splitQuery(s: string): { base: string; salt: string | null } {
  const at = s.indexOf("?");
  if (at < 0) return { base: s, salt: null };
  const query = s.slice(at + 1);
  // THE NARROWING, and the reason this change is purely additive. A `?` is a legal character in a
  // resource key and always has been: `…/report?year=2024.csv` is a real, working public read whose
  // retrieval key includes the `?year=2024.csv`. Splitting unconditionally would derive a different
  // key and make already-published content unreadable — a regression in the one direction that
  // cannot be migrated, since the content is already on chain. So a query is only recognized as a
  // query when it carries a salt PARAMETER at a boundary (SALT_PARAM_AT_BOUNDARY above).
  //
  // Presence of the parameter, not a valid salt VALUE, is deliberately what governs the split: it
  // closes the leak for every value alphabet, including a malformed non-hex one, which would
  // otherwise stay inside `resourceKey` and ride onto every returned read result. Whether the value
  // is a usable salt is the separate question SALT_QUERY_VALUE_RE answers.
  if (!SALT_QUERY_MARKER_RE.test(query)) return { base: s, salt: null };
  const m = SALT_QUERY_VALUE_RE.exec(query);
  return { base: s.slice(0, at), salt: m ? m[1]!.toLowerCase() : null };
}

/**
 * Parse a DIG URN into its parts. Throws on a malformed URN.
 *
 * @example
 * parseUrn("urn:dig:chia:" + "ab".repeat(32) + "/index.html")
 * // → { storeId: "abab…", root: null, resourceKey: "index.html", salt: null }
 */
export function parseUrn(raw: string): ParsedUrn {
  const s = String(raw ?? "").trim();
  const { base, salt } = splitQuery(s);
  const m = URN_PATH_RE.exec(base);
  if (!m) {
    throw new DigSdkError(
      "INVALID_ARGUMENT",
      "Not a valid dig URN (expected urn:dig:chia:<store-id>[:<root>]/<path>[?salt=<hex>]).",
      {
        value: s,
        // The salt form is written LAST, with no trailing punctuation, because this string is
        // itself swept by the salt redaction on its way into the error context: the sweep replaces
        // everything after `salt=` up to a delimiter, so a bracketed `[?salt=<hex>]` would arrive at
        // the consumer as `[?salt=<redacted>` with its closing bracket eaten. Trailing it keeps the
        // help string intact WITHOUT narrowing the sweep (which must stay a superset of the URN
        // grammar's capture, #2518). The full bracketed grammar is in the message above.
        expected:
          "urn:dig:chia:<store-id>[:<root>]/<path>, optionally ?salt=<hex>",
      },
    );
  }
  return {
    storeId: m[1]!.toLowerCase(),
    root: m[2] ? m[2].toLowerCase() : null,
    resourceKey: m[3]!,
    salt,
  };
}

/** The placeholder a private-store salt is replaced with in any error/display string. */
export const REDACTED_SALT = "<redacted>";

// Matcher for ANY `salt=<value>` occurrence in a string. Matches the value up to the next
// query/fragment delimiter or whitespace, so a bare `salt=<secret>` (no leading `?`/`&`, e.g.
// inside a malformed-URN error `value`) is still redacted. Module-scoped so it compiles once
// (no `i` flag — the class is already case-covering where hex).
const SALT_PARAM_RE = /(salt=)[^&#\s]+/g;

// Replace EVERY `salt=<value>` occurrence with the placeholder. Idempotent (re-running it over an
// already-redacted string rewrites the placeholder to itself), so it is safe as a final pass.
function stripSaltParams(s: string): string {
  return s.replace(SALT_PARAM_RE, `$1${REDACTED_SALT}`);
}

/**
 * Return `raw` with any private-store `salt=<secret>` replaced by {@link REDACTED_SALT}, so a URN
 * (or any string) can be put into a logged/serialized error without republishing the out-of-band
 * secret that makes a store private.
 *
 * PURE and NON-THROWING by design: it does NOT parse. It never calls `parseUrn` — that would
 * construct a `DigSdkError`, whose own context redaction would re-enter this function and recurse
 * without bound (a fatal, uncatchable crash) — and it does not re-implement the grammar either.
 *
 * Being grammar-INDEPENDENT is the guarantee, not a shortcut (#2518). Redaction must be a strict
 * SUPERSET of whatever any parser captures: the strings that reach it are not all well-formed URNs
 * (an error's `value` may be arbitrary text carrying a `salt=`), and a redactor that recognized only
 * what the parser recognizes would leak again the moment the two drifted apart — which is exactly
 * how the salt leaked in the first place. Sweeping EVERY `salt=` occurrence, wherever it appears, is
 * what makes the guarantee independent of the grammar, so it must never be narrowed to match it.
 *
 * It must never throw and never construct a `DigSdkError`.
 */
export function redactUrnSalt(raw: string): string {
  const s = String(raw ?? "");
  // A string with no `salt=` substring cannot carry a private-store salt — return it untouched
  // (also skips the regex for the common case: rpcMethod, plain paths, non-URN values).
  if (!s.includes("salt=")) return s;
  return stripSaltParams(s);
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
