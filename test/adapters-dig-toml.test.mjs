// Minimal dig.toml reader — the adapters read only the handful of top-level string/int keys
// `digstore deploy` itself reads (store-id, output-dir, build-command, message, network, remote,
// wait-timeout), accepting both the canonical `kebab-case` and the `snake_case` alias, exactly like
// digstore-cli/src/dig_toml.rs. We parse those few keys ourselves rather than add a TOML dependency.

import test from "node:test";
import assert from "node:assert/strict";
import { parseDigToml } from "../dist/adapters.js";

const STORE = "ab".repeat(32);

test("parseDigToml: reads kebab-case keys", () => {
  const t = parseDigToml(
    [
      `store-id = "${STORE}"`,
      `output-dir = "dist"`,
      `build-command = "npm run build"`,
      `network = "mainnet"`,
    ].join("\n"),
  );
  assert.equal(t.storeId, STORE);
  assert.equal(t.outputDir, "dist");
  assert.equal(t.buildCommand, "npm run build");
  assert.equal(t.network, "mainnet");
});

test("parseDigToml: accepts snake_case aliases", () => {
  const t = parseDigToml(
    `store_id = "${STORE}"\noutput_dir = "build"\nbuild_command = "x"`,
  );
  assert.equal(t.storeId, STORE);
  assert.equal(t.outputDir, "build");
  assert.equal(t.buildCommand, "x");
});

test("parseDigToml: kebab-case wins over snake_case when both present", () => {
  const t = parseDigToml(`output_dir = "old"\noutput-dir = "new"`);
  assert.equal(t.outputDir, "new");
});

// Regression (#1156, finding 8): the kebab-wins precedence must hold for EVERY key pair and
// regardless of source-line order, not just for one field. The prior key-ordering used a
// single-argument comparator (`(a) => a.includes("-") ? 1 : -1`, ignoring `b`), an inconsistent
// comparator whose result is engine-dependent — it only produced the intended snake-then-kebab
// apply order by luck on some engines. A proper two-argument partition comparator guarantees the
// canonical kebab-case alias is always applied last (and therefore wins) on every engine.
test("parseDigToml: kebab-case wins for every key pair, either source order", () => {
  const kebabWins = parseDigToml(
    [
      `store_id = "snake"`,
      `store-id = "kebab"`,
      `output_dir = "snake"`,
      `output-dir = "kebab"`,
      `build_command = "snake"`,
      `build-command = "kebab"`,
      `wait_timeout = 1`,
      `wait-timeout = 2`,
    ].join("\n"),
  );
  assert.equal(kebabWins.storeId, "kebab");
  assert.equal(kebabWins.outputDir, "kebab");
  assert.equal(kebabWins.buildCommand, "kebab");
  assert.equal(kebabWins.waitTimeout, 2);

  // Kebab still wins even when the snake_case alias appears AFTER it in the source.
  const kebabFirst = parseDigToml(
    [
      `store-id = "kebab"`,
      `store_id = "snake"`,
      `output-dir = "kebab"`,
      `output_dir = "snake"`,
    ].join("\n"),
  );
  assert.equal(kebabFirst.storeId, "kebab");
  assert.equal(kebabFirst.outputDir, "kebab");
});

test("parseDigToml: ignores comments and blank lines", () => {
  const t = parseDigToml(`# a comment\n\noutput-dir = "dist" # trailing\n`);
  assert.equal(t.outputDir, "dist");
});

test("parseDigToml: numeric wait-timeout", () => {
  const t = parseDigToml(`wait-timeout = 120`);
  assert.equal(t.waitTimeout, 120);
});

test("parseDigToml: empty input yields an empty config", () => {
  const t = parseDigToml("");
  assert.deepEqual(t, {});
});

test("parseDigToml: single-quoted values are supported", () => {
  const t = parseDigToml(`output-dir = 'out'`);
  assert.equal(t.outputDir, "out");
});
