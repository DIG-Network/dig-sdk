// `@dignetwork/dig-sdk/vite` — a Vite plugin that makes DIG a first-class deploy target.
//
// Two jobs:
//   1. DEV: during `vite dev` it injects the SDK's `window.chia` dev shim into the served HTML, so a
//      plain browser (no DIG Browser, no extension) still has an injected wallet to develop against
//      — the SAME injected-provider contract the SDK's ChiaProvider detects in production.
//   2. PUBLISH: it exposes `digDeploy()` — call it from a `publish` script (after `vite build`) to
//      shell out to `digstore deploy --json`, shipping the build dir → a new capsule and printing
//      the chia:// content-open URL + the DIGHUb view URL. (Deploy is a deliberate, credentialed
//      step — it spends $DIG — so it is NOT wired into the default `vite build`; opt in via a
//      `publish` script.)
//
// Vite is an OPTIONAL peer dependency: this module declares no hard import of "vite". The returned
// object is a structurally-valid Vite Plugin (name + transformIndexHtml), typed loosely so the SDK
// builds without vite installed.

import { devShimScript, type DevShimOptions } from "./adapters/dev-shim.js";
import type { AdapterOptions } from "./adapters/config.js";
import type { DeployResult } from "./adapters/deploy.js";
import { runDeploy } from "./adapters/run.js";

/** Options for {@link digVite}. */
export interface DigVitePluginOptions {
  /**
   * Inject the dev `window.chia` shim during `vite dev`. Default: true. The shim never clobbers a
   * real injected wallet (it guards on an existing `window.chia`).
   */
  devWallet?: boolean;
  /** Dev-shim options (e.g. the mock address it returns). */
  devWalletOptions?: DevShimOptions;
}

// A minimal structural type for the Vite plugin shape we return, so we don't depend on "vite".
interface VitePluginLike {
  name: string;
  apply?: "serve" | "build";
  transformIndexHtml?: {
    order: "pre";
    handler: (html: string) => string;
  };
}

/**
 * The Vite plugin. Add to `vite.config` `plugins: [digVite()]`. Injects the dev wallet shim in
 * `vite dev`; deploys are run separately via {@link digDeploy} (or the `digDeploy` re-export) from a
 * `publish` script.
 */
export function digVite(options: DigVitePluginOptions = {}): VitePluginLike {
  const injectDev = options.devWallet !== false;
  const shim = injectDev ? devShimScript(options.devWalletOptions) : "";

  return {
    name: "dignetwork:vite-plugin-dig",
    // The dev shim is only meaningful for the dev server.
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler(html: string): string {
        if (!injectDev) return html;
        const tag = `\n<script>${shim}</script>\n`;
        // Inject as early as possible so window.chia exists before app code runs.
        if (html.includes("<head>")) return html.replace("<head>", `<head>${tag}`);
        return tag + html;
      },
    },
  };
}

/**
 * Deploy the built site to a DIG capsule. Call from a `publish` npm script AFTER `vite build`
 * (e.g. `"publish:dig": "vite build && node -e \"import('@dignetwork/dig-sdk/vite').then(m=>m.digDeploy())\""`).
 * Reads `dig.toml` + env (DIGSTORE_*) for config + secrets. The adapter has already built, so it
 * tells digstore to stage the existing output dir rather than rebuild.
 */
export function digDeploy(options: AdapterOptions = {}): Promise<DeployResult> {
  return runDeploy({ ...options, skipBuild: true });
}

export default digVite;
