// Regression guard for the "/spend" subpath re-export of @dignetwork/chip35-dl-coin-wasm.
//
// The SDK's "./spend" entry is `export * from "@dignetwork/chip35-dl-coin-wasm"`, so EVERY symbol
// the canonical spend builder exports flows through unchanged. When chip35 0.5.0 added the asset
// builders (NFT / DID / CAT / CHIP-0007 metadata / offer codec / sha256), the SDK had to bump its
// dependency `^0.4.0` -> `^0.5.0` for them to appear here. chip35 0.7.0 then added the in-dapp
// monetization spends (#46: payment + receipt verify + NFT/collection gating), so the SDK bumped
// `^0.5.0` -> `^0.7.0` to surface them. This test pins that contract: it fails on a chip35 that
// lacks these symbols and passes once the SDK consumes the version that exports them.
//
// Why we assert against the dependency's own export surface rather than importing ../dist/spend.js
// and reading off its keys: chip35-dl-coin-wasm is wasm-bindgen "bundler"-target glue whose entry
// does a top-level `import * as wasm from "./..._bg.wasm"`. Plain Node's ESM loader cannot load a
// raw .wasm import, so *executing* the re-export throws ERR_UNKNOWN_FILE_EXTENSION here (it works in
// bundlers/browsers, the SDK's actual consumers). We therefore verify the contract statically:
//   1) the version of chip35 the SDK resolves to exports the new symbols (the `export *` source),
//   2) the BUILT dist/spend.{js,cjs} re-export from chip35 (guards the broken-publish bug: no dist).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Resolve the chip35 package the SDK actually depends on, and read its declared export surface
// (the .d.ts is the source of truth for what `export *` forwards).
const chip35Pkg = require("@dignetwork/chip35-dl-coin-wasm/package.json");
const chip35Dts = readFileSync(
  require.resolve(`@dignetwork/chip35-dl-coin-wasm/${chip35Pkg.types}`),
  "utf8",
);
const chip35Exports = new Set(
  [...chip35Dts.matchAll(/export (?:declare )?function ([A-Za-z0-9_]+)/g)].map((m) => m[1]),
);

// The asset builders + helpers introduced in chip35-dl-coin-wasm 0.5.0. The dep bump to ^0.5.0 is
// what makes these reachable via the "./spend" re-export.
const NEW_0_5_0_EXPORTS = [
  "mintNft",
  "bulkMint",
  "createDid",
  "issueCat",
  "buildChip0007Metadata",
  "validateChip0007",
  "generateItemMetadata",
  "sha256",
  "encodeOffer",
  "decodeOffer",
];

// The in-dapp monetization spends + read helpers introduced in chip35-dl-coin-wasm 0.7.0 (#46).
// The dep bump to ^0.7.0 is what makes these reachable via the "./spend" re-export, and they back
// the high-level `Paywall` helper on the main SDK surface.
const NEW_0_7_0_EXPORTS = [
  "buildPayment",
  "buildCatPayment",
  "paymentNonce",
  "verifyPaymentReceipt",
  "proveNftOwnership",
  "proveCollectionMembership",
];

// Core CHIP-0035 store-coin builders that must remain available across the bump.
const CORE_STORE_EXPORTS = [
  "mintStore",
  "meltStore",
  "updateStoreMetadata",
  "updateStoreOwnership",
  "oracleSpend",
  "addFee",
  "dataStoreFromSpend",
  "hexSpendBundleToCoinSpends",
  "spendBundleToHex",
  "init",
];

test("SDK depends on chip35-dl-coin-wasm >= 0.7.0", () => {
  const [maj, min] = chip35Pkg.version.split(".").map(Number);
  assert.ok(
    maj > 0 || (maj === 0 && min >= 7),
    `resolved chip35-dl-coin-wasm is ${chip35Pkg.version}, expected >= 0.7.0`,
  );
});

test("/spend re-exports the chip35 0.5.0 asset builders", () => {
  for (const name of NEW_0_5_0_EXPORTS) {
    assert.ok(
      chip35Exports.has(name),
      `@dignetwork/dig-sdk/spend must re-export ${name} (requires chip35-dl-coin-wasm >= 0.5.0)`,
    );
  }
});

test("/spend re-exports the new chip35 0.7.0 monetization spends (#46)", () => {
  for (const name of NEW_0_7_0_EXPORTS) {
    assert.ok(
      chip35Exports.has(name),
      `@dignetwork/dig-sdk/spend must re-export ${name} (requires chip35-dl-coin-wasm >= 0.7.0)`,
    );
  }
});

test("/spend keeps re-exporting the core CHIP-0035 store builders", () => {
  for (const name of CORE_STORE_EXPORTS) {
    assert.ok(chip35Exports.has(name), `@dignetwork/dig-sdk/spend must re-export ${name}`);
  }
});

test("built dist/spend.{js,cjs} re-export from chip35-dl-coin-wasm (dist is present)", () => {
  const esm = readFileSync(new URL("../dist/spend.js", import.meta.url), "utf8");
  const cjs = readFileSync(new URL("../dist/spend.cjs", import.meta.url), "utf8");
  assert.match(esm, /@dignetwork\/chip35-dl-coin-wasm/, "dist/spend.js must re-export chip35");
  assert.match(cjs, /@dignetwork\/chip35-dl-coin-wasm/, "dist/spend.cjs must re-export chip35");
});
