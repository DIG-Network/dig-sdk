// DigClient wired to the §5.3 ladder (#2134): a client with no explicit `rpc` resolves the endpoint
// through the ladder (local node preferred), memoizes it per instance, and lets a per-call
// `opts.rpc` still override. The probe is injected so these are deterministic + network-free.

import test from "node:test";
import assert from "node:assert/strict";
import { DigClient, DIG_LOCAL_URL, GATEWAY_URL } from "../dist/index.js";

test("no explicit rpc → resolves via the ladder (dig.local when it answers)", async () => {
  const dig = new DigClient({
    isBrowser: false,
    nodeProbe: async (url) => url === DIG_LOCAL_URL,
  });
  assert.deepEqual(await dig.resolveEndpoint(), {
    url: DIG_LOCAL_URL,
    via: "dig.local",
  });
});

test("no local node answers → gateway is the terminal fallback", async () => {
  const dig = new DigClient({ isBrowser: false, nodeProbe: async () => false });
  assert.deepEqual(await dig.resolveEndpoint(), {
    url: GATEWAY_URL,
    via: "gateway",
  });
});

test("explicit rpc overrides the ladder and never probes", async () => {
  let probed = false;
  const dig = new DigClient({
    rpc: "https://explicit.example",
    isBrowser: false,
    nodeProbe: async () => {
      probed = true;
      return true;
    },
  });
  const r = await dig.resolveEndpoint();
  assert.deepEqual(r, { url: "https://explicit.example", via: "explicit" });
  assert.equal(probed, false);
});

test("resolution is memoized — the ladder is probed exactly once per instance", async () => {
  let probeCalls = 0;
  const dig = new DigClient({
    isBrowser: false,
    nodeProbe: async () => {
      probeCalls += 1;
      return false; // fall all the way through to the gateway each time it IS probed
    },
  });
  await dig.resolveEndpoint();
  await dig.resolveEndpoint();
  await dig.resolveEndpoint();
  // Two local rungs probed on the first resolve; zero on the cached subsequent calls.
  assert.equal(probeCalls, 2, "endpoint must resolve once and be reused");
});
