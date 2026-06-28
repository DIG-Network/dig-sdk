// Deploy-config resolution for the framework adapters.
//
// The final config a deploy runs with is composed from three layers, highest precedence first:
//   1. plugin options   — what the developer wrote in vite.config / the Next adapter call
//   2. environment vars  — what CI injects (DIGSTORE_*), incl. the SECRETS (deploy key, salt)
//   3. dig.toml          — the project's checked-in defaults
//   4. built-in defaults — outputDir="dist", network="mainnet" (mirrors deploy.rs::resolve_config)
//
// This mirrors `digstore deploy`'s own resolution order (flag/env > dig.toml > default) so the
// adapters never disagree with the CLI about what a project deploys. SECRETS are resolved ONLY from
// env — never from options or dig.toml — so they can't end up checked into a repo or a config file.

import type { DigTomlConfig } from "./dig-toml.js";

/** Per-call options a developer passes to the Vite plugin / Next adapter. */
export interface AdapterOptions {
  /** On-chain store id (64-hex) to advance. Usually set in dig.toml instead. */
  storeId?: string;
  /** Built-output directory to publish. Defaults to the framework's output (or "dist"). */
  outputDir?: string;
  /** Shell build command for `digstore` to run. Omit when the adapter builds itself. */
  buildCommand?: string;
  /** Commit message for the new capsule. */
  message?: string;
  /** Chain network. Defaults to "mainnet". */
  network?: string;
  /** The `origin` remote to publish to (e.g. `dig://<storeId>`). */
  remote?: string;
  /** Seconds to wait for on-chain confirmation. */
  waitTimeout?: number;
}

/** The fully resolved config a deploy runs with. Secrets are present only if env supplied them. */
export interface ResolvedDeployConfig {
  storeId?: string;
  outputDir: string;
  buildCommand?: string;
  message?: string;
  network: string;
  remote?: string;
  waitTimeout?: number;
  /** Publisher deploy key (64-hex). From env only. */
  deployKey?: string;
  /** Private-store secret salt (64-hex). From env only. */
  salt?: string;
}

/** Inputs to resolution — kept explicit so it is a pure function (no process.env read inside). */
export interface ResolveInput {
  options: AdapterOptions;
  digToml: DigTomlConfig;
  env: Record<string, string | undefined>;
}

/** A non-empty, trimmed env value, or undefined. Empty/whitespace env vars count as unset. */
function envVal(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key];
  if (v == null) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** First defined of the candidates (treating "" the caller already filtered as undefined). */
function pick<T>(...candidates: (T | undefined)[]): T | undefined {
  for (const c of candidates) if (c !== undefined) return c;
  return undefined;
}

/**
 * Resolve the final deploy config. Precedence per field: options > env (DIGSTORE_*) > dig.toml >
 * default. Secrets (deployKey, salt) are taken from env ONLY.
 */
export function resolveDeployConfig(input: ResolveInput): ResolvedDeployConfig {
  const { options, digToml, env } = input;

  const storeId = pick(
    options.storeId,
    envVal(env, "DIGSTORE_STORE_ID"),
    digToml.storeId,
  );
  const outputDir =
    pick(options.outputDir, envVal(env, "DIGSTORE_OUTPUT_DIR"), digToml.outputDir) ?? "dist";
  const buildCommand = pick(
    options.buildCommand,
    envVal(env, "DIGSTORE_BUILD_COMMAND"),
    digToml.buildCommand,
  );
  const message = pick(options.message, envVal(env, "DIGSTORE_MESSAGE"), digToml.message);
  const network =
    pick(options.network, envVal(env, "DIGSTORE_NETWORK"), digToml.network) ?? "mainnet";
  const remote = pick(options.remote, envVal(env, "DIGSTORE_REMOTE"), digToml.remote);

  const waitFromEnv = envVal(env, "DIGSTORE_WAIT_TIMEOUT");
  const waitTimeout = pick(
    options.waitTimeout,
    waitFromEnv != null ? Number.parseInt(waitFromEnv, 10) : undefined,
    digToml.waitTimeout,
  );

  return {
    storeId,
    outputDir,
    buildCommand,
    message,
    network,
    remote,
    waitTimeout: Number.isFinite(waitTimeout) ? waitTimeout : undefined,
    // SECRETS — env only.
    deployKey: envVal(env, "DIGSTORE_DEPLOY_KEY"),
    salt: envVal(env, "DIGSTORE_STORE_SALT"),
  };
}
