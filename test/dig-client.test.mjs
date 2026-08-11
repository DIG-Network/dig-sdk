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
  rootIsPinned,
  DIG_CLIENT_WASM_SHA256,
  parseUrn,
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

// ---------------------------------------------------------------------------------------------
// #2262 gate finding 1/4 — the ACCEPTANCE DOMAIN of `rootIsPinned`.
//
// The predicate decides WHETHER the inclusion gate runs, so anything it fails to recognise as a
// root is silently ungated. Its domain must therefore be at least as wide as the wasm verifier's:
// any root the verifier will accept and verify against MUST read as pinned, or a root that
// verifies correctly on an honest node returns attacker plaintext on a spoofed one, with no
// symptom. These tests anchor the predicate to the wasm's OWN accepted domain (probed below),
// never to captured output.
// ---------------------------------------------------------------------------------------------

const PINNED_ROOT = "cd".repeat(32);

/** The five non-canonical renderings of a pinned root that a caller can plausibly supply. */
const NON_CANONICAL_PINNED_ROOTS = {
  uppercase: PINNED_ROOT.toUpperCase(),
  "mixed case": "Cd".repeat(32),
  "0x-prefixed": `0x${PINNED_ROOT}`,
  "surrounding whitespace": `  ${PINNED_ROOT}  `,
  "trailing newline": `${PINNED_ROOT}\n`,
};

/**
 * Does the wasm verifier ACCEPT this rendering as a trusted root? Probed from the verifier itself:
 * it rejects an unusable root with a "trusted root …" error before it ever looks at the proof, so
 * any OTHER outcome means the root parsed and the rendering is inside the verifiable domain.
 */
function wasmAcceptsRoot(wasm, ciphertext, root) {
  try {
    wasm.verifyInclusion(ciphertext, "", root);
    return true;
  } catch (e) {
    return !/trusted root/i.test(String(e.message));
  }
}

test("rootIsPinned recognises every root rendering the wasm verifier accepts", async () => {
  const wasm = await loadDigClientWasm();
  const ct = wasm.encryptResource(STORE, "index.html", new Uint8Array([1]));
  // Control: the probe must actually discriminate, or the assertion below is vacuous.
  assert.equal(wasmAcceptsRoot(wasm, ct, PINNED_ROOT), true);
  assert.equal(wasmAcceptsRoot(wasm, ct, "latest"), false);

  for (const [name, root] of Object.entries(NON_CANONICAL_PINNED_ROOTS)) {
    if (!wasmAcceptsRoot(wasm, ct, root)) continue; // outside the verifiable domain
    assert.equal(
      rootIsPinned(root),
      true,
      `${name} verifies but reads as unpinned`,
    );
  }
});

test("rootIsPinned is fail-closed: only the unpinned sentinels are ungated", () => {
  // Pinned (gated) — canonical, every non-canonical rendering, and anything unrecognised.
  assert.equal(rootIsPinned(PINNED_ROOT), true);
  for (const [name, root] of Object.entries(NON_CANONICAL_PINNED_ROOTS)) {
    assert.equal(rootIsPinned(root), true, `${name} must be gated`);
  }
  // Anchoring: a 64-hex digest embedded in a LONGER string is not a canonical root, so it must
  // fall to the gated side (the wasm will reject it → a loud INCLUSION_UNVERIFIED), never slip
  // through as "unpinned".
  assert.equal(rootIsPinned(`root=${PINNED_ROOT}`), true);
  assert.equal(rootIsPinned(`${PINNED_ROOT}${PINNED_ROOT}`), true);
  assert.equal(rootIsPinned("not-a-root"), true);

  // Unpinned (blind-model exception) — the narrow sentinel allowlist only, in any rendering.
  for (const sentinel of ["latest", "LATEST", " latest ", "", "   "]) {
    assert.equal(
      rootIsPinned(sentinel),
      false,
      `${JSON.stringify(sentinel)} is a sentinel`,
    );
  }
  assert.equal(rootIsPinned(null), false);
  assert.equal(rootIsPinned(undefined), false);
});

test("readText fails closed for EVERY non-canonical rendering of a pinned root", async () => {
  const wasm = await loadDigClientWasm();
  const malicious = new TextEncoder().encode("<script>steal()</script>");
  const ciphertext = wasm.encryptResource(STORE, "index.html", malicious);
  const urn = `urn:dig:chia:${STORE}/index.html`;

  for (const [name, root] of Object.entries(NON_CANONICAL_PINNED_ROOTS)) {
    const dig = new DigClient({
      fetch: mockCiphertextRpc(ciphertext).fetchImpl,
    });
    await assert.rejects(
      () => dig.readText({ urn, root }),
      (e) => e instanceof DigSdkError && e.code === "INCLUSION_UNVERIFIED",
      `spoofed node + ${name} pinned root must not yield plaintext`,
    );
  }
});

