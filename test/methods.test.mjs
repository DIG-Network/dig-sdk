// The canonical CHIP-0002 method surface — the parity contract both transports share. A method in
// one transport but not the other is a real bug (hub "#40"); these pin the shared list + sign order.

import test from "node:test";
import assert from "node:assert/strict";
import { WALLET_METHODS, SIGN_METHODS, DEFAULT_CHAIN } from "../dist/index.js";

test("WALLET_METHODS includes the full canonical CHIP-0002 set", () => {
  for (const m of [
    "chip0002_connect",
    "chip0002_chainId",
    "chip0002_getPublicKeys",
    "chip0002_getAssetCoins",
    "chip0002_getAssetBalance",
    "chip0002_signCoinSpends",
    "chip0002_signMessage",
    "chia_getAddress",
    "chia_signMessageByAddress",
    "chia_takeOffer",
  ]) {
    assert.ok(WALLET_METHODS.includes(m), `missing ${m}`);
  }
});

test("SIGN_METHODS preference order: by-address first, by-pubkey fallback", () => {
  assert.deepEqual([...SIGN_METHODS], [
    "chia_signMessageByAddress",
    "chip0002_signMessage",
  ]);
});

test("both sign methods are part of the negotiated set", () => {
  for (const m of SIGN_METHODS) assert.ok(WALLET_METHODS.includes(m));
});

test("default chain is mainnet", () => {
  assert.equal(DEFAULT_CHAIN, "chia:mainnet");
});
