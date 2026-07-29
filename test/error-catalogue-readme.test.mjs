// README ↔ error-catalogue lockstep (#1807 finding 9, §6.2). The README "### Error codes" table is
// hand-maintained beside the exported DIG_SDK_ERROR_CODES catalogue; the two silently drift when a
// code is added or removed. This test pins them together: the set of codes documented in the README
// table MUST equal the set of exported code values. A drift fails here with the exact diff.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DIG_SDK_ERROR_CODES } from "../dist/index.js";

/**
 * Extract the set of error codes documented in the README "### Error codes" table.
 * Robust to row reordering / added columns: it scopes to the section body (heading → next `---`
 * or `##` boundary) and reads the first backtick-wrapped UPPER_SNAKE token of each table row.
 */
function readmeErrorCodes() {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  );
  const start = readme.indexOf("### Error codes");
  assert.notEqual(start, -1, 'README is missing the "### Error codes" section');

  const rest = readme.slice(start + "### Error codes".length);
  const end = rest.search(/^(?:---|## )/m);
  const section = end === -1 ? rest : rest.slice(0, end);

  const codes = new Set();
  for (const line of section.split("\n")) {
    // A table data row: leading `|`, first cell a `` `CODE` `` token. The header/divider rows and
    // the prose/example above the table have no such leading backtick cell.
    const match = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line);
    if (match) codes.add(match[1]);
  }
  return codes;
}

test("README error table documents exactly the exported catalogue", () => {
  const documented = readmeErrorCodes();
  const exported = new Set(Object.values(DIG_SDK_ERROR_CODES));

  const undocumented = [...exported].filter((c) => !documented.has(c)).sort();
  const stale = [...documented].filter((c) => !exported.has(c)).sort();

  assert.deepEqual(
    undocumented,
    [],
    `error codes exported but missing from the README table: ${undocumented.join(", ")}`,
  );
  assert.deepEqual(
    stale,
    [],
    `error codes in the README table but not exported: ${stale.join(", ")}`,
  );
});