test("read() canonicalises the effective root once, so every layer sees one form", async () => {
  const wasm = await loadDigClientWasm();
  const plaintext = new TextEncoder().encode("canonical-root content");
  const ciphertext = wasm.encryptResource(STORE, "index.html", plaintext);

  for (const root of Object.values(NON_CANONICAL_PINNED_ROOTS)) {
    const dig = new DigClient({
      fetch: mockCiphertextRpc(ciphertext).fetchImpl,
    });
    const r = await dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root });
    assert.equal(r.root, PINNED_ROOT);
  }
});

// ---------------------------------------------------------------------------------------------
// #2303 defect 1 — the private-store secret salt MUST NOT leak into a thrown error.
//
// A private-store URN carries `?salt=<secret>` — the out-of-band secret that makes the store
// private. Any DigSdkError that copies the raw URN into its context republishes that secret the
// moment a consumer logs the error (console/Sentry/Datadog). The whole serialized error (message +
// every context field) must contain the secret NOWHERE — a spot-check of one field is not enough,
// because a future field could carry it too.
// ---------------------------------------------------------------------------------------------
const SECRET_SALT = "deadbeef".repeat(8); // 64-hex; distinctive so it is greppable in the error

// Serialize EVERYTHING a consumer could log: the message, the toJSON() view, and every own
// property (message/stack/context and any nested field), so the assertion sees the whole error.
function serializeError(err) {
  return [
    err.message,
    err.stack ?? "",
    JSON.stringify(err.toJSON?.() ?? {}),
    JSON.stringify(err.context ?? {}),
  ].join("\n");
}

test("DECRYPT_FAILED never leaks the private-store salt into the serialized error (#2303)", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32); // pinned
  // Serve public (no-salt) ciphertext, then read with a private-store salt → wrong key → decrypt fails.
  const ciphertext = wasm.encryptResource(
    STORE,
    "index.html",
    new TextEncoder().encode("x"),
  );
  const { fetchImpl } = mockCiphertextRpc(ciphertext);
  const dig = new DigClient({ fetch: fetchImpl });
  const urn = `urn:dig:chia:${STORE}/index.html?salt=${SECRET_SALT}`;

  const err = await dig.readVerified({ urn, root }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof DigSdkError && err.code === "DECRYPT_FAILED");
  const serialized = serializeError(err);
  assert.ok(
    !serialized.includes(SECRET_SALT),
    `salt leaked into serialized error: ${serialized}`,
  );
});

test("INCLUSION_UNVERIFIED never leaks the private-store salt (#2303)", async () => {
  const wasm = await loadDigClientWasm();
  const root = "cd".repeat(32); // pinned
  // Encrypt UNDER the salt so it decrypts, but serve a bogus proof → inclusion fails under pinned root.
  const ciphertext = wasm.encryptResource(
    STORE,
    "index.html",
    new TextEncoder().encode("private content"),
    SECRET_SALT,
  );
  const { fetchImpl } = mockCiphertextRpc(ciphertext);
  const dig = new DigClient({ fetch: fetchImpl });
  const urn = `urn:dig:chia:${STORE}/index.html?salt=${SECRET_SALT}`;

  const err = await dig.readVerified({ urn, root }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof DigSdkError && err.code === "INCLUSION_UNVERIFIED");
  const serialized = serializeError(err);
  assert.ok(
    !serialized.includes(SECRET_SALT),
    `salt leaked into serialized error: ${serialized}`,
  );
});

// ---------------------------------------------------------------------------------------------
// #2303 defect 2 — an untrusted node's declared total_length must be bounded BEFORE allocation.
//
// The §5.3 ladder makes an unauthenticated local node the default endpoint, so a ~200-byte JSON
// declaring an absurd total_length would otherwise force a multi-GiB allocation before any
// verification — a cheap DoS. The client must refuse a total_length above the protocol ceiling
// with a typed error, WITHOUT attempting the allocation.
// ---------------------------------------------------------------------------------------------
function mockOversizedRpc(declaredTotal) {
  const fetchImpl = async (_url, init) => {
    if (!init || typeof init.body !== "string") return { ok: false };
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total_length: declaredTotal,
            offset: 0,
            ciphertext: "",
            inclusion_proof: "",
            complete: true,
          },
        };
      },
    };
  };
  return { fetchImpl };
}

test("refuses an oversized total_length with RESOURCE_TOO_LARGE, without allocating (#2303)", async () => {
  const root = "cd".repeat(32);
  // 0xFFFFFFFF (4 GiB - 1) — the max a `>>> 0` cast preserves, far above any plausible resource.
  const { fetchImpl } = mockOversizedRpc(0xffffffff);
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "RESOURCE_TOO_LARGE",
  );
});

