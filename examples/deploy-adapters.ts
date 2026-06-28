// Typechecked example: the framework adapters + their pure core. Verifies the public surface of
// `@dignetwork/dig-sdk/vite`, `/next`, and `/adapters` compiles for a consumer (no vite/next
// runtime needed — the adapter modules import neither). Mirrors the README "Framework adapters".

import { digVite, digDeploy as digViteDeploy } from "@dignetwork/dig-sdk/vite";
import {
  digDeploy as digNextDeploy,
  digNextDevShimTag,
  digNextDevShimScript,
} from "@dignetwork/dig-sdk/next";
import {
  resolveDeployConfig,
  buildDeployArgs,
  buildDeployEnv,
  parseDeployResult,
  parseDigToml,
  devShimScript,
  DEV_SHIM_MARKER,
  type ResolvedDeployConfig,
  type DeployResult,
} from "@dignetwork/dig-sdk/adapters";

// --- Vite plugin: add to vite.config plugins, deploy from a publish script ---
const vitePlugin = digVite({ devWallet: true, devWalletOptions: { address: "xch1dev" } });
void vitePlugin.name;

export async function publishViteSite(): Promise<DeployResult> {
  return digViteDeploy({ message: "ci deploy" });
}

// --- Next adapter: dev shim helpers + deploy the static export ---
const headTag: string = digNextDevShimTag();
const scriptBody: string = digNextDevShimScript({ address: "xch1devnext" });
void headTag;
void scriptBody;

export async function publishNextSite(): Promise<DeployResult> {
  return digNextDeploy({ outputDir: "out" });
}

// --- Pure core: compose your own deploy step ---
const cfg: ResolvedDeployConfig = resolveDeployConfig({
  options: { message: "release" },
  digToml: parseDigToml(`output-dir = "dist"`),
  env: process.env,
});
const argv: string[] = buildDeployArgs(cfg, { skipBuild: true });
const env: Record<string, string> = buildDeployEnv(cfg);
const shim: string = devShimScript();
void argv;
void env;
void shim;
void DEV_SHIM_MARKER;

export function parseExampleResult(stdout: string): DeployResult {
  return parseDeployResult(stdout);
}
