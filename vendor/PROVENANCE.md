# Vendored artifacts — provenance

These files are vendored copies of the DIG **read-crypto** WASM (`dig_client`) and its
wasm-bindgen ES-module glue. They are **byte-identical** to the artifacts shipped by the rest of
the DIG ecosystem — the `dig-chrome-extension`, the `dig-companion`, and `hub.dig.net` all run the
**same** `dig_client` WASM, which is built from `chip35_dl_coin`'s `dig-client-wasm` crate.

Vendoring them lets the SDK run the **same** verify + decrypt read path those clients use, in
either the browser or Node, with no network round-trip for the crypto.

| File | Source (in the dig_ecosystem monorepo) | Notes |
|---|---|---|
| `dig_client.mjs` | `modules/dig-companion/node/src/vendor/dig_client.mjs` (← `dig-chrome-extension/dig_client.js`) | wasm-bindgen ES-module glue. Copied verbatim, `.mjs` so Node loads it as an ES module. No code changes. |
| `dig_client_bg.wasm` | `modules/dig-companion/node/src/vendor/dig_client_bg.wasm` (← `dig-chrome-extension/dig_client_bg.wasm`) | The read-crypto WASM binary. Copied verbatim. |
| `dig_client.d.ts` | `modules/hub.dig.net/apps/web/public/dig-client/dig_client.d.ts` | The WASM's TypeScript surface. Copied verbatim. |

## Subresource Integrity (SRI)

`dig_client_bg.wasm` SHA-256 (lowercase hex):

```
ff486be806f908a2a90780e499a04dbd34e10e3b97be0470cb9ee841a1e49e77
```

This is the **same digest** asserted by:

- `dig-chrome-extension/background.js` → `DIG_CLIENT_WASM_SHA256`
- `hub.dig.net` `sw.js` and `apps/web/lib/dig-client.js`
- `dig-companion` `node/src/dig-client.js`

The SDK's loader (`src/loader.ts` → `DIG_CLIENT_WASM_SHA256`) re-verifies this digest at load time
and **fails closed** if it does not match — a tampered or wrong WASM refuses to run unverified
crypto, exactly as the extension/companion/hub do.

## Why vendor instead of depend on `@dignetwork/chip35-dl-coin-wasm`?

The published `@dignetwork/chip35-dl-coin-wasm` package exposes **only the CHIP-0035 spend
builder** (mintStore, meltStore, updateStoreMetadata, …) — it does **not** export the read-crypto
(retrievalKey / deriveKey / verifyInclusion / decryptChunk). The read-crypto is a **separate**
wasm artifact (`dig_client`) built from the same repo. So the SDK:

- **depends on** `@dignetwork/chip35-dl-coin-wasm` for spends (re-exported via `@dignetwork/dig-sdk/spend`), and
- **vendors** the `dig_client` read-crypto WASM here (SRI-pinned) for `DigClient`.

## Updating

If the canonical `dig_client` WASM changes (a new `chip35_dl_coin` release → extension/companion
bump), re-copy `dig_client.mjs` + `dig_client_bg.wasm` (+ `dig_client.d.ts`) from the ecosystem,
recompute the SHA-256 of `dig_client_bg.wasm`, and update the `DIG_CLIENT_WASM_SHA256` constant in
`src/loader.ts` **and** the digest above. Keep this digest in lock-step with the
extension/companion/hub.

## Publishing the read-crypto wasm — `@dignetwork/dig-client` (roadmap #16)

The read-crypto wasm is currently **vendored** in *every* consumer (this SDK under `vendor/`, plus
`dig-chrome-extension`, `dig-companion`, and `hub.dig.net`). Each hand-copies the same
`dig_client_bg.wasm` + glue + `.d.ts` and re-asserts the same SHA-256. That is brittle: a wasm bump
means re-copying into four+ repos and hoping the digests stay aligned.

**The fix (#16): publish the wasm once as `@dignetwork/dig-client`, so nobody vendors it again.**

### What dig-sdk ships TODAY (the immediate win — no cross-repo dependency)

`@dignetwork/dig-sdk/dig-client` (built from `src/dig-client-entry.ts`) is the clean, publishable
read-crypto subpath: `DigClient`, the SRI-pinned `loadDigClientWasm`/`configureWasm`,
`DIG_CLIENT_WASM_SHA256`, and the pure URN helpers, all with `.d.ts`. It runs over the wasm vendored
here. **The hub and `dig-embed.js` can already depend on `@dignetwork/dig-sdk/dig-client` instead of
hand-copying the wasm** — that removes most of the duplication now, with the digest enforced in one
place (`src/loader.ts`).

### What must be published in the CANONICAL repo (the cross-repo step — `chip35_dl_coin`)

The wasm is built from `chip35_dl_coin`'s `dig-client-wasm` crate. To stop vendoring entirely, that
repo must publish an npm package (proposed name `@dignetwork/dig-client`) containing:

1. `dig_client_bg.wasm` — the read-crypto binary (the artifact this `vendor/` copies verbatim).
2. `dig_client.mjs` — the wasm-bindgen ES-module glue.
3. `dig_client.d.ts` — the TypeScript surface.
4. A package `exports` map so web + Node both resolve the wasm + glue, and an integrity note
   (the SHA-256) so consumers can SRI-pin it — the **same** digest pinned here.

**Versioning story:** the npm package version tracks the `dig-client-wasm` crate version; each
release records the wasm SHA-256 in its README/CHANGELOG. The digest — not the npm semver — remains
the canonical trust anchor: consumers pin and verify the SHA-256 regardless of the package version,
so a wrong/tampered artifact fails closed even if the version "looks right".

### Wiring dig-sdk to the published package (when it exists) — without breaking the fallback

Once `@dignetwork/dig-client` is published, the ONLY change in dig-sdk is in **`src/loader.ts`**:
resolve the glue + wasm bytes from the published package (e.g. `import.meta.resolve`/a dep import)
*before* falling back to the bytes under `vendor/`. The SRI check (`DIG_CLIENT_WASM_SHA256`) is
unchanged and still gates both paths, so:

- the **public surface of `@dignetwork/dig-sdk/dig-client` does not change** — consumers are
  unaffected;
- the **vendored fallback stays intact** — if the dependency is absent (or its bytes don't match the
  pinned digest), the loader uses `vendor/` exactly as today.

> **TODO (#16, cross-repo):** publish `@dignetwork/dig-client` from `chip35_dl_coin`'s
> `dig-client-wasm` crate (items 1–4 above), then update `src/loader.ts` to prefer it with the
> `vendor/` fallback, keeping `DIG_CLIENT_WASM_SHA256` in lock-step. Until then, the vendored path
> is the source of truth and `@dignetwork/dig-sdk/dig-client` is the consumable entry.