// ---------------------------------------------------------------------------------------------
// #2303 regression — salt redaction must NOT recurse into DigSdkError construction.
//
// A malformed URL that carries `salt=` makes parseUrn throw INVALID_ARGUMENT with the raw string
// in `value`. If the redactor re-parsed that value with the THROWING parseUrn it would construct
// another DigSdkError → whose context redaction re-enters the redactor → unbounded recursion that
// terminates as a fatal, uncatchable V8 crash (a ~40-byte DoS). The redactor must be pure: it must
// redact WITHOUT re-entering error construction.
// ---------------------------------------------------------------------------------------------
function serializeErrorFull(err) {
  return [
    err.message,
    err.stack ?? "",
    JSON.stringify(err.toJSON?.() ?? {}),
    JSON.stringify(err.context ?? {}),
    err.cause ? String(err.cause) : "",
  ].join("\n");
}

test("parseUrn on a malformed URN carrying salt= does NOT crash and never leaks the salt (#2303)", () => {
  const SALT = "deadbeef".repeat(4); // 32-hex; distinctive + greppable
  // Malformed store id ("zz" is not 64-hex) AND a salt query param — the recursion trigger.
  const bad = `urn:dig:chia:zz/index.html?salt=${SALT}`;
  const err = (() => {
    try {
      parseUrn(bad);
      return null;
    } catch (e) {
      return e; // must be reachable — a fatal recursion crash never gets here
    }
  })();
  assert.ok(err instanceof DigSdkError && err.code === "INVALID_ARGUMENT");
  assert.ok(
    !serializeErrorFull(err).includes(SALT),
    `salt leaked from a malformed-URN error: ${serializeErrorFull(err)}`,
  );
});

