// Tests for the typed error taxonomy (#92 agent-friendly polish). Every failure the SDK surfaces is
// a DigSdkError with a STABLE `.code` (UPPER_SNAKE) so an agent can branch on it instead of
// string-matching prose. These tests pin: (1) the catalogue shape, (2) that the public surfaces
// throw coded errors (not bare Error) for the documented failure paths.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DigSdkError,
  DIG_SDK_ERROR_CODES,
  isDigSdkError,
  DigClient,
  ChiaProvider,
  Paywall,
  parseUrn,
  capabilities,
} from "../dist/index.js";

test("DigSdkError carries a stable code + context and is an Error", () => {
  const e = new DigSdkError("ROOT_REQUIRED", "need a root", { value: "x" });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof DigSdkError);
  assert.equal(e.name, "DigSdkError");
  assert.equal(e.code, "ROOT_REQUIRED");
  assert.equal(e.context.value, "x");
  assert.deepEqual(e.toJSON(), {
    code: "ROOT_REQUIRED",
    message: "need a root",
    context: { value: "x" },
  });
});

test("isDigSdkError narrows by code", () => {
  const e = new DigSdkError("RPC_TRANSPORT", "down");
  assert.ok(isDigSdkError(e));
  assert.ok(isDigSdkError(e, "RPC_TRANSPORT"));
  assert.ok(!isDigSdkError(e, "RPC_ERROR"));
  assert.ok(!isDigSdkError(new Error("plain")));
});

test("DIG_SDK_ERROR_CODES codes are UPPER_SNAKE and self-keyed", () => {
  const codes = Object.entries(DIG_SDK_ERROR_CODES);
  assert.ok(
    codes.length >= 15,
    "the catalogue should cover every failure class",
  );
  for (const [k, v] of codes) {
    assert.equal(k, v, `code value must equal its key (${k})`);
    assert.match(v, /^[A-Z][A-Z0-9_]*$/, `${v} must be UPPER_SNAKE`);
  }
  // The catalogue advertised via capabilities() matches the const exactly.
  assert.deepEqual(
    [...capabilities().errorCodes].sort(),
    Object.values(DIG_SDK_ERROR_CODES).sort(),
  );
});

// ---- DigClient: read-crypto / RPC coded errors ----

