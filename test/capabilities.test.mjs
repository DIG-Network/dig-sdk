// Tests for the SDK's runtime self-description (#92 agent-friendly polish): SDK_VERSION +
// capabilities()/describe(). An agent must be able to introspect the SDK's version, modules,
// methods, chains, and error codes without reading source — and SDK_VERSION must match package.json
// (it is injected at build time, so this test guards against drift).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SDK_VERSION, capabilities, describe } from "../dist/index.js";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

test("SDK_VERSION is exported and matches package.json (injected at build time)", () => {
  assert.equal(typeof SDK_VERSION, "string");
  assert.equal(SDK_VERSION, pkg.version, "SDK_VERSION must equal package.json version");
  assert.notEqual(SDK_VERSION, "0.0.0-dev", "version must be injected by the build, not the fallback");
});

test("capabilities() returns the machine-readable SDK surface", () => {
  const cap = capabilities();
  assert.equal(cap.name, "@dignetwork/dig-sdk");
  assert.equal(cap.version, SDK_VERSION);

  // Modules: the four pillars must be discoverable by name.
  const moduleNames = cap.modules.map((m) => m.name);
  for (const m of ["ChiaProvider", "DigClient", "Paywall", "spend"]) {
    assert.ok(moduleNames.includes(m), `capabilities().modules must include ${m}`);
  }
  // Every module carries a summary + an import entry.
  for (const m of cap.modules) {
    assert.equal(typeof m.summary, "string");
    assert.ok(m.summary.length > 0);
    assert.ok(m.entry.startsWith("@dignetwork/dig-sdk"));
  }

  // Wallet method surface mirrors the canonical list.
  assert.ok(cap.walletMethods.includes("chip0002_signCoinSpends"));
  assert.ok(cap.walletMethods.includes("chia_getAddress"));
  assert.deepEqual(cap.signMethods, ["chia_signMessageByAddress", "chip0002_signMessage"]);

  // Transports + chains.
  assert.deepEqual([...cap.transports].sort(), ["injected", "walletconnect"]);
  assert.deepEqual(cap.chains, ["chia:mainnet"]);

  // Read path: default RPC + the SRI-pinned read-crypto wasm digest.
  assert.equal(cap.defaultRpc, "https://rpc.dig.net");
  assert.match(cap.readCryptoWasmSha256, /^[0-9a-f]{64}$/);

  // Error catalogue is present and non-empty.
  assert.ok(Array.isArray(cap.errorCodes));
  assert.ok(cap.errorCodes.includes("ROOT_REQUIRED"));
  assert.ok(cap.errorCodes.includes("DEPLOY_FAILED"));
  assert.ok(cap.errorCodes.includes("SPEND_BUILDER_UNAVAILABLE"));
});

test("describe() is an alias for capabilities()", () => {
  assert.equal(describe, capabilities);
  assert.deepEqual(describe(), capabilities());
});

test("capabilities() is a fresh object each call (no shared mutable state leak)", () => {
  const a = capabilities();
  const b = capabilities();
  assert.notEqual(a, b, "each call returns a new object");
  assert.deepEqual(a, b, "but with identical content");
});
