// Adapter deploy-arg construction + result parsing — the PURE glue around `digstore deploy --json`.
//
//   • buildDeployArgs: resolved config -> the exact argv passed to `digstore` (always --json, plus
//     only the flags whose values are set). Secrets (deploy key, salt) are NEVER placed on argv —
//     they are passed through the child env so they don't leak into the process table, exactly as
//     digstore-cli recommends (deploy.rs::resolve_deploy_key).
//   • buildDeployEnv: the env overlay carrying the secrets to the child.
//   • parseDeployResult: the `digstore deploy --json` stdout object -> a friendly
//     { capsule, storeId, root, chiaUrl, digUrl, hubUrl } (the URLs derived the same way digstore
//     does — chiaUrl is the user-facing content-open address, matching digstore's `content_address`).
//
// No child process is spawned here — these are the pure pieces the Vite/Next adapters compose.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDeployArgs,
  buildDeployEnv,
  parseDeployResult,
} from "../dist/adapters.js";
import { isDigSdkError } from "../dist/index.js";

const STORE = "ab".repeat(32);
const ROOT = "cd".repeat(32);

test("buildDeployArgs: always deploy + --json", () => {
  const argv = buildDeployArgs({ outputDir: "dist", network: "mainnet" });
  assert.equal(argv[0], "deploy");
  assert.ok(argv.includes("--json"), "must request machine-readable output");
});

test("buildDeployArgs: maps set fields to flags, omits unset", () => {
  const argv = buildDeployArgs({
    storeId: STORE,
    outputDir: "out",
    buildCommand: "npm run build",
    message: "ci deploy",
    network: "mainnet",
    remote: "dig://" + STORE,
  });
  assert.ok(argv.includes("--store-id") && argv.includes(STORE));
  assert.ok(argv.includes("--output-dir") && argv.includes("out"));
  assert.ok(argv.includes("--build-command") && argv.includes("npm run build"));
  assert.ok(argv.includes("--message") && argv.includes("ci deploy"));
  assert.ok(argv.includes("--remote") && argv.includes("dig://" + STORE));
});

test("buildDeployArgs: NEVER puts secrets on argv", () => {
  const argv = buildDeployArgs({
    outputDir: "dist",
    deployKey: "ff".repeat(32),
    salt: "11".repeat(32),
  });
  const joined = argv.join(" ");
  assert.ok(!joined.includes("ff".repeat(32)), "deploy key must not be on argv");
  assert.ok(!joined.includes("11".repeat(32)), "salt must not be on argv");
  assert.ok(!argv.includes("--deploy-key"));
  assert.ok(!argv.includes("--salt"));
});

test("buildDeployArgs: omits build-command when the adapter already built", () => {
  // When the adapter runs the framework build itself, it should NOT ask digstore to rebuild.
  const argv = buildDeployArgs({ outputDir: "dist", buildCommand: "npm run build" }, { skipBuild: true });
  assert.ok(!argv.includes("--build-command"));
});

test("buildDeployEnv: carries secrets through the child env", () => {
  const env = buildDeployEnv({ deployKey: "ff".repeat(32), salt: "11".repeat(32) });
  assert.equal(env.DIGSTORE_DEPLOY_KEY, "ff".repeat(32));
  assert.equal(env.DIGSTORE_STORE_SALT, "11".repeat(32));
});

test("buildDeployEnv: omits absent secrets", () => {
  const env = buildDeployEnv({ deployKey: "ff".repeat(32) });
  assert.equal(env.DIGSTORE_DEPLOY_KEY, "ff".repeat(32));
  assert.ok(!("DIGSTORE_STORE_SALT" in env));
});

test("parseDeployResult: extracts capsule, store id, root and derives URLs", () => {
  const capsule = `${STORE}:${ROOT}`;
  const out = parseDeployResult(
    JSON.stringify({ root: ROOT, capsule, size: 1234, pushed: true }),
  );
  assert.equal(out.capsule, capsule);
  assert.equal(out.storeId, STORE);
  assert.equal(out.root, ROOT);
  // chia:// is the user-facing content-open address — matches digstore's printed `content_address`
  // (chia://<storeId>:<rootHash>/). The browser/extension register chia:// for opening DIG content.
  assert.equal(out.chiaUrl, `chia://${STORE}:${ROOT}/`);
  // digUrl is a DEPRECATED alias carrying the SAME chia:// value (back-compat for consumers that
  // read `digUrl`; framework-adapters still read it). It is NOT a §21 remote dig:// locator.
  assert.equal(out.digUrl, `chia://${STORE}:${ROOT}/`);
  // hub view URL mirrors digstore deploy's hub_url().
  assert.equal(out.hubUrl, `https://hub.dig.net/stores/${STORE}`);
  assert.equal(out.pushed, true);
});

test("parseDeployResult: prefers the digstore-emitted content_address for chiaUrl when present", () => {
  // digstore deploy --preview --json prints `content_address: chia://<store>:<root>/`. When the
  // deploy JSON carries it, the SDK must surface that exact value (single source of truth) rather
  // than re-deriving — keeping the SDK's chiaUrl byte-identical to what digstore printed.
  const capsule = `${STORE}:${ROOT}`;
  const content = `chia://${STORE}:${ROOT}/`;
  const out = parseDeployResult(
    JSON.stringify({ root: ROOT, capsule, content_address: content, pushed: true }),
  );
  assert.equal(out.chiaUrl, content);
  assert.equal(out.digUrl, content);
});

test("parseDeployResult: tolerates extra JSON log lines, takes the last object", () => {
  const capsule = `${STORE}:${ROOT}`;
  const stdout =
    `{"phase":"staged","files":3}\n` +
    `${JSON.stringify({ root: ROOT, capsule })}\n`;
  const out = parseDeployResult(stdout);
  assert.equal(out.capsule, capsule);
  assert.equal(out.storeId, STORE);
});

test("parseDeployResult: throws a clear error when no capsule is present", () => {
  assert.throws(
    () => parseDeployResult(`{"error":"nothing to deploy"}`),
    /capsule/i,
  );
});

test("parseDeployResult: throws on non-JSON output", () => {
  assert.throws(() => parseDeployResult("digstore: command not found"), /could not parse/i);
});

test("parseDeployResult: unparseable output throws coded DEPLOY_OUTPUT_UNPARSEABLE", () => {
  assert.throws(
    () => parseDeployResult("digstore: command not found"),
    (e) => isDigSdkError(e, "DEPLOY_OUTPUT_UNPARSEABLE"),
  );
});

test("parseDeployResult: missing capsule throws coded DEPLOY_OUTPUT_UNPARSEABLE", () => {
  assert.throws(
    () => parseDeployResult(`{"error":"nothing to deploy"}`),
    (e) => isDigSdkError(e, "DEPLOY_OUTPUT_UNPARSEABLE"),
  );
});

test("parseDeployResult: malformed capsule throws coded INVALID_ARGUMENT", () => {
  assert.throws(
    () => parseDeployResult(JSON.stringify({ capsule: "not-a-capsule" })),
    (e) => isDigSdkError(e, "INVALID_ARGUMENT"),
  );
});
