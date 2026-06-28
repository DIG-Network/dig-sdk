// URN parsing / canonicalization — the pure, dependency-free contract. Mirrors the parser the
// hub, extension, and companion use; these pin the shapes the rest of the ecosystem relies on.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseUrn,
  isUrn,
  reconstructUrn,
  reconstructUrnWithRoot,
} from "../dist/index.js";

const STORE = "ab".repeat(32); // 64 hex
const ROOT = "cd".repeat(32);

test("parseUrn: rootless canonical form", () => {
  const p = parseUrn(`urn:dig:chia:${STORE}/index.html`);
  assert.equal(p.storeId, STORE);
  assert.equal(p.root, null);
  assert.equal(p.resourceKey, "index.html");
  assert.equal(p.salt, null);
});

test("parseUrn: root-pinned form", () => {
  const p = parseUrn(`urn:dig:chia:${STORE}:${ROOT}/img/logo.png`);
  assert.equal(p.storeId, STORE);
  assert.equal(p.root, ROOT);
  assert.equal(p.resourceKey, "img/logo.png");
});

test("parseUrn: private-store salt", () => {
  const p = parseUrn(`urn:dig:chia:${STORE}/secret.txt?salt=deadbeef`);
  assert.equal(p.resourceKey, "secret.txt");
  assert.equal(p.salt, "deadbeef");
});

test("parseUrn: uppercase store/root are lowercased", () => {
  const p = parseUrn(`urn:dig:chia:${STORE.toUpperCase()}:${ROOT.toUpperCase()}/x`);
  assert.equal(p.storeId, STORE);
  assert.equal(p.root, ROOT);
});

test("parseUrn: rejects a non-URN", () => {
  assert.throws(() => parseUrn("https://example.com/index.html"));
  assert.throws(() => parseUrn(`urn:dig:chia:tooshort/index.html`));
});

test("isUrn: true/false without throwing", () => {
  assert.equal(isUrn(`urn:dig:chia:${STORE}/a`), true);
  assert.equal(isUrn("nope"), false);
});

test("reconstructUrn: rootless; empty key -> index.html", () => {
  assert.equal(reconstructUrn(STORE, "a/b.txt"), `urn:dig:chia:${STORE}/a/b.txt`);
  assert.equal(reconstructUrn(STORE, ""), `urn:dig:chia:${STORE}/index.html`);
});

test("reconstructUrnWithRoot: root-pinned display URN", () => {
  assert.equal(
    reconstructUrnWithRoot(STORE, ROOT, "x.txt"),
    `urn:dig:chia:${STORE}:${ROOT}/x.txt`,
  );
});
