// dig-node's miss contract, client side (dig_ecosystem#2188).
//
// FIXTURE PROVENANCE. Every frame under test is loaded from `conformance/miss-contract.json`, which
// is transcribed field-for-field from dig-node's own `redirect_error_object()` and its own assertion
// (`redirect_error_object_names_code_providers_depth_and_cap`). It is deliberately NOT a shape this
// test file authors: a mock that both encodes and decodes the same assumption proves only that the
// assumption is self-consistent. The one thing this cannot catch is the node changing its shape, so
// the fixture carries a source citation for the next reader to diff against.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MISS_RPC_CODES,
  REDIRECT_HOP_CAP,
  MISS_BACKOFF_BASE_MS,
  MISS_RATE_LIMIT_SCOPE,
  RedirectBudget,
  classifyMissError,
  parseMissRedirect,
  missBackoffMs,
} from "../dist/index.js";

const FRAMES = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../conformance/miss-contract.json", import.meta.url),
    ),
    "utf8",
  ),
);

// ---------------------------------------------------------------------------
// The codes, pinned to the numbers dig-rpc-protocol 0.10.1 publishes.
// ---------------------------------------------------------------------------

test("the miss codes are pinned to the published taxonomy numbers", () => {
  assert.equal(MISS_RPC_CODES.CONTENT_MISS_RATE_LIMITED, -32003);
  assert.equal(MISS_RPC_CODES.CONTENT_REDIRECT, -32008);
  assert.equal(MISS_RPC_CODES.CONTENT_MISS_INCONCLUSIVE, -32017);
  assert.equal(MISS_RPC_CODES.RESOURCE_UNAVAILABLE, -32004);
});

test("the client hop cap equals dig-node's REDIRECT_HOP_CAP", () => {
  // dig-node/crates/dig-node-core/src/download.rs: `pub const REDIRECT_HOP_CAP: u64 = 4`.
  assert.equal(REDIRECT_HOP_CAP, 4);
  // ...and the node's own frame advertises exactly that, so the two genuinely agree on the wire
  // rather than merely agreeing with this file.
  assert.equal(FRAMES.redirect.data.redirect.max_redirects, REDIRECT_HOP_CAP);
});

// ---------------------------------------------------------------------------
// Classification — the four codes carry different instructions and must not merge.
// ---------------------------------------------------------------------------

test("each real node frame classifies as its own kind", () => {
  assert.equal(classifyMissError(FRAMES.redirect), "redirect");
  assert.equal(classifyMissError(FRAMES.rate_limited), "rate-limited");
  assert.equal(classifyMissError(FRAMES.inconclusive), "inconclusive");
  assert.equal(classifyMissError(FRAMES.not_found), "not-found");
});

test("the four kinds are DISTINCT — a client can act on the difference", () => {
  // The bug this pins: collapsing the contract into one "miss" bucket. That is exactly what makes a
  // client hammer a node that asked it to stop, or report "not found" for content that is merely
  // momentarily unreachable. Four frames must yield four answers.
  const kinds = [
    FRAMES.redirect,
    FRAMES.rate_limited,
    FRAMES.inconclusive,
    FRAMES.not_found,
  ].map(classifyMissError);
  assert.equal(
    new Set(kinds).size,
    4,
    `expected 4 distinct kinds, got ${kinds}`,
  );
});

test("a non-miss error is not claimed by the miss contract", () => {
  assert.equal(classifyMissError({ code: -32601, message: "no method" }), null);
  assert.equal(classifyMissError({ code: -32000 }), null);
  assert.equal(classifyMissError(null), null);
  assert.equal(classifyMissError(undefined), null);
  assert.equal(classifyMissError({}), null);
  // A code arriving as a STRING is not the numeric code the taxonomy defines.
  assert.equal(classifyMissError({ code: "-32008" }), null);
});

// ---------------------------------------------------------------------------
// Decoding the real -32008 payload.
// ---------------------------------------------------------------------------

