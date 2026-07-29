# Runbook — `@dignetwork/dig-sdk`

Operational runbook for the typed integration SDK. Two parts: (a) the release/publish flow, and
(b) building + testing locally.

## (a) Release — publish to npm

The SDK ships to npm as **`@dignetwork/dig-sdk`**. Publishing is fully tag-driven; you do NOT hand
push tags or run `npm publish` — the workflows own both.

**Flow (per-merge tag):**

1. On a feature branch, bump `package.json` `version` per SemVer (§2.4) as the last change before
   merge. The `ensure-version-increment` gate FAILS a PR whose version does not increase vs `main`.
2. Merge the PR to `main` (squash — one Conventional Commit).
3. **`release.yml`** (`on: push: main`) regenerates `CHANGELOG.md` from the Conventional Commits with
   git-cliff, commits it to `main`, then tags that commit `vX.Y.Z` and pushes the tag. The changelog
   is therefore included in the tag. It is idempotent — a no-op if the version's tag already exists,
   and it skips its own `chore(release):` commit.
4. The pushed `v*` tag (and the published GitHub Release) triggers **`publish-npm.yml`**, which
   builds (ESM + CJS + `.d.ts`), runs typecheck + tests, then `npm publish --access public`. The
   version published is whatever is in `package.json` on the released commit.

**Credentials / secrets:**

- **npm publish** uses npm **Trusted Publishing (OIDC)** — there is **no `NPM_TOKEN`**. npm exchanges
  the workflow run's GitHub OIDC token for a short-lived publish token, so the npm-side trusted
  publisher MUST be configured for org `DIG-Network`, repo `dig-sdk`, workflow `publish-npm.yml`.
  (Requires npm CLI ≥ 11.5.1; the workflow upgrades npm because Node 22 bundles npm 10.)
- **`RELEASE_TOKEN`** (a classic PAT, org-admin identity) pushes the changelog commit + tag in
  `release.yml`. A tag pushed by the default `GITHUB_TOKEN` would NOT trigger `publish-npm.yml`
  (GitHub anti-recursion), and the changelog commit must pass branch protection
  (`enforce_admins = false`). NEVER print or commit the PAT.

**Verify it went live:**

- `gh run watch <id>` for the `publish-npm` run → green.
- `npm view @dignetwork/dig-sdk version` shows the new `X.Y.Z`.
- The GitHub Release `vX.Y.Z` exists with the git-cliff changelog notes.

## (b) Local build + test

**Prereqs:** Node ≥ 18 (CI tests on 18/20; publish runs on 22), npm.

**Install:**

```sh
npm ci        # reproducible install from package-lock.json
```

**Build (ESM + CJS + d.ts via tsup):**

```sh
npm run build
```

**Test + coverage** (tests import from `dist/`, so `npm run build` first):

```sh
npm run build && npm test        # node --test over test/*.test.mjs
npm run coverage                 # c8 node --test — coverage must stay ≥ 80%
```

**The full local gate** (mirrors CI — run before opening/merging a PR):

```sh
npm run verify   # lint → format:check → typecheck → build → test
```

Individually: `npm run lint` (ESLint, zero errors), `npm run format:check` (Prettier),
`npm run typecheck` (`tsc --noEmit`), `npm run test:examples` (typecheck the `examples/`).