test("a non-URN context string containing salt= is redacted, no crash (#2303)", () => {
  const SALT = "cafebabe".repeat(4);
  // A bare `salt=<secret>` with no leading `?`/`&` and no surrounding URN structure.
  const err = new DigSdkError("RPC_ERROR", "boom", {
    detail: `connection failed while fetching salt=${SALT} from peer`,
  });
  assert.ok(
    !serializeErrorFull(err).includes(SALT),
    `salt leaked from a plain context string: ${serializeErrorFull(err)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// #2517 — the two client-side resource paths the #2303 `total_length` ceiling does NOT bound.
//
// #2303 bounds the DECLARED aggregate length before allocating the reassembly buffer. It says
// nothing about (a) how big ONE response's ciphertext may be, or (b) how many responses the client
// will accept. Both fixtures below therefore declare a TINY, perfectly legal `total_length`, so a
// build carrying only the #2303 guard cannot pass them: whatever refuses must be a new bound.
// ---------------------------------------------------------------------------------------------

// A node that declares a 100-byte resource and then returns `b64Bytes` of base64 ciphertext in a
// single response. `total_length` is legal, so only a PER-RESPONSE bound can refuse this.
function mockOversizedChunkRpc(b64Bytes) {
  const fetchImpl = async (_url, init) => {
    if (!init || typeof init.body !== "string") return { ok: false };
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total_length: 100,
            offset: 0,
            ciphertext: "A".repeat(b64Bytes),
            inclusion_proof: "",
            complete: true,
          },
        };
      },
    };
  };
  return { fetchImpl };
}

test("refuses a single oversized RPC response with RESOURCE_TOO_LARGE (#2517)", async () => {
  const root = "cd".repeat(32);
  // 12 MiB of base64 → ~9 MiB decoded, above the per-response ceiling but far below the 512 MiB
  // aggregate ceiling and paired with a 100-byte declared total_length, so #2303's guard is blind
  // to it. Sized in base64 characters because that is what the client sees before it decodes.
  const { fetchImpl } = mockOversizedChunkRpc(12 * 1024 * 1024);
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "RESOURCE_TOO_LARGE",
  );
});

test("accepts a single response at the per-response ceiling (#2517)", async () => {
  // The bound pinned from BOTH sides: a response the size the backend legitimately serves must
  // still be read. 3 MiB of base64 (~2.25 MiB decoded) is a normal full chunk.
  const root = "cd".repeat(32);
  const { fetchImpl } = mockOversizedChunkRpc(3 * 1024 * 1024);
  const dig = new DigClient({ fetch: fetchImpl });
  // The read must reach the crypto stage rather than being refused up front. Whether the garbage
  // ciphertext then decrypts is beside the point; the only forbidden outcome is the size refusal.
  let refusal = null;
  try {
    await dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root });
  } catch (e) {
    refusal = e;
  }
  assert.ok(
    !(refusal instanceof DigSdkError && refusal.code === "RESOURCE_TOO_LARGE"),
    `a legitimate full chunk was refused as oversized: ${refusal?.message}`,
  );
});

test("refuses a non-streaming response whose content-length exceeds the ceiling (#2517)", async () => {
  // A non-streaming shim (no `body`) that declares an oversized content-length. The streaming
  // branch never runs; the ceiling must fall back to the declared header value.
  const root = "cd".repeat(32);
  const oversizedLength = 17 * 1024 * 1024; // 17 MiB > 16 MiB ceiling
  const fetchImpl = async (_url, init) => {
    if (!init || typeof init.body !== "string") return { ok: false };
    return {
      ok: true,
      headers: {
        get: (name) =>
          name.toLowerCase() === "content-length"
            ? String(oversizedLength)
            : null,
      },
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total_length: 100,
            offset: 0,
            ciphertext: "A",
            inclusion_proof: "",
            complete: true,
          },
        };
      },
    };
  };
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "RESOURCE_TOO_LARGE",
  );
});

// A node that never completes. `advance` bytes of forward progress per page: 0 exercises the
// strict-progress guard, 1 exercises the max-page cap (progress is real but uselessly slow).
function mockNeverCompletingRpc(advance) {
  const calls = { n: 0 };
  let next = 0;
  const fetchImpl = async (_url, init) => {
    if (!init || typeof init.body !== "string") return { ok: false };
    calls.n += 1;
    // Safety valve so an UNFIXED build terminates the test run instead of spinning forever. It is
    // three orders of magnitude above the page cap, so it can only be reached by a client with no
    // bound at all — and it surfaces as a DIFFERENT error code, keeping the assertion falsifiable.
    if (calls.n > 50_000)
      throw new Error("mock safety valve: client never stopped paging");
    const offset = next;
    next += advance;
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total_length: 64 * 1024 * 1024,
            offset,
            next_offset: next,
            ciphertext: "",
            inclusion_proof: "",
            complete: false,
          },
        };
      },
    };
  };
  return { fetchImpl, calls };
}

test(
  "refuses a node whose next_offset never advances, instead of spinning (#2517)",
  { timeout: 20_000 },
  async () => {
    const root = "cd".repeat(32);
    const { fetchImpl, calls } = mockNeverCompletingRpc(0);
    const dig = new DigClient({ fetch: fetchImpl });
    await assert.rejects(
      () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
      (e) => e instanceof DigSdkError && e.code === "RPC_MALFORMED_RESPONSE",
    );
    // Refused on the FIRST non-advancing response, not after the page cap —
    // proves the strict-progress guard fired, not merely the iteration ceiling.
    assert.equal(calls.n, 1);
  },
);

test(
  "refuses a node that advances but never completes, after exactly MAX_CONTENT_PAGES pages (#2517)",
  { timeout: 20_000 },
  async () => {
    const root = "cd".repeat(32);
    const { fetchImpl, calls } = mockNeverCompletingRpc(1);
    const dig = new DigClient({ fetch: fetchImpl });
    let err = null;
    try {
      await dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root });
    } catch (e) {
      err = e;
    }
    // A well-formed-but-endless node is a client resource ceiling, not a wire-format fault.
    assert.ok(err instanceof DigSdkError, `expected a DigSdkError, got ${err}`);
    assert.equal(err.code, "RESOURCE_TOO_LARGE");
    // Pin the CONSTANT, not a range: a range assertion is satisfied by any cap in the window, so a
    // cap silently changed to 3000 (or a guard that fires early) would pass unnoticed. The client
    // reports its own ceiling in `maxPages`, and the request count must equal it exactly — one
    // request per permitted page, refusing on the page that would exceed the ceiling.
    assert.equal(err.context.maxPages, 4096);
    assert.equal(calls.n, err.context.maxPages);
  },
);

// ---------------------------------------------------------------------------------------------
// The paging loop's SUCCESS path. Both loop guards (#2517) sit on it, and every other paging test
// asserts a refusal — so without this a guard that refused EVERYTHING would still look green.
// ---------------------------------------------------------------------------------------------

// A node that serves an 8-byte resource as two legal 4-byte pages, the second completing it.
function mockTwoPageRpc() {
  const pages = [
    { bytes: [1, 2, 3, 4], offset: 0, next_offset: 4, complete: false },
    { bytes: [5, 6, 7, 8], offset: 4, next_offset: null, complete: true },
  ];
  const calls = { n: 0, offsets: [] };
  const fetchImpl = async (_url, init) => {
    if (!init || typeof init.body !== "string") return { ok: false };
    const asked = JSON.parse(init.body).params.offset;
    calls.n += 1;
    calls.offsets.push(asked);
    const p = pages.find((q) => q.offset === asked);
    if (!p)
      throw new Error(`client asked for an offset no page serves: ${asked}`);
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total_length: 8,
            offset: p.offset,
            next_offset: p.next_offset,
            ciphertext: Buffer.from(p.bytes).toString("base64"),
            inclusion_proof: "",
            complete: p.complete,
          },
        };
      },
    };
  };
  return { fetchImpl, calls };
}

test("reassembles a two-page read into the served bytes, in order (#2517)", async () => {
  const root = "cd".repeat(32);
  const { fetchImpl, calls } = mockTwoPageRpc();
  const dig = new DigClient({ fetch: fetchImpl });
  // `read` is the oblivious primitive: undecryptable bytes come back as `decrypted: false` with the
  // RAW reassembled ciphertext, which is exactly what makes the loop's output observable here.
  const r = await dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root });
  assert.deepEqual([...r.bytes], [1, 2, 3, 4, 5, 6, 7, 8]);
  // The client followed `next_offset` rather than re-requesting or over-requesting.
  assert.deepEqual(calls.offsets, [0, 4]);
  assert.equal(calls.n, 2);
});

// ---------------------------------------------------------------------------------------------
// The per-response ceiling pinned at the BOUND itself. The 3 MiB / 12 MiB pair above brackets it
// only loosely, so an off-by-a-factor in the base64→bytes estimate would survive both.
// ---------------------------------------------------------------------------------------------

// Base64 carries 3 bytes per 4 characters, so this many characters decode to exactly the ceiling.
const B64_CHARS_AT_CEILING = (6 * 1024 * 1024 * 4) / 3;

test("accepts a response decoding to EXACTLY the per-response ceiling (#2517)", async () => {
  const root = "cd".repeat(32);
  const { fetchImpl } = mockOversizedChunkRpc(B64_CHARS_AT_CEILING);
  const dig = new DigClient({ fetch: fetchImpl });
  let refusal = null;
  try {
    await dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root });
  } catch (e) {
    refusal = e;
  }
  assert.ok(
    !(refusal instanceof DigSdkError && refusal.code === "RESOURCE_TOO_LARGE"),
    `a response AT the ceiling was refused as oversized: ${refusal?.message}`,
  );
});

test("refuses a response one base64 quantum OVER the per-response ceiling (#2517)", async () => {
  const root = "cd".repeat(32);
  // +4 characters is the smallest step that raises the floored decoded size at all (+3 bytes).
  const { fetchImpl } = mockOversizedChunkRpc(B64_CHARS_AT_CEILING + 4);
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "RESOURCE_TOO_LARGE",
  );
});

// ---------------------------------------------------------------------------------------------
// The per-response ceiling measures `ciphertext.length`, so it only binds when `ciphertext` is a
// STRING. `JSON.parse` can hand the client an array, a number, a boolean or an object, and `atob`
// coerces all of them — so the type guard is what makes the ceiling a ceiling.
// ---------------------------------------------------------------------------------------------

// Serve an arbitrary JSON value as `ciphertext`, with a legal 100-byte `total_length`.
function mockCiphertextValueRpc(value) {
  const fetchImpl = async (_url, init) => {
    if (!init || typeof init.body !== "string") return { ok: false };
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total_length: 100,
            offset: 0,
            ciphertext: value,
            inclusion_proof: "",
            complete: true,
          },
        };
      },
    };
  };
  return { fetchImpl };
}

test("refuses an oversized payload smuggled as a one-element ciphertext array (#2517)", async () => {
  const root = "cd".repeat(32);
  // The SAME payload the plain-string test above proves is refused — wrapped in an array, whose
  // `.length` is 1 while `atob`'s ToString coercion still decodes every byte of the element. If the
  // guard only saw the wrapper's length, this read would succeed and the ceiling would be a fiction.
  const payload = "A".repeat(12 * 1024 * 1024);
  const { fetchImpl } = mockCiphertextValueRpc([payload]);
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "RPC_MALFORMED_RESPONSE",
  );
});

test("refuses a nested-array ciphertext (#2517)", async () => {
  const root = "cd".repeat(32);
  const { fetchImpl } = mockCiphertextValueRpc([
    ["A".repeat(12 * 1024 * 1024)],
  ]);
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "RPC_MALFORMED_RESPONSE",
  );
});

for (const [label, value] of [
  ["a number", 12345],
  ["a boolean", true],
  ["an object", {}],
]) {
  test(`refuses ${label} as ciphertext with a coded error (#2517)`, async () => {
    const root = "cd".repeat(32);
    // Without the type guard these compare as `NaN > MAX`, which is FALSE — the ceiling fails OPEN
    // — and the object case reaches `atob` and surfaces an uncoded DOMException.
    const { fetchImpl } = mockCiphertextValueRpc(value);
    const dig = new DigClient({ fetch: fetchImpl });
    await assert.rejects(
      () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
      (e) => e instanceof DigSdkError && e.code === "RPC_MALFORMED_RESPONSE",
    );
  });
}

test("refuses an out-of-range chunk offset with a coded error, not a raw RangeError (#2517)", async () => {
  const root = "cd".repeat(32);
  // `TypedArray.set` throws a RangeError when the target offset exceeds the buffer — even for an
  // empty source — and a raw RangeError escaping `read()` breaks the SDK's contract that every
  // failure it surfaces is a DigSdkError.
  const { fetchImpl } = mockChunkOffsetRpc(5000);
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "RPC_MALFORMED_RESPONSE",
  );
});

