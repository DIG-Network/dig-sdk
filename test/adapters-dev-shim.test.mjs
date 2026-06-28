// Dev-shim injection string — the pure string the Vite plugin / Next adapter inject into the dev
// server's HTML so a plain browser (no DIG Browser, no extension) gets a `window.chia` during
// `dev`. It mirrors the SDK's injected-provider contract (InjectedChiaProvider): an object with
// `isDIG`, `request({method,params})`, and `connect()`. The shim must be eval-free and must clearly
// mark itself a DEV stub so it is never mistaken for a real wallet.

import test from "node:test";
import assert from "node:assert/strict";
import { devShimScript, DEV_SHIM_MARKER } from "../dist/adapters.js";

test("devShimScript: defines window.chia with the injected-provider contract", () => {
  const s = devShimScript();
  assert.match(s, /window\.chia/);
  assert.match(s, /isDIG/);
  assert.match(s, /request/);
  assert.match(s, /connect/);
});

test("devShimScript: is marked as a DEV stub (not a real wallet)", () => {
  const s = devShimScript();
  assert.ok(s.includes(DEV_SHIM_MARKER), "must carry the dev-shim marker");
  assert.match(s, /dev/i);
});

test("devShimScript: is eval-free (CSP-safe) — no eval/new Function", () => {
  const s = devShimScript();
  assert.ok(!/\beval\s*\(/.test(s), "no eval()");
  assert.ok(!/new\s+Function\s*\(/.test(s), "no new Function()");
});

test("devShimScript: does not clobber a real injected provider", () => {
  const s = devShimScript();
  // It must guard on an existing window.chia so the DIG Browser / a real extension wins.
  assert.match(s, /window\.chia\s*(\|\||=|\?)/);
});

test("devShimScript: accepts a configured mock address and echoes it", () => {
  const addr = "xch1devmockaddress";
  const s = devShimScript({ address: addr });
  assert.ok(s.includes(addr), "the configured dev address must appear in the shim");
});

test("devShimScript: is a self-contained IIFE script body (injectable as-is)", () => {
  const s = devShimScript();
  // No bare import/export — it is inlined into a <script>, not imported as a module.
  assert.ok(!/^\s*import\s/m.test(s), "no top-level import");
  assert.ok(!/^\s*export\s/m.test(s), "no top-level export");
});