test("DigClient.read without a root throws ROOT_REQUIRED", async () => {
  const dig = new DigClient();
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${"ab".repeat(32)}/index.html` }),
    (e) => isDigSdkError(e, "ROOT_REQUIRED"),
  );
});

test("DigClient RPC transport failure throws RPC_TRANSPORT with rpcMethod context", async () => {
  const dig = new DigClient({
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(
    () =>
      dig.read({
        urn: `urn:dig:chia:${"ab".repeat(32)}/index.html`,
        root: "cd".repeat(32),
      }),
    (e) =>
      isDigSdkError(e, "RPC_TRANSPORT") &&
      e.context.rpcMethod === "dig.getContent",
  );
});

test("DigClient RPC HTTP error throws RPC_ERROR with httpStatus", async () => {
  const dig = new DigClient({
    fetch: async () => ({
      ok: false,
      status: 503,
      async json() {
        return {};
      },
    }),
  });
  await assert.rejects(
    () =>
      dig.read({
        urn: `urn:dig:chia:${"ab".repeat(32)}/index.html`,
        root: "cd".repeat(32),
      }),
    (e) => isDigSdkError(e, "RPC_ERROR") && e.context.httpStatus === 503,
  );
});

test("DigClient JSON-RPC error throws RPC_ERROR carrying the server message", async () => {
  const dig = new DigClient({
    fetch: async () => ({
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "boom" },
        };
      },
    }),
  });
  await assert.rejects(
    () =>
      dig.read({
        urn: `urn:dig:chia:${"ab".repeat(32)}/index.html`,
        root: "cd".repeat(32),
      }),
    (e) => isDigSdkError(e, "RPC_ERROR") && e.context.rpcCode === -32000,
  );
});

// ---- provider/connect coded errors ----

test("ChiaProvider.connect mode=injected with no wallet throws NO_INJECTED_WALLET", async () => {
  await assert.rejects(
    () => ChiaProvider.connect({ mode: "injected" }),
    (e) => isDigSdkError(e, "NO_INJECTED_WALLET"),
  );
});

test("ChiaProvider.connect mode='browser-wallet' (chooser alias) with no wallet throws NO_INJECTED_WALLET", async () => {
  await assert.rejects(
    () => ChiaProvider.connect({ mode: "browser-wallet" }),
    (e) => isDigSdkError(e, "NO_INJECTED_WALLET"),
  );
});

test("ChiaProvider.connect mode=walletconnect without options throws WC_OPTIONS_REQUIRED", async () => {
  await assert.rejects(
    () => ChiaProvider.connect({ mode: "walletconnect" }),
    (e) => isDigSdkError(e, "WC_OPTIONS_REQUIRED"),
  );
});

// ---- paywall coded errors ----

test("Paywall.requestPayment without a builder throws SPEND_BUILDER_UNAVAILABLE", async () => {
  const provider = {
    backend: "injected",
    async getPublicKeys() {
      return ["ab".repeat(48)];
    },
    async getXchCoins() {
      return [];
    },
    async signCoinSpends() {
      return "ff".repeat(96);
    },
  };
  const paywall = new Paywall(provider, { spends: { init() {} } });
  await assert.rejects(
    () => paywall.requestPayment({ amount: 1, owner: "11".repeat(32) }),
    (e) => isDigSdkError(e, "SPEND_BUILDER_UNAVAILABLE"),
  );
});

test("Paywall.proveAccess with both nft and collection throws INVALID_ARGUMENT", async () => {
  const paywall = new Paywall(
    { backend: "injected" },
    { spends: { init() {} } },
  );
  await assert.rejects(
    () =>
      paywall.proveAccess({
        parentSpend: {},
        owner: "11".repeat(32),
        nft: "44".repeat(32),
        collection: "55".repeat(32),
      }),
    (e) => isDigSdkError(e, "INVALID_ARGUMENT"),
  );
});

// ---- URN parse coded error ----

test("parseUrn on a malformed URN throws INVALID_ARGUMENT", () => {
  assert.throws(
    () => parseUrn("not-a-urn"),
    (e) => isDigSdkError(e, "INVALID_ARGUMENT"),
  );
});

// ---- Error CONSTRUCTION can never throw (#2719) --------------------------------------------
//
// `redactContext` walks `context` recursively. 0.6.3 bounded the CYCLE case, but a deeply NESTED
// (acyclic) context still recursed once per level and blew the stack INSIDE the `DigSdkError`
// constructor — a `RangeError` escaping from a throw site that was itself refusing hostile input,
// so an uncoded error escaped the whole public surface. Depth, not cycles, is the case a hostile
// ~293 KiB JSON response actually produces.

// Deeper than any host's call-stack frame budget (V8's default is ~11k frames), so an unbounded
// recursive walk cannot survive it on any runtime this SDK supports.
const HOSTILE_NESTING_DEPTH = 50_000;

function deeplyNested(depth) {
  let node = { leaf: true };
  for (let i = 0; i < depth; i++) node = { a: node };
  return node;
}

test("DigSdkError construction survives a deeply nested context (#2719)", () => {
  const err = new DigSdkError("RPC_MALFORMED_RESPONSE", "hostile shape", {
    rpcMethod: "dig.getContent",
    declaredLength: deeplyNested(HOSTILE_NESTING_DEPTH),
  });
  // The error is fully usable: coded, serializable, and the shallow context it carries survives.
  assert.equal(err.code, "RPC_MALFORMED_RESPONSE");
  assert.equal(err.context.rpcMethod, "dig.getContent");
  assert.doesNotThrow(() => JSON.stringify(err.toJSON()));
});

test("a deeply nested context is truncated, not walked to the bottom (#2719)", () => {
  const err = new DigSdkError("RPC_MALFORMED_RESPONSE", "hostile shape", {
    declaredLength: deeplyNested(HOSTILE_NESTING_DEPTH),
  });
  // Walk the surviving copy: it must bottom out in a finite number of levels. Counting the levels
  // (rather than merely asserting construction succeeded) is what distinguishes a real depth bound
  // from an implementation that only caught the RangeError and dropped the whole context.
  let node = err.context.declaredLength;
  let levels = 0;
  while (node && typeof node === "object" && "a" in node) {
    node = node.a;
    levels++;
    assert.ok(levels < 1000, "redacted context is not depth-bounded");
  }
  assert.ok(levels > 0, "the nested context was dropped entirely, not bounded");
});

test("a getter that throws in context cannot break error construction (#2719)", () => {
  // `context` reaches the constructor from a throw site that may have put an attacker-controlled
  // object in it; a throwing getter is the other way redaction itself can fail. The constructor
  // must still produce a usable coded error.
  const hostile = {};
  Object.defineProperty(hostile, "boom", {
    enumerable: true,
    get() {
      throw new Error("nope");
    },
  });
  const err = new DigSdkError("RPC_ERROR", "m", { hostile });
  assert.equal(err.code, "RPC_ERROR");
  assert.doesNotThrow(() => JSON.stringify(err.toJSON()));
});

// ---------------------------------------------------------------------------------------------
// A `__proto__`-keyed context survives redaction as ordinary data (#2719).
//
// The redaction copy is built with `out[k] = …`, and for `k === "__proto__"` that assignment does
// not create a property — it invokes the setter on `Object.prototype` and replaces the COPY's
// prototype. This is not prototype pollution (the target is a fresh object, and the subtree is
// already redacted before assignment), but it costs two real things: the subtree vanishes from
// `JSON.stringify`, so the diagnostics are silently lost, and a `"__proto__": null` value produces
// a null-prototype object on which consumer code calling `sub.hasOwnProperty(...)` throws.
// ---------------------------------------------------------------------------------------------

test("a __proto__-keyed context stays serializable and pollutes nothing (#2719)", () => {
  const context = JSON.parse(
    '{"rpcMethod":"dig.getContent","__proto__":{"polluted":"urn?salt=ff00ff00"}}',
  );
  const err = new DigSdkError("RPC_MALFORMED_RESPONSE", "hostile key", context);

  // The subtree is DATA: it round-trips through JSON rather than disappearing into a prototype.
  const serialized = JSON.parse(JSON.stringify(err.context));
  assert.equal(serialized.rpcMethod, "dig.getContent");
  assert.deepEqual(Object.keys(serialized).sort(), ["__proto__", "rpcMethod"]);
  // Redaction still reached inside it — being data must not mean being skipped.
  assert.ok(!JSON.stringify(err.context).includes("ff00ff00"));

  // And nothing was written through to the shared prototype, on this object or globally.
  assert.equal(Object.getPrototypeOf(err.context), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test("a null __proto__ value leaves the redacted context usable (#2719)", () => {
  const context = JSON.parse('{"rpcMethod":"dig.getContent","__proto__":null}');
  const err = new DigSdkError("RPC_MALFORMED_RESPONSE", "null proto", context);
  // The failure this pins: assigning `null` through the setter yields a null-prototype object, so
  // ordinary consumer code touching an inherited method throws instead of reading a field.
  assert.doesNotThrow(() =>
    Object.prototype.hasOwnProperty.call(err.context, "rpcMethod"),
  );
  // Called as consumer code would — off the object, through its inherited prototype.
  const hasOwn = err.context["hasOwnProperty"];
  assert.equal(typeof hasOwn, "function");
  assert.equal(hasOwn.call(err.context, "rpcMethod"), true);
});
