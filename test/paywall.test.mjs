// Tests for the high-level `Paywall` helper (#46 monetization). The Paywall composes a connected
// `ChiaProvider` (the wallet) with the CANONICAL chip35 monetization spends. We assert the
// contract that matters for "never hand-roll spends":
//
//   • requestPayment DELEGATES coin-spend construction to the wasm builder (buildPayment /
//     buildCatPayment) — the Paywall never assembles a coin spend itself — and then PUSHES the
//     wasm's coinSpends to the wallet for signing via provider.signCoinSpends(...).
//   • verifyReceipt / proveAccess delegate to the wasm's read helpers (verifyPaymentReceipt,
//     proveNftOwnership, proveCollectionMembership).
//
// The chip35 wasm is wasm-bindgen "bundler"-target glue that plain Node's ESM loader cannot
// execute (top-level `import * as wasm from "./..._bg.wasm"`), so the Paywall accepts the spend
// builder via injection (a `spends` option). We inject a SPY that records the calls and returns a
// realistic { coinSpends, receipt } — we do NOT replace the building with a hand-rolled spend; we
// assert the Paywall routes through the injected canonical builder and forwards its output verbatim.

import test from "node:test";
import assert from "node:assert/strict";
import { Paywall } from "../dist/index.js";

const PUBKEY = "ab".repeat(48); // 48-byte synthetic BLS key, hex
const OWNER_PH = "11".repeat(32); // owner puzzle hash, hex
const ASSET_ID = "22".repeat(32); // a CAT (DIG) asset id, hex

// A fake connected wallet: records the methods the Paywall drives and returns canned wallet data.
function fakeProvider({ responses = {}, keys = [PUBKEY] } = {}) {
  const calls = [];
  return {
    calls,
    backend: "injected",
    async getPublicKeys() {
      calls.push({ method: "getPublicKeys" });
      return keys;
    },
    async getXchCoins(limit) {
      calls.push({ method: "getXchCoins", limit });
      return responses.xchCoins ?? [{ parent_coin_info: "00", puzzle_hash: OWNER_PH, amount: 1000 }];
    },
    async getCatCoins(assetId, limit) {
      calls.push({ method: "getCatCoins", assetId, limit });
      return responses.catCoins ?? [{ coin: {}, info: { assetId } }];
    },
    async signCoinSpends(coinSpends) {
      calls.push({ method: "signCoinSpends", coinSpends });
      return responses.signature ?? "ff".repeat(96);
    },
  };
}

// A spy standing in for the canonical chip35 monetization spends. Records args and returns a
// realistic shape; it is the SINGLE place coin spends are "built", proving the Paywall delegates.
function spyChip35() {
  const calls = [];
  const COIN_SPENDS = [{ coin: { amount: 500 }, puzzle_reveal: "ff", solution: "80" }];
  const RECEIPT = { ownerPuzzleHash: OWNER_PH, amount: 500n, nonce: "33".repeat(32) };
  return {
    calls,
    COIN_SPENDS,
    RECEIPT,
    init() {
      calls.push({ fn: "init" });
    },
    paymentNonce(bytes) {
      calls.push({ fn: "paymentNonce", bytes });
      return new Uint8Array(32).fill(0x33);
    },
    buildPayment(key, coins, ownerPh, amount, nonce, fee) {
      calls.push({ fn: "buildPayment", key, coins, ownerPh, amount, nonce, fee });
      return { coinSpends: COIN_SPENDS, receipt: RECEIPT };
    },
    buildCatPayment(key, cats, ownerPh, amount, nonce) {
      calls.push({ fn: "buildCatPayment", key, cats, ownerPh, amount, nonce });
      return { coinSpends: COIN_SPENDS, receipt: RECEIPT };
    },
    verifyPaymentReceipt(observed, ownerPh, minAmount, asset, nonce) {
      calls.push({ fn: "verifyPaymentReceipt", observed, ownerPh, minAmount, asset, nonce });
      return { ok: true };
    },
    proveNftOwnership(parentSpend, owner, requiredNft) {
      calls.push({ fn: "proveNftOwnership", parentSpend, owner, requiredNft });
      return { ok: true, proof: { launcherId: "aa" } };
    },
    proveCollectionMembership(parentSpend, owner, requiredDid) {
      calls.push({ fn: "proveCollectionMembership", parentSpend, owner, requiredDid });
      return { ok: true, proof: { launcherId: "aa" } };
    },
  };
}

test("Paywall is exported from the main SDK surface", () => {
  assert.equal(typeof Paywall, "function");
});

test("requestPayment (XCH): delegates spend build to wasm buildPayment, pushes to wallet", async () => {
  const provider = fakeProvider();
  const spends = spyChip35();
  const paywall = new Paywall(provider, { spends });

  const result = await paywall.requestPayment({ amount: 500, owner: OWNER_PH, memo: "unlock-123" });

  // The coin spend was built by the canonical wasm builder, NOT hand-rolled by the Paywall.
  const built = spends.calls.find((c) => c.fn === "buildPayment");
  assert.ok(built, "Paywall must call the wasm buildPayment to construct the XCH payment");
  assert.equal(built.amount, 500n, "amount forwarded to the wasm as BigInt mojos");
  // The exact coinSpends the wasm produced were pushed to the wallet for signing — unchanged.
  const signed = provider.calls.find((c) => c.method === "signCoinSpends");
  assert.ok(signed, "Paywall must push the built coin spends to the wallet for signing");
  assert.deepEqual(signed.coinSpends, spends.COIN_SPENDS, "wasm coinSpends forwarded verbatim");
  // The Paywall returns the receipt (from the wasm) + the wallet signature.
  assert.equal(result.signature, "ff".repeat(96));
  assert.deepEqual(result.receipt, spends.RECEIPT);
  assert.deepEqual(result.coinSpends, spends.COIN_SPENDS);
  // CAT builder was never used for an XCH payment.
  assert.ok(!spends.calls.some((c) => c.fn === "buildCatPayment"));
});

