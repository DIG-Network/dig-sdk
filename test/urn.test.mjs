// URN parsing / canonicalization — the pure, dependency-free contract. Mirrors the parser the
// hub, extension, and companion use; these pin the shapes the rest of the ecosystem relies on.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseUrn,
  isUrn,
  reconstructUrn,
  reconstructUrnWithRoot,
  DigSdkError,
} from "../dist/index.js";

const STORE = "ab".repeat(32); // 64 hex
const ROOT = "cd".repeat(32);

test("parseUrn: rootless canonical form", () => {
  const p = parseUrn(`urn:dig:chia:${STORE}/index.html`);
  assert.equal(p.storeId, STORE);
  assert.equal(p.root, null);
  assert.equal(p.resourceKey, "index.html");
  assert.equal(p.salt, null);
});

test("parseUrn: root-pinned form", () => {
  const p = parseUrn(`urn:dig:chia:${STORE}:${ROOT}/img/logo.png`);
  assert.equal(p.storeId, STORE);
  assert.equal(p.root, ROOT);
  assert.equal(p.resourceKey, "img/logo.png");
});

test("parseUrn: private-store salt", () => {
  const p = parseUrn(`urn:dig:chia:${STORE}/secret.txt?salt=deadbeef`);
  assert.equal(p.resourceKey, "secret.txt");
  assert.equal(p.salt, "deadbeef");
});

test("parseUrn: uppercase store/root are lowercased", () => {
  const p = parseUrn(
    `urn:dig:chia:${STORE.toUpperCase()}:${ROOT.toUpperCase()}/x`,
  );
  assert.equal(p.storeId, STORE);
  assert.equal(p.root, ROOT);
});

test("parseUrn: rejects a non-URN", () => {
  assert.throws(() => parseUrn("https://example.com/index.html"));
  assert.throws(() => parseUrn(`urn:dig:chia:tooshort/index.html`));
});

test("isUrn: true/false without throwing", () => {
  assert.equal(isUrn(`urn:dig:chia:${STORE}/a`), true);
  assert.equal(isUrn("nope"), false);
});

test("reconstructUrn: rootless; empty key -> index.html", () => {
  assert.equal(
    reconstructUrn(STORE, "a/b.txt"),
    `urn:dig:chia:${STORE}/a/b.txt`,
  );
  assert.equal(reconstructUrn(STORE, ""), `urn:dig:chia:${STORE}/index.html`);
});

test("reconstructUrnWithRoot: root-pinned display URN", () => {
  assert.equal(
    reconstructUrnWithRoot(STORE, ROOT, "x.txt"),
    `urn:dig:chia:${STORE}:${ROOT}/x.txt`,
  );
});

// ---------------------------------------------------------------------------------------------
// #2518 — a salt that is NOT the final URN component must still be redacted.
//
// URN_RE's optional `?salt=` group only captures a salt in FINAL position. A URN with a trailing
// `&x=1`, a `#fragment`, or a rooted form with a trailing param still MATCHES the regex (the
// resource-key group absorbs the query tail) with the salt group ABSENT — so the pre-fix redactor
// took the "well-formed URN, nothing to redact" path and returned the string untouched, publishing
// the out-of-band secret that makes a private store private into any serialized error.
//
// These assert on the RENDERED output a consumer actually sees (message + toJSON + context), not
// on the redaction helper — a test that only checks the helper is blind to any other path that
// renders the raw value.
// ---------------------------------------------------------------------------------------------
const NF_SALT = "c0ffee".repeat(6); // 36-hex, distinctive + greppable

// Everything a consumer can realistically log from a caught error.
function renderError(err) {
  return [
    err.message,
    JSON.stringify(err.toJSON()),
    JSON.stringify(err.context),
  ].join("\n");
}

const NON_FINAL_SALT_URNS = [
  ["trailing & param", `urn:dig:chia:${STORE}/a.txt?salt=${NF_SALT}&x=1`],
  ["trailing #fragment", `urn:dig:chia:${STORE}/a.txt?salt=${NF_SALT}#frag`],
  [
    "rooted + trailing param",
    `urn:dig:chia:${STORE}:${ROOT}/a.txt?salt=${NF_SALT}&v=2`,
  ],
];

