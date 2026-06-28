// The transient-publish detector — the double-prompt safety boundary. It must classify a
// relay-publish failure (request never reached the wallet → safe to retry) apart from a
// wallet/user rejection or a response timeout (NOT safe to retry).

import test from "node:test";
import assert from "node:assert/strict";
import { isTransientPublishError } from "../dist/index.js";

test("classifies relay-publish failures as transient", () => {
  for (const msg of [
    "Failed or timed out to publish payload",
    "WebSocket connection failed",
    "Connection closed",
    "socket stalled",
    "request reset",
  ]) {
    assert.equal(isTransientPublishError(new Error(msg)), true, msg);
  }
});

test("does NOT retry rejections / response timeouts", () => {
  for (const msg of [
    "User rejected the request",
    "Sage did not respond — open the Sage app and try again.",
    "Missing or invalid. request() method:",
  ]) {
    assert.equal(isTransientPublishError(new Error(msg)), false, msg);
  }
});

test("non-error inputs do not throw and return false", () => {
  assert.equal(isTransientPublishError(null), false);
  assert.equal(isTransientPublishError(undefined), false);
  assert.equal(isTransientPublishError(42), false);
});