// Serve an empty chunk at an arbitrary declared `offset` into a 100-byte resource.
function mockChunkOffsetRpc(offset) {
  const fetchImpl = async (_url, init) => {
    if (!init || typeof init.body !== "string") return { ok: false };
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total_length: 100,
            offset,
            ciphertext: "",
            inclusion_proof: "",
            complete: true,
          },
        };
      },
    };
  };
  return { fetchImpl };
}

// ---------------------------------------------------------------------------------------------
// Raw-throw containment (#2518). `atob` and `Response.json()` both throw UNCODED errors on a
// malformed body, and §2 of SPEC.md states without qualification that every failure the SDK
// surfaces is a `DigSdkError`. A consumer following the documented catch shape
// (`if (isDigSdkError(e)) handle(); else throw e;`) turns an uncoded throw into an unhandled
// rejection — process exit on Node >= 15 — from one unauthenticated response.
// ---------------------------------------------------------------------------------------------

for (const [label, value] of [
  ["an illegal base64 character", "!"],
  ["a base64 length that is not a whole quantum", "A"],
]) {
  test(`refuses ${label} in ciphertext with a coded error, not a raw DOMException (#2518)`, async () => {
    const root = "cd".repeat(32);
    const { fetchImpl } = mockCiphertextValueRpc(value);
    const dig = new DigClient({ fetch: fetchImpl });
    await assert.rejects(
      () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
      (e) => e instanceof DigSdkError && e.code === "RPC_MALFORMED_RESPONSE",
    );
  });
}

