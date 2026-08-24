// The miss contract driven through the REAL DigClient read path (dig_ecosystem#2188).
//
// These drive `readVerified` / `read` against an injected `fetch` that answers with the frames in
// `conformance/miss-contract.json` — the shapes transcribed from dig-node's own source — so the
// client's redirect handling is exercised end to end rather than at the pure-decoder layer that
// `miss.test.mjs` already covers.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DigClient,
  DIG_LOCAL_URL,
  GATEWAY_URL,
  LOOPBACK_URL,
  isDigSdkError,
} from "../dist/index.js";

const FRAMES = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../conformance/miss-contract.json", import.meta.url)),
    "utf8",
  ),
);

const STORE = "aa".repeat(32);
const ROOT = "bb".repeat(32);
const URN = `urn:dig:chia:${STORE}:${ROOT}/index.html`;

/** A JSON-RPC error response carrying one of the real node frames. */
const errorBody = (frame) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, error: frame });

/**
 * A success response serving bytes that are NOT bound to the on-chain root — the shape a hostile or
 * simply wrong holder produces. Used to prove the trust gate still runs after a redirect.
 */
const unverifiableBody = () =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      total_length: 4,
      ciphertext: Buffer.from("junk").toString("base64"),
      inclusion_proof: Buffer.from("not-a-proof").toString("base64"),
      chunk_lens: [4],
      complete: true,
      next_offset: null,
      roothash: ROOT,
    },
  });

/**
 * Build an injected fetch from a url -> body-producing map, recording every endpoint asked, in
 * order. `/health` probes answer for the local rung only, so the ladder resolves to `dig.local` and
 * the gateway is its successor.
 */
function harness(routes) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/health")) {
      return { ok: String(url).startsWith(DIG_LOCAL_URL), status: 200 };
    }
    asked.push(String(url));
    const body = routes[String(url)];
    assert.ok(body, `unexpected endpoint asked: ${url}`);
    const text = typeof body === "function" ? body(init) : body;
    return {
      ok: true,
      status: 200,
      body: null, // no ReadableStream: exercises the platform-parse fallback
      json: async () => JSON.parse(text),
    };
  };
  return { asked, fetchImpl };
}

const client = (fetchImpl, extra = {}) =>
  new DigClient({
    fetch: fetchImpl,
    isBrowser: false,
    // Instant back-off so a -32003 path costs no wall-clock time.
    sleep: async () => {},
    ...extra,
  });

// ---------------------------------------------------------------------------
// THE TRUST BOUNDARY. A redirect must not become a way to skip verification.
// ---------------------------------------------------------------------------

test("content served AFTER a redirect is still trust-gated, exactly as a first-hop answer is", async () => {
  // Redirected leg: dig.local misses with the real -32008, the gateway then serves unverifiable
  // bytes. NC-12 says the redirect target is a hint, not an authority — so these bytes must be
  // refused for exactly the same reason they would be refused without any redirect.
  const redirected = harness({
    [DIG_LOCAL_URL]: errorBody(FRAMES.redirect),
    // The rung AFTER dig.local is the loopback node, not the gateway (NODE_LADDER order).
    [LOOPBACK_URL]: unverifiableBody(),
  });
  const viaRedirect = await client(redirected.fetchImpl)
    .readVerified({ urn: URN })
    .then(
      () => null,
      (e) => e,
    );

  // CONTROL: the same unverifiable bytes served directly by the first node, no redirect involved.
  // Without this control the test could pass on a redirect-specific failure that has nothing to do
  // with verification, and would prove nothing about the trust gate.
  const direct = harness({ [DIG_LOCAL_URL]: unverifiableBody() });
  const viaDirect = await client(direct.fetchImpl)
    .readVerified({ urn: URN })
    .then(
      () => null,
      (e) => e,
    );

  assert.ok(viaRedirect, "redirected read must NOT return bytes");
  assert.ok(viaDirect, "the control read must NOT return bytes either");
  assert.ok(isDigSdkError(viaRedirect), `coded error expected, got ${viaRedirect}`);
  assert.equal(
    viaRedirect.code,
    viaDirect.code,
    "the redirect path must fail for the SAME reason as the direct path — a different code would mean a different, weaker path",
  );

  // ...and the redirect genuinely happened: the second node really was asked. Without this the
  // assertions above would hold vacuously if the client had refused before ever redirecting.
  assert.deepEqual(redirected.asked, [DIG_LOCAL_URL, LOOPBACK_URL]);
});

// ---------------------------------------------------------------------------
// §5.3 — an explicitly-configured node is never routed around.
// ---------------------------------------------------------------------------

