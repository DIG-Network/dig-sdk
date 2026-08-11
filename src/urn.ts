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

// THE PARAMETER NAME — the one thing both decisions about a query tail share. A `salt=` counts only
// at a parameter BOUNDARY, never inside another parameter's value: `…/data?desalt=9.json` contains
// the substring at no boundary, carries no salt and no secret, and an unanchored predicate stripped
// its whole query and derived a different retrieval key than 0.6.3 — unmigratable, since the content
// is already on chain.
//
// What the two decisions do NOT share is their SEPARATOR SET, and pretending otherwise is the defect
// shape this file has now hit twice. Each is spelled out below, at its own definition, with the
// reason it differs — rather than two bare literals free to drift apart.
const SALT_PARAM_NAME = "salt=";

// The literal the SPLIT decision scans for: a salt parameter introduced by an `&`. The other way a
// tail can qualify — `salt=` at the very start of the query — is tested with `startsWith` instead of
// a regex, because the split loop must not materialise a tail per candidate `?` (see `splitQuery`).
const SALT_AFTER_AMP = `&${SALT_PARAM_NAME}`;

// The salt VALUE, read from a tail that has ALREADY been judged to be a query. The hex class
// terminates the value at the first non-hex character, so a trailing `&next=…` or `#fragment` ends it.
//
// ITS SEPARATOR SET IS DELIBERATELY WIDER THAN THE SPLIT'S — that difference is why the two are
// written out separately instead of sharing one literal, and why each states its own set here.
// Restated: they answer different questions.
//
//   • the SPLIT asks "does this `?` START the query?", and only an `&salt=` may answer yes. Widening
//     it would make `report?year=2024.csv?salt=ff` qualify at its FIRST `?` and truncate a real,
//     already-published key back to `report`.
//   • this asks "where is the salt INSIDE the query?" — and once a `?` has been judged to start the
//     query, every later `?` is inside it and is a separator, not part of a parameter name.
//
// The wider set is what SPEC §7.1 already specifies (a boundary is "the start of a query segment …
// or immediately after an `&`", first boundary occurrence carrying a HEX value wins). Honouring only
// `&` made the code and the SPEC derive different keys, and the code's answer was the silently
// unusable one: `a?salt=zz?salt=ff00ff00` yielded no salt at all, so nothing could decrypt.
const SALT_QUERY_VALUE_RE = new RegExp(
  `(?:^|[&?])${SALT_PARAM_NAME}([0-9a-fA-F]+)`,
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
  // EVERY `?` is a candidate, not just the first. A `?` is a legal character in a resource key and
  // always has been, so the salt query is not necessarily the first one: `…/report?year=2024.csv`
  // is a real working key, and `…/report?year=2024.csv?salt=<hex>` is the natural way to salt it —
  // exactly the shape SPEC's `<resource_key>[?salt=<hex>]` grammar describes. Splitting at the first
  // `?` unconditionally left that secret inside `resourceKey`, which is copied onto every returned
  // read result: the #2518 leak itself, and a retrieval key that differs from 0.6.3's for content
  // already published on chain.
  //
  // The FIRST qualifying `?` wins, not the last, because it strips the most: on `a?salt=aa?salt=bb`
  // the whole tail goes, so no later `salt=` can survive inside the key. Splitting at the last would
  // leave `a?salt=aa` — a leak — which is the direction that must never be chosen.
  //
  // LINEAR, deliberately. The obvious form of this loop takes `s.slice(at + 1)` — an O(n) copy —
  // and runs a full regex scan over that tail, once per `?`. That is quadratic, and `isUrn` is
  // exactly the cheap validator a dapp runs on untrusted input: measured, a 125 KiB URN of question
  // marks went from 0.3 ms to 866 ms, and a 195 KiB one blocked the event loop for 2.1 seconds.
  //
  // So the tail is never materialised. The two ways a tail can qualify are tested directly against
  // `s`: `salt=` sitting at the very start of the query, or an `&salt=` somewhere after this `?`.
  //
  // `ampIdx` MOVES FORWARD rather than being computed once. A single precomputed index is wrong:
  // a brute-force over the generated space found `k&salt=?&salt=`, where the only `&salt=` before
  // the second `?` sits BEHIND it and must not qualify it. Re-searching only when the index falls
  // behind keeps the scans disjoint, so the whole loop stays linear.
  let ampIdx = s.indexOf(SALT_AFTER_AMP);
  for (let at = s.indexOf("?"); at >= 0; at = s.indexOf("?", at + 1)) {
    if (ampIdx >= 0 && ampIdx < at) ampIdx = s.indexOf(SALT_AFTER_AMP, at);
    // THE NARROWING, and the reason this change stays additive. A tail is only a query when it
    // carries a salt PARAMETER at a boundary (SALT_PARAM_AT_BOUNDARY above). Splitting on anything
    // broader derives a different key for a key that carries no salt and no secret at all, and makes
    // already-published content unreadable — a regression that cannot be migrated.
    //
    // Presence of the parameter, not a valid salt VALUE, is deliberately what governs the split: it
    // closes the leak for every value alphabet, including a malformed non-hex one, which would
    // otherwise stay inside `resourceKey`. Whether the value is a USABLE salt is the separate
    // question SALT_QUERY_VALUE_RE answers.
    const isQuery = s.startsWith(SALT_PARAM_NAME, at + 1) || ampIdx > at;
    if (!isQuery) continue;
    // The tail is materialised exactly ONCE, for the `?` that won — the cost the loop above refuses
    // to pay per candidate is paid a single time on the way out.
    const m = SALT_QUERY_VALUE_RE.exec(s.slice(at + 1));
    return { base: s.slice(0, at), salt: m ? m[1]!.toLowerCase() : null };
  }
  return { base: s, salt: null };
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
