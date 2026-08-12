// The deliberately-WRONG URN parsers the conformance table exists to catch.
//
// A conformance table is only worth what it can REJECT. Each parser here is a real defect that was
// found in a real implementation, or the nearest wrong reading of one of the rules — reproduced as
// a runnable parser so `urn-table-discrimination.test.mjs` can assert the table actually fails it,
// rather than assuming a row is load-bearing because its name says so.
//
// Every sibling is a full parser producing the same comparable outcome string as `referenceParse`,
// so a sibling's disagreement with a table row is exactly a derived-key disagreement.

const PATH_RE = /^urn:dig:chia:([0-9a-fA-F]{64})(?::([0-9a-fA-F]{64}))?\/(.+)$/;

/** The correct marker/value pair, restated here so a sibling can vary ONE of them at a time. */
const MARKER_RE = /(?:^|&)salt=/;
const VALUE_RE = /(?:^|[&?])salt=([0-9a-fA-F]+)/;

/** The correct split: the first `?` whose tail carries a boundary `salt=` wins. */
function split(s, { markerRe = MARKER_RE, valueRe = VALUE_RE } = {}) {
  for (let at = s.indexOf("?"); at >= 0; at = s.indexOf("?", at + 1)) {
    const query = s.slice(at + 1);
    if (!markerRe.test(query)) continue;
    const m = valueRe.exec(query);
    return { base: s.slice(0, at), salt: m ? m[1].toLowerCase() : null };
  }
  return { base: s, salt: null };
}

/** Assemble the comparable outcome from an already-split URN. `"THROW"` means "rejected". */
function outcome({ base, salt }) {
  const m = PATH_RE.exec(base);
  // The root is lowercase-normalized exactly as the real parser normalizes it. Getting this wrong
  // makes EVERY sibling fail the root-pinned row, which reads as a healthy margin while proving
  // nothing about the defect each sibling actually carries.
  return m
    ? `${m[1].toLowerCase()}|${m[2]?.toLowerCase() ?? ""}|${m[3]}|${salt}`
    : "THROW";
}

/**
 * The wrong siblings, keyed by the defect each one carries. Each takes the raw URN string and
 * returns the same outcome shape the real parser is measured in.
 *
 * The invariant every entry must hold: exactly ONE thing is wrong with it. A sibling with two
 * defects would be caught by a table that only pins one of them, which is the false green this
 * whole file guards against.
 */
export const WRONG_SIBLINGS = {
  // dig-chrome-extension, measured: the parameter NAME was matched case-insensitively, so `?SALT=`
  // was read as a salt. It silently changes a derived DECRYPTION key, and nothing else about the
  // parser differs — which is why the table needs more than one row that can see it.
  "case-insensitive parameter name": (urn) =>
    outcome(
      split(urn, {
        markerRe: /(?:^|&)salt=/i,
        valueRe: /(?:^|[&?])salt=([0-9a-fA-F]+)/i,
      }),
    ),

  // dig-chrome-extension, measured: after extracting the salt it stripped any REMAINING query with
  // an unconditional `\?.*$`, truncating `report?year=2024.csv` — a real, already-published key.
  "unconditional \\?.*$ strip": (urn) => {
    const { salt } = split(urn);
    return outcome({ base: urn.replace(/\?.*$/, ""), salt });
  },

  // The pre-#2518 reading: the query is whatever follows the FIRST `?`, whether or not it carries a
  // salt. Truncates every key that legitimately contains a `?`.
  "split at the first '?'": (urn) => {
    const at = urn.indexOf("?");
    if (at < 0) return outcome({ base: urn, salt: null });
    const m = VALUE_RE.exec(urn.slice(at + 1));
    return outcome({ base: urn.slice(0, at), salt: m ? m[1].toLowerCase() : null });
  },

  // The plausible shortcut: hand the query tail to a general-purpose query parser. `URLSearchParams`
  // PERCENT-DECODES, so `?salt=%61%61` becomes the salt `aa` and derives a key for content that has
  // no salt at all.
  "URLSearchParams (percent-decodes)": (urn) => {
    for (let at = urn.indexOf("?"); at >= 0; at = urn.indexOf("?", at + 1)) {
      const query = urn.slice(at + 1);
      if (!MARKER_RE.test(query)) continue;
      const raw = new URLSearchParams(query).get("salt");
      const hex = /^([0-9a-fA-F]+)/.exec(raw ?? "");
      return outcome({ base: urn.slice(0, at), salt: hex ? hex[1].toLowerCase() : null });
    }
    return outcome({ base: urn, salt: null });
  },

  // The stricter-looking value rule: require the WHOLE parameter value to be hex rather than taking
  // its leading hex run. Reads no salt where the contract reads one.
  "whole-value-hex test": (urn) =>
    outcome(
      split(urn, {
        valueRe: /(?:^|[&?])salt=([0-9a-fA-F]+)(?=$|[&?#])/,
      }),
    ),

  // on.dig.net's `stripQueryHash`, measured: it split on `#` as well as `?`, truncating the working
  // key `notes#1.md` to `notes`. A `#` is an ordinary character in a store key; there are no
  // fragments in this grammar.
  "'#'-stripping (treats '#' as a fragment)": (urn) => {
    const { base, salt } = split(urn);
    return outcome({ base: base.replace(/#.*$/, ""), salt });
  },

  // on.dig.net's `stripQueryHash`, in its own shape: it cut at the first `?` OR `#`, whichever came
  // first, BEFORE any salt reasoning. That both truncates `notes#1.md` and can discard the salt
  // query along with it, so it is a distinct defect from stripping the `#` afterwards.
  "'#'-or-'?'-stripping, whichever comes first": (urn) => {
    const cut = urn.search(/[?#]/);
    if (cut < 0) return outcome({ base: urn, salt: null });
    const m = VALUE_RE.exec(urn.slice(cut + 1));
    return outcome({
      base: urn.slice(0, cut),
      salt: m ? m[1].toLowerCase() : null,
    });
  },
};

/** The correct outcome for a table case, read from the case's own `expect`. */
export function expectedOutcome(c) {
  if (c.expect.invalid === true) return "THROW";
  return `${c.expect.storeId}|${c.expect.root ?? ""}|${c.expect.resourceKey}|${c.expect.salt}`;
}

/** The names of the table rows a given sibling gets wrong. */
export function failingRows(table, sibling) {
  return table.cases
    .filter((c) => {
      let got;
      try {
        got = sibling(c.urn);
      } catch {
        got = "THROW";
      }
      return got !== expectedOutcome(c);
    })
    .map((c) => c.name);
}
