// Adapter config resolution — the PURE precedence logic shared by the Vite plugin and the Next
// adapter. Resolves the final deploy config from (plugin options > env > dig.toml > defaults), so
// a project's `dig.toml` and a CI's env vars compose exactly the way `digstore deploy` itself
// resolves them (see digstore-cli/src/commands/deploy.rs::resolve_config). Tested without touching
// the filesystem or spawning anything.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveDeployConfig } from "../dist/adapters.js";

const STORE = "ab".repeat(32); // 64-hex

test("resolveDeployConfig: defaults when nothing supplied", () => {
  const c = resolveDeployConfig({ options: {}, digToml: {}, env: {} });
  assert.equal(c.outputDir, "dist"); // matches digstore deploy default
  assert.equal(c.network, "mainnet");
  assert.equal(c.storeId, undefined);
  assert.equal(c.buildCommand, undefined);
  assert.equal(c.deployKey, undefined);
});

test("resolveDeployConfig: dig.toml supplies values", () => {
  const c = resolveDeployConfig({
    options: {},
    digToml: { storeId: STORE, outputDir: "build", buildCommand: "npm run build" },
    env: {},
  });
  assert.equal(c.storeId, STORE);
  assert.equal(c.outputDir, "build");
  assert.equal(c.buildCommand, "npm run build");
});

test("resolveDeployConfig: plugin options override dig.toml", () => {
  const c = resolveDeployConfig({
    options: { outputDir: "out", storeId: STORE },
    digToml: { outputDir: "dist", storeId: "cd".repeat(32) },
    env: {},
  });
  assert.equal(c.outputDir, "out");
  assert.equal(c.storeId, STORE);
});

test("resolveDeployConfig: secrets come from env, never from options/dig.toml", () => {
  const c = resolveDeployConfig({
    options: {},
    digToml: {},
    env: { DIGSTORE_DEPLOY_KEY: "ff".repeat(32), DIGSTORE_STORE_SALT: "11".repeat(32) },
  });
  assert.equal(c.deployKey, "ff".repeat(32));
  assert.equal(c.salt, "11".repeat(32));
});

test("resolveDeployConfig: env store-id is honored under dig.toml but over default", () => {
  const c = resolveDeployConfig({
    options: {},
    digToml: {},
    env: { DIGSTORE_STORE_ID: STORE },
  });
  assert.equal(c.storeId, STORE);
});

test("resolveDeployConfig: precedence is options > env > dig.toml for store id", () => {
  const fromToml = resolveDeployConfig({
    options: {},
    digToml: { storeId: "aa".repeat(32) },
    env: { DIGSTORE_STORE_ID: "bb".repeat(32) },
  });
  assert.equal(fromToml.storeId, "bb".repeat(32), "env beats dig.toml");
  const fromOpts = resolveDeployConfig({
    options: { storeId: "cc".repeat(32) },
    digToml: { storeId: "aa".repeat(32) },
    env: { DIGSTORE_STORE_ID: "bb".repeat(32) },
  });
  assert.equal(fromOpts.storeId, "cc".repeat(32), "options beat env");
});

test("resolveDeployConfig: empty-string env values are ignored (treated as unset)", () => {
  const c = resolveDeployConfig({
    options: {},
    digToml: { storeId: STORE },
    env: { DIGSTORE_STORE_ID: "   ", DIGSTORE_DEPLOY_KEY: "" },
  });
  assert.equal(c.storeId, STORE);
  assert.equal(c.deployKey, undefined);
});