for (const [label, urn] of NON_FINAL_SALT_URNS) {
  test(`a non-final salt (${label}) never reaches a rendered error (#2518)`, () => {
    const err = new DigSdkError("INVALID_ARGUMENT", "bad urn", { value: urn });
    const rendered = renderError(err);
    assert.ok(
      !rendered.includes(NF_SALT),
      `salt leaked into a rendered error: ${rendered}`,
    );
    assert.ok(rendered.includes("<redacted>"));
  });
}

test("a salt inside the resource key is redacted alongside a final salt (#2518)", () => {
  const inner = "aaaa1111".repeat(4);
  const trailing = "bbbb2222".repeat(4);
  const err = new DigSdkError("INVALID_ARGUMENT", "bad urn", {
    value: `urn:dig:chia:${STORE}/a?salt=${inner}&b=1?salt=${trailing}`,
  });
  const rendered = renderError(err);
  assert.ok(!rendered.includes(inner), `inner salt leaked: ${rendered}`);
  assert.ok(!rendered.includes(trailing), `trailing salt leaked: ${rendered}`);
});

test("a cyclic error context does not throw during construction (#2518)", () => {
  const cyclic = { rpcMethod: "dig.getContent", self: null };
  cyclic.self = cyclic;
  const nested = { a: [cyclic], b: cyclic };
  let err;
  assert.doesNotThrow(() => {
    err = new DigSdkError("RPC_MALFORMED_RESPONSE", "cyclic context", nested);
  });
  // The cycle is preserved by identity (not cloned into an infinite tree) and the acyclic fields
  // still round-trip, so the guard costs no fidelity.
  assert.equal(err.context.a[0].rpcMethod, "dig.getContent");
  assert.equal(err.context.b, err.context.a[0]);
  assert.equal(err.context.b.self, err.context.b);
});

// ---------------------------------------------------------------------------------------------
// `splitQuery` must be LINEAR in the URN's length (#2719).
//
// Iterating every `?` while taking `s.slice(at + 1)` — an O(n) copy — and running a full regex scan
// over that tail makes the parser quadratic. `isUrn`/`parseUrn` are public exports and `isUrn` is
// exactly the cheap validator a dapp runs on untrusted input, so this is a remote stall:
//
//     16 000 `?`  (16 KiB)   0.0 ms on 0.6.3  ->  21.1 ms
//    128 000 `?` (125 KiB)   0.3 ms on 0.6.3  -> 865.8 ms
//
// The threshold below is deliberately generous — 100 ms against a measured 0.3 ms linear cost and a
// measured ~866 ms quadratic one. It is a shape assertion (linear vs quadratic), not a benchmark,
// so it cannot flake on a slow machine while still failing decisively if the quadratic returns.
// ---------------------------------------------------------------------------------------------

test("a URN with 128k question marks parses in linear time (#2719)", () => {
  const urn = `urn:dig:chia:${STORE}/${"?".repeat(128_000)}a`;
  const started = Date.now();
  isUrn(urn);
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 100,
    `isUrn took ${elapsed}ms on a ${urn.length}-byte URN`,
  );
});

// The rewrite above is a PERFORMANCE change and must decide every input exactly as the rule reads.
// A hand-picked case list cannot show that, so both implementations are swept over a generated
// space of separator/value/position combinations and compared field for field.
test("the linear split agrees with the reference rule on every generated input (#2719)", async () => {
  const { referenceParse, actualParse, generatedTails } =
    await import("./urn-splitquery-equivalence.mjs");
  let compared = 0;
  const differences = [];
  for (const tail of generatedTails()) {
    const urn = `urn:dig:chia:${STORE}/${tail}`;
    compared++;
    const expected = referenceParse(urn);
    const actual = actualParse(parseUrn, urn);
    if (expected !== actual && differences.length < 5) {
      differences.push(`${JSON.stringify(tail)}: ${expected} != ${actual}`);
    }
  }
  assert.ok(compared > 100_000, `only ${compared} inputs compared`);
  assert.deepEqual(differences, [], `compared ${compared} inputs`);
});

