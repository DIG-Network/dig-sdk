// ChiaProvider transport SELECTION + the CHIP-0002 response normalizers — exercised against a
// mock injected `window.chia`. No relay, no real wallet: we assert the selection policy (prefer
// injected) and that the normalizers tolerate the wallet-specific casing the real Sage / DIG
// Browser return.

import test from "node:test";
import assert from "node:assert/strict";
import { ChiaProvider, isInjectedAvailable } from "../dist/index.js";

// Build a fake injected provider that records calls and returns canned (Sage-shaped) responses.
function fakeInjected({ isDIG = true, responses = {} } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      isDIG,
      isConnected: false,
      async connect() {
        this.isConnected = true;
        return { connected: true };
      },
      async request({ method, params }) {
        calls.push({ method, params });
        if (method in responses) {
          const r = responses[method];
          return typeof r === "function" ? r(params) : r;
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
  };
}

function withInjected(fake, fn) {
  const prev = globalThis.chia;
  globalThis.chia = fake.provider;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete globalThis.chia;
      else globalThis.chia = prev;
    });
}

test("isInjectedAvailable: detects isDIG, ignores plain window.chia by default", async () => {
  await withInjected(fakeInjected({ isDIG: true }), () => {
    assert.equal(isInjectedAvailable(), true);
  });
  await withInjected(fakeInjected({ isDIG: false }), () => {
    assert.equal(isInjectedAvailable(), false); // not a DIG wallet
    assert.equal(isInjectedAvailable({ anyChia: true }), true); // but is a chia provider
  });
});

test("connect(auto): prefers the injected DIG wallet", async () => {
  const fake = fakeInjected({
    responses: { chia_getAddress: { address: "xch1exampleaddr" } },
  });
  await withInjected(fake, async () => {
    const provider = await ChiaProvider.connect({ mode: "auto" });
    assert.equal(provider.backend, "injected");
    assert.equal(provider.session.topic, "injected");
    assert.equal(await provider.getAddress(), "xch1exampleaddr");
  });
});

test("connect(injected) without a wallet throws", async () => {
  const prev = globalThis.chia;
  delete globalThis.chia;
  try {
    await assert.rejects(() => ChiaProvider.connect({ mode: "injected" }), /No injected DIG wallet/);
  } finally {
    if (prev !== undefined) globalThis.chia = prev;
  }
});

test("connect(walletconnect) without options throws a clear error", async () => {
  await assert.rejects(
    () => ChiaProvider.connect({ mode: "walletconnect" }),
    /WalletConnect options are required/,
  );
});

test("signMessage normalizes by-address response (0x-prefixed pubkey)", async () => {
  const fake = fakeInjected({
    responses: {
      chia_getAddress: { address: "xch1addr" },
      chia_signMessageByAddress: {
        public_key: "aa".repeat(48), // snake_case, no 0x — must normalize
        signature: "bb".repeat(96),
      },
    },
  });
  await withInjected(fake, async () => {
    const provider = await ChiaProvider.connect({ mode: "auto" });
    const { publicKey, signature } = await provider.signMessage("hello");
    assert.equal(publicKey, "0x" + "aa".repeat(48));
    assert.equal(signature, "bb".repeat(96));
    // by-address was used (injected supports it), so the fallback method was never called
    assert.ok(fake.calls.some((c) => c.method === "chia_signMessageByAddress"));
    assert.ok(!fake.calls.some((c) => c.method === "chip0002_signMessage"));
  });
});

test("signCoinSpends returns the aggregated signature, tolerant of casing", async () => {
  const fake = fakeInjected({
    responses: { chip0002_signCoinSpends: { aggregated_signature: "cc".repeat(96) } },
  });
  await withInjected(fake, async () => {
    const provider = await ChiaProvider.connect({ mode: "auto" });
    const sig = await provider.signCoinSpends([{ coin: {}, puzzle_reveal: "00", solution: "00" }]);
    assert.equal(sig, "cc".repeat(96));
    const call = fake.calls.find((c) => c.method === "chip0002_signCoinSpends");
    assert.equal(call.params.partialSign, true); // the proven partialSign path
  });
});

test("getXchBalance normalizes a mojo balance to a string", async () => {
  const fake = fakeInjected({
    responses: { chip0002_getAssetBalance: { confirmed: 1234567890 } },
  });
  await withInjected(fake, async () => {
    const provider = await ChiaProvider.connect({ mode: "auto" });
    assert.equal(await provider.getXchBalance(), "1234567890");
  });
});
