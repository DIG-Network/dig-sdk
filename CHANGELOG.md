# Changelog

All notable changes to `@dignetwork/dig-sdk` are documented here. This project follows
[Semantic Versioning](https://semver.org/). While the SDK is pre-1.0, the minor version is the
feature lane (additive, backwards-compatible surface) and the patch version is for fixes.

## 0.2.0

Additive release: new read and monetization surface, agent-friendly self-description, and the
framework-deploy adapters — all backwards compatible with `0.1.0`.

### Added

- **`DigClient` collection reads** — `getCollection({ launcherIds, did? })` returns public
  NFT-collection facts (`did`, `declared_did`, `item_count`, `resolved_count`,
  `royalty_basis_points`), and `listCollectionItems({ launcherIds, offset?, limit? })` returns a
  page of items resolved to their current on-chain owner, royalty, and CHIP-0007 metadata
  (`{ items, offset, limit, total, next_offset }`).
- **`chia://` deploy result** — the deploy adapters parse `digstore deploy --json` into a
  `DeployResult` that surfaces the `chia://` content-open address (`chiaUrl`) alongside the DIGHUb
  view URL (`hubUrl`). `digUrl` is retained as a deprecated alias of `chiaUrl`.
- **`Paywall`** — a high-level pay-to-unlock helper that charges XCH or a CAT (e.g. `$DIG`) to
  unlock content, built on the monetization spends re-exported from `/spend`.
- **Machine-readable self-description** — `SDK_VERSION` (injected from `package.json` at build time)
  and `capabilities()` / `describe()`, which report the SDK's version, modules, wallet/sign methods,
  transports, chains, default RPC, read-crypto wasm digest, and the full error-code catalogue so an
  agent can introspect the surface without reading source.
- **Typed error taxonomy** — every failure carries a stable machine-readable error code.
- **Framework adapters** — `@dignetwork/dig-sdk/adapters`, `/vite`, and `/next` entry points for the
  Vite plugin and Next.js static-export adapter (the building blocks behind
  `@dignetwork/vite-plugin-dig` and `@dignetwork/next-plugin-dig`).

### Changed

- Bumped `@dignetwork/chip35-dl-coin-wasm` to `^0.8.0` (agent-friendly introspection on the spend
  builder), surfaced at the `/spend` subpath.
- UX consistency: the `chia://` content-open URL form, the `DIGHUb` wordmark, and the `$DIG` sigil
  across copy and examples.

### Fixed

- `Paywall` random-nonce generation on Node 18 (no global WebCrypto).

## 0.1.0

Initial release: the typed front door for DIG dapps — `ChiaProvider` (injected `window.chia` /
WalletConnect→Sage wallet surface), `DigClient` (read-crypto: verify + decrypt content by URN), URN
helpers, and the canonical CHIP-0035 spend builder re-exported at the `/spend` subpath. ESM + CJS +
`.d.ts`, browser and Node 18+.
