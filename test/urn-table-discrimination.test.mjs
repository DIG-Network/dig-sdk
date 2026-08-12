// The conformance table's DISCRIMINATION power, asserted rather than assumed.
//
// `urn-conformance.test.mjs` proves dig-sdk passes the table. That is only half of what the table
// is for: a table every plausible-but-wrong parser also passes certifies nothing. This file runs
// the known-wrong siblings (`urn-wrong-siblings.mjs`) against it and asserts each one FAILS — and
// fails by a margin, so no single row is the only thing standing between a defect and a green run.
//
// Measured before this file existed: a sibling whose ONLY defect was a case-insensitive parameter
// name failed exactly ONE row. Deleting or weakening that row would have unpinned a rule whose
// violation silently changes a derived decryption key, with every other row still green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  WRONG_SIBLINGS,
  expectedOutcome,
  failingRows,
} from "./urn-wrong-siblings.mjs";

const table = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../conformance/urn-parse.json", import.meta.url)),
    "utf8",
  ),
);

// The margin every sibling must clear. TWO is the point of the number: at one, a single row edit
// silently unpins a rule, which is exactly the state the case-sensitivity rule was found in.
const MIN_FAILING_ROWS = 2;

for (const [defect, sibling] of Object.entries(WRONG_SIBLINGS)) {
  test(`the table rejects a sibling whose defect is: ${defect}`, () => {
    const failed = failingRows(table, sibling);
    assert.ok(
      failed.length >= MIN_FAILING_ROWS,
      `only ${failed.length} row(s) reject this sibling (need >= ${MIN_FAILING_ROWS}); ` +
        `a one-row margin means deleting that row unpins the rule. Rows: ${failed.join(" | ")}`,
    );
  });
}

test("two siblings share a failing-row set ONLY when the table cannot tell them apart at all", () => {
  // A guard on this file rather than on the table: a copy-paste slip that gave two entries the same
  // defect would report a healthy margin for a rule nothing exercises.
  //
  // Equal failing sets are not automatically that slip, though. `unconditional \?.*$ strip` and
  // `split at the first '?'` are genuinely different defects that happen to be observationally
  // IDENTICAL on this grammar — both cut at the first `?`, and no URN can make their salt readings
  // diverge (a `?`-borne salt inside the wider tail would itself have qualified that earlier `?`).
  // So the check is the sharper one: identical failing sets are allowed only when the two siblings
  // agree on EVERY row, which is what makes them indistinguishable rather than duplicated.
  const groups = new Map();
  for (const [name, sibling] of Object.entries(WRONG_SIBLINGS)) {
    const key = failingRows(table, sibling).join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([name, sibling]);
  }
  for (const peers of groups.values()) {
    if (peers.length === 1) continue;
    const [, first] = peers[0];
    for (const [name, sibling] of peers.slice(1)) {
      for (const c of table.cases) {
        assert.equal(
          sibling(c.urn),
          first(c.urn),
          `"${name}" and "${peers[0][0]}" fail the same rows but differ on "${c.name}" — ` +
            "the table is blind to a real behavioural difference between them",
        );
      }
    }
  }
});

test("the CORRECT reading of every rule passes the whole table", () => {
  // The control. Without it, a table that rejected everything — including the contract itself —
  // would satisfy every assertion above.
  for (const c of table.cases) {
    assert.equal(
      typeof expectedOutcome(c),
      "string",
      `case ${c.name} has no computable outcome`,
    );
  }
  const shipped = failingRows(table, (urn) => {
    const c = table.cases.find((x) => x.urn === urn);
    return expectedOutcome(c);
  });
  assert.deepEqual(shipped, [], "the table disagrees with itself");
});

// ---------------------------------------------------------------------------
// Outcome distinctness — the table's power stated as a property of its ROWS, so a future edit
// cannot swap in same-value rows and quietly reduce it while every sibling test still passes.
// ---------------------------------------------------------------------------

test("no two cases carry the same URN", () => {
  const urns = table.cases.map((c) => c.urn);
  assert.equal(
    new Set(urns).size,
    urns.length,
    "a duplicated URN adds a row and no discrimination",
  );
});

test("a case with two salt candidates offers two DIFFERENT values", () => {
  // The first-wins rule is only testable when the candidates differ: a row carrying `salt=aa` twice
  // is satisfied identically by a first-wins and a last-wins scanner, so it looks like coverage of
  // the ordering rule while proving nothing about it.
  const multi = table.cases.filter(
    (c) => (c.urn.match(/salt=/gi) ?? []).length > 1,
  );
  assert.ok(multi.length >= 4, "the ordering rules need several multi-candidate rows");
  for (const c of multi) {
    const values = [...c.urn.matchAll(/salt=([^&?#]*)/gi)].map((m) => m[1]);
    assert.equal(
      new Set(values).size,
      values.length,
      `${c.name}: its salt candidates repeat a value, so it cannot see an ordering defect`,
    );
  }
});

test("rows sharing one expected outcome differ in their salt-relevant STRUCTURE", () => {
  // Many rows legitimately share an outcome (`secret.txt` + `ff00ff00` is reached four ways) — that
  // IS the point of those rows: each proves a different route to the same answer. What must never
  // happen is two rows sharing both the outcome AND the structure, which is a clone.
  const byOutcome = new Map();
  for (const c of table.cases) {
    const key = expectedOutcome(c);
    if (!byOutcome.has(key)) byOutcome.set(key, []);
    byOutcome.get(key).push(c);
  }
  for (const [out, cases] of byOutcome) {
    const sigs = cases.map((c) => saltStructure(c.urn));
    assert.equal(
      new Set(sigs).size,
      sigs.length,
      `two rows share the outcome ${out} AND its structure: ${cases.map((c) => c.name).join(" | ")}`,
    );
  }
});

/**
 * A URN reduced to the structure the salt rules actually read: the separators, and each remaining
 * run replaced by its CLASS. Two URNs with the same structure exercise the same rules, whatever
 * their filenames say.
 */
function saltStructure(urn) {
  return urn
    .replace(/[0-9a-fA-F]{64}/g, "S")
    .split(/([?&=#/:])/)
    .map((part) => {
      if (part.length <= 1 && /[?&=#/:]/.test(part)) return part;
      if (part === "") return "";
      if (part === "salt") return "salt";
      if (part.toLowerCase() === "salt") return "SALT-miscased";
      // The value classes are exactly the distinctions the value rules make. Collapsing them (an
      // early version had one "txt" class) makes the percent-encoding row and the non-hex-value row
      // look like clones of each other, when each pins a different rule.
      if (part.includes("%")) return "pct-encoded";
      if (/^[0-9a-fA-F]+$/.test(part)) return "hex";
      if (/^[0-9a-fA-F]/.test(part)) return "hex-prefixed";
      return "txt";
    })
    .join("");
}