// A REAL `Response`, so `json()` throws the same SyntaxError the global fetch would — a mock that
// merely rejected could not tell us the wrapper catches what the platform actually throws.
function mockNonJsonBodyRpc(body) {
  return async () => new Response(body, { status: 200 });
}

for (const [label, body] of [
  ["a non-JSON body", "{{{"],
  ["an empty body", ""],
]) {
  test(`refuses ${label} on a 200 with a coded error, not a raw SyntaxError (#2518)`, async () => {
    const root = "cd".repeat(32);
    const dig = new DigClient({ fetch: mockNonJsonBodyRpc(body) });
    // The wrapper sits in the shared RPC transport, so it must hold for the WHOLE public surface,
    // not just the `getContent` path the sibling guards cover.
    const calls = [
      () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
      () => dig.readText({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
      () => dig.readVerified({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
      () => dig.getCollection({ storeId: STORE }),
      () => dig.listCollectionItems({ storeId: STORE }),
    ];
    for (const call of calls) {
      await assert.rejects(
        call,
        (e) => e instanceof DigSdkError && e.code === "RPC_MALFORMED_RESPONSE",
      );
    }
  });
}

test("ACCEPTS a chunk offset exactly equal to total_length (#2517)", async () => {
  const root = "cd".repeat(32);
  // SPEC.md documents the boundary as "no greater than `total_length`", so `offset === total` is
  // the largest LEGAL write position (an empty terminal chunk). Pinning it from the accepting side
  // is what stops the guard drifting to `>=`; the sibling test above pins the refusing side.
  const { fetchImpl } = mockChunkOffsetRpc(100);
  const dig = new DigClient({ fetch: fetchImpl });
  const res = await dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root });
  // Resolving at all is the property: the sibling offset test proves an out-of-range offset
  // REFUSES, so only the accepting side can distinguish `at > total` from `at >= total`.
  assert.equal(res.bytes.length, 100);
});

// ---------------------------------------------------------------------------------------------
// A hostile response shape must not escape the SDK uncoded (#2719).
//
// The `total_length` guard fires CORRECTLY on a non-numeric declared length and puts the offending
// value into the error context — which, for an attacker-shaped value, is where redaction used to
// blow the stack. This drives the end-to-end path a ~293 KiB nested JSON response produces, so it
// fails against the unbounded redaction even though the guard itself was already right.
// ---------------------------------------------------------------------------------------------

function mockNestedTotalLengthRpc(depth) {
  let nested = { leaf: true };
  for (let i = 0; i < depth; i++) nested = { a: nested };
  return async (_url, init) => {
    if (!init || typeof init.body !== "string") return { ok: false };
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total_length: nested,
            offset: 0,
            ciphertext: "",
            inclusion_proof: "",
            complete: true,
          },
        };
      },
    };
  };
}

