// The shared, Node-only deploy runner both framework adapters call on their `publish` step.
//
// It composes the pure pieces (load dig.toml → resolve config → build argv + env), spawns the
// installed `digstore` binary with `deploy --json`, and parses the result into a friendly
// DeployResult ({ capsule, chiaUrl, hubUrl }). It is intentionally thin: ALL deploy logic lives in
// `digstore deploy` (the canonical deployer — advances the on-chain root, stages, pushes the
// capsule); this only marshals config in and the result out.
//
// Node-only: it uses node:child_process / node:fs. The framework entrypoints import it lazily on
// the publish path so importing the plugin in a browser/config context never pulls Node APIs.

import { resolveDeployConfig, type AdapterOptions } from "./config.js";
import { parseDigToml, type DigTomlConfig } from "./dig-toml.js";
import {
  buildDeployArgs,
  buildDeployEnv,
  parseDeployResult,
  type DeployArgsOptions,
  type DeployResult,
} from "./deploy.js";
import { DigSdkError } from "../errors.js";

/** Options for {@link runDeploy}. */
export interface RunDeployOptions extends AdapterOptions, DeployArgsOptions {
  /** Project root that holds `dig.toml` and the build output. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The `digstore` executable. Defaults to `"digstore"` (must be on PATH). */
  digstoreBin?: string;
  /** Sink for human-readable progress. Defaults to `console.log`. */
  logger?: (line: string) => void;
}

/** Read `dig.toml` from `cwd` (returns {} when absent). */
async function readDigToml(cwd: string): Promise<DigTomlConfig> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  try {
    const text = await readFile(path.join(cwd, "dig.toml"), "utf8");
    return parseDigToml(text);
  } catch {
    return {}; // no dig.toml — rely on options + env
  }
}

/**
 * Resolve config, run `digstore deploy --json`, and parse the capsule. Spawns `digstore` with the
 * SECRETS injected through the child env (never the argv). Rejects with digstore's stderr on
 * non-zero exit. Returns the parsed {@link DeployResult}.
 */
export async function runDeploy(options: RunDeployOptions = {}): Promise<DeployResult> {
  const cwd = options.cwd ?? process.cwd();
  const bin = options.digstoreBin ?? "digstore";
  const log = options.logger ?? ((l: string) => console.log(l));

  const digToml = await readDigToml(cwd);
  const cfg = resolveDeployConfig({
    options: {
      storeId: options.storeId,
      outputDir: options.outputDir,
      buildCommand: options.buildCommand,
      message: options.message,
      network: options.network,
      remote: options.remote,
      waitTimeout: options.waitTimeout,
    },
    digToml,
    env: process.env,
  });

  const argv = buildDeployArgs(cfg, { skipBuild: options.skipBuild });
  const childEnv = { ...process.env, ...buildDeployEnv(cfg) };

  log(`▶ digstore ${argv.filter((a) => a !== cfg.deployKey && a !== cfg.salt).join(" ")}`);

  const { spawn } = await import("node:child_process");
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, argv, {
      cwd,
      env: childEnv,
      // digstore reads no stdin here; capture stdout (the JSON) and stream stderr through.
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e: Error) => {
      reject(
        new DigSdkError(
          "DIGSTORE_NOT_FOUND",
          `could not run "${bin}" — is digstore installed and on PATH? (${e.message})`,
          { bin },
          { cause: e },
        ),
      );
    });
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(out);
      else
        reject(
          new DigSdkError("DEPLOY_FAILED", `digstore deploy failed (exit ${code}).\n${err || out}`, {
            exitCode: code,
            stderr: err.slice(0, 2000),
          }),
        );
    });
  });

  const result = parseDeployResult(stdout);
  log(`✓ deployed capsule ${result.capsule}`);
  // chia:// is the user-facing content-open address (what they open in the DIG Browser/extension).
  log(`  open    ${result.chiaUrl}`);
  log(`  view    ${result.hubUrl}`);
  return result;
}
