// The pure glue around `digstore deploy --json`: build the child argv + env, and parse the result.
//
// The adapters SHELL OUT to the installed `digstore` binary (the canonical deployer — it advances
// the on-chain root, stages the build dir, and pushes the new capsule to DIGHUb). They never
// re-implement deploy. These helpers are the deterministic, side-effect-free pieces:
//
//   • buildDeployArgs  — resolved config → argv (always `deploy --json`, only set flags).
//   • buildDeployEnv   — resolved config → the env overlay carrying the SECRETS to the child, so the
//                        deploy key / salt are NEVER on the argv (process-table leak), matching
//                        digstore-cli's own guidance (deploy.rs).
//   • parseDeployResult— `digstore deploy --json` stdout → { capsule, storeId, root, chiaUrl,
//                        digUrl, hubUrl, pushed }, deriving the URLs exactly as digstore does
//                        (capsule = storeId:root; hub view = https://hub.dig.net/stores/<id>;
//                        chiaUrl = the user-facing content-open address chia://<store>:<root>/,
//                        matching digstore's printed `content_address`).

import type { ResolvedDeployConfig } from "./config.js";
import { DigSdkError } from "../errors.js";

/** Knobs for argv construction. */
export interface DeployArgsOptions {
  /**
   * The adapter already ran the framework build, so don't hand `--build-command` to digstore (it
   * would rebuild). The output dir is staged as-is.
   */
  skipBuild?: boolean;
}

/**
 * Build the argv for `digstore <argv>` from a resolved config. Always `deploy --json`. Only flags
 * whose values are set are emitted. SECRETS (deployKey, salt) are intentionally excluded — they go
 * through the env (buildDeployEnv) so they never appear in the process table.
 */
export function buildDeployArgs(
  cfg: ResolvedDeployConfig,
  opts: DeployArgsOptions = {},
): string[] {
  const argv: string[] = ["deploy", "--json"];
  if (cfg.storeId) argv.push("--store-id", cfg.storeId);
  if (cfg.outputDir) argv.push("--output-dir", cfg.outputDir);
  if (!opts.skipBuild && cfg.buildCommand) argv.push("--build-command", cfg.buildCommand);
  if (cfg.message) argv.push("--message", cfg.message);
  if (cfg.network) argv.push("--network", cfg.network);
  if (cfg.remote) argv.push("--remote", cfg.remote);
  if (cfg.waitTimeout != null) argv.push("--wait-timeout", String(cfg.waitTimeout));
  return argv;
}

/**
 * The env overlay to merge onto the child process env: the SECRETS, passed out-of-band so they are
 * never visible on the command line. Returns only the keys that have a value.
 */
export function buildDeployEnv(cfg: ResolvedDeployConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.deployKey) env.DIGSTORE_DEPLOY_KEY = cfg.deployKey;
  if (cfg.salt) env.DIGSTORE_STORE_SALT = cfg.salt;
  return env;
}

/** The friendly, parsed outcome of a deploy. */
export interface DeployResult {
  /** `storeId:rootHash` — the capsule identity (the ecosystem-vocabulary id the user shares). */
  capsule: string;
  /** Store identity (64-hex). */
  storeId: string;
  /** The new on-chain root (64-hex). */
  root: string;
  /**
   * The user-facing content-open address `chia://<storeId>:<rootHash>/` — what a user types/clicks
   * to open this verified capsule in the DIG Browser / extension (the scheme they register). This
   * matches digstore deploy's printed `content_address` exactly. (Distinct from the §21 remote
   * locator `dig://<host>/<store_id>` and the `urn:dig:` namespace, which stay `dig://`.)
   */
  chiaUrl: string;
  /**
   * @deprecated Use {@link chiaUrl}. Kept as a back-compat alias for consumers that read `digUrl`;
   * it now carries the SAME `chia://<storeId>:<rootHash>/` content-open value (NOT a `dig://` URL).
   */
  digUrl: string;
  /** The human "view it" URL on DIGHUb (the same one `digstore deploy` prints). */
  hubUrl: string;
  /** Whether the capsule was pushed to DIGHUb (when the JSON reported it). */
  pushed?: boolean;
}

const CAPSULE_RE = /^([0-9a-f]{64}):([0-9a-f]{64})$/i;

/**
 * Parse `digstore deploy --json` stdout into a DeployResult. digstore emits a single JSON object
 * (with at least `capsule` and `root`); we also tolerate extra JSON log lines by scanning lines
 * bottom-up for the first object that carries a `capsule`. Throws a clear error if none is found or
 * the output isn't JSON at all.
 */
export function parseDeployResult(stdout: string): DeployResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"));

  if (lines.length === 0) {
    throw new DigSdkError(
      "DEPLOY_OUTPUT_UNPARSEABLE",
      `could not parse digstore deploy output (no JSON object found). Output was:\n${stdout.slice(0, 500)}`,
      { stdout: stdout.slice(0, 500) },
    );
  }

  // Prefer the LAST JSON object that has a capsule (deploy emits one final result object). Keep the
  // first parseable object as a fallback so the error message can show what digstore DID return.
  let obj: Record<string, unknown> | undefined;
  let fallback: Record<string, unknown> | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // not JSON — skip this line
    }
    if (typeof parsed.capsule === "string") {
      obj = parsed;
      break;
    }
    if (!fallback) fallback = parsed;
  }

  if (!obj) {
    if (fallback) {
      throw new DigSdkError(
        "DEPLOY_OUTPUT_UNPARSEABLE",
        `digstore deploy did not report a capsule (deploy may have failed). Output:\n${JSON.stringify(fallback)}`,
        { output: fallback },
      );
    }
    throw new DigSdkError(
      "DEPLOY_OUTPUT_UNPARSEABLE",
      `could not parse digstore deploy output as JSON:\n${stdout.slice(0, 500)}`,
      { stdout: stdout.slice(0, 500) },
    );
  }

  const capsule = obj.capsule as string;
  const m = CAPSULE_RE.exec(capsule);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new DigSdkError(
      "INVALID_ARGUMENT",
      `digstore deploy reported a malformed capsule "${capsule}" (expected storeId:root)`,
      { value: capsule, expected: "storeId:root" },
    );
  }
  const storeId = m[1].toLowerCase();
  const root = (typeof obj.root === "string" ? obj.root : m[2]).toLowerCase();

  // The user-facing content-open address. Prefer the value digstore itself printed
  // (`content_address`, the single source of truth — digstore deploy.rs::branding::content_url) so
  // the SDK stays byte-identical to the CLI; otherwise derive it the same way digstore does:
  // chia://<storeId>:<rootHash>/ (trailing slash, no resource). This is what a user opens in the
  // DIG Browser/extension — NOT the §21 remote dig:// locator.
  const chiaUrl =
    typeof obj.content_address === "string"
      ? obj.content_address
      : `chia://${storeId}:${root}/`;

  return {
    capsule,
    storeId,
    root,
    chiaUrl,
    // Deprecated alias: same chia:// content-open value (back-compat for consumers reading digUrl).
    digUrl: chiaUrl,
    // Mirrors digstore deploy.rs::hub_url — the public DIGHUb view of an owned store.
    hubUrl: `https://hub.dig.net/stores/${storeId}`,
    pushed: typeof obj.pushed === "boolean" ? obj.pushed : undefined,
  };
}