test("refuses a deeply nested total_length with a coded error, not a RangeError (#2719)", async () => {
  const root = "cd".repeat(32);
  const dig = new DigClient({ fetch: mockNestedTotalLengthRpc(50_000) });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "RPC_MALFORMED_RESPONSE",
  );
});

// ---------------------------------------------------------------------------------------------
// The response BODY is bounded inside the shared transport (#2517).
//
// The per-response ciphertext ceiling runs AFTER `rpcCall` has already parsed the body, so a node
// declaring `total_length: 100` and answering with tens of MiB was fully resident before anything
// refused it (measured: 319 MiB RSS for a 64 MiB body). The bound therefore has to live in the
// transport, and it has to STOP READING — not read everything and complain afterwards.
// ---------------------------------------------------------------------------------------------

// A REAL `Response` over a stream that reports how much of itself was pulled. `produced` is the
// discriminating measurement: an implementation that buffers the whole body and then checks its
// size passes an error-code assertion identically, and only this counter can tell them apart.
function mockOversizedBodyRpc(totalBytes, { chunkBytes = 1 << 20 } = {}) {
  const meter = { produced: 0 };
  const fetchImpl = async () => {
    const stream = new ReadableStream({
      pull(controller) {
        if (meter.produced >= totalBytes) {
          controller.close();
          return;
        }
        const n = Math.min(chunkBytes, totalBytes - meter.produced);
        meter.produced += n;
        controller.enqueue(new Uint8Array(n).fill(0x20));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, meter };
}

test("refuses an oversized RPC response body and stops reading it (#2517)", async () => {
  const root = "cd".repeat(32);
  // 64 MiB — the size measured at 319 MiB RSS on the unbounded path, and ~4x the transport budget.
  const { fetchImpl, meter } = mockOversizedBodyRpc(64 * 1024 * 1024);
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${STORE}/index.html`, root }),
    (e) => e instanceof DigSdkError && e.code === "RESOURCE_TOO_LARGE",
  );
  // The read stopped near the budget rather than draining the body. Pinned well under the 64 MiB
  // the mock would happily serve, so a buffer-then-check implementation fails here.
  assert.ok(
    meter.produced < 32 * 1024 * 1024,
    `read did not stop early: pulled ${meter.produced} bytes`,
  );
});

test("the transport bound is applied to EVERY dig.* method (#2517)", async () => {
  const calls = [
    (dig) => dig.getCollection({ storeId: STORE }),
    (dig) => dig.listCollectionItems({ launcherIds: [STORE] }),
    (dig) =>
      dig.read({
        urn: `urn:dig:chia:${STORE}/index.html`,
        root: "cd".repeat(32),
      }),
  ];
  for (const call of calls) {
    const { fetchImpl } = mockOversizedBodyRpc(64 * 1024 * 1024);
    const dig = new DigClient({ fetch: fetchImpl });
    await assert.rejects(
      () => call(dig),
      (e) => e instanceof DigSdkError && e.code === "RESOURCE_TOO_LARGE",
    );
  }
});

test("a legitimate-sized response body still parses (#2517)", async () => {
  // The bound must be picked from the protocol's own per-response ceiling, so a response carrying a
  // full legal chunk has to pass. Without this side the budget could drift down to anything.
  const ciphertext = new Uint8Array(3 * 1024 * 1024).fill(7);
  const { fetchImpl } = mockCiphertextRpc(ciphertext);
  const dig = new DigClient({ fetch: fetchImpl });
  const res = await dig.read({
    urn: `urn:dig:chia:${STORE}/index.html`,
    root: "cd".repeat(32),
  });
  assert.equal(res.bytes.length, ciphertext.length);
});

// A NON-WHATWG body shape still gets the ceiling (#2517, adversarial-gate finding).
//
// `DigClientOptions.fetch` is a public, documented injection point, and the two most common Node
// fetch implementations an embedder supplies — `node-fetch` v2 and `cross-fetch` — hand back a Node
// `Readable` as `res.body`: truthy, NO `getReader`, and async-iterable. A chunked response from one
// carries no `content-length` either, so before this the body reached `res.json()` completely
// unbounded — the exact defect #2517 exists to close, silently absent for those consumers.
function mockAsyncIterableBodyRpc(totalBytes, { chunkBytes = 1 << 20 } = {}) {
  const meter = { produced: 0 };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    // No `getReader` and no `content-length` — the node-fetch v2 shape exactly.
    body: {
      async *[Symbol.asyncIterator]() {
        while (meter.produced < totalBytes) {
          const n = Math.min(chunkBytes, totalBytes - meter.produced);
          meter.produced += n;
          yield Buffer.alloc(n, 0x20);
        }
      },
    },
    headers: { get: () => null },
    json: async () => {
      throw new Error("res.json() must not be reached: the body is measurable");
    },
  });
  return { fetchImpl, meter };
}

test("bounds an async-iterable (node-fetch v2 shaped) response body (#2517)", async () => {
  const { fetchImpl, meter } = mockAsyncIterableBodyRpc(64 * 1024 * 1024);
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () =>
      dig.read({
        urn: `urn:dig:chia:${STORE}/index.html`,
        root: "cd".repeat(32),
      }),
    (e) => e instanceof DigSdkError && e.code === "RESOURCE_TOO_LARGE",
  );
  // Measure the PULL, not just the code: a buffer-then-check implementation returns the same error
  // after draining all 64 MiB, which is the resource exhaustion the ceiling exists to prevent.
  assert.ok(
    meter.produced < 32 * 1024 * 1024,
    `read did not stop early: pulled ${meter.produced} bytes`,
  );
});

test("a legal async-iterable response still parses — the bound is not a blanket refusal (#2517)", async () => {
  // The control. Without it, a fix that simply refused every non-WHATWG body would pass the test
  // above while breaking every `node-fetch` consumer.
  const payload = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { items: [], total: 0 } }),
  );
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        // Split mid-payload, so a per-chunk decode bug would corrupt the parse.
        yield payload.subarray(0, 7);
        yield payload.subarray(7);
      },
    },
    headers: { get: () => null },
    json: async () => {
      throw new Error("res.json() must not be reached: the body is measurable");
    },
  });
  const dig = new DigClient({ fetch: fetchImpl });
  const res = await dig.listCollectionItems({
    storeId: STORE,
    collection: "c",
  });
  assert.deepEqual(res.items, []);
});

test("refuses an unmeasurable stream chunk rather than failing open (#2517)", async () => {
  // `read += undefined` is NaN and `NaN > MAX` is FALSE, so one unmeasurable chunk would silently
  // disable the ceiling for the rest of the body. A size guard must fail CLOSED on a shape it
  // cannot account for.
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield { not: "bytes" };
      },
    },
    headers: { get: () => null },
    json: async () => ({ jsonrpc: "2.0", id: 1, result: {} }),
  });
  const dig = new DigClient({ fetch: fetchImpl });
  await assert.rejects(
    () => dig.listCollectionItems({ storeId: STORE, collection: "c" }),
    // Discriminate on the MESSAGE, not the code. `RPC_MALFORMED_RESPONSE` is also what a plain
    // JSON-parse failure raises, so an implementation that let the chunk through and then failed to
    // parse it would satisfy a code-only assertion while the ceiling was off.
    (e) =>
      e instanceof DigSdkError &&
      e.code === "RPC_MALFORMED_RESPONSE" &&
      /cannot be bounded/.test(e.message),
  );
});

test("a chunk that FORGES Uint8Array's prototype cannot disable the ceiling (#2517)", async () => {
  // `instanceof Uint8Array` is a prototype-chain check, so `Object.create(Uint8Array.prototype)`
  // with a poisoned `byteLength` satisfies it. A size guard that trusts such a chunk adds NaN (or a
  // negative number) to its counter, and `NaN > MAX` is false — the ceiling is then off for the
  // whole rest of the body. The poisoned chunk goes FIRST, followed by 64 MiB of real buffers.
  //
  // Asserting on the error code alone would NOT catch a bypass here: the body that gets through is
  // not valid JSON, so a bypass also throws `RPC_MALFORMED_RESPONSE`. The discriminating assertion
  // is how many bytes were pulled.
  for (const poison of [NaN, -1e9, "1"]) {
    const meter = { produced: 0 };
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      body: {
        async *[Symbol.asyncIterator]() {
          const fake = Object.create(Uint8Array.prototype);
          Object.defineProperty(fake, "byteLength", { get: () => poison });
          yield fake;
          while (meter.produced < 64 * 1024 * 1024) {
            meter.produced += 1 << 20;
            yield Buffer.alloc(1 << 20, 0x20);
          }
        },
      },
      headers: { get: () => null },
      json: async () => ({ jsonrpc: "2.0", id: 1, result: {} }),
    });
    const dig = new DigClient({ fetch: fetchImpl });
    await assert.rejects(() =>
      dig.listCollectionItems({ storeId: STORE, collection: "c" }),
    );
    assert.ok(
      meter.produced < 32 * 1024 * 1024,
      `byteLength=${poison} disabled the ceiling: pulled ${meter.produced} bytes`,
    );
  }
});
