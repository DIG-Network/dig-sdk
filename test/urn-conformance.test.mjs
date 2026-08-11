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
});

// The table is only as good as its coverage of the edges where implementations actually differ: a
// sibling could pass every row of a table that omitted these and still derive a different key. Each
// predicate names the divergence it guards, so a future trim of the table fails HERE with the reason
// rather than silently reducing what conformance means.
const REQUIRED_COVERAGE = {
  "a salt in non-final position": (c) =>
    c.expect.salt && /salt=[0-9a-f]+&/.test(c.urn),
  "a resource key containing '#'": (c) => c.expect.resourceKey?.includes("#"),
  "a resource key containing '?' with NO salt (the no-regression case)": (c) =>
    c.expect.resourceKey?.includes("?") && c.expect.salt === null,
  "a percent-encoded salt value (not decoded)": (c) => c.urn.includes("salt=%"),
  "an empty salt value": (c) => /salt=(&|$)/.test(c.urn),
  "a duplicated salt parameter": (c) =>
    (c.urn.match(/salt=/g) ?? []).length > 1,
  "an uppercase parameter name": (c) => c.urn.includes("SALT="),
  "'salt=' inside another parameter's value": (c) => /=salt=/.test(c.urn),
  "a 'salt=' substring at NO parameter boundary, with the key preserved verbatim":
    (c) =>
      c.urn.includes("salt=") &&
      !/[?&]salt=/.test(c.urn) &&
      c.expect.resourceKey?.includes("salt="),
  "a partly-hex salt value (the leading-hex-run rule)": (c) =>
    /salt=[0-9a-f]+[g-z]/.test(c.urn) && c.expect.salt,
  // The other half of the '?'-in-key pair. Covering only the no-salt half is what let the
  // second-'?' leak ship green: every predicate passed while the secret sat in `resourceKey`.
  "a '?'-in-key WITH a boundary salt (the second-'?' class)": (c) =>
    c.expect.resourceKey?.includes("?") && c.expect.salt,
};

for (const [what, matches] of Object.entries(REQUIRED_COVERAGE)) {
  test(`the conformance table covers ${what}`, () => {
    assert.ok(table.cases.some(matches), `no case covers ${what}`);
  });
}

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

test("the salt never survives inside resourceKey, at whichever '?' it is appended (#2518)", () => {
  // The leak stated as a PROPERTY over the position of the salt query, because that is the axis the
  // implementation kept getting wrong: first it read the salt only in FINAL position, then it split
  // only at the FIRST `?`. Both left the secret inside `resourceKey`, which `readResource` copies
  // onto the returned object — so `JSON.stringify(result)` republished the one value that makes a
  // private store private. A `?` is legal in a key, so a salt appended after a second `?` is the
  // grammar's own `<resource_key>[?salt=<hex>]` form, not an exotic input.
  const secret = "deadbeefdeadbeef";
  const tails = [
    `secret.txt?salt=${secret}`,
    `secret.txt?salt=${secret}&x=1`,
    `secret.txt?x=1&salt=${secret}`,
    `report?year=2024.csv?salt=${secret}`,
    `a?b?salt=${secret}`,
    `notes#1.md?salt=${secret}`,
  ];
  for (const tail of tails) {
    const parsed = parseUrn(`urn:dig:chia:${"ab".repeat(32)}/${tail}`);
    assert.equal(parsed.salt, secret, `${tail}: salt not extracted`);
    assert.ok(
      !JSON.stringify({ ...parsed, salt: null }).includes(secret),
      `${tail}: the salt survived somewhere other than the salt field`,
    );
  }
});

test("a query carrying no salt PARAMETER leaves the resource key verbatim (#2518 property)", () => {
  // THE PROPERTY, not one input. The named regression below pins `report?year=2024.csv`, a key with no
  // `salt=` text at all — and the nearest wrong implementation passes it: a split predicate that tests
  // an UNANCHORED `salt=` substring, while the salt itself is read only at a parameter boundary. Every
  // key here contains the substring `salt=` somewhere that is NOT a boundary, so it carries no salt,
  // no secret and nothing to protect; under the broader predicate each loses its whole query and
  // derives a retrieval key different from 0.6.3's, for content already published on chain.
  //
  // The split decision must be exactly as strict as the salt decision, never broader.
  const noBoundarySalt = [
    "data?desalt=9.json",
    "report?tag=salt=1.csv",
    "archive?q=a&b=salt=2.zip",
    "index.html?ref=mysalt=1",
    "secret.txt?note=salt=ff00ff00",
  ];
  for (const key of noBoundarySalt) {
    const parsed = parseUrn(`urn:dig:chia:${"ab".repeat(32)}/${key}`);
    assert.equal(parsed.resourceKey, key, `${key} lost part of its key`);
    assert.equal(parsed.salt, null, `${key} has no salt parameter`);
  }

  // The other half of the boundary rule, asserted together so neither can be satisfied by loosening
  // the other: a salt that IS at a boundary must still split, and must still leave nothing behind —
  // including when its value is malformed, which is the case that could smuggle a secret in an
  // unexpected alphabet into `resourceKey` and onto every returned read result.
  const boundarySalt = [
    ["secret.txt?salt=ff00ff00", "ff00ff00"],
    ["secret.txt?x=1&salt=ff00ff00", "ff00ff00"],
    ["secret.txt?salt=not-hex-secret", null],
  ];
  for (const [key, salt] of boundarySalt) {
    const parsed = parseUrn(`urn:dig:chia:${"ab".repeat(32)}/${key}`);
    assert.equal(parsed.resourceKey, "secret.txt", `${key} kept its query`);
    assert.equal(parsed.salt, salt);
  }
});

test("a resource key containing '?' still parses verbatim when no salt is present (#2518 regression)", () => {
  // The named regression: 0.6.3 absorbed a `?` into the resource key, and SPEC.md imposes no charset
  // restriction, so `report?year=2024.csv` is a real key with a real retrieval key and a working
  // public read. An unconditional query split derives a DIFFERENT key and makes already-published
  // content unreadable — unmigratable, because the content is already on chain. Pinned here as its
  // own named test, not only as a table row, because this is the property that keeps 0.6.4 additive.
  const parsed = parseUrn(
    `urn:dig:chia:${"ab".repeat(32)}/report?year=2024.csv`,
  );
  assert.equal(parsed.resourceKey, "report?year=2024.csv");
  assert.equal(parsed.salt, null);
});
