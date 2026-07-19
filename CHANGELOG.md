# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org) and
[Conventional Commits](https://www.conventionalcommits.org).

## [0.4.1] - 2026-07-19

### Tests
- **coverage:** Wire c8 coverage collection with a CI-gated ≥80% floor (lines/functions/branches/statements) and add unit tests for the WalletConnect request/retry loop, the ChiaProvider surface + CHIP-0002 response normalizers, and the Vite/Next framework adapters (#1156)

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


