// DigClient public collection reads (#39): getCollection / listCollectionItems wired to the dig RPC.
// A mock fetch asserts the JSON-RPC method + params the SDK sends and returns canned results, so the
// SDK's request shaping, result typing, pagination plumbing, and error mapping are all verified
// without a network. (The owner-independent lineage resolution itself is proven in the digstore-chain
// simulator tests; here we prove the SDK speaks the contract.)

import test from "node:test";
import assert from "node:assert/strict";
import { DigClient, isDigSdkError } from "../dist/index.js";

const LAUNCHERS = ["ab".repeat(32), "cd".repeat(32)];
const DID = "ef".repeat(32);

/** A mock fetch that records the JSON-RPC request and returns `result` as a JSON-RPC 2.0 response. */
function mockRpc(result, captured) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    captured.method = body.method;
    captured.params = body.params;
    return {
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: body.id ?? 1, result };
      },
    };
  };
}

test("getCollection sends dig.getCollection with launcher_ids + did and returns the facts", async () => {
  const captured = {};
  const result = {
    did: DID,
    declared_did: DID,
    item_count: 2,
    resolved_count: 2,
    royalty_basis_points: 300,
  };
  const dig = new DigClient({ fetch: mockRpc(result, captured) });
  const meta = await dig.getCollection({ launcherIds: LAUNCHERS, did: DID });

  assert.equal(captured.method, "dig.getCollection");
  assert.deepEqual(captured.params.launcher_ids, LAUNCHERS);
  assert.equal(captured.params.did, DID);
  assert.equal(meta.resolved_count, 2);
  assert.equal(meta.royalty_basis_points, 300);
  assert.equal(meta.did, DID);
});

test("getCollection omits did when not supplied", async () => {
  const captured = {};
  const dig = new DigClient({
    fetch: mockRpc(
      { did: null, declared_did: null, item_count: 0, resolved_count: 0, royalty_basis_points: null },
      captured,
    ),
  });
  await dig.getCollection({ launcherIds: [] });
  assert.equal(captured.params.did, undefined, "no did key when none supplied");
  assert.deepEqual(captured.params.launcher_ids, []);
});

test("listCollectionItems sends dig.listCollectionItems with offset/limit and returns the page", async () => {
  const captured = {};
  const page = {
    items: [
      {
        launcher_id: LAUNCHERS[0],
        coin_id: "11".repeat(32),
        owner_did: DID,
        royalty_puzzle_hash: "22".repeat(32),
        royalty_basis_points: 300,
        owner_puzzle_hash: "33".repeat(32),
        metadata: {
          edition_number: 1,
          edition_total: 2,
          data_uris: ["dig://store/1.png"],
          data_hash: "44".repeat(32),
          metadata_uris: [],
          metadata_hash: null,
          license_uris: [],
          license_hash: null,
        },
      },
    ],
    offset: 0,
    limit: 50,
    total: 2,
    next_offset: 1,
  };
  const dig = new DigClient({ fetch: mockRpc(page, captured) });
  const got = await dig.listCollectionItems({ launcherIds: LAUNCHERS, offset: 0, limit: 50 });

  assert.equal(captured.method, "dig.listCollectionItems");
  assert.deepEqual(captured.params.launcher_ids, LAUNCHERS);
  assert.equal(captured.params.offset, 0);
  assert.equal(captured.params.limit, 50);
  assert.equal(got.items.length, 1);
  assert.equal(got.items[0].owner_puzzle_hash, "33".repeat(32));
  assert.equal(got.items[0].metadata.data_uris[0], "dig://store/1.png");
  assert.equal(got.next_offset, 1, "more pages available");
});

test("listCollectionItems omits offset/limit when not supplied (server defaults apply)", async () => {
  const captured = {};
  const dig = new DigClient({
    fetch: mockRpc({ items: [], offset: 0, limit: 50, total: 0, next_offset: null }, captured),
  });
  await dig.listCollectionItems({ launcherIds: LAUNCHERS });
  assert.equal(captured.params.offset, undefined);
  assert.equal(captured.params.limit, undefined);
});

test("a JSON-RPC error surfaces as a coded DigSdkError (RPC_ERROR)", async () => {
  const errFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: body.id ?? 1,
          error: { code: -32602, message: "params.launcher_ids must be an array" },
        };
      },
    };
  };
  const dig = new DigClient({ fetch: errFetch });
  await assert.rejects(
    () => dig.getCollection({ launcherIds: [] }),
    (e) => isDigSdkError(e, "RPC_ERROR") && e.context.rpcMethod === "dig.getCollection",
  );
});
