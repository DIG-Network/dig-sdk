// The WalletConnect→Sage request path — the double-prompt safety boundary at runtime. These tests
// drive a mock SignClient through the transport's `request` loop to prove the three guarantees the
// production code makes (walletconnect.ts:152-199):
//
//   1. a per-request response timeout fires when Sage never answers (a backgrounded mobile wallet
//      can hang forever), surfacing WALLET_TIMEOUT and NOT hanging;
//   2. only a TRANSIENT relay-publish failure (the request never reached Sage) is retried, up to
//      3 attempts — so a genuine send is never re-issued and the user is never double-prompted;
//   3. a wallet/user rejection (or a response timeout) throws immediately, issuing exactly ONE
//      request to the wallet.
//
// `WalletConnectTransport`'s constructor is `private` in TypeScript only — at runtime it is an
// ordinary constructor, so we build an instance directly with a mock client instead of standing up
// the real relay-backed SignClient.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { WalletConnectTransport } from "../dist/index.js";

const TOPIC = "topic-abc";
const CHAIN = "chia:mainnet";
const SIGN_METHOD = "chip0002_signMessageByAddress";

/** Build a mock SignClient whose session grants `methods` and whose `request` runs `impl`. */
function mockClient({ methods = [], request }) {
  const session = { topic: TOPIC, namespaces: { chia: { methods } } };
  return {
    session: {
      get: () => session,
      getAll: () => [session],
    },
    request,
    disconnect: mock.fn(async () => {}),
  };
}

/** Construct a transport around a mock client (private ctor is compile-time only). */
function transportWith(client, timeoutMs = 60_000) {
  return new WalletConnectTransport(client, { topic: TOPIC }, CHAIN, timeoutMs);
}

test("request resolves with the wallet's response on the happy path", async () => {
  const request = mock.fn(async () => ({ ok: true }));
  const t = transportWith(mockClient({ methods: [SIGN_METHOD], request }));

  assert.deepEqual(await t.request(SIGN_METHOD, { a: 1 }), { ok: true });
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(request.mock.calls[0].arguments[0], {
    topic: TOPIC,
    chainId: CHAIN,
    request: { method: SIGN_METHOD, params: { a: 1 } },
  });
});

test("request throws METHOD_NOT_SUPPORTED without ever reaching the wallet", async () => {
  const request = mock.fn(async () => ({ ok: true }));
  const t = transportWith(mockClient({ methods: ["some_other_method"], request }));

  await assert.rejects(() => t.request(SIGN_METHOD, {}), (e) => {
    assert.equal(e.code, "METHOD_NOT_SUPPORTED");
    return true;
  });
  assert.equal(request.mock.callCount(), 0, "must not prompt a wallet it cannot use");
});

test("supports() treats an empty granted-method list as unknown-but-allowed", () => {
  const t = transportWith(mockClient({ methods: [], request: async () => null }));
  assert.equal(t.supports(SIGN_METHOD), true);
});

test("request times out with WALLET_TIMEOUT when the wallet never answers", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  // A request that never settles — the timeout must win the race.
  const t = transportWith(mockClient({ methods: [], request: () => new Promise(() => {}) }), 5_000);

  const pending = t.request(SIGN_METHOD, {});
  const assertion = assert.rejects(() => pending, (e) => {
    assert.equal(e.code, "WALLET_TIMEOUT");
    return true;
  });
  ctx.mock.timers.tick(5_000);
  await assertion;
});

test("request retries ONLY a transient relay-publish failure, then succeeds", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  let attempt = 0;
  const request = mock.fn(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("Failed or timed out to publish payload");
    return "signed";
  });
  const t = transportWith(mockClient({ methods: [], request }));

  const pending = t.request(SIGN_METHOD, {});
  await drainTimers(ctx);
  assert.equal(await pending, "signed");
  assert.equal(request.mock.callCount(), 2, "retried the transient publish failure exactly once");
});

test("request exhausts 3 attempts on repeated transient failures, then throws", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const request = mock.fn(async () => {
    throw new Error("WebSocket connection failed");
  });
  const t = transportWith(mockClient({ methods: [], request }));

  const pending = t.request(SIGN_METHOD, {});
  const assertion = assert.rejects(() => pending, /WebSocket connection failed/);
  await drainTimers(ctx);
  await assertion;
  assert.equal(request.mock.callCount(), 3, "MAX_ATTEMPTS = 3");
});

test("request never re-issues a user rejection — no double prompt", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const request = mock.fn(async () => {
    throw new Error("User rejected the request");
  });
  const t = transportWith(mockClient({ methods: [], request }));

  await assert.rejects(() => t.request(SIGN_METHOD, {}), /User rejected/);
  assert.equal(request.mock.callCount(), 1, "a rejection reaches the wallet exactly once");
});

test("disconnect is best-effort and swallows client errors", async () => {
  const client = mockClient({ methods: [], request: async () => null });
  const t = transportWith(client);
  await t.disconnect();
  assert.equal(client.disconnect.mock.callCount(), 1);

  const failing = mockClient({ methods: [], request: async () => null });
  failing.disconnect = mock.fn(async () => {
    throw new Error("relay gone");
  });
  await assert.doesNotReject(() => transportWith(failing).disconnect());
});

// Flush microtasks and advance the mocked clock repeatedly so the retry loop progresses through its
// inter-attempt back-off sleeps without waiting on real wall-clock time.
async function drainTimers(ctx) {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    ctx.mock.timers.tick(5_000);
  }
  await Promise.resolve();
}
