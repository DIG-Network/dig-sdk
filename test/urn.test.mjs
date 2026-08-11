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
  assert.ok(elapsed < 100, `isUrn took ${elapsed}ms on a ${urn.length}-byte URN`);
});

// The rewrite above is a PERFORMANCE change and must decide every input exactly as the rule reads.
// A hand-picked case list cannot show that, so both implementations are swept over a generated
// space of separator/value/position combinations and compared field for field.
test("the linear split agrees with the reference rule on every generated input (#2719)", async () => {
  const { referenceParse, actualParse, generatedTails } = await import(
    "./urn-splitquery-equivalence.mjs"
  );
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
