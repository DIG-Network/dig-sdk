# Contributing to @dignetwork/dig-sdk

Thanks for your interest in improving the SDK. This is the typed front door dapps use to talk to
the DIG Network (`ChiaProvider`, `DigClient`, the CHIP-0035 spend builder, `Paywall`, and the
Vite/Next framework adapters) — please read this before opening a PR.

## Reporting an issue

File at [github.com/DIG-Network/dig-sdk/issues](https://github.com/DIG-Network/dig-sdk/issues).
Include: what you observed, what you expected, and a minimal repro (a code snippet or a failing
test is ideal).

## Prerequisites

- **Node >= 18** (`package.json` `engines`). CI runs the suite on both Node 18 and Node 20.
- No wallet or mainnet connection needed to develop or test. The unit suite drives `ChiaProvider`
  through a mock transport (see `test/chia-provider.test.mjs`) so every fallback branch — DIG
  Browser injected wallet, WalletConnect → Sage — is exercised without a real wallet or chain
  call.

## Build & test

```bash
npm ci

# build ESM + CJS + .d.ts
npm run build

# unit + integration tests (mocked transport, no network)
npm test

# same, with coverage (must clear the 80% gate — see .c8rc.json)
npm run coverage

# typecheck the README code examples against the built .d.ts, so docs can't drift
npm run test:examples

# everything CI runs, in one shot
npm run verify
```

## The gate (must pass before a PR is merged)

CI (`.github/workflows/ci.yml`) runs the following on every push and PR, on Node 18 and Node 20:

```bash
npm run lint          # eslint, zero errors
npm run format:check  # prettier --check
npm run typecheck     # tsc --noEmit
npm run build         # tsup: ESM + CJS + .d.ts
npm run test:examples # README examples typecheck against the built types
npm run coverage      # node --test under c8, gated at 80% lines/functions/branches/statements
```

Two more required checks run on every PR to `main`:

- **Commitlint** (`.github/workflows/commitlint.yml`) — every commit message and the PR title must
  follow [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): summary`).
- **Version increment** (`.github/workflows/ensure-version-increment.yml`) — `package.json`
  `version` must be higher than on `main`. Bump it as the last step before opening the PR: patch
  for a compatible fix, minor for a compatible new capability, major for a breaking change.

## Pull requests

`main` is protected: PRs only, all of the checks above green, and every review thread (including
any GitHub Advanced Security / CodeQL finding) resolved before a squash-merge. On merge,
`release.yml` cuts the matching `vX.Y.Z` tag, which triggers `publish-npm.yml` to publish the
package to npm.

1. Branch from `main`.
2. Make the gate green locally (`npm run verify`, plus `npm run coverage`).
3. Bump `package.json` `version`.
4. Open a PR with a clear description of the change and its rationale, and a Conventional Commit
   title. Keep the diff focused.

## Where things live

| Path | Responsibility |
|---|---|
| `src/provider/` | `ChiaProvider` — CHIP-0002 wallet abstraction (DIG Browser wallet, WalletConnect/Sage fallback) |
| `src/dig-client.ts` / `src/dig-client-entry.ts` | `DigClient` — read, verify, and decrypt content by URN |
| `src/spend.ts` | The CHIP-0035 spend builder, re-exporting `@dignetwork/chip35-dl-coin-wasm` |
| `src/paywall.ts` / `src/collection.ts` | `Paywall` — pay-to-unlock and NFT/collection-gated access |
| `src/adapters*.ts` | The Vite and Next.js framework adapters |
| `src/urn.ts` | URN parsing + the retrieval-key derivation |
| `conformance/` | Cross-repo conformance fixtures (e.g. URN parsing) shared with other DIG repos |
| `test/` | The `node --test` suite (mocked transports, no live network) |

Spends are never hand-rolled: this package only ever builds them through
`@dignetwork/chip35-dl-coin-wasm` and has the wallet sign them.
