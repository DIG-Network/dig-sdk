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

// #2262: read() is a GENUINE OBLIVIOUS primitive — it returns advisory { verified, decrypted }
// and NEVER throws on unverified/undecryptable content (beyond a transport failure). The
// secure-by-default sibling readVerified() (and the render-class readText()) are the fail-closed
// readers renderers MUST use.
test("read() is oblivious: unverified-but-decrypting content returns advisory, never throws", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32);
  const bytes = new TextEncoder().encode(
    "served, decrypts, but chain-unbacked",
  );
  const ciphertext = wasm.encryptResource(STORE, "index.html", bytes);
  const { fetchImpl } = mockCiphertextRpc(ciphertext); // bogus proof → verified=false

  const dig = new DigClient({ fetch: fetchImpl });
  const r = await dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root });
  assert.equal(r.decrypted, true);
  assert.equal(r.verified, false); // advisory — caller decides trust
  assert.deepEqual(r.bytes, bytes);
});

// (4) read() is oblivious on a DECRYPT failure too: hand back the raw ciphertext, no throw.
test("read() oblivious on decrypt-fail: returns { decrypted:false, bytes:ciphertext }, no throw", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32);
  const salt = "ab".repeat(32);
  // Encrypt under a private-store salt, then read WITHOUT the salt → wrong key → decrypt fails.
  const ciphertext = wasm.encryptResource(
    STORE,
    "index.html",
    new TextEncoder().encode("x"),
    salt,
  );
  const { fetchImpl } = mockCiphertextRpc(ciphertext);

  const dig = new DigClient({ fetch: fetchImpl });
  const r = await dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root });
  assert.equal(r.decrypted, false);
  assert.deepEqual(r.bytes, ciphertext); // the raw served ciphertext, unchanged
});

// (1) readVerified() is fail-closed: a decrypt failure throws DECRYPT_FAILED (never raw bytes).
test("readVerified throws DECRYPT_FAILED when the URN does not decrypt the served bytes (pinned root)", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32); // pinned (64-hex)
  const salt = "ab".repeat(32);
  const ciphertext = wasm.encryptResource(
    STORE,
    "index.html",
    new TextEncoder().encode("x"),
    salt,
  );
  const { fetchImpl } = mockCiphertextRpc(ciphertext); // read without salt → decrypt fails

  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.readVerified({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "DECRYPT_FAILED",
  );
});

// (2) Under a PINNED root, unverified inclusion is fatal for the secure readers — both readVerified
// and readText throw INCLUSION_UNVERIFIED (the #2134 spoofed-node protection, now render-scoped).
test("readVerified AND readText throw INCLUSION_UNVERIFIED under a pinned root when inclusion fails", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32); // pinned
  const malicious = new TextEncoder().encode("attacker-controlled plaintext");
  const ciphertext = wasm.encryptResource(STORE, "index.html", malicious);
  const urn = `urn:dig:chia:${STORE}/index.html`;

  const dig1 = new DigClient({
    fetch: mockCiphertextRpc(ciphertext).fetchImpl,
  });
  await assert.rejects(
    () => dig1.readVerified({ urn, root }),
    (e) => e instanceof DigSdkError && e.code === "INCLUSION_UNVERIFIED",
  );
  const dig2 = new DigClient({
    fetch: mockCiphertextRpc(ciphertext).fetchImpl,
  });
  await assert.rejects(
    () => dig2.readText({ urn, root }),
    (e) => e instanceof DigSdkError && e.code === "INCLUSION_UNVERIFIED",
  );
});

// (3) BLIND-MODEL EXCEPTION: under an UNPINNED / "latest" root, inclusion is advisory — readVerified
// gates on decryption only and resolves even though the inclusion proof did not verify.
test("readVerified resolves under an unpinned root when decryption succeeds (inclusion advisory)", async () => {
  const wasm = await loadDigClientWasm();
  const plaintext = new TextEncoder().encode("latest-root content");
  const ciphertext = wasm.encryptResource(STORE, "index.html", plaintext);
  const { fetchImpl } = mockCiphertextRpc(ciphertext); // verified=false

  const dig = new DigClient({ fetch: fetchImpl });
  const r = await dig.readVerified({
    urn: `urn:dig:chia:${STORE}/index.html`,
    root: "latest", // unpinned sentinel — not 64-hex
  });
  assert.equal(r.decrypted, true);
  assert.equal(r.verified, false); // advisory under the blind-model exception
  assert.deepEqual(r.bytes, plaintext);
});
