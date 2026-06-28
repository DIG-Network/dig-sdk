// `@dignetwork/dig-sdk/next` — a Next.js static-export adapter for shipping to DIG.
//
// Next has no Vite-style `transformIndexHtml` hook, so the two jobs are surfaced as helpers a Next
// project wires in:
//   1. DEV: `digNextDevShimTag()` returns a ready `<script …>` string to drop into the app's
//      `<head>` (e.g. in `app/layout.tsx` or `_document`) so `next dev` has the SDK's `window.chia`
//      dev shim — the SAME injected-provider contract production uses. It guards on a real wallet
//      and is eval-free. Gate it on `process.env.NODE_ENV !== "production"` in your layout so it
//      ships only in dev.
//   2. PUBLISH: `digDeploy()` ships the static-export output (`out/` by default — what
//      `next build` writes with `output: "export"`) to a DIG capsule via `digstore deploy --json`,
//      printing the dig:// + DIGHub URL. Call it from a `publish` script after the build.
//
// Next is an OPTIONAL peer: this module imports nothing from "next". The publish runner is the
// shared Node-only `runDeploy`.

import { devShimScript, type DevShimOptions } from "./adapters/dev-shim.js";
import type { AdapterOptions } from "./adapters/config.js";
import type { DeployResult } from "./adapters/deploy.js";
import { runDeploy } from "./adapters/run.js";

/** Next static-export writes here by default (`output: "export"`). */
const NEXT_EXPORT_DIR = "out";

/**
 * The raw dev-shim script BODY (no `<script>` tags) — for callers that inject it themselves (e.g.
 * via Next's `<Script id=… dangerouslySetInnerHTML>` or a custom `_document`).
 */
export function digNextDevShimScript(options: DevShimOptions = {}): string {
  return devShimScript(options);
}

/**
 * A ready-to-inline `<script>…</script>` tag carrying the dev shim. Drop into the app `<head>`
 * (guard on dev): e.g. in `app/layout.tsx`
 * `{process.env.NODE_ENV !== "production" && <head dangerouslySetInnerHTML={{ __html: digNextDevShimTag() }} />}`.
 * Prefer `digNextDevShimScript()` with Next's `<Script>` component when you can.
 */
export function digNextDevShimTag(options: DevShimOptions = {}): string {
  return `<script>${devShimScript(options)}</script>`;
}

/**
 * Deploy the Next static export to a DIG capsule. Call from a `publish` script AFTER
 * `next build` (with `output: "export"`). Defaults `outputDir` to `out` (Next's export dir); reads
 * `dig.toml` + env (DIGSTORE_*) for the rest. The adapter has already built, so digstore stages the
 * existing `out/` rather than rebuilding.
 */
export function digDeploy(options: AdapterOptions = {}): Promise<DeployResult> {
  return runDeploy({ ...options, outputDir: options.outputDir ?? NEXT_EXPORT_DIR, skipBuild: true });
}

export default digDeploy;