test("requestPayment (CAT/assetId): routes through wasm buildCatPayment", async () => {
  const provider = fakeProvider();
  const spends = spyChip35();
  const paywall = new Paywall(provider, { spends });

  await paywall.requestPayment({ amount: 100, owner: OWNER_PH, assetId: ASSET_ID });

  assert.ok(
    spends.calls.some((c) => c.fn === "buildCatPayment"),
    "an assetId payment must build via the wasm buildCatPayment",
  );
  assert.ok(!spends.calls.some((c) => c.fn === "buildPayment"), "XCH builder not used for a CAT");
  // CAT coins were sourced for the asset, and the spends were pushed to sign.
  assert.ok(provider.calls.some((c) => c.method === "getCatCoins" && c.assetId === ASSET_ID));
  assert.ok(provider.calls.some((c) => c.method === "signCoinSpends"));
});

test("requestPayment: derives a nonce from memo via the wasm paymentNonce when none given", async () => {
  const provider = fakeProvider();
  const spends = spyChip35();
  const paywall = new Paywall(provider, { spends });

  await paywall.requestPayment({ amount: 1, owner: OWNER_PH, memo: "resource-A" });

  assert.ok(
    spends.calls.some((c) => c.fn === "paymentNonce"),
    "memo without explicit nonce must derive one via the canonical wasm paymentNonce",
  );
});

// Regression: the no-memo/no-nonce path generates a random 32-byte nonce. On Node 18 there is no
// global `crypto` (WebCrypto is exposed globally only since Node 20), so this used to throw
// "crypto is not defined" in CI. The Paywall must fall back to node:crypto's webcrypto. We simulate
// Node 18 by removing globalThis.crypto for the duration of the call.
test("requestPayment: random-nonce path works without a global crypto (Node 18)", async () => {
  const provider = fakeProvider();
  const spends = spyChip35();
  const paywall = new Paywall(provider, { spends });

  const prev = globalThis.crypto;
  // delete is a no-op if the property is non-configurable, so also overwrite to be safe.
  try {
    delete globalThis.crypto;
  } catch {
    /* non-configurable on some runtimes */
  }
  try {
    const result = await paywall.requestPayment({ amount: 1, owner: OWNER_PH }); // no memo, no nonce
    assert.equal(result.nonce.length, 64, "a 32-byte (64-hex) nonce must be generated");
    assert.ok(/^[0-9a-f]{64}$/.test(result.nonce), "nonce is lowercase hex");
    // It did NOT route through the wasm nonce/builder for nonce derivation, but DID build + sign.
    assert.ok(!spends.calls.some((c) => c.fn === "paymentNonce"));
    assert.ok(provider.calls.some((c) => c.method === "signCoinSpends"));
  } finally {
    if (prev !== undefined) globalThis.crypto = prev;
  }
});

test("verifyReceipt: delegates to the wasm verifyPaymentReceipt and returns its verdict", async () => {
  const provider = fakeProvider();
  const spends = spyChip35();
  const paywall = new Paywall(provider, { spends });

  const verdict = await paywall.verifyReceipt({
    observed: { paidToPuzzleHash: OWNER_PH, amount: 500n, asset: { xch: true } },
    owner: OWNER_PH,
    minAmount: 500,
  });

  assert.deepEqual(verdict, { ok: true });
  assert.ok(spends.calls.some((c) => c.fn === "verifyPaymentReceipt"));
});

test("proveAccess({ nft }): delegates to wasm proveNftOwnership", async () => {
  const provider = fakeProvider();
  const spends = spyChip35();
  const paywall = new Paywall(provider, { spends });

  const res = await paywall.proveAccess({
    parentSpend: { coin: {}, puzzle_reveal: "ff", solution: "80" },
    owner: OWNER_PH,
    nft: "44".repeat(32),
  });

  assert.equal(res.ok, true);
  assert.ok(spends.calls.some((c) => c.fn === "proveNftOwnership"));
  assert.ok(!spends.calls.some((c) => c.fn === "proveCollectionMembership"));
});

test("proveAccess({ collection }): delegates to wasm proveCollectionMembership", async () => {
  const provider = fakeProvider();
  const spends = spyChip35();
  const paywall = new Paywall(provider, { spends });

  const res = await paywall.proveAccess({
    parentSpend: { coin: {}, puzzle_reveal: "ff", solution: "80" },
    owner: OWNER_PH,
    collection: "55".repeat(32),
  });

  assert.equal(res.ok, true);
  assert.ok(spends.calls.some((c) => c.fn === "proveCollectionMembership"));
  assert.ok(!spends.calls.some((c) => c.fn === "proveNftOwnership"));
});

test("Paywall NEVER hand-rolls spends: with no wasm builder, requestPayment fails (does not fabricate)", async () => {
  const provider = fakeProvider();
  // A "builder" missing buildPayment — the Paywall must refuse, not assemble a coin spend itself.
  const paywall = new Paywall(provider, { spends: { init() {}, paymentNonce: () => new Uint8Array(32) } });
  await assert.rejects(
    () => paywall.requestPayment({ amount: 1, owner: OWNER_PH }),
    /buildPayment/,
    "must surface that the canonical builder is unavailable rather than hand-roll a spend",
  );
  // It must NOT have pushed any fabricated coin spends to the wallet.
  assert.ok(!provider.calls.some((c) => c.method === "signCoinSpends"));
});
