# @dignetwork/dig-sdk

The typed front door for building dapps on the **DIG Network**. One `npm i` gives you:

- **`ChiaProvider`** — a Chia wallet your dapp gets for free. It prefers the injected **DIG Browser**
  wallet (`window.chia`) and falls back to **WalletConnect → Sage**, behind one normalized
  CHIP-0002 surface (`getAddress`, `signMessage`, `signCoinSpends`, `takeOffer`, balances, coins).
- **`DigClient`** — read **verified, encrypted** content by URN. It derives the URN's keys in the
  browser, verifies inclusion against the on-chain root, and decrypts — the serving host stays
  blind (it only ever relays opaque ciphertext + proofs).
- **`@dignetwork/dig-sdk/spend`** — the canonical CHIP-0035 spend builder
  (`@dignetwork/chip35-dl-coin-wasm`) re-exported. Build store / NFT / CAT spends through the SDK
  and sign them with the wallet. Spends are **never** hand-rolled.
- **`Paywall`** — a high-level **pay-to-unlock** helper. Charge XCH or a CAT (e.g. DIG) to unlock a
  resource, then gate access by verifying the payment — or gate on holding an **NFT** / a
  **collection** membership. It composes `ChiaProvider` with the canonical monetization spends; the
  wasm builds every coin spend, the wallet signs it.
