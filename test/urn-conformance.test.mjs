// dig-sdk's parser run against the SHARED URN parse conformance table (#2518).
//
// The table — `conformance/urn-parse.json` — is the artifact that makes agreement between the DIG
// URN parsers (dig-sdk, the extension, the hub, the companion) verifiable instead of asserted in a
// comment. dig-sdk claimed byte-identity with its siblings in a doc comment while the extension
// diverged structurally; a comment cannot fail, so nobody found out until the divergence produced a
// wrong derived key. This test is the dig-sdk end of that contract.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUrn, isUrn } from "../dist/index.js";

const TABLE_PATH = fileURLToPath(
  new URL("../conformance/urn-parse.json", import.meta.url),
);
const table = JSON.parse(readFileSync(TABLE_PATH, "utf8"));

test("the conformance table is well-formed and non-trivial", () => {
  assert.equal(table.version, 1);
  assert.ok(
    Array.isArray(table.cases) && table.cases.length >= 10,
    "the table must carry the real case set, not a stub",
  );
  // Every case is complete. A case missing its `expect` would silently pass the loop below.
  for (const c of table.cases) {
    assert.equal(typeof c.urn, "string", `case ${c.name} has no urn`);
    assert.equal(typeof c.expect, "object", `case ${c.name} has no expect`);
  }
  // The table must actually exercise both verdicts, or the loop below proves only one half.
  assert.ok(table.cases.some((c) => c.expect.invalid === true));
  assert.ok(table.cases.some((c) => c.expect.invalid !== true));
  // …and it must cover the two cases this contract exists for.
  assert.ok(
    table.cases.some(
      (c) =>
        c.expect.salt &&
        c.urn.includes("salt=") &&
        c.urn.indexOf("salt=") <
          c.urn.length - "salt=".length - c.expect.salt.length,
    ),
    "no non-final-position salt case",
  );
  assert.ok(
    table.cases.some((c) => c.expect.resourceKey?.includes("#")),
    "no '#'-in-key case",
  );
});

for (const c of table.cases) {
  test(`conformance: ${c.name}`, () => {
    if (c.expect.invalid === true) {
      assert.equal(isUrn(c.urn), false);
      assert.throws(() => parseUrn(c.urn));
      return;
    }
    assert.equal(isUrn(c.urn), true);
    const parsed = parseUrn(c.urn);
    assert.equal(parsed.storeId, c.expect.storeId);
    assert.equal(parsed.root, c.expect.root);
    assert.equal(parsed.resourceKey, c.expect.resourceKey);
    assert.equal(parsed.salt, c.expect.salt);
  });
}

test("a non-final-position salt never reaches the resource key (#2518)", () => {
  // The leak this table exists for: the secret used to survive inside `resourceKey`, which is copied
  // onto every returned read result and is the derivation input — so it both leaked AND derived a key
  // that could not decrypt. Asserting on `resourceKey` (not merely that `salt` was extracted) is what
  // pins the leak closed, because an implementation could extract the salt and still leave it behind.
  const secret = "deadbeefdeadbeef";
  const urn = `urn:dig:chia:${"ab".repeat(32)}/secret.txt?salt=${secret}&x=1`;
  const parsed = parseUrn(urn);
  assert.equal(parsed.salt, secret);
  assert.equal(parsed.resourceKey, "secret.txt");
  for (const [field, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      assert.ok(
        !value.includes(secret) || field === "salt",
        `the salt leaked into ${field}`,
      );
    }
  }
});
