// The §5.3 client→node resolution ladder (#2134). These tests drive the PURE resolver with an
// INJECTED fake probe, so precedence + probe-timeout fall-through + caching are asserted
// deterministically with no sockets. Ladder order: explicit › DIG_NODE_URL › dig.local › localhost
// › rpc.dig.net (gateway terminal); the browser build skips the local rungs.

import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveNodeEndpoint,
  makeHealthProbe,
  isBrowserEnv,
  readEnvNodeUrl,
  NODE_LADDER,
  DIG_LOCAL_URL,
  LOOPBACK_URL,
  GATEWAY_URL,
} from "../dist/index.js";

const NEVER = async () => false; // every rung is a non-answer
const ALWAYS = async () => true; // every rung answers
const answersAt = (wanted) => async (url) => url === wanted;

test("explicit endpoint wins outright and skips probing", async () => {
  let probed = false;
  const r = await resolveNodeEndpoint({
    explicit: "https://my.node.example",
    env: "https://ignored.example",
    isBrowser: false,
    probe: async () => {
      probed = true;
      return true;
    },
    timeoutMs: 5,
  });
  assert.deepEqual(r, { url: "https://my.node.example", via: "explicit" });
  assert.equal(probed, false, "an explicit endpoint must not probe the ladder");
});

test("DIG_NODE_URL wins over the auto ladder (but not over explicit)", async () => {
  let probed = false;
  const r = await resolveNodeEndpoint({
    env: "https://env.node.example",
    isBrowser: false,
    probe: async () => {
      probed = true;
      return true;
    },
    timeoutMs: 5,
  });
  assert.deepEqual(r, { url: "https://env.node.example", via: "env" });
  assert.equal(probed, false, "an env override must not probe the ladder");
});

test("blank explicit/env fall through to the probed ladder", async () => {
  const r = await resolveNodeEndpoint({
    explicit: "   ",
    env: "",
    isBrowser: false,
    probe: answersAt(DIG_LOCAL_URL),
    timeoutMs: 5,
  });
  assert.equal(r.via, "dig.local");
});

test("dig.local is tried before localhost before the gateway", async () => {
  const order = [];
  const probe = async (url) => {
    order.push(url);
    return false;
  };
  await resolveNodeEndpoint({ isBrowser: false, probe, timeoutMs: 5 });
  // The gateway is terminal — never probed — so only the two local rungs are, in ladder order.
  assert.deepEqual(order, [DIG_LOCAL_URL, LOOPBACK_URL]);
});

test("dig.local answering wins (localhost + gateway not consulted)", async () => {
  const r = await resolveNodeEndpoint({
    isBrowser: false,
    probe: ALWAYS,
    timeoutMs: 5,
  });
  assert.deepEqual(r, { url: DIG_LOCAL_URL, via: "dig.local" });
});

test("dig.local down → localhost answers → localhost wins", async () => {
  const r = await resolveNodeEndpoint({
    isBrowser: false,
    probe: answersAt(LOOPBACK_URL),
    timeoutMs: 5,
  });
  assert.deepEqual(r, { url: LOOPBACK_URL, via: "localhost" });
});

test("no local node answers → gateway is the terminal fallback", async () => {
  const r = await resolveNodeEndpoint({
    isBrowser: false,
    probe: NEVER,
    timeoutMs: 5,
  });
  assert.deepEqual(r, { url: GATEWAY_URL, via: "gateway" });
});

test("a probe that THROWS/times out falls through, never aborts the ladder", async () => {
  // dig.local rejects (a timeout/abort/connection error); localhost answers → localhost wins.
  const probe = async (url) => {
    if (url === DIG_LOCAL_URL) throw new Error("simulated abort/timeout");
    return url === LOOPBACK_URL;
  };
  const r = await resolveNodeEndpoint({
    isBrowser: false,
    probe,
    timeoutMs: 5,
  });
  assert.deepEqual(r, { url: LOOPBACK_URL, via: "localhost" });
});

test("browser: local rungs are skipped — gateway without probing", async () => {
  let probed = false;
  const r = await resolveNodeEndpoint({
    isBrowser: true,
    probe: async () => {
      probed = true;
      return true;
    },
    timeoutMs: 5,
  });
  assert.deepEqual(r, { url: GATEWAY_URL, via: "gateway" });
  assert.equal(probed, false, "the browser build must not probe local rungs");
});

test("browser still honours an explicit endpoint and DIG_NODE_URL", async () => {
  assert.equal(
    (
      await resolveNodeEndpoint({
        explicit: "https://x",
        isBrowser: true,
        probe: NEVER,
        timeoutMs: 5,
      })
    ).via,
    "explicit",
  );
  assert.equal(
    (
      await resolveNodeEndpoint({
        env: "https://y",
        isBrowser: true,
        probe: NEVER,
        timeoutMs: 5,
      })
    ).via,
    "env",
  );
});

test("makeHealthProbe: GET /health, true on 2xx, false otherwise", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.method]);
    return { ok: url.endsWith("/up/health") };
  };
  const probe = makeHealthProbe(fetchImpl);
  assert.equal(await probe("https://up", 50), true);
  assert.equal(await probe("https://down", 50), false);
  assert.deepEqual(calls, [
    ["https://up/health", "GET"],
    ["https://down/health", "GET"],
  ]);
});

test("makeHealthProbe: a trailing slash is normalized (no double slash)", async () => {
  let seen = "";
  const probe = makeHealthProbe(async (url) => {
    seen = url;
    return { ok: true };
  });
  await probe("https://node/", 50);
  assert.equal(seen, "https://node/health");
});

test("readEnvNodeUrl reads DIG_NODE_URL from process.env (trimmed)", () => {
  const prev = process.env.DIG_NODE_URL;
  try {
    process.env.DIG_NODE_URL = "  https://from.env  ";
    assert.equal(readEnvNodeUrl(), "https://from.env");
    delete process.env.DIG_NODE_URL;
    assert.equal(readEnvNodeUrl(), undefined);
  } finally {
    if (prev === undefined) delete process.env.DIG_NODE_URL;
    else process.env.DIG_NODE_URL = prev;
  }
});

test("isBrowserEnv is false under Node (no window/document)", () => {
  assert.equal(isBrowserEnv(), false);
});

test("the ladder is the fixed §5.3 order with the documented endpoints", () => {
  assert.deepEqual(
    NODE_LADDER.map((r) => [r.via, r.url, r.localOnly]),
    [
      ["dig.local", "https://127.0.0.2:443", true],
      ["localhost", "http://localhost:9778", true],
      ["gateway", "https://rpc.dig.net", false],
    ],
  );
});
