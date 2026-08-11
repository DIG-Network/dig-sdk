// A standalone re-implementation of `splitQuery`'s CONTRACT, plus the generated input space both
// the equivalence test and the SPEC-alignment test are swept over.
//
// It exists so a performance rewrite can be proven behaviour-preserving against something other
// than itself: the optimised implementation in `src/urn.ts` and this straightforward one must agree
// on every generated input. Keep this version OBVIOUS — its value is that it is transparently the
// rule as written, not that it is fast.

/** The salt parameter NAME. The two separator sets below differ; the name never does. */
const SALT_PARAM = "salt=";

/**
 * Does this tail carry a salt parameter, making it a query rather than part of the resource key?
 * Only `&` separates here — see `src/urn.ts` for why widening this would truncate working keys.
 */
const markerRe = new RegExp(`(?:^|&)${SALT_PARAM}`);

/**
 * The salt VALUE inside a tail already judged to BE a query. Its separator set is WIDER than the
 * marker's: once a `?` has been judged to start the query, every later `?` is inside it.
 */
const valueRe = new RegExp(`(?:^|[&?])${SALT_PARAM}([0-9a-fA-F]+)`);

/** The value scanner as it read BEFORE the SPEC alignment — `&` only. Kept to measure the change. */
const narrowValueRe = new RegExp(`(?:^|&)${SALT_PARAM}([0-9a-fA-F]+)`);

/** The reference split: the first `?` whose tail carries a salt parameter wins. */
export function referenceSplitQuery(s, valuePattern = valueRe) {
  for (let at = s.indexOf("?"); at >= 0; at = s.indexOf("?", at + 1)) {
    const query = s.slice(at + 1);
    if (!markerRe.test(query)) continue;
    const m = valuePattern.exec(query);
    return { base: s.slice(0, at), salt: m ? m[1].toLowerCase() : null };
  }
  return { base: s, salt: null };
}

const PATH_RE = /^urn:dig:chia:([0-9a-fA-F]{64})(?::([0-9a-fA-F]{64}))?\/(.+)$/;

/** What `parseUrn` must produce for `urn`, as a comparable string (`"THROW"` when it must reject). */
export function referenceParse(urn, valuePattern = valueRe) {
  const { base, salt } = referenceSplitQuery(String(urn).trim(), valuePattern);
  const m = PATH_RE.exec(base);
  return m ? `${m[1].toLowerCase()}|${m[2] ?? ""}|${m[3]}|${salt}` : "THROW";
}

/** The same shape read off the real parser, so the two are compared field for field. */
export function actualParse(parseUrn, urn) {
  try {
    const p = parseUrn(urn);
    return `${p.storeId}|${p.root ?? ""}|${p.resourceKey}|${p.salt}`;
  } catch {
    return "THROW";
  }
}

// The token alphabet: every character class that can change where the query starts or where the
// salt is read — the separators (`?`, `&`, `#`), the parameter name, hex / non-hex / empty values,
// and ordinary key text.
const TOKENS = [
  "?",
  "&",
  "#",
  "salt=",
  // TWO DISTINCT hex values, deliberately. With only one, no generated input can ever hold two
  // DIFFERENT usable salts, so the sweep is structurally unable to tell a first-wins scanner from a
  // last-wins one — the property the widening actually changes. That blind spot alone hid
  // `k??salt=aa11&salt=ff00` (0 hits across 579,189 two-hex-token inputs at depth 5).
  "salt=aa11",
  "salt=ff00",
  "salt=zz",
  "ff00",
  "zz",
  "k",
  ".csv",
  "=",
  "",
];

/** Every token sequence of length 1..`maxLen`, as a resource-key tail. */
/** The pre-alignment reading of the same URN, for measuring exactly what the widening changed. */
export function narrowParse(urn) {
  return referenceParse(urn, narrowValueRe);
}

// `maxLen` is 6, not 5, for one measured reason: the shortest tail that can carry two hex salts
// across a `?` boundary — `k` `?` `?` `salt=aa11` `&` `salt=ff00` — is SIX tokens long. At 5 the
// space is 3,257,430 inputs and contains zero of them.
// The salt as PUBLISHED 0.6.3 read it: a salt only in FINAL position, matched off the whole URN.
// It is the baseline that decides whether a behaviour change can break a read that works TODAY —
// an input 0.6.3 reads as `null` could never decrypt for a real user, so moving its salt breaks
// nothing. Copied verbatim from `git show f78fcb0:src/urn.ts`.
const PUBLISHED_063_RE =
  /^urn:dig:chia:([0-9a-fA-F]{64})(?::([0-9a-fA-F]{64}))?\/(.+?)(?:\?salt=([0-9a-fA-F]+))?$/;

/** The salt published 0.6.3 reads for `urn`, or null. */
export function publishedSalt(urn) {
  const m = PUBLISHED_063_RE.exec(String(urn).trim());
  return m?.[4] ? m[4].toLowerCase() : null;
}

export function* generatedTails(maxLen = 6) {
  const build = function* (prefix, depth) {
    if (prefix !== "") yield prefix;
    if (depth === 0) return;
    for (const t of TOKENS) yield* build(prefix + t, depth - 1);
  };
  yield* build("", maxLen);
}
