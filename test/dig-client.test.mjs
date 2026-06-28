// DigClient read-crypto wired to the REAL vendored wasm (loaded + SRI-verified in Node). Proves
// the loader works, the SRI digest matches, key derivation is deterministic, and an
// encrypt→decrypt roundtrip closes under the URN-derived key (the read path the host stays blind to).

import test from "node:test";
import assert from "node:assert/strict";
import {
  DigClient,
  loadDigClientWasm,
  DIG_CLIENT_WASM_SHA256,
} from "../dist/index.js";

const STORE = "ab".repeat(32);

test("loadDigClientWasm: loads + SRI-verifies the vendored wasm", async () => {
  const wasm = await loadDigClientWasm();
  assert.equal(typeof wasm.retrievalKey, "function");
  assert.equal(typeof wasm.deriveKey, "function");
  assert.equal(typeof wasm.verifyInclusion, "function");
  assert.equal(typeof wasm.decryptChunk, "function");
  // version() exists and is a non-empty string
  assert.equal(typeof wasm.version(), "string");
});

test("SRI digest constant matches the canonical ecosystem digest", () => {
  assert.equal(
    DIG_CLIENT_WASM_SHA256,
    "ff486be806f908a2a90780e499a04dbd34e10e3b97be0470cb9ee841a1e49e77",
  );
});

test("retrievalKey is SHA-256(canonical URN): 64-hex, deterministic, key-sensitive", async () => {
  const dig = new DigClient();
  const a = await dig.retrievalKey(STORE, "index.html");
  const b = await dig.retrievalKey(STORE, "index.html");
  const c = await dig.retrievalKey(STORE, "other.html");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b); // deterministic
  assert.notEqual(a, c); // different resource → different key
});

test("empty resource key resolves to index.html (default view)", async () => {
  const dig = new DigClient();
  assert.equal(await dig.retrievalKey(STORE, ""), await dig.retrievalKey(STORE, "index.html"));
});

test("deriveKey: 32-byte (64-hex) AES key; salt changes the key", async () => {
  const dig = new DigClient();
  const pub = await dig.deriveKey(STORE, "a.txt");
  const priv = await dig.deriveKey(STORE, "a.txt", "ff".repeat(32));
  assert.match(pub, /^[0-9a-f]{64}$/);
  assert.match(priv, /^[0-9a-f]{64}$/);
  assert.notEqual(pub, priv); // salt mixes into the key
});

test("deriveUrnKeys: parses + derives both keys from a URN string", async () => {
  const dig = new DigClient();
  const k = await dig.deriveUrnKeys({ urn: `urn:dig:chia:${STORE}/index.html` });
  assert.equal(k.storeId, STORE);
  assert.equal(k.resourceKey, "index.html");
  assert.equal(k.retrievalKey, await dig.retrievalKey(STORE, "index.html"));
  assert.equal(k.decryptionKey, await dig.deriveKey(STORE, "index.html"));
});

test("encrypt → decrypt roundtrip under the URN-derived key (public store)", async () => {
  const wasm = await loadDigClientWasm();
  const plaintext = new TextEncoder().encode("hello, verified + encrypted DIG content");
  const ciphertext = wasm.encryptResource(STORE, "msg.txt", plaintext);
  assert.ok(ciphertext.length > plaintext.length); // GCM-SIV tag overhead
  const key = wasm.deriveKey(STORE, "msg.txt");
  const opened = wasm.decryptChunk(key, ciphertext);
  assert.deepEqual(opened, plaintext);
});

test("encrypt → decrypt roundtrip under a private-store salt", async () => {
  const wasm = await loadDigClientWasm();
  const salt = "12".repeat(32);
  const plaintext = new TextEncoder().encode("private payload");
  const ciphertext = wasm.encryptResource(STORE, "p.txt", plaintext, salt);
  // The right salt opens it…
  const goodKey = wasm.deriveKey(STORE, "p.txt", salt);
  assert.deepEqual(wasm.decryptChunk(goodKey, ciphertext), plaintext);
  // …the public (no-salt) key does NOT (wrong key → tag failure throws).
  const wrongKey = wasm.deriveKey(STORE, "p.txt");
  assert.throws(() => wasm.decryptChunk(wrongKey, ciphertext));
});

test("DigClient.read requires an on-chain root", async () => {
  const dig = new DigClient();
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html` }),
    /on-chain root is required/,
  );
});

test("DigClient.read fetches by retrieval key, verifies, and decrypts (mock RPC)", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32);
  const plaintext = new TextEncoder().encode("served + decrypted via mock RPC");
  const ciphertext = wasm.encryptResource(STORE, "index.html", plaintext);
  const expectedRk = wasm.retrievalKey(STORE, "index.html");
  const b64 = Buffer.from(ciphertext).toString("base64");

  // Mock fetch: assert the request is addressed by the retrieval key, return the ciphertext as a
  // single complete chunk. (verifyInclusion will be false here — no real proof — which the
  // oblivious model treats as advisory; decryption still succeeds under the URN key.)
  let sawRetrievalKey = null;
  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    sawRetrievalKey = body.params.retrieval_key;
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total_length: ciphertext.length,
            offset: 0,
            ciphertext: b64,
            inclusion_proof: "",
            complete: true,
          },
        };
      },
    };
  };

  const dig = new DigClient({ fetch: mockFetch });
  const res = await dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root });
  assert.equal(sawRetrievalKey, expectedRk); // addressed by the retrieval key, never the URN
  assert.equal(res.decrypted, true);
  assert.deepEqual(res.bytes, plaintext);
  assert.equal(res.root, root);

  const text = await dig.readText({ urn: `urn:dig:chia:${STORE}/index.html`, root });
  assert.equal(text, "served + decrypted via mock RPC");
});
