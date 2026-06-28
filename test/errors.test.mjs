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
  assert.ok(codes.length >= 15, "the catalogue should cover every failure class");
  for (const [k, v] of codes) {
    assert.equal(k, v, `code value must equal its key (${k})`);
    assert.match(v, /^[A-Z][A-Z0-9_]*$/, `${v} must be UPPER_SNAKE`);
  }
  // The catalogue advertised via capabilities() matches the const exactly.
  assert.deepEqual([...capabilities().errorCodes].sort(), Object.values(DIG_SDK_ERROR_CODES).sort());
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
    () => dig.read({ urn: `urn:dig:chia:${"ab".repeat(32)}/index.html`, root: "cd".repeat(32) }),
    (e) => isDigSdkError(e, "RPC_TRANSPORT") && e.context.rpcMethod === "dig.getContent",
  );
});

test("DigClient RPC HTTP error throws RPC_ERROR with httpStatus", async () => {
  const dig = new DigClient({
    fetch: async () => ({ ok: false, status: 503, async json() { return {}; } }),
  });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${"ab".repeat(32)}/index.html`, root: "cd".repeat(32) }),
    (e) => isDigSdkError(e, "RPC_ERROR") && e.context.httpStatus === 503,
  );
});

test("DigClient JSON-RPC error throws RPC_ERROR carrying the server message", async () => {
  const dig = new DigClient({
    fetch: async () => ({
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } };
      },
    }),
  });
  await assert.rejects(
    () => dig.read({ urn: `urn:dig:chia:${"ab".repeat(32)}/index.html`, root: "cd".repeat(32) }),
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
  const paywall = new Paywall({ backend: "injected" }, { spends: { init() {} } });
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
