// De-vendoring proof (#16 / #108): the SDK's read-crypto wasm comes from the published
// @dignetwork/dig-capsule-wasm package — NOT a hand-copied vendor/ directory. These tests assert the
// dependency wiring so a regression (re-vendoring, or resolving a stray copy) fails CI.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

test("@dignetwork/dig-capsule-wasm is a declared runtime dependency", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(
    pkg.dependencies && typeof pkg.dependencies["@dignetwork/dig-capsule-wasm"] === "string",
    "expected @dignetwork/dig-capsule-wasm in dependencies",
  );
});

test("the read-crypto wasm resolves from node_modules/@dignetwork/dig-capsule-wasm (not vendor/)", () => {
  const wasmPath = require.resolve("@dignetwork/dig-capsule-wasm/dig_client_bg.wasm");
  assert.match(
    wasmPath.replace(/\\/g, "/"),
    /node_modules\/@dignetwork\/dig-capsule-wasm\//,
    "wasm must be resolved from the published package",
  );
});

test("no vendored dig-client artifacts remain in the repo", () => {
  // The whole point of #108: the vendor/ copy is gone. Guard against re-vendoring.
  for (const p of [
    "vendor/dig_client_bg.wasm",
    "vendor/dig_client.mjs",
    "vendor/dig_client.d.ts",
  ]) {
    assert.equal(existsSync(path.join(repoRoot, p)), false, `${p} must not exist (de-vendored)`);
  }
});

test("the package's shipped wasm matches its published integrity.json digest", () => {
  const wasmPath = require.resolve("@dignetwork/dig-capsule-wasm/dig_client_bg.wasm");
  const sha = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
  const integrity = require("@dignetwork/dig-capsule-wasm/integrity.json");
  assert.equal(sha, integrity.sha256);
});

