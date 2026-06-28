// `@dignetwork/dig-sdk/dig-client` — the clean, publishable read-crypto subpath (#16).
//
// Today the read-crypto wasm is VENDORED inside dig-sdk (vendor/, SRI-pinned). This subpath is the
// stable, documented entry the ecosystem (hub, dig-embed.js) can consume so they stop hand-copying
// the wasm — and the seam through which dig-sdk will later consume a published
// `@dignetwork/dig-client` package WITHOUT breaking the vendored fallback. This test pins the
// contract: the subpath exposes the loader + integrity digest + DigClient, with types, and the
// integrity digest is the same one the rest of the ecosystem asserts.

import test from "node:test";
import assert from "node:assert/strict";
import * as digClient from "../dist/dig-client.js";

test("dig-client subpath exposes the read-crypto surface", () => {
  assert.equal(typeof digClient.loadDigClientWasm, "function");
  assert.equal(typeof digClient.configureWasm, "function");
  assert.equal(typeof digClient.DigClient, "function");
  assert.equal(typeof digClient.DEFAULT_RPC, "string");
});

test("dig-client subpath re-exports the canonical SRI digest", () => {
  // The single source of truth for the wasm integrity — must match the ecosystem-wide digest.
  assert.equal(
    digClient.DIG_CLIENT_WASM_SHA256,
    "ff486be806f908a2a90780e499a04dbd34e10e3b97be0470cb9ee841a1e49e77",
  );
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
