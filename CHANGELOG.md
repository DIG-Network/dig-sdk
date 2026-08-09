# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org) and
[Conventional Commits](https://www.conventionalcommits.org).

## [0.6.2] - 2026-08-09

### Security
- **dig-client:** Redact the private-store `?salt=` secret from every `DigSdkError` context so a
  logged error can't republish it; centralized in the `DigSdkError` constructor (#2303).
- **dig-client:** Bound an untrusted node's declared `total_length` against a 512 MiB ceiling before
  allocating the reassembly buffer, refusing an oversized/unallocatable length with the new
  `RESOURCE_TOO_LARGE` error — closes a cheap pre-verification allocation DoS (#2303).

## [0.6.1] - 2026-08-07

### Features
- **dig-sdk:** Fail-closed readVerified sibling + rootIsPinned; keep read() oblivious (#2262) (#11)

## [0.5.0] - 2026-08-06

### Bug Fixes
- **dig-sdk:** Implement the §5.3 node-resolution ladder (#2134)

## [0.4.4] - 2026-08-06

### Chores
- Add .gitattributes to pin LF line endings (#2198)

## [0.4.3] - 2026-07-29

### Chores
- **dig-sdk:** Docs/DRY polish — SPEC read-crypto, hex.ts, README test, runbook (#1807)

## [0.4.2] - 2026-07-29

### Bug Fixes
- **sdk:** Dig.toml key precedence + eslint/prettier gates + scope SRI docs (#7)

## [0.4.1] - 2026-07-19

### Testing
- **dig-sdk:** Add c8 coverage gate (≥80%) + WalletConnect/provider transport tests (§2.3) (#6)

## [0.4.0] - 2026-07-18

### Features
- **spend:** Re-export bulkMintFunded via chip35 0.13.0 bump (#305)

## [0.3.3] - 2026-07-18

### Chores
- **dig-sdk:** Retarget read-crypto dep to @dignetwork/dig-capsule-wasm (#987) (#4)

## [0.3.2] - 2026-07-07

### Bug Fixes
- Use bare node --test to fix Node 22 directory-arg incompatibility (#3)

## [0.3.1] - 2026-07-07

### CI
- Publish via npm trusted publishing (OIDC), retire NPM_TOKEN (#2)

## [0.3.0] - 2026-07-06

### Features
- **provider:** Dual Browser Wallet vs WalletConnect connector chooser

## [0.2.1] - 2026-07-04

### CI
- Enforce version increment in PRs (package.json / Cargo.toml)- Enforce Conventional Commits with commitlint on PRs- Enforce Conventional Commits with commitlint on PRs- Auto-publish npm on version tag + changelog/tag on merge (#230 auto-publish-everything)

### Chores
- **changelog:** Add git-cliff config for Conventional-Commit changelog


