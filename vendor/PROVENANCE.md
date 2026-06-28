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
