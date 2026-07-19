// The thin Vite + Next framework entrypoints (src/vite.ts, src/next.ts). They compose the tested
// adapter core (dev-shim + deploy) into the shape each framework wires in, so these tests only need
// to assert that composition: the dev-wallet shim is injected (and suppressible) and the helpers
// hand back the expected script/tag/plugin shapes. The deploy path itself is covered by the adapter
// core suite; here we just prove the framework glue passes through correctly.

import test from "node:test";
import assert from "node:assert/strict";
import { digVite } from "../dist/vite.js";
import { digNextDevShimScript, digNextDevShimTag } from "../dist/next.js";
import { DEV_SHIM_MARKER } from "../dist/adapters.js";

test("digVite returns a serve-only plugin that injects the dev shim into <head>", () => {
  const plugin = digVite();
  assert.equal(plugin.name, "dignetwork:vite-plugin-dig");
  assert.equal(plugin.apply, "serve");

  const out = plugin.transformIndexHtml.handler("<html><head></head><body></body></html>");
  assert.ok(out.includes(DEV_SHIM_MARKER), "shim marker injected");
  assert.ok(out.includes("<head>\n<script>"), "shim placed right after <head>");
});

test("digVite prepends the shim when the document has no <head>", () => {
  const out = digVite().transformIndexHtml.handler("<body>hi</body>");
  assert.ok(out.startsWith("\n<script>"), "shim prepended when no <head> to anchor on");
  assert.ok(out.includes(DEV_SHIM_MARKER));
});

test("digVite with devWallet:false injects nothing and passes HTML through unchanged", () => {
  const html = "<html><head></head></html>";
  assert.equal(digVite({ devWallet: false }).transformIndexHtml.handler(html), html);
});

test("digNextDevShimScript / Tag return the shim, the tag wrapped in a <script>", () => {
  const script = digNextDevShimScript();
  assert.ok(script.includes(DEV_SHIM_MARKER));
  assert.equal(digNextDevShimTag(), `<script>${script}</script>`);
});