// ---------------------------------------------------------------------------------------------
// The salt VALUE is read at `?` boundaries too, so the SYSTEM.md grammar and the scanner derive the
// same key.
//
// The grammar defines a boundary as "the start of a query segment (the text following some `?`), or
// immediately after an `&`", with the FIRST boundary occurrence carrying a hex value winning. The
// value scanner only honoured `&`, so the two derived different keys — and the code's answer was the
// silently-unusable one:
//
//   a?salt=zz?salt=ff00ff00                     code: null (cannot decrypt)   SPEC: ff00ff00
//   report?year=2024.csv?salt=aaaa&salt=bbbb    code: bbbb (last)             SPEC: aaaa (first)
//
// Only the VALUE scanner widens. The SPLIT marker must NOT: if a `?`-borne `salt=` could decide
// which `?` starts the query, `report?year=2024.csv?salt=ff` would qualify at its FIRST `?` and
// truncate a real, already-published key back to `report`.
// ---------------------------------------------------------------------------------------------

test("a '?'-borne salt inside the chosen query is read as the salt (#2719)", () => {
  const parsed = parseUrn(`urn:dig:chia:${STORE}/a?salt=zz?salt=ff00ff00`);
  assert.equal(parsed.resourceKey, "a");
  assert.equal(parsed.salt, "ff00ff00");
});

test("the FIRST boundary salt in the query wins, whichever separator introduced it (#2719)", () => {
  const parsed = parseUrn(
    `urn:dig:chia:${STORE}/report?year=2024.csv?salt=aaaa&salt=bbbb`,
  );
  assert.equal(parsed.salt, "aaaa");
});

test("a '?'-borne salt does NOT decide which '?' starts the query (#2719)", () => {
  // The regression the widened VALUE scanner must not cause. Widening the SPLIT marker as well would
  // make the first `?` qualify and truncate this working key back to `report`.
  const parsed = parseUrn(`urn:dig:chia:${STORE}/report?year=2024.csv?salt=ff`);
  assert.equal(parsed.resourceKey, "report?year=2024.csv");
  assert.equal(parsed.salt, "ff");
});

