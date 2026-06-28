// The `window.chia` DEV shim the adapters inject during `dev`.
//
// In production a dapp's wallet is the REAL injected provider — the DIG Browser's in-process wallet
// (or a CHIP-0002 extension) — which the SDK's ChiaProvider detects on `window.chia` via the
// `isDIG` marker (see src/provider/injected.ts). During local `vite dev` / `next dev` there is no
// such wallet, so calling `ChiaProvider.connect({ mode: "injected" })` would fail and the developer
// couldn't exercise the wallet path at all.
//
// This shim installs a MINIMAL, clearly-labelled stub that satisfies the SAME injected-provider
// contract the SDK detects (`isDIG`, `request({method,params})`, `connect()`), so the wallet code
// path runs end-to-end in dev. It is a STUB, not a wallet: it returns a configurable mock address
// and otherwise throws on methods that would need real signing, so a developer is never misled into
// thinking a signature is real. It is generated as a self-contained, eval-free `<script>` body
// (CSP-safe) that GUARDS on an existing `window.chia`, so a real wallet always wins.
//
// The shim's method names + response envelope mirror src/provider/injected.ts and
// src/provider/methods.ts (the native provider returns `{ data }`), so the SAME normalizers run in
// dev as in production — only the values are mocked.

import { INJECTED_TOPIC } from "../provider/injected.js";

/** A literal substring stamped into the shim so it is unmistakably a dev stub (asserted in tests). */
export const DEV_SHIM_MARKER = "dig-sdk:dev-wallet-shim";

/** Options for the generated dev shim. */
export interface DevShimOptions {
  /** Mock receive address the shim returns from `getAddress`. A clearly-fake default is used. */
  address?: string;
}

/** A clearly-fake default dev address (so it is obvious in the UI this is not a real wallet). */
const DEFAULT_DEV_ADDRESS = "xch1dev0000000000000000000000000000000000000000000000000000devshim";

/** JSON-encode a string for safe inlining into a script literal. */
function lit(s: string): string {
  return JSON.stringify(s);
}

/**
 * Generate the dev-shim `<script>` body (no surrounding `<script>` tags). Inline it into the dev
 * server's served HTML. It is an IIFE that installs `window.chia` ONLY if one is not already
 * present, so the DIG Browser / a real extension always takes precedence. Eval-free and
 * dependency-free — safe under a strict CSP.
 */
export function devShimScript(options: DevShimOptions = {}): string {
  const address = options.address ?? DEFAULT_DEV_ADDRESS;
  // The shim mirrors the injected-provider contract the SDK detects. `request` resolves a small set
  // of read methods with mock data and rejects signing methods (a dev stub must not fake a
  // signature). Method names are the bare CHIP-0002 names the SDK normalizes.
  return [
    `/* ${DEV_SHIM_MARKER} — DEV ONLY. A stub wallet for local development; NOT a real wallet. */`,
    `(function () {`,
    `  "use strict";`,
    `  if (typeof window === "undefined") return;`,
    `  // A real injected wallet (DIG Browser / extension) always wins — never clobber it.`,
    `  if (window.chia) return;`,
    `  var DEV_ADDRESS = ${lit(address)};`,
    `  var TOPIC = ${lit(INJECTED_TOPIC)};`,
    `  function ok(data) { return Promise.resolve({ data: data }); }`,
    `  function nope(method) {`,
    `    return Promise.reject(new Error(`,
    `      "[" + ${lit(DEV_SHIM_MARKER)} + "] '" + method + "' needs a real wallet; the dev shim does not sign. " +`,
    `      "Open in the DIG Browser or connect a wallet to sign for real."));`,
    `  }`,
    `  window.chia = {`,
    `    isDIG: true,        // detected by the SDK's injected-provider check`,
    `    isDevShim: true,    // so the app can tell it is the dev stub`,
    `    topic: TOPIC,`,
    `    connect: function () { return Promise.resolve(true); },`,
    `    request: function (args) {`,
    `      var method = args && args.method ? String(args.method) : "";`,
    `      switch (method) {`,
    `        case "chip0002_connect": return ok(true);`,
    `        case "chip0002_getPublicKeys": return ok([]);`,
    `        case "getAddress":`,
    `        case "chia_getAddress": return ok(DEV_ADDRESS);`,
    `        default:`,
    `          // Signing / spend methods must not be faked.`,
    `          return nope(method);`,
    `      }`,
    `    },`,
    `    on: function () {},`,
    `    off: function () {},`,
    `  };`,
    `  if (window.console && window.console.info) {`,
    `    window.console.info("[" + ${lit(DEV_SHIM_MARKER)} + "] installed a DEV window.chia (mock address " + DEV_ADDRESS + ").");`,
    `  }`,
    `})();`,
  ].join("\n");
}
