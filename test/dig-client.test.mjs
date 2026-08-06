// DigClient read-crypto wired to the REAL wasm from the published @dignetwork/dig-capsule-wasm package
// (loaded + SRI-verified in Node). Proves the loader works, the SRI digest matches the package's
// integrity.json, key derivation is deterministic, and an encrypt→decrypt roundtrip closes under
// the URN-derived key (the read path the host stays blind to).

import test from "node:test";
import assert from "node:assert/strict";
import {
  DigClient,
  DigSdkError,
  loadDigClientWasm,
  DIG_CLIENT_WASM_SHA256,
} from "../dist/index.js";

const STORE = "ab".repeat(32);

test("loadDigClientWasm: loads + SRI-verifies the packaged wasm", async () => {
  const wasm = await loadDigClientWasm();
  assert.equal(typeof wasm.retrievalKey, "function");
  assert.equal(typeof wasm.deriveKey, "function");
  assert.equal(typeof wasm.verifyInclusion, "function");
  assert.equal(typeof wasm.decryptChunk, "function");
  // version() exists and is a non-empty string
  assert.equal(typeof wasm.version(), "string");
});

test("SRI digest constant matches the published @dignetwork/dig-capsule-wasm integrity.json", async () => {
  // The single source of truth for the wasm integrity is the digest the package publishes in
  // integrity.json. The SDK pins that exact value and fails closed on a mismatch.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const integrity = require("@dignetwork/dig-capsule-wasm/integrity.json");
  assert.equal(DIG_CLIENT_WASM_SHA256, integrity.sha256);
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
  assert.equal(
    await dig.retrievalKey(STORE, ""),
    await dig.retrievalKey(STORE, "index.html"),
  );
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
  const k = await dig.deriveUrnKeys({
    urn: `urn:dig:chia:${STORE}/index.html`,
  });
  assert.equal(k.storeId, STORE);
  assert.equal(k.resourceKey, "index.html");
  assert.equal(k.retrievalKey, await dig.retrievalKey(STORE, "index.html"));
  assert.equal(k.decryptionKey, await dig.deriveKey(STORE, "index.html"));
});

test("encrypt → decrypt roundtrip under the URN-derived key (public store)", async () => {
  const wasm = await loadDigClientWasm();
  const plaintext = new TextEncoder().encode(
    "hello, verified + encrypted DIG content",
  );
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

// A mock RPC serving a resource's ciphertext as a single complete chunk, addressed by retrieval key.
// `proof` is the inclusion proof it returns ("" = a bogus/absent proof → verifyInclusion is false).
function mockCiphertextRpc(ciphertext, { proof = "" } = {}) {
  const b64 = Buffer.from(ciphertext).toString("base64");
  const seen = {};
  const fetchImpl = async (_url, init) => {
    // Health probes (GET, no body) fall through so resolution reaches the mocked endpoint.
    if (!init || typeof init.body !== "string") return { ok: false };
    const body = JSON.parse(init.body);
    seen.retrievalKey = body.params.retrieval_key;
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
            inclusion_proof: proof,
            complete: true,
          },
        };
      },
    };
  };
  return { fetchImpl, seen };
}

test("readResource (advisory) fetches by retrieval key + decrypts without requiring verification", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32);
  const plaintext = new TextEncoder().encode("served + decrypted via mock RPC");
  const ciphertext = wasm.encryptResource(STORE, "index.html", plaintext);
  const expectedRk = wasm.retrievalKey(STORE, "index.html");
  const { fetchImpl, seen } = mockCiphertextRpc(ciphertext); // bogus proof → verified=false

  const dig = new DigClient({ fetch: fetchImpl });
  const res = await dig.readResource({
    storeId: STORE,
    resourceKey: "index.html",
    root,
  });
  assert.equal(seen.retrievalKey, expectedRk); // addressed by the retrieval key, never the URN
  assert.equal(res.decrypted, true); // decrypts under the public URN key…
  assert.equal(res.verified, false); // …but is NOT bound to the chain (advisory API returns it)
  assert.deepEqual(res.bytes, plaintext);
  assert.equal(res.root, root);
});

// REGRESSION (#2134 dual-gate finding): the §5.3 ladder makes an UNAUTHENTICATED local node the
// default endpoint for Node consumers, so a spoofed node can serve Enc(publicKey, malicious) that
// DECRYPTS (decrypted=true) but FAILS inclusion (verified=false). The fail-closed default readers
// MUST refuse to return those chain-unbacked bytes.
test("read throws on unverified content (fail-closed) — never returns chain-unbacked bytes", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32);
  const malicious = new TextEncoder().encode("attacker-controlled plaintext");
  const ciphertext = wasm.encryptResource(STORE, "index.html", malicious);
  const { fetchImpl } = mockCiphertextRpc(ciphertext); // decrypts, but verified=false

  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "CONTENT_UNVERIFIED",
    "read must fail-closed on unverified content",
  );
});

test("readText throws CONTENT_UNVERIFIED on unverified content (fail-closed)", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32);
  const malicious = new TextEncoder().encode("attacker-controlled plaintext");
  const ciphertext = wasm.encryptResource(STORE, "index.html", malicious);
  const { fetchImpl } = mockCiphertextRpc(ciphertext);

  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.readText({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "CONTENT_UNVERIFIED",
  );
});
