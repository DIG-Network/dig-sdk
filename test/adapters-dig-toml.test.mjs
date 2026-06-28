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
  const t = parseDigToml(`store_id = "${STORE}"\noutput_dir = "build"\nbuild_command = "x"`);
  assert.equal(t.storeId, STORE);
  assert.equal(t.outputDir, "build");
  assert.equal(t.buildCommand, "x");
});

test("parseDigToml: kebab-case wins over snake_case when both present", () => {
  const t = parseDigToml(`output_dir = "old"\noutput-dir = "new"`);
  assert.equal(t.outputDir, "new");
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
