// The ChiaProvider surface + the CHIP-0002 response normalizers behind it (src/provider/methods.ts).
// A real wallet returns the same datum in many shapes (0x-prefixed or not, snake_case or camelCase,
// a bare string or a nested object), and the SDK's job is to fold all of them into ONE canonical
// shape. We drive the provider through a mock transport so every tolerant fallback branch is
// exercised without a live wallet, and assert the provider's own behaviour (address caching, the
// sign-by-address→sign-by-key fallback, the connector chooser, the connect() guard errors).

import test from "node:test";
import assert from "node:assert/strict";
import { ChiaProvider, connectWallet } from "../dist/index.js";

/** A WalletTransport stand-in: canned per-method responses + a call log. */
function mockTransport({ responses = {}, supports = () => true } = {}) {
  const calls = [];
  return {
    backend: "injected",
    chain: "chia:mainnet",
    topic: "topic-1",
    supports: typeof supports === "function" ? supports : (m) => supports.includes(m),
    request: async (method, params) => {
      calls.push({ method, params });
      const r = responses[method];
      return typeof r === "function" ? r(params) : r;
    },
    disconnect: async () => {},
    calls,
  };
}

const provider = (opts) => ChiaProvider.fromTransport(mockTransport(opts));

test("getAddress tolerates string / {address} / {data.address} / null and caches", async () => {
  assert.equal(await provider({ responses: { chia_getAddress: "xch1abc" } }).getAddress(), "xch1abc");
  assert.equal(
    await provider({ responses: { chia_getAddress: { address: "xch1nested" } } }).getAddress(),
    "xch1nested",
  );
  assert.equal(
    await provider({ responses: { chia_getAddress: { data: { address: "xch1data" } } } }).getAddress(),
    "xch1data",
  );
  assert.equal(await provider({ responses: { chia_getAddress: {} } }).getAddress(), null);

  const t = mockTransport({ responses: { chia_getAddress: "xch1cached" } });
  const p = ChiaProvider.fromTransport(t);
  await p.getAddress();
  await p.getAddress();
  assert.equal(t.calls.length, 1, "address is fetched once then cached");
  assert.equal(p.session.address, "xch1cached");
});

test("getPublicKeys tolerates array / publicKeys / public_keys / keys / none", async () => {
  const from = (resp) => provider({ responses: { chip0002_getPublicKeys: resp } }).getPublicKeys();
  assert.deepEqual(await from(["0xk"]), ["0xk"]);
  assert.deepEqual(await from({ publicKeys: ["a"] }), ["a"]);
  assert.deepEqual(await from({ public_keys: ["b"] }), ["b"]);
  assert.deepEqual(await from({ keys: ["c"] }), ["c"]);
  assert.deepEqual(await from({}), []);
});

test("signMessage prefers sign-by-address and 0x-normalizes the key", async () => {
  const p = provider({
    supports: ["chia_signMessageByAddress"],
    responses: {
      chia_signMessageByAddress: { public_key: "deadbeef", aggregated_signature: "0xsig" },
    },
  });
  const res = await p.signMessage("hello", "xch1me");
  assert.deepEqual(res, { publicKey: "0xdeadbeef", signature: "0xsig" });
});

test("signMessage falls back to sign-by-key when the by-address method is not granted", async () => {
  const t = mockTransport({
    supports: () => false, // no method granted → fall back to sign-by-public-key
    responses: {
      chip0002_getPublicKeys: ["0xpk0"],
      chip0002_signMessage: "0xbaresig", // a bare-string signature response
    },
  });
  const res = await ChiaProvider.fromTransport(t).signMessage("hi", "xch1me");
  assert.deepEqual(res, { publicKey: "0xpk0", signature: "0xbaresig" });
  assert.ok(t.calls.some((c) => c.method === "chip0002_signMessage"));
});

test("signMessage throws WALLET_NO_KEYS when the fallback wallet has no keys", async () => {
  const p = provider({ supports: () => false, responses: { chip0002_getPublicKeys: [] } });
  await assert.rejects(() => p.signMessage("hi", "xch1me"), (e) => e.code === "WALLET_NO_KEYS");
});

test("signMessage defaults the address to the wallet's own address", async () => {
  const t = mockTransport({
    supports: ["chia_signMessageByAddress"],
    responses: {
      chia_getAddress: "xch1self",
      chia_signMessageByAddress: { signature: "0xs" },
    },
  });
  await ChiaProvider.fromTransport(t).signMessage("msg");
  const signCall = t.calls.find((c) => c.method === "chia_signMessageByAddress");
  assert.equal(signCall.params.address, "xch1self");
});

