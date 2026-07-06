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

// ---- #63: dual 'Browser Wallet' vs 'WalletConnect' chooser --------------------------------------
//
// ChiaProvider must never silently pick a wallet when a caller wants to offer the user a choice.
// listConnectors() is the discoverable, side-effect-free enumeration a chooser UI renders from;
// mode: "browser-wallet" is the explicit-preference alias a caller passes once the user picks.

test("listConnectors: surfaces both connectors without connecting to either (no auto-pick)", async () => {
  const fake = fakeInjected({ isDIG: true });
  await withInjected(fake, () => {
    const connectors = ChiaProvider.listConnectors();
    assert.equal(connectors.length, 2);

    const browserWallet = connectors.find((c) => c.id === "browser-wallet");
    const walletConnect = connectors.find((c) => c.id === "walletconnect");
    assert.ok(browserWallet, "browser-wallet connector must be listed");
    assert.ok(walletConnect, "walletconnect connector must be listed");
    assert.equal(browserWallet.backend, "injected");
    assert.equal(browserWallet.label, "Browser Wallet");
    assert.equal(browserWallet.available, true); // window.chia is present
    assert.equal(walletConnect.backend, "walletconnect");
    assert.equal(walletConnect.label, "WalletConnect");
    assert.equal(walletConnect.available, true); // always offered

    // Merely listing connectors must NEVER connect — no auto-pick, no side effects.
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.provider.isConnected, false);
  });
});

test("listConnectors: Browser Wallet is unavailable (but still listed) with no injected provider", async () => {
  const prev = globalThis.chia;
  delete globalThis.chia;
  try {
    const connectors = ChiaProvider.listConnectors();
    const browserWallet = connectors.find((c) => c.id === "browser-wallet");
    const walletConnect = connectors.find((c) => c.id === "walletconnect");
    assert.equal(browserWallet.available, false);
    assert.equal(walletConnect.available, true); // WalletConnect is always available
  } finally {
    if (prev !== undefined) globalThis.chia = prev;
  }
});

test("connect(mode: 'browser-wallet') selects the injected transport (Browser Wallet)", async () => {
  const fake = fakeInjected({
    responses: { chia_getAddress: { address: "xch1chooserbrowser" } },
  });
  await withInjected(fake, async () => {
    const provider = await ChiaProvider.connect({ mode: "browser-wallet" });
    assert.equal(provider.backend, "injected");
    assert.equal(await provider.getAddress(), "xch1chooserbrowser");
  });
});

test("connect(mode: 'browser-wallet') without a wallet throws NO_INJECTED_WALLET", async () => {
  const prev = globalThis.chia;
  delete globalThis.chia;
  try {
    await assert.rejects(
      () => ChiaProvider.connect({ mode: "browser-wallet" }),
      /No injected DIG wallet/,
    );
  } finally {
    if (prev !== undefined) globalThis.chia = prev;
  }
});

test("connect(mode: 'walletconnect') is unaffected by the chooser addition (regression)", async () => {
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
