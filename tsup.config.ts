import { defineConfig } from "tsup";

// Build the SDK to ESM + CJS + .d.ts for both browser and Node 18+.
//
//  • Two entrypoints: the main API ("index") and the spend re-export ("spend").
//  • `esbuildOptions.supported.eval = false` would *reject* eval at build time; we go
//    further and never write eval in source, so the bundle is usable in CSP-strict
//    contexts (no `unsafe-eval`). We also pin `keepNames` so the wasm-bindgen glue's
//    function identities survive minification-free.
//  • The vendored read-crypto wasm + its glue are NOT bundled — they ship as files under
//    `vendor/` (see package.json "files") and are loaded at runtime by src/loader.ts, so
//    the wasm is fetched/SRI-verified lazily and never inlined as a giant base64 blob.
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
  // Never inline these — they are loaded at runtime (vendor glue) or are a peer/dep.
  external: [
    "@dignetwork/chip35-dl-coin-wasm",
    "@walletconnect/sign-client",
  ],
  esbuildOptions(options) {
    // No eval anywhere — keep the bundle CSP-safe (no `unsafe-eval` required).
    options.define = { ...options.define };
    options.legalComments = "none";
  },
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