test("an explicit endpoint is NOT routed around on a miss — the user's choice survives", async () => {
  const EXPLICIT = "https://my.node.example";
  const { asked, fetchImpl } = harness({
    [EXPLICIT]: errorBody(FRAMES.redirect),
  });
  const err = await client(fetchImpl, { rpc: EXPLICIT })
    .readVerified({ urn: URN })
    .then(
      () => null,
      (e) => e,
    );

  assert.ok(isDigSdkError(err));
  assert.equal(err.code, "CONTENT_NO_REACHABLE_HOLDER");
  // The load-bearing assertion: the gateway was never contacted. A client that silently fell back
  // would leak the read to a host the user deliberately did not choose.
  assert.deepEqual(
    asked,
    [EXPLICIT],
    "only the explicitly-configured node may be asked",
  );
});

// ---------------------------------------------------------------------------
// What the user is told when a miss cannot be recovered.
// ---------------------------------------------------------------------------

test("an unrecoverable redirect says the content EXISTS but is unreachable — never not-found", async () => {
  const { fetchImpl } = harness({
    [DIG_LOCAL_URL]: errorBody(FRAMES.redirect),
    [LOOPBACK_URL]: errorBody(FRAMES.redirect),
    [GATEWAY_URL]: errorBody(FRAMES.redirect),
  });
  const err = await client(fetchImpl)
    .readVerified({ urn: URN })
    .then(
      () => null,
      (e) => e,
    );

  assert.ok(isDigSdkError(err, "CONTENT_NO_REACHABLE_HOLDER"));
  // The holders the node named are handed out, so a node-class caller that CAN dial the peer
  // protocol still receives them rather than losing them at this boundary.
  assert.equal(err.context.providers.length, 1);
  assert.equal(
    err.context.providers[0].peerId,
    FRAMES.redirect.data.redirect.providers[0].peer_id,
  );
  assert.equal(err.context.retryable, true);
  assert.doesNotMatch(
    err.message,
    /not found|does not exist|no such/i,
    "a redirected miss must never be reported as absence",
  );
});

test("-32017 is reported as UNKNOWN availability, not as absence", async () => {
  const { fetchImpl } = harness({
    [DIG_LOCAL_URL]: errorBody(FRAMES.inconclusive),
    [LOOPBACK_URL]: errorBody(FRAMES.inconclusive),
    [GATEWAY_URL]: errorBody(FRAMES.inconclusive),
  });
  const err = await client(fetchImpl)
    .readVerified({ urn: URN })
    .then(
      () => null,
      (e) => e,
    );
  assert.ok(isDigSdkError(err, "CONTENT_AVAILABILITY_UNKNOWN"));
  assert.equal(err.context.retryable, true);
});

test("-32004 is settled — it stops immediately and does not walk the ladder", async () => {
  const { asked, fetchImpl } = harness({
    [DIG_LOCAL_URL]: errorBody(FRAMES.not_found),
  });
  await client(fetchImpl)
    .readVerified({ urn: URN })
    .then(
      () => null,
      (e) => e,
    );
  // A settled not-found is the node's final answer; re-asking every other rung would be pure
  // fan-out for a question already answered.
  assert.deepEqual(asked, [DIG_LOCAL_URL]);
});

// ---------------------------------------------------------------------------
// -32003 back-off.
// ---------------------------------------------------------------------------

test("-32003 is waited out against the SAME node before any other rung is tried", async () => {
  let attempts = 0;
  const { asked, fetchImpl } = harness({
    [DIG_LOCAL_URL]: () => {
      attempts += 1;
      // Refuse twice, then serve. A client that treated -32003 as "move on" would never see the
      // third attempt, and a client that treated it as fatal would never retry at all.
      return attempts <= 2 ? errorBody(FRAMES.rate_limited) : unverifiableBody();
    },
    [LOOPBACK_URL]: unverifiableBody(),
    [GATEWAY_URL]: unverifiableBody(),
  });
  await client(fetchImpl)
    .read({ urn: URN })
    .then(
      () => null,
      (e) => e,
    );

  assert.equal(attempts, 3, "the refusing node is re-asked after backing off");
  assert.deepEqual(
    asked,
    [DIG_LOCAL_URL, DIG_LOCAL_URL, DIG_LOCAL_URL],
    "a rate-limit refusal must not fan out to another node — that answers 'slow down' with more load",
  );
});

test("a node that never stops rate-limiting is abandoned, and says so truthfully", async () => {
  const { fetchImpl } = harness({
    [DIG_LOCAL_URL]: errorBody(FRAMES.rate_limited),
    [LOOPBACK_URL]: errorBody(FRAMES.rate_limited),
    [GATEWAY_URL]: errorBody(FRAMES.rate_limited),
  });
  const err = await client(fetchImpl)
    .readVerified({ urn: URN })
    .then(
      () => null,
      (e) => e,
    );
  assert.ok(isDigSdkError(err, "CONTENT_MISS_RATE_LIMITED"));
  // Scoped to the node, so a caller knows the CONTENT was never the problem.
  assert.equal(err.context.scope, "node");
  assert.equal(err.context.retryable, true);
});
