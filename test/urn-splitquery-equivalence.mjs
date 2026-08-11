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

/** The salt VALUE inside a tail already judged to BE a query. */
const valueRe = new RegExp(`(?:^|&)${SALT_PARAM}([0-9a-fA-F]+)`);

/** The reference split: the first `?` whose tail carries a salt parameter wins. */
export function referenceSplitQuery(s) {
  for (let at = s.indexOf("?"); at >= 0; at = s.indexOf("?", at + 1)) {
    const query = s.slice(at + 1);
    if (!markerRe.test(query)) continue;
    const m = valueRe.exec(query);
    return { base: s.slice(0, at), salt: m ? m[1].toLowerCase() : null };
  }
  return { base: s, salt: null };
}

const PATH_RE = /^urn:dig:chia:([0-9a-fA-F]{64})(?::([0-9a-fA-F]{64}))?\/(.+)$/;

/** What `parseUrn` must produce for `urn`, as a comparable string (`"THROW"` when it must reject). */
export function referenceParse(urn) {
  const { base, salt } = referenceSplitQuery(String(urn).trim());
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
export function* generatedTails(maxLen = 5) {
  const build = function* (prefix, depth) {
    if (prefix !== "") yield prefix;
    if (depth === 0) return;
    for (const t of TOKENS) yield* build(prefix + t, depth - 1);
  };
  yield* build("", maxLen);
}