// Widening the VALUE scanner is a behaviour CHANGE, so it is MEASURED rather than asserted.
//
// The claim this sweep once made — "no input that had a salt before loses it" — was FALSE, and green
// only because the generator could not express the class that breaks it. `k??salt=aa11&salt=ff00`
// carries two DIFFERENT usable salts, and the widening MOVES the read from `ff00` (the only `&`
// boundary) to `aa11` (the earlier `?` boundary). That is a different decryption key, so the honest
// claim is not "nothing moves" but "nothing that WORKS TODAY moves".
//
// Three properties are pinned, and the third is the one that carries the safety argument:
//
//   1. the resource key is never affected — only the salt is;
//   2. no input is left with NO salt where it previously had one (a widening must not blind the
//      scanner, which is the failure mode #2518 was);
//   3. every input whose salt MOVES reads `salt: null` under PUBLISHED 0.6.3, so no read that a real
//      user can perform today changes its key. This is checked against 0.6.3's own final-position
//      regex, not against either side of the change, so it cannot be satisfied circularly.
test("widening the salt scanner changes only salts, and moves none that 0.6.3 could read (#2719)", async () => {
  const { referenceParse, narrowParse, publishedSalt, generatedTails } =
    await import("./urn-splitquery-equivalence.mjs");
  let compared = 0;
  let changed = 0;
  let moved = 0;
  const keyChanges = [];
  const saltsBlinded = [];
  const movedReadableIn063 = [];
  const movedExamples = [];
  for (const tail of generatedTails()) {
    const urn = `urn:dig:chia:${STORE}/${tail}`;
    compared++;
    const before = narrowParse(urn);
    const after = referenceParse(urn);
    if (before === after) continue;
    changed++;
    const [, , keyBefore, saltBefore] = before.split("|");
    const [, , keyAfter, saltAfter] = after.split("|");
    if (keyBefore !== keyAfter && keyChanges.length < 5) {
      keyChanges.push(`${tail}: ${keyBefore} -> ${keyAfter}`);
    }
    if (saltBefore === "null") continue;
    if (saltAfter === "null" && saltsBlinded.length < 5) {
      saltsBlinded.push(`${tail}: ${saltBefore} -> null`);
      continue;
    }
    moved++;
    if (movedExamples.length < 5) {
      movedExamples.push(`${tail}: ${saltBefore} -> ${saltAfter}`);
    }
    if (publishedSalt(urn) !== null && movedReadableIn063.length < 5) {
      movedReadableIn063.push(`${tail}: ${saltBefore} -> ${saltAfter}`);
    }
  }
  assert.deepEqual(keyChanges, [], "the widening moved a resource key");
  assert.deepEqual(saltsBlinded, [], "the widening removed a salt entirely");
  assert.deepEqual(
    movedReadableIn063,
    [],
    "the widening moved a salt that published 0.6.3 could read",
  );
  assert.ok(
    changed > 0,
    `the widening changed nothing across ${compared} inputs`,
  );
  // The sweep must be able to SEE the moved-salt class; if it cannot, properties 2 and 3 above are
  // vacuous and this test is measuring an empty set. This is the assertion the previous generator
  // (one hex token, depth 5) would have failed.
  assert.ok(
    moved > 0,
    `no generated input moves a salt — the generator is blind to the class (${compared} compared)`,
  );
  assert.ok(
    movedExamples.some((e) => e.includes("?salt=")),
    `no moved-salt example crosses a '?' boundary: ${movedExamples.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------------------------
// The module's own boundary against the #2719 coercion class.
//
// `parseUrn` is what a dapp runs on untrusted input, and it began with `String(raw ?? "")` — the
// very coercion this release exists to close everywhere else. `String()` on a deeply nested array
// reaches `Array.prototype.join`, which recurses once per level and throws a raw `RangeError`. That
// escapes as an UNCODED error from a public export, in a release whose SPEC states every failure the
// SDK surfaces is a coded `DigSdkError`.
//
// The fixture is nested 60_000 deep because that is the depth measured to blow the stack; a shallow
// nested array coerces fine and would assert nothing. It is built iteratively — building it
// recursively would blow the stack in the TEST rather than in the code under test.
function deeplyNestedArray(depth = 60_000) {
  let a = [];
  for (let i = 0; i < depth; i++) a = [a];
  return a;
}

test("parseUrn refuses a non-scalar argument with a coded error, not a RangeError (#2719)", () => {
  for (const hostile of [deeplyNestedArray(), {}, [], () => {}]) {
    let thrown;
    try {
      parseUrn(hostile);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof DigSdkError, `uncoded throw: ${thrown}`);
    assert.equal(thrown.code, "INVALID_ARGUMENT");
    // The hostile value must not be echoed into the context — that hands it straight to the
    // redaction walk this refusal exists to keep it away from.
    assert.equal(thrown.context?.value, undefined);
  }
});

test("parseUrn still accepts the scalars it always coerced (#2719)", () => {
  // The refusal must be narrow: only shapes that can RECURSE. Scalars coerce in constant time, and
  // narrowing to `typeof === "string"` would be an unrequested behaviour change.
  assert.throws(() => parseUrn(null), DigSdkError);
  assert.throws(() => parseUrn(undefined), DigSdkError);
  assert.throws(() => parseUrn(42), DigSdkError);
  assert.equal(parseUrn(` urn:dig:chia:${STORE}/a.txt `).resourceKey, "a.txt");
});

test("isUrn returns false for a non-scalar rather than propagating (#2719)", () => {
  assert.equal(isUrn(deeplyNestedArray()), false);
  assert.equal(isUrn({}), false);
});

test("redactUrnSalt is total: a non-scalar neither throws nor constructs an error (#2719)", async () => {
  const { redactUrnSalt, REDACTED_SALT } = await import("../dist/index.js");
  // It must NOT construct a DigSdkError either — the error constructor redacts its own context
  // through this function, so throwing one here would re-enter and recurse without bound.
  assert.equal(typeof redactUrnSalt(deeplyNestedArray()), "string");
  assert.equal(redactUrnSalt({}), "[object]");
  assert.equal(redactUrnSalt(deeplyNestedArray()), "[array]");
  assert.equal(redactUrnSalt(undefined), "");
  assert.equal(redactUrnSalt(null), "");
  // The scalar and string behaviour it already had is unchanged.
  assert.equal(redactUrnSalt(`?salt=deadbeef`), `?salt=${REDACTED_SALT}`);
  assert.equal(redactUrnSalt("plain"), "plain");
});
