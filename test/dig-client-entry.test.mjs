// `@dignetwork/dig-sdk/dig-client` — the clean, publishable read-crypto subpath (#16).
//
// The read-crypto wasm is consumed from the published `@dignetwork/dig-capsule-wasm` package (no longer
// vendored). This subpath is the stable, documented entry the ecosystem (hub, dig-embed.js) can
// consume so they stop hand-copying the wasm. This test pins the contract: the subpath exposes the
// loader + integrity digest + DigClient, with types, and the integrity digest is the same one the
// package publishes in its integrity.json.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as digClient from "../dist/dig-client.js";

const require = createRequire(import.meta.url);

test("dig-client subpath exposes the read-crypto surface", () => {
  assert.equal(typeof digClient.loadDigClientWasm, "function");
  assert.equal(typeof digClient.configureWasm, "function");
  assert.equal(typeof digClient.DigClient, "function");
  assert.equal(typeof digClient.DEFAULT_RPC, "string");
});

test("dig-client subpath re-exports the canonical SRI digest (= package integrity.json)", () => {
  // The single source of truth for the wasm integrity is the digest published by
  // @dignetwork/dig-capsule-wasm. The SDK pins that exact value.
  const integrity = require("@dignetwork/dig-capsule-wasm/integrity.json");
  assert.equal(digClient.DIG_CLIENT_WASM_SHA256, integrity.sha256);
});

test("dig-client subpath exposes URN helpers (pure)", () => {
  assert.equal(typeof digClient.parseUrn, "function");
  assert.equal(typeof digClient.reconstructUrn, "function");
});

test("dig-client subpath: DigClient matches the main entry's implementation", async () => {
  // Each entrypoint is its own tsup bundle (splitting: false), so the class OBJECTS differ by
  // reference — but they are built from the SAME source. Assert they are the same implementation:
  // same name, same method surface, same SRI digest (the read-crypto contract).
  const main = await import("../dist/index.js");
  assert.equal(digClient.DigClient.name, main.DigClient.name);
  assert.equal(digClient.DIG_CLIENT_WASM_SHA256, main.DIG_CLIENT_WASM_SHA256);
  const surface = (C) =>
    Object.getOwnPropertyNames(C.prototype)
      .filter((n) => n !== "constructor")
      .sort();
  assert.deepEqual(surface(digClient.DigClient), surface(main.DigClient));
});