test("signCoinSpends tolerates string / signature / aggregatedSignature / none", async () => {
  const from = (resp) => provider({ responses: { chip0002_signCoinSpends: resp } }).signCoinSpends([]);
  assert.equal(await from("0xagg"), "0xagg");
  assert.equal(await from({ signature: "0xa" }), "0xa");
  assert.equal(await from({ aggregatedSignature: "0xb" }), "0xb");
  assert.equal(await from({ aggregated_signature: "0xc" }), "0xc");
  assert.equal(await from({}), "");
});

test("takeOffer passes through when supported and throws when not", async () => {
  const ok = provider({ supports: ["chia_takeOffer"], responses: { chia_takeOffer: { id: 1 } } });
  assert.deepEqual(await ok.takeOffer("offer1", 5), { id: 1 });

  const no = provider({ supports: () => false });
  await assert.rejects(() => no.takeOffer("offer1"), (e) => e.code === "METHOD_NOT_SUPPORTED");
});

test("balances fold the many casing shapes into a mojo string, null on absent/invalid", async () => {
  const xch = (resp) => provider({ responses: { chip0002_getAssetBalance: resp } }).getXchBalance();
  assert.equal(await xch({ confirmed: 100 }), "100");
  assert.equal(await xch({ spendable: 200 }), "200");
  assert.equal(await xch({ confirmedWalletBalance: 300 }), "300");
  assert.equal(await xch({ confirmed_wallet_balance: 400 }), "400");
  assert.equal(await xch({ balance: 500 }), "500");
  assert.equal(await xch({ data: { confirmed: 600 } }), "600");
  assert.equal(await xch(700), "700");
  assert.equal(await xch(null), null);
  assert.equal(await xch({ confirmed: "not-a-number" }), null);
});

test("getCatBalance strips a 0x prefix from the asset id it sends the wallet", async () => {
  const t = mockTransport({ responses: { chip0002_getAssetBalance: { confirmed: 42 } } });
  const bal = await ChiaProvider.fromTransport(t).getCatBalance("0xDEADbeef");
  assert.equal(bal, "42");
  const call = t.calls.find((c) => c.method === "chip0002_getAssetBalance");
  assert.equal(call.params.assetId, "deadbeef");
  assert.equal(call.params.type, "cat");
});

test("coin queries tolerate an array or a {coins} envelope, else empty", async () => {
  assert.deepEqual(
    await provider({ responses: { chip0002_getAssetCoins: [{ c: 1 }] } }).getXchCoins(),
    [{ c: 1 }],
  );
  assert.deepEqual(
    await provider({ responses: { chip0002_getAssetCoins: { coins: [{ c: 2 }] } } }).getCatCoins("ab"),
    [{ c: 2 }],
  );
  assert.deepEqual(await provider({ responses: { chip0002_getAssetCoins: null } }).getXchCoins(), []);
});

test("session, backend, supports and the raw request escape hatch reflect the transport", async () => {
  const t = mockTransport({ supports: ["chip0002_getPublicKeys"], responses: { foo: "bar" } });
  const p = ChiaProvider.fromTransport(t);
  assert.equal(p.backend, "injected");
  assert.equal(p.supports("chip0002_getPublicKeys"), true);
  assert.equal(p.supports("nope"), false);
  assert.equal(await p.request("foo"), "bar");
  assert.deepEqual(p.session, {
    backend: "injected",
    chain: "chia:mainnet",
    topic: "topic-1",
    address: null,
  });
  await p.disconnect();
});

test("listConnectors always offers WalletConnect and detects no Browser Wallet in Node", () => {
  const connectors = ChiaProvider.listConnectors();
  const wc = connectors.find((c) => c.id === "walletconnect");
  const bw = connectors.find((c) => c.id === "browser-wallet");
  assert.equal(wc.available, true);
  assert.equal(wc.backend, "walletconnect");
  assert.equal(bw.available, false, "no injected window.chia under node --test");
});

test("connect() surfaces the actionable guard errors without a wallet present", async () => {
  await assert.rejects(
    () => ChiaProvider.connect({ mode: "injected" }),
    (e) => e.code === "NO_INJECTED_WALLET",
  );
  await assert.rejects(
    () => ChiaProvider.connect({ mode: "walletconnect" }),
    (e) => e.code === "WC_OPTIONS_REQUIRED",
  );
  // auto with no injected wallet AND no WalletConnect options falls through to the WC guard.
  await assert.rejects(
    () => connectWallet({ mode: "auto" }),
    (e) => e.code === "WC_OPTIONS_REQUIRED",
  );
});