test("the real -32008 frame decodes to its peer id AND its candidate addresses", () => {
  const r = parseMissRedirect(FRAMES.redirect);
  assert.ok(r, "the real node frame must decode");
  assert.equal(r.providers.length, 1);
  // BOTH: the contract carries a peer id and the addresses to reach it. A client that read only one
  // of the two could not act on the redirect at all.
  assert.equal(
    r.providers[0].peerId,
    FRAMES.redirect.data.redirect.providers[0].peer_id,
  );
  assert.deepEqual(r.providers[0].addresses, [
    { host: "10.0.0.7", port: 9444, kind: "direct" },
  ]);
  assert.equal(r.redirectDepth, 2);
  assert.equal(r.maxRedirects, 4);
});

test("only a -32008 yields a redirect payload", () => {
  assert.equal(parseMissRedirect(FRAMES.rate_limited), null);
  assert.equal(parseMissRedirect(FRAMES.inconclusive), null);
  assert.equal(parseMissRedirect(FRAMES.not_found), null);
  // A -32008 with no readable payload is not a usable redirect.
  assert.equal(parseMissRedirect({ code: -32008 }), null);
  assert.equal(parseMissRedirect({ code: -32008, data: {} }), null);
});

test("a hostile redirect payload degrades field by field, never throws", () => {
  const hostile = {
    code: -32008,
    data: {
      redirect: {
        providers: [
          { peer_id: "", addresses: [] }, // no id — unusable, dropped
          { addresses: [{ host: "h", port: 1 }] }, // no id — dropped
          {
            peer_id: "good",
            addresses: [
              { host: "ok", port: 9444, kind: "direct" },
              { host: "", port: 9444 }, // no host — dropped
              { host: "h", port: 0 }, // port below range — dropped
              { host: "h", port: 65536 }, // port above range — dropped
              { host: "h", port: 1.5 }, // non-integer — dropped
              { host: "h", port: "9444" }, // string port — dropped
            ],
          },
        ],
        redirect_depth: -1, // negative is not a hop count
        max_redirects: "lots", // not a number
      },
    },
  };
  const r = parseMissRedirect(hostile);
  assert.ok(r);
  assert.equal(r.providers.length, 1, "only the one usable provider survives");
  assert.equal(r.providers[0].peerId, "good");
  assert.deepEqual(r.providers[0].addresses, [
    { host: "ok", port: 9444, kind: "direct" },
  ]);
  assert.equal(
    r.redirectDepth,
    0,
    "an unreadable depth reads as zero consumed",
  );
  assert.equal(
    r.maxRedirects,
    REDIRECT_HOP_CAP,
    "an unreadable cap falls back to the client's own ceiling",
  );
});

// ---------------------------------------------------------------------------
// THE BOUND. This is the load-bearing group: a redirect cycle must terminate.
// ---------------------------------------------------------------------------

test("a REDIRECT CYCLE terminates — the client counts its own hops", () => {
  // The nearest wrong implementation advances only when the SERVED redirect_depth advances. This
  // fixture is built to distinguish the two: a ring of nodes that each answer a well-formed -32008
  // carrying `redirect_depth: 0`. Against the wrong version this loop never ends; against a client
  // that counts its own hops it ends in at most REDIRECT_HOP_CAP steps.
  const cycle = {
    code: -32008,
    data: {
      redirect: {
        providers: [{ peer_id: "ring", addresses: [] }],
        redirect_depth: 0,
        max_redirects: REDIRECT_HOP_CAP,
      },
    },
  };
  const budget = new RedirectBudget();
  let followed = 0;
  // Hard iteration ceiling so a REGRESSION FAILS rather than hanging the suite: a test that hangs
  // on regression is not a proof, it is a timeout.
  for (let guard = 0; guard < 1000; guard++) {
    const next = budget.advance(parseMissRedirect(cycle));
    if (next === null) break;
    followed++;
  }
  assert.equal(
    followed,
    REDIRECT_HOP_CAP - 1,
    "a depth-0 ring is followed a bounded number of times and then abandoned",
  );
  assert.equal(budget.used, REDIRECT_HOP_CAP);
});

