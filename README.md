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

### URN helpers (pure)

`parseUrn`, `isUrn`, `reconstructUrn`, `reconstructUrnWithRoot` and the `ParsedUrn` type — the same
URN grammar the hub, extension, and companion use.

### Spend builder

`import * as spend from "@dignetwork/dig-sdk/spend"` re-exports
[`@dignetwork/chip35-dl-coin-wasm`](https://www.npmjs.com/package/@dignetwork/chip35-dl-coin-wasm):
`mintStore`, `meltStore`, `updateStoreMetadata`, `updateStoreOwnership`, `oracleSpend`, `addFee`,
`buildDigPayment`, `dataStoreFromSpend`, `hexSpendBundleToCoinSpends`, `spendBundleToHex`,
`digCatPuzzleHash`, `digTreasuryInnerPuzzleHash`, `digstoreOwnerHint`, `init`.

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
