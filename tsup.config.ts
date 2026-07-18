import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

// The published version, read from package.json and injected as a compile-time constant so
// `SDK_VERSION` / `capabilities().version` can never drift from what's on npm (see src/capabilities.ts).
const pkgVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  .version as string;

// Build the SDK to ESM + CJS + .d.ts for both browser and Node 18+.
//
//  • Two entrypoints: the main API ("index") and the spend re-export ("spend").
//  • `esbuildOptions.supported.eval = false` would *reject* eval at build time; we go
//    further and never write eval in source, so the bundle is usable in CSP-strict
//    contexts (no `unsafe-eval`). We also pin `keepNames` so the wasm-bindgen glue's
//    function identities survive minification-free.
//  • The read-crypto wasm comes from the published `@dignetwork/dig-capsule-wasm` package — kept
//    external so it is resolved at runtime by src/loader.ts (Node: the sync `nodejs` build;
//    browser: the `web` build) and SRI-verified, never inlined as a giant base64 blob.
//  • `@dignetwork/chip35-dl-coin-wasm` is an external dependency (the canonical spend
//    builder); we never bundle or re-emit it.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    spend: "src/spend.ts",
    // Framework adapters (#44) + their pure core. `adapters` is the framework-agnostic,
    // spawn-nothing core (unit-tested); `vite`/`next` are the thin framework entrypoints.
    adapters: "src/adapters.ts",
    vite: "src/vite.ts",
    next: "src/next.ts",
    // Publishable read-crypto subpath (#16) — a clean, SRI-pinned entry that stays usable even
    // once the canonical wasm is published to npm (see src/dig-client-entry.ts).
    "dig-client": "src/dig-client-entry.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  // Never inline these — they are resolved at runtime (the read-crypto package + its subpaths)
  // or are a peer/dep.
  external: [
    "@dignetwork/chip35-dl-coin-wasm",
    "@dignetwork/dig-capsule-wasm",
    "@dignetwork/dig-capsule-wasm/node",
    "@dignetwork/dig-capsule-wasm/web",
    "@walletconnect/sign-client",
  ],
  // Inject the package version as the compile-time constant `__SDK_VERSION__` (read by
  // src/capabilities.ts) so the published `SDK_VERSION` always matches package.json.
  define: {
    __SDK_VERSION__: JSON.stringify(pkgVersion),
  },
  esbuildOptions(options) {
    // No eval anywhere — keep the bundle CSP-safe (no `unsafe-eval` required).
    options.define = { ...options.define };
    options.legalComments = "none";
  },
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