test("the bound is pinned from BOTH sides — under it follows, at it stops", () => {
  const at = (depth) => ({
    providers: [],
    redirectDepth: depth,
    maxRedirects: REDIRECT_HOP_CAP,
  });
  // `redirect_depth` counts hops ALREADY CONSUMED, so the cap is reached when it EQUALS the cap --
  // matching dig-node, which answers the plain not-found only once a request is at or over
  // REDIRECT_HOP_CAP. The last PERMITTED hop is therefore `cap - 1`, and it must still be followed:
  // stopping there would silently spend one fewer hop than the contract allows.
  assert.equal(
    new RedirectBudget().advance(at(REDIRECT_HOP_CAP - 1)),
    REDIRECT_HOP_CAP - 1,
    "the last permitted hop is still followed",
  );
  // AT the cap it stops. A bound tested only from below can only confirm itself.
  assert.equal(
    new RedirectBudget().advance(at(REDIRECT_HOP_CAP)),
    null,
    "a request already at the cap is not redirected again",
  );
  // OVER the cap it stops too.
  assert.equal(new RedirectBudget().advance(at(REDIRECT_HOP_CAP + 100)), null);
});

test("a node cannot RAISE the client's hop ceiling, only lower it", () => {
  // A hostile node advertising a huge budget must not buy itself more hops. The client's own cap
  // wins; the peer's number is only ever a request for less.
  const greedy = {
    providers: [],
    redirectDepth: 0,
    maxRedirects: 1_000_000,
  };
  const budget = new RedirectBudget();
  let followed = 0;
  for (let guard = 0; guard < 1000; guard++) {
    if (budget.advance(greedy) === null) break;
    followed++;
  }
  assert.equal(
    followed,
    REDIRECT_HOP_CAP - 1,
    "an advertised million-hop budget is confined to the client's cap",
  );

  // ...and the lowering direction genuinely works: a node asking for one hop gets one.
  const modest = { providers: [], redirectDepth: 0, maxRedirects: 1 };
  assert.equal(
    new RedirectBudget().advance(modest),
    null,
    "a node advertising a 1-hop budget is respected downward",
  );
});

test("the served depth can push the budget FORWARD but never backward", () => {
  const budget = new RedirectBudget();
  // A node reporting hop 2 jumps the client straight to 2 — it may not rewind to 1.
  assert.equal(
    budget.advance({ providers: [], redirectDepth: 2, maxRedirects: 4 }),
    2,
  );
  // A node then claiming hop 0 cannot undo that; the client's own counter still advances.
  assert.equal(
    budget.advance({ providers: [], redirectDepth: 0, maxRedirects: 4 }),
    3,
  );
  assert.equal(
    budget.advance({ providers: [], redirectDepth: 0, maxRedirects: 4 }),
    null,
    "the cap is reached regardless of what the peer claims",
  );
});

// ---------------------------------------------------------------------------
// -32003 back-off.
// ---------------------------------------------------------------------------

test("-32003 scopes the back-off to the NODE, not the content", () => {
  // dig-node's MissRateLimiter is a per-REQUESTOR bucket on that node's miss-lookup path, so the
  // refusal says nothing about the resource. Scoping it to the content would blacklist content that
  // was never unavailable.
  assert.equal(MISS_RATE_LIMIT_SCOPE, "node");
});

test("the back-off starts at the node's own refill period and grows", () => {
  // dig-node publishes DEFAULT_MISS_LOOKUP_REFILL_PER_SEC = 4, i.e. one token per 250 ms. A first
  // wait shorter than that guarantees a second refusal.
  assert.equal(MISS_BACKOFF_BASE_MS, 250);
  assert.equal(missBackoffMs(0), 250);
  assert.equal(missBackoffMs(1), 500);
  assert.equal(missBackoffMs(2), 1000);
  // Bounded: it does not grow without limit however many refusals arrive.
  assert.equal(missBackoffMs(3), missBackoffMs(99));
  // Junk attempt counts do not produce NaN or negative waits.
  for (const bad of [-1, NaN, Infinity, undefined]) {
    const ms = missBackoffMs(bad);
    assert.ok(Number.isFinite(ms) && ms >= MISS_BACKOFF_BASE_MS, `bad=${bad}`);
  }
});

test("the -32003 frame really does carry no interval — the client must supply one", () => {
  // Recorded as a test because it is the reason MISS_BACKOFF_BASE_MS has to be derived at all: if
  // the node ever starts stating a retry interval, this fails and the client should prefer it.
  assert.equal(FRAMES.rate_limited.data, undefined);
});