- **Framework adapters** — `@dignetwork/dig-sdk/vite` (a Vite plugin) and `@dignetwork/dig-sdk/next`
  (a Next static-export adapter): inject a `window.chia` dev wallet during `dev`, and ship your
  build to a DIG capsule on a `publish` script. See **[Framework adapters](#framework-adapters)**.
- **`@dignetwork/dig-sdk/dig-client`** — the read-crypto on its own (just `DigClient` + the loader +
  URN helpers), for consumers that want only the read path (e.g. a worker). Same SRI-pinned wasm.

Ships **ESM + CJS + `.d.ts`**, runs in the **browser and Node 18+**, and is **eval-free** (usable
in CSP-strict contexts).

```bash
npm i @dignetwork/dig-sdk
# Optional: only if you use the WalletConnect → Sage fallback
npm i @walletconnect/sign-client
```

---

## Read verified, encrypted content in 5 lines

```ts
import { DigClient } from "@dignetwork/dig-sdk";

const dig = new DigClient();                       // defaults to https://rpc.dig.net
const { bytes, decrypted, verified } = await dig.read({
  urn: "urn:dig:chia:<storeId>/index.html",        // the resource to read
  root: "<onchain-root-hex>",                       // the trust anchor (from the chain)
});
console.log(decrypted, verified, new TextDecoder().decode(bytes));
```

`read()` returns the authenticated **plaintext** when the URN key decrypts the served bytes
(`decrypted: true`); otherwise it returns the raw ciphertext (a decoy is just opaque bytes — the
model is oblivious, so a read is never a "not found" verdict). `verified` is the advisory
inclusion-proof check against `root`. For text, `await dig.readText({ urn, root })` returns the
decoded string (or throws if it didn't decrypt).

A private store adds a salt — either inline in the URN (`…/secret.txt?salt=<hex>`) or as
`dig.read({ urn, root, salt })`.

## Connect a wallet + sign

```ts
import { ChiaProvider } from "@dignetwork/dig-sdk";

// Prefers the injected DIG Browser wallet; falls back to WalletConnect → Sage.
const provider = await ChiaProvider.connect({
  mode: "auto",
  walletConnect: {
    projectId: "<walletconnect-cloud-project-id>",
    metadata: {
      name: "My DIG dapp",
      description: "Built with @dignetwork/dig-sdk",
      url: "https://my-dapp.example",
      icons: ["https://my-dapp.example/icon.png"],
    },
    onUri: (uri) => showWalletConnectQr(uri), // render the QR / copy-link for the fallback
  },
});

const address = await provider.getAddress();
const { publicKey, signature } = await provider.signMessage("Login to My DIG dapp");
// → verify the BLS signature server-side against the CHIP-0002 message hash + publicKey
```

If you only target the DIG Browser, drop `walletConnect` and use `mode: "injected"` (or `"auto"`,
which still prefers injected). `provider.backend` tells you which transport connected.

## Build + sign a store spend

```ts
import { ChiaProvider } from "@dignetwork/dig-sdk";
import * as spend from "@dignetwork/dig-sdk/spend"; // the canonical CHIP-0035 builder

spend.init();
// Build a spend bundle with the wasm builder (e.g. spend.mintStore(...) / spend.updateStoreMetadata(...)),
// then hand its coin spends to the wallet to sign:
const provider = await ChiaProvider.connect({ mode: "injected" });
const aggregatedSignature = await provider.signCoinSpends(/* coinSpends from the builder */ []);
```

The hub builds spend bundles in-browser via this wasm and pushes them to the wallet for signing —
your dapp does the same through the SDK.

## Charge for access (Paywall)

`Paywall` turns the monetization spends into a pay-to-unlock flow. It sources the buyer's coins from
the connected wallet, asks the wasm to build the payment, pushes those coin spends to the wallet to
sign, and hands you back a **receipt** — it never assembles a spend itself.

```ts
import { ChiaProvider, Paywall } from "@dignetwork/dig-sdk";

const provider = await ChiaProvider.connect({ mode: "auto", walletConnect });
const paywall = new Paywall(provider); // chip35 monetization wasm is loaded lazily under a bundler

// Charge 0.25 XCH to unlock a resource (amount is mojos). `memo` derives a deterministic unlock nonce.
const { receipt, signature } = await paywall.requestPayment({
  amount: 250_000_000_000n,
  owner: dappOwnerPuzzleHashHex,
  memo: `unlock:${resourceId}:${userId}`,
});

// …or charge a CAT (e.g. DIG) by passing its tail hash:
await paywall.requestPayment({ amount: 100n, owner: dappOwnerPuzzleHashHex, assetId: digTailHashHex });

// Later, gate access by re-checking the on-chain payment against the receipt:
const { ok } = await paywall.verifyReceipt({
  observed: observedPayment, // an ObservedPayment you filled in after reading the owner's coin
  owner: dappOwnerPuzzleHashHex,
  minAmount: 250_000_000_000n,
});
if (ok) grantAccess();

// Or gate on holding an NFT (or a collection membership) instead of a payment:
const access = await paywall.proveAccess({ parentSpend, owner, nft: nftLauncherIdHex });
// const access = await paywall.proveAccess({ parentSpend, owner, collection: creatorDidHex });
```

> No bundler? Pass the spend builder in yourself — `new Paywall(provider, { spends })`, where
> `spends` is `import * as spends from "@dignetwork/dig-sdk/spend"` (or the chip35 module). The
> builder is always the canonical wasm; the Paywall only orchestrates it.

---

## API surface

### `ChiaProvider`

| Member | Description |
|---|---|
| `static connect(options)` | Connect a wallet. `mode`: `"auto"` (default, prefer injected) / `"injected"` / `"walletconnect"`. |
| `connectWallet(options)` | Convenience alias for `ChiaProvider.connect`. |
| `backend` / `session` | The connected transport (`"injected"` \| `"walletconnect"`) and session descriptor. |
| `getAddress()` | The wallet's receive address (cached). |
| `getPublicKeys()` | The wallet's synthetic public keys. |
| `signMessage(message, address?)` | Sign a UTF-8 message; returns `{ publicKey, signature }` (0x-normalized). |
| `signCoinSpends(coinSpends)` | Sign raw CHIP-0035 coin spends (partialSign); returns the aggregated signature hex. |
| `takeOffer(offer, fee?)` | Accept a Chia offer string (e.g. an NFT offer). |
| `getXchBalance()` / `getCatBalance(assetId)` | Spendable balances (mojo/base-unit strings). |
| `getXchCoins(limit?)` / `getCatCoins(assetId, limit?)` | Unspent coins for funding a spend. |
| `request(method, params?)` | Escape hatch: a raw CHIP-0002 request through the active transport. |
| `supports(method)` / `disconnect()` | Capability check / teardown. |

Transports are also exported directly (`InjectedTransport`, `WalletConnectTransport`,
`isInjectedAvailable`, `getInjectedProvider`) for advanced flows (e.g. restoring a WC session via
`WalletConnectTransport.restore(...)`).

### `DigClient`

| Member | Description |
|---|---|
| `new DigClient({ rpc?, fetch? })` | RPC defaults to `https://rpc.dig.net`. |
| `read({ urn, root?, salt? }, opts?)` | Fetch + verify + decrypt → `{ bytes, verified, decrypted, … }`. |
| `readText({ urn, root?, salt? }, opts?)` | As `read`, decoded to a UTF-8 string (throws if not decrypted). |
| `readResource({ storeId, resourceKey, root, salt? }, opts?)` | Read by explicit parts instead of a URN. |
| `deriveUrnKeys({ urn, salt? })` | The root-independent `{ retrievalKey, decryptionKey }` for a URN. |
| `retrievalKey(storeId, key)` / `deriveKey(storeId, key, salt?)` | The individual derivations. |
| `verifyInclusion(ciphertext, proof, root)` / `reconstructUrn(...)` | Lower-level read-crypto. |
| `wasm()` | The raw SRI-verified read-crypto wasm (`decryptChunk`, `encryptResource`, `version`, …). |

### `Paywall`

| Member | Description |
|---|---|
| `new Paywall(provider, { spends? })` | Wrap a connected `ChiaProvider`. `spends` defaults to a lazy `import("@dignetwork/chip35-dl-coin-wasm")` (pass it for non-bundler runtimes). |
| `requestPayment({ amount, owner, assetId?, memo?, nonce?, fee?, coinLimit? })` | Build the payment via the wasm (`buildPayment` XCH / `buildCatPayment` CAT) and push it to the wallet to sign. Returns `{ signature, receipt, coinSpends, nonce }`. |
| `verifyReceipt({ observed, owner, minAmount, asset?, nonce? })` | Verify an observed on-chain payment unlocks the paywall (wasm `verifyPaymentReceipt`). Returns `{ ok, error? }`. |
| `proveAccess({ parentSpend, owner, nft? \| collection? })` | Prove NFT ownership (`proveNftOwnership`) or collection membership (`proveCollectionMembership`). Returns `{ ok, proof?, error? }`. |

`amount` / `minAmount` / `fee` accept a `number` or `bigint`; hashes/ids/nonces are hex (with or
without `0x`). The Paywall holds **no** spend-assembly logic — if the canonical wasm builder is
unavailable it throws rather than fabricate a spend.

### URN helpers (pure)

`parseUrn`, `isUrn`, `reconstructUrn`, `reconstructUrnWithRoot` and the `ParsedUrn` type — the same
URN grammar the hub, extension, and companion use.

### Spend builder

`import * as spend from "@dignetwork/dig-sdk/spend"` re-exports
[`@dignetwork/chip35-dl-coin-wasm`](https://www.npmjs.com/package/@dignetwork/chip35-dl-coin-wasm)
(≥ 0.7.0): store coins (`mintStore`, `meltStore`, `updateStoreMetadata`, `updateStoreOwnership`,
`oracleSpend`), assets (`mintNft`, `bulkMint`, `createDid`, `issueCat`), CHIP-0007 metadata
(`buildChip0007Metadata`, `validateChip0007`, `generateItemMetadata`), offers (`encodeOffer`,
`decodeOffer`), monetization (`buildPayment`, `buildCatPayment`, `paymentNonce`,
`verifyPaymentReceipt`, `proveNftOwnership`, `proveCollectionMembership` — these back the
[`Paywall`](#paywall) helper), and helpers (`addFee`, `dataStoreFromSpend`,
`hexSpendBundleToCoinSpends`, `spendBundleToHex`, `digstoreOwnerHint`, `sha256`, `init`).

---

## Framework adapters

Make DIG a first-class deploy target for the frameworks you already use. Each adapter does two
things: injects a **`window.chia` dev wallet** during local `dev` (the same injected-provider
contract `ChiaProvider` detects in production, so the wallet path runs end-to-end locally), and
ships your build to a **DIG capsule** via `digstore deploy --json` on a `publish` script.

> Deploying **spends DIG** (each deploy publishes a new capsule), so it is a deliberate, credentialed
> step — never wired into the default `build`. Config + secrets are read from your project's
> `dig.toml` and `DIGSTORE_*` env vars, exactly like `digstore deploy`; the deploy key and store
> salt come from the env only (never argv) so they don't leak. Requires the `digstore` CLI on PATH.

### Vite — `@dignetwork/dig-sdk/vite`

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { digVite } from "@dignetwork/dig-sdk/vite";

export default defineConfig({
  plugins: [digVite()], // injects the window.chia dev shim during `vite dev`
});
```

```jsonc
// package.json — opt in to deploy with a publish script (after the build)
{
  "scripts": {
    "publish:dig": "vite build && node -e \"import('@dignetwork/dig-sdk/vite').then(m => m.digDeploy())\""
  }
}
```

`digDeploy()` shells out to `digstore deploy --json`, ships the build dir to a new capsule, and
prints the `dig://` + `https://hub.dig.net/stores/<id>` URL. Disable the dev shim with
`digVite({ devWallet: false })`; set its mock address with `digVite({ devWalletOptions: { address } })`.

### Next.js (static export) — `@dignetwork/dig-sdk/next`

Next has no Vite-style HTML hook, so the dev shim is a helper you drop into your `<head>` (guarded to
dev), and `digDeploy()` ships the `out/` static export:

```tsx
// app/layout.tsx — dev-only window.chia shim
import { digNextDevShimTag } from "@dignetwork/dig-sdk/next";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        {process.env.NODE_ENV !== "production" && (
          <script dangerouslySetInnerHTML={{ __html: digNextDevShimTag().replace(/^<script>|<\/script>$/g, "") }} />
        )}
      </head>
      <body>{children}</body>
    </html>
  );
}
```

```jsonc
// package.json — deploy the static export (next.config: `output: "export"`)
{
  "scripts": {
    "publish:dig": "next build && node -e \"import('@dignetwork/dig-sdk/next').then(m => m.digDeploy())\""
  }
}
```

`digDeploy()` defaults the output dir to `out` (Next's export dir); override any field via
`digDeploy({ outputDir, storeId, message, … })` or `dig.toml`.

### Configuration

Both adapters resolve config with this precedence: **`digDeploy()` options > `DIGSTORE_*` env >
`dig.toml` > defaults** (mirroring `digstore deploy`). Common keys: `store-id`, `output-dir`,
`message`, `network`, `remote` (in `dig.toml`); secrets `DIGSTORE_DEPLOY_KEY` and (private stores)
`DIGSTORE_STORE_SALT` from the env. The pure building blocks (config resolution, deploy-arg
construction, the dev-shim string, the `dig.toml` reader) are exported from
`@dignetwork/dig-sdk/adapters` if you want to compose your own deploy step.

---

## Key concepts

- **URN** — `urn:dig:chia:<storeId>[:<root>]/<resourceKey>[?salt=<hex>]` addresses one resource in
  a store. The retrieval + decryption keys are **root-independent** (the root is only the trust
  anchor for verification).
- **Oblivious / blind host** — the dig RPC returns indistinguishable ciphertext for any retrieval
  key, so presence is unknowable. The client decrypts what it can; it never asks the host "is this
  present?".
- **Trust anchor** — content is verified against an **on-chain root** that *you* resolve from the
  chain (coinset.org / the store singleton) and pass to `read({ root })`. The serving host can
  never be the trust anchor.

## Read-crypto wasm provenance

`DigClient` runs the **same** `dig_client` read-crypto WASM the DIG Browser, the
`dig-chrome-extension`, the `dig-companion`, and `hub.dig.net` use. It is vendored under `vendor/`,
pinned by SHA-256 (`ff486be8…`), and **SRI-verified at load** — a tampered or wrong artifact
**fails closed** rather than running unverified crypto. See `vendor/PROVENANCE.md`.

### CSP-strict / no-bundler browsers

The wasm is loaded lazily; in a bundler that resolves package files it is found automatically. If
your environment can't resolve the vendored files (or your CSP blocks runtime fetches), fetch +
verify the bytes yourself and hand them in **before** the first read:

```ts
import { configureWasm } from "@dignetwork/dig-sdk";
configureWasm({ wasmBytes: myVerifiedBytes, glueUrl: "/dig-client/dig_client.mjs" });
```

## License

MIT
