# dig-sdk — normative specification

This is the authoritative contract for **`@dignetwork/dig-sdk`**'s wallet-connector surface —
`ChiaProvider`, the two `WalletTransport` backends (injected `window.chia` / WalletConnect→Sage),
and the connector-selection API (`ConnectOptions`, `ChiaProvider.listConnectors`). An independent
reimplementation of this surface MUST behave as described here. Keywords **MUST**, **MUST NOT**,
**SHOULD**, and **MAY** are used in the RFC 2119 sense. Field/type names are the exported public
surface and are stable contracts.

The SDK's other pillars — `DigClient` (read-crypto), `Paywall` (monetization), the `/spend`
CHIP-0035 re-export, and the Vite/Next framework adapters — are documented in `README.md`; their
normative contracts land in this file as they are substantially touched. The read-crypto surface
`DigClient` consumes is normatively specified in §7; the `Paywall`'s coin management — capped
high-value-first selection and consolidation — in §8.

---

## 1. Wallet transports

A `WalletTransport` is the low-level channel `ChiaProvider` issues CHIP-0002 RPCs through. Exactly
two backends exist:

| `backend`         | Description                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `"injected"`      | The DIG Browser's in-process wallet (or a compatible CHIP-0002 extension) exposed as `window.chia`. No relay, no pairing, no QR. |
| `"walletconnect"` | WalletConnect v2 → Sage, over the WalletConnect relay. Requires `@walletconnect/sign-client` (optional peer dependency).         |

Every `WalletTransport` implementation MUST expose:

| Member                                      | Contract                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`                                   | The `WalletBackend` this transport is (`"injected"` \| `"walletconnect"`), fixed at construction.                                                              |
| `chain`                                     | The CAIP-2 chain id this transport is bound to.                                                                                                                |
| `topic`                                     | A session identifier: the real WalletConnect relay topic, or the fixed sentinel `"injected"` for the injected backend.                                         |
| `supports(method): boolean`                 | True iff the active session grants `method`. An empty/unknown grant set MUST be treated as "granted" (fail open on capability, fail closed on the actual RPC). |
| `request(method, params): Promise<unknown>` | Issue one CHIP-0002 RPC. MUST reject with a `DigSdkError` (never a bare `Error`) when the method is unsupported or the transport fails.                        |
| `disconnect(): Promise<void>`               | Best-effort teardown. MUST NOT throw for an already-torn-down session.                                                                                         |

### 1.1 Injected transport (`InjectedTransport`)

- Detection (`isInjectedAvailable`) keys on the **unspoofable `isDIG` marker** the DIG Browser sets
  on its `window.chia` provider, NOT merely the presence of `window.chia` — a different Chia
  provider could also define that global. `isInjectedAvailable({ anyChia: true })` widens
  detection to any object at `window.chia` exposing a `request` function.
- `connect(eager)` MUST call the provider's own `connect(eager)` when present, blocking until the
  user approves/rejects the origin. A provider without a `connect` method (an older build) MUST be
  tolerated — `request()` gates capability per-method instead.
- `supports(method)` is a static allowlist over `WALLET_METHODS` — the injected wallet returns the
  full canonical method set (Sage-shaped responses), so there is no per-session negotiation.
- `topic` is always the fixed sentinel `"injected"` (there is no relay topic for this backend).

### 1.2 WalletConnect transport (`WalletConnectTransport`)

- `optionalNamespaces` ONLY — Sage rejects `requiredNamespaces`. The namespace advertises the full
  `WALLET_METHODS` set for the configured `chain`.
- Every `request()` races the underlying WC request against a per-request timeout
  (`requestTimeoutMs`, default `60_000`ms) and rejects `WALLET_TIMEOUT` on expiry (a backgrounded
  mobile Sage can otherwise hang forever).
- `request()` retries ONLY a transient relay-PUBLISH failure (the request never reached Sage), up
  to 3 attempts with linear backoff (`1200ms * attempt`). A response timeout or a wallet/user
  rejection MUST propagate immediately — a retry after Sage already surfaced a prompt would
  double-prompt the user.
- `restore(options)` reconnects to an existing WC session (most-recent-first) that grants at least
  one `SIGN_METHODS` entry — a session that cannot sign is useless to the SDK's normalized surface
  and MUST be skipped.
- The `@walletconnect/sign-client` import is dynamic (lazy) so the rest of the SDK loads without
  it; a missing/malformed module surfaces as `WC_DEPENDENCY_MISSING`, never a raw import error.

---

## 2. `ChiaProvider`

`ChiaProvider` normalizes both transports behind one CHIP-0002 surface (`getAddress`,
`signMessage`, `signCoinSpends`, `takeOffer`, balances, coins, `request`/`supports` escape hatches,
`disconnect`). It is constructed ONLY via `ChiaProvider.connect(...)` or
`ChiaProvider.fromTransport(...)` — there is no public constructor.

### 2.1 `ConnectOptions.mode` — connector selection

| `mode` value                              | Resolution                                                                                                                                       | Backward compatibility          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `"auto"` (default when `mode` is omitted) | Try the injected transport first; if unavailable, fall back to WalletConnect. Never asks the caller.                                             | The pre-#63 default; unchanged. |
| `"injected"`                              | Require the injected transport. Reject `NO_INJECTED_WALLET` if unavailable.                                                                      | Pre-#63 value; unchanged.       |
| `"browser-wallet"`                        | **Alias of `"injected"`** — identical resolution and identical `NO_INJECTED_WALLET` failure. Exists as the chooser-facing connector id (see §3). | Added by #63; purely additive.  |
| `"walletconnect"`                         | Require the WalletConnect transport. Reject `WC_OPTIONS_REQUIRED` if `walletConnect` options are absent.                                         | Unchanged.                      |

`connect()` MUST normalize `"browser-wallet"` to the same code path as `"injected"` before
dispatch; the two values MUST NEVER diverge in behavior. Whichever value the caller passed MUST be
echoed back verbatim in a thrown `DigSdkError`'s `context.mode` (not the normalized value), so a
caller that passed `"browser-wallet"` sees `"browser-wallet"` in the error, not `"injected"`.

`"auto"` MUST remain the default and MUST remain a silent (non-choice-presenting) resolution — it
exists for callers that target exactly one wallet and don't want a chooser. It MUST NOT be changed
to prompt, block, or otherwise diverge from its pre-#63 behavior; doing so would be a breaking
change requiring a major version bump (§5.1 of the ecosystem contract governs the bar for that).

Successfully connecting via any `mode` value MUST yield a `ChiaProvider` exposing the identical
normalized CHIP-0002 surface — a dapp's post-connect code path MUST NOT need to branch on which
connector was used (only `provider.backend` differs, `"injected"` for both `"injected"` and
`"browser-wallet"`).

### 2.2 `session` / `backend`

`provider.backend` reports the underlying `WalletBackend` (`"injected"` | `"walletconnect"`) —
this is the transport identity, and is **not** affected by which `mode` alias connected it (a
`"browser-wallet"` connect reports `backend: "injected"`, matching a plain `"injected"` connect
byte-for-byte). `provider.session` returns `{ backend, chain, topic, address }`.

---

## 3. Connector chooser (`ChiaProvider.listConnectors`) — #63

`ChiaProvider.listConnectors(options?: { acceptAnyInjected?: boolean }): ConnectorInfo[]` is the
discoverable enumeration a 'Browser Wallet vs WalletConnect' chooser UI renders from.

### 3.1 Contract

- MUST be synchronous and MUST NOT connect, negotiate, or otherwise mutate wallet/session state —
  it is a pure detection query. A caller invoking `listConnectors()` alone MUST NOT cause any
  wallet RPC, injected-provider `connect()` call, or WalletConnect pairing to occur.
- MUST always return exactly two entries, in this fixed order:
  1. `{ id: "browser-wallet", backend: "injected", label: "Browser Wallet", available }`
  2. `{ id: "walletconnect", backend: "walletconnect", label: "WalletConnect", available: true }`
- `browser-wallet.available` MUST equal `isInjectedAvailable({ anyChia: options?.acceptAnyInjected })`
  evaluated at call time (re-evaluate on every call — no caching — since injection can appear after
  page load, e.g. an extension finishing its own startup).
- `walletconnect.available` MUST always be `true` — WalletConnect has no local presence to detect
  (availability is a relay-reachability question resolved only once pairing is attempted), so it is
  always offered as a choice.
- `label` values (`"Browser Wallet"`, `"WalletConnect"`) are the canonical chooser copy shared with
  the hub's own chooser (ecosystem `SYSTEM.md` → canonical terminology). A consuming UI SHOULD use
  these labels verbatim (subject to its own i18n layer) rather than inventing new copy.
- Each `ConnectorInfo.id` MUST be a valid `ConnectOptions.mode` value — passing `chosen.id` straight
  through as `mode` MUST connect via that exact connector with no further mapping required by the
  caller.

### 3.2 Non-goals (this call does not do these — the caller does)

- **No persistence.** The SDK holds no storage; a caller that wants to pre-select the user's last
  choice next session MUST persist `chosen.id` itself (e.g. `localStorage`) and MUST still let the
  user change it — the SDK does not gate re-choosing.
- **No auto-connect.** `listConnectors()` never transitions into `connect()`; the caller decides
  when (and whether) to call `connect({ mode: chosen.id })` after the user picks.

---

## 4. Error taxonomy (connector-relevant codes)

Every failure on this surface is a `DigSdkError` (never a bare `Error`) with a stable UPPER_SNAKE
`.code` plus structured `.context`. The catalogue is exhaustively listed in `README.md` §"Error
codes" and mirrored by `capabilities().errorCodes`; the codes the connector surface (§1–§3) and the
coin-management surface (§8) can throw are:

| Code                    | Thrown when                                                                                                                                                                         | Context                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `NO_INJECTED_WALLET`    | `mode: "injected"` or `mode: "browser-wallet"` found no usable `window.chia`.                                                                                                       | `mode` (the caller's raw value), `acceptAnyInjected`                                         |
| `WC_OPTIONS_REQUIRED`   | WalletConnect was needed (`mode: "walletconnect"`, or the WC leg of `"auto"`) but no `walletConnect` options were supplied.                                                         | `mode` (the caller's raw value)                                                              |
| `WC_DEPENDENCY_MISSING` | The optional `@walletconnect/sign-client` peer dependency is not installed/usable.                                                                                                  | —                                                                                            |
| `METHOD_NOT_SUPPORTED`  | The active transport/session does not grant the requested CHIP-0002 method.                                                                                                         | `method`                                                                                     |
| `WALLET_TIMEOUT`        | A WalletConnect RPC exceeded `requestTimeoutMs` without a response.                                                                                                                 | `method`, `timeoutMs`                                                                        |
| `NEEDS_CONSOLIDATION`   | `Paywall.requestPayment`: the wallet holds enough of the asset, but covering the target needs more than `coinLimit` coins (§8.5). Recoverable — `Paywall.consolidate()` then retry. | `asset`, `availableCoinCount`, `availableTotal`, `required`, `cap` (counts and amounts ONLY) |
| `INSUFFICIENT_FUNDS`    | `Paywall.requestPayment`: the wallet's total for the asset is below the target — consolidation cannot help (§8.5). Terminal for this wallet state.                                  | `asset`, `availableCoinCount`, `availableTotal`, `required`, `cap` (counts and amounts ONLY) |

`isDigSdkError(e, code?)` is the required narrowing check (brand-based, not `instanceof`) since the
SDK ships several independently-bundled entry points that each inline their own `DigSdkError`
class identity.

---

## 5. Backward compatibility (HARD RULE — this surface)

- Every `ConnectOptions` field and every `mode` value that existed before #63 (`"auto"`,
  `"injected"`, `"walletconnect"`, `walletConnect`, `chain`, `acceptAnyInjected`) MUST continue to
  resolve identically. A caller who has never heard of `listConnectors()` or `"browser-wallet"`
  MUST see no behavior change.
- New connector-selection surface (`"browser-wallet"`, `listConnectors`) is strictly **additive** —
  it MUST be reachable without touching any existing call site, and removing it would be a breaking
  (major) change.
- `provider.backend` values (`"injected"` | `"walletconnect"`) are a stable contract other code
  (persisted sessions, analytics, hub-side chooser logic) may branch on; they MUST NOT be renamed
  to the connector ids (`"browser-wallet"`) — the two vocabularies (backend vs connector) are
  intentionally distinct and MUST stay so.

---

## 6. Conformance notes (cross-repo)

- The chooser labels (`"Browser Wallet"`, `"WalletConnect"`) and the underlying dual-transport
  policy MUST agree with the hub's own Connect chooser and with docs.dig.net's integration guide —
  a drift between the SDK's connector ids/labels and the hub's UI copy is a bug in whichever side is
  stale.
- `WALLET_METHODS` / `SIGN_METHODS` (the CHIP-0002 method surface both transports negotiate) are
  defined once in `src/methods.ts` and MUST be identical for both transports — a dapp's method call
  MUST behave the same regardless of which connector is active.
- The `Paywall`'s coin selection and consolidation (§8) obey the ecosystem coin-management contract
  (`SYSTEM.md` → chip35_dl_coin → "Coin-management shared contract"): the ordering, the 50-coin
  cap, the three-way `SelectCoinsResult` and the two consolidation builders are chip35's, consumed
  verbatim. A change to any of them is a coordinated chip35 + `SYSTEM.md` + consumer change — never
  an SDK-local one.

---

## 7. Read-crypto (`DigClient`)

`DigClient` is the read side of the SDK: it derives a resource's keys CLIENT-SIDE, fetches opaque
ciphertext + inclusion proofs from the dig RPC, verifies inclusion against a caller-supplied
on-chain root, and decrypts — so the serving host stays BLIND. The values in this section are
**byte-identical cross-repo contracts**: the URN grammar, the retrieval-key derivation, and the
JSON-RPC wire shapes MUST match dig-store's `dig-resolver`/`dig-client-wasm`, the dig-node RPC, and
the shared definitions in the ecosystem `SYSTEM.md` (→ "URN scheme", "content-read RPC"). This
section DOCUMENTS them; an implementation MUST NOT diverge from `SYSTEM.md`.

### 7.0 Node endpoint resolution (CLAUDE.md §5.3 ladder)

`DigClient` MUST NOT hard-code `https://rpc.dig.net` as its primary/only endpoint. It resolves the
dig node/RPC endpoint through the fixed §5.3 ladder, using the FIRST option that responds, and
memoizes the choice for the client instance's lifetime:

1. **Explicit** — `new DigClient({ rpc })`. When set it OVERRIDES the whole ladder (no probing). A
   per-call `opts.rpc` likewise overrides for that call.
2. **`DIG_NODE_URL`** — the environment override (read via `process.env` where present; absent in a
   browser). Overrides the probed ladder (no probing).
3. **`dig.local`** — the installed local node, PORTLESS HTTPS at `https://127.0.0.2:443`.
4. **`localhost`** — the loopback node's PLAINTEXT HTTP listener at `http://localhost:9778` (never
   TLS).
5. **`https://rpc.dig.net`** — the public gateway, the TERMINAL fallback (an ordinary well-known
   node, never privileged). Used when no earlier rung answers; it is not itself probed.

Each local rung (3, 4) is probed with a cheap `GET ${url}/health` on a short timeout
(`DEFAULT_PROBE_TIMEOUT_MS`); a rung that times out or errors MUST fall through to the next, never
abort the ladder. Precedence order MUST be exactly: explicit › `DIG_NODE_URL` › `dig.local` ›
`localhost` › gateway.

**Environments.** In a **Node** process the full ladder is probed. In a **browser** page the LOCAL
rungs (3, 4) are SKIPPED — a page served over `https://` cannot probe a plaintext-loopback
(mixed content) nor a self-signed `https://127.0.0.2` (cert/CSP) — so a browser client resolves
explicit › `DIG_NODE_URL` › gateway. A browser page that wants a local node passes it explicitly or
relies on the DIG Browser / extension. Environment is auto-detected (`isBrowserEnv`) and overridable
via `new DigClient({ isBrowser })`.

`capabilities().nodeResolution` describes the ladder machine-readably (the ordered rungs, the
`DIG_NODE_URL` env var, and that local probing is `"node-only"`). `capabilities().defaultRpc` remains
`https://rpc.dig.net` — redocumented as the ladder's terminal fallback, NOT a privileged primary.

**mTLS.** §5.3's node-class mTLS transport is out of scope for endpoint RESOLUTION; the transport
stays the SDK's existing HTTPS `fetch`, gated on the gateway's mTLS endpoint existing.

### 7.1 URN scheme

A DIG resource is addressed by a URN of the exact form:

```
urn:dig:chia:<store_id>[:<root>]/<resource_key>[?salt=<hex>]
```

The grammar itself — what a URN means, which `?` starts a query, and how the `salt` parameter is
recognized and read — is **NOT restated here**. It is normative in the superproject's `SYSTEM.md`,
section "DIG URN grammar (normative, cross-repo)", which is the authority for every DIG parser in
every repo and every language. dig-sdk is a conforming implementation of it, not its owner: this
package once carried its own copy of these rules, and a copy kept in step by prose rather than by a
test is exactly how two parsers came to derive different keys (#2518).

What remains here is dig-sdk's OWN contract — the API behaviour a consumer of this package may rely
on, over and above the shared grammar.

- `parseUrn` accepts a mixed-case `<store_id>`/`<root>` and returns them lowercased; `<resource_key>`
  is returned verbatim. `salt` is returned lowercased, or `null`.
- Conformance is machine-checked, never asserted: `conformance/urn-parse.json` is shipped in the npm
  package (importable as `@dignetwork/dig-sdk/conformance/urn-parse.json`) and is run against this
  parser by `test/urn-conformance.test.mjs`. `test/urn-table-discrimination.test.mjs` additionally
  proves the table still REJECTS the known-wrong readings, so no rule in it rests on a single row.
  A second implementation demonstrates agreement by passing that table.

`parseUrn` MUST reject a non-scalar argument (object, array, function) with a coded
`INVALID_ARGUMENT` error BEFORE coercing it to a string, and MUST NOT place the value in the error
context. Coercing a deeply nested array recurses and throws an uncoded `RangeError`, which would
escape the "every failure is a coded `DigSdkError`" guarantee at the one surface a consumer runs on
untrusted input. `isUrn` MUST return `false` for such an argument, and `redactUrnSalt` MUST remain
total for it without constructing a `DigSdkError`.

A parser MUST NOT recognize the query with a broader test than it recognizes a _qualifying_ `salt=`.
Splitting on an unanchored `salt=` substring truncates keys that carry no salt and no secret at all, deriving a
different retrieval key for content that is already published on chain — unreadable, and unmigratable.
`report?year=2024.csv` and `notes#1.md` are likewise valid, working keys, and a parser that strips
either derives a different retrieval key and cannot read already-published content.

When a query IS recognized, `salt` is read as an ordinary query PARAMETER and the remainder of the
query is discarded (no other parameter addresses a resource). The salt value MUST be resolved by these
rules, which are a contract a second implementation is REQUIRED to match — a general-purpose
query parser (e.g. `URLSearchParams`) does NOT satisfy them and will derive a different key:

- **Any position.** `?salt=<hex>`, `?salt=<hex>&x=1` and `?x=1&salt=<hex>` all carry the salt. A
  parser MUST NOT read `salt` in final position only: that left the secret inside `<resource_key>` —
  both a key-derivation input and a field copied onto every returned read result — so such a URN
  leaked the salt AND derived a key that could not decrypt anything (#2518).
- **No percent-decoding.** The value is taken verbatim; `?salt=%61%61` is NOT the salt `aa`, it is no
  salt at all.
- **The parameter name is case-sensitive.** `?SALT=<hex>` is not a salt parameter.
- **Parameter boundary required** (the rule above): within the chosen query, `salt=` counts at the
  start, after an `&`, or after a `?`; inside another parameter's value it is not a salt.
- **The first boundary occurrence carrying a hex value wins.** On `?salt=aaaa&salt=bbbb` the salt is
  `aaaa`. An earlier occurrence whose value is empty or does not begin with a hex digit is skipped,
  so `?salt=&salt=bbbb` yields `bbbb` — a parser that stops at the first occurrence unconditionally
  derives a different key here.
- **Empty or valueless is null.** `?salt=` and `?salt` yield `null`, never `""`. `?salt` carries no
  `=`, so it is not a boundary `salt=` at all and the tail stays part of `<resource_key>`.
- **The value is the leading hex run.** `?salt=ff00ff00#frag` and `?salt=ff00ff00&x=1` both yield
  `ff00ff00`: the value ends at the first character outside `[0-9a-fA-F]`. A value with no leading hex
  digit is not a salt (`?salt=not-hex` → `null`), and one that is only partly hex resolves to its hex
  prefix (`?salt=ff00zz` → `ff00`). A parser that requires the WHOLE value to be hex derives a
  different key on that last input.

A value that fails these rules yields `salt: null`. The query is still split off whenever a boundary
`salt=` is present — including for a malformed value — so a secret in an unexpected alphabet cannot
ride along inside `<resource_key>`.

The **machine-readable authority** for this behaviour is `conformance/urn-parse.json`, shipped in the
npm package. Every implementation of this scheme MUST pass that table; agreement between parsers is
verified against it, never asserted (the parsed `<resource_key>`/`salt` pair determines the derived
keys, so two parsers that disagree read different bytes).

**Salt redaction (normative).** The salt is the out-of-band secret that makes a store private, so it
MUST NOT be republished by the SDK's own diagnostics. Every `DigSdkError` redacts its context when
the error is constructed: any lowercase `salt=<value>` occurring in a string reachable from
`context` by walking its own enumerable array elements and object properties — in a well-formed URN,
in a malformed one, or in free text — is replaced with the literal `<redacted>` before it is stored.
Within that reach, redaction MUST be a strict superset of what the URN grammar captures, and MUST NOT
be narrowed to match the parser: the strings that reach redaction are not all well-formed URNs (an
error's `value` may be arbitrary text), so every `salt=<value>` occurrence is swept wherever it
appears. That independence is what keeps the guarantee intact if the two ever drift apart again.

**Error construction is TOTAL (normative).** Constructing a `DigSdkError` MUST NOT throw, whatever
shape `context` has. A throw during construction happens inside a `throw new DigSdkError(...)`
expression that no call site can wrap, so it replaces a coded, catchable refusal with an uncoded
error escaping the whole public surface. The context walk is therefore bounded in every direction a
hostile value can be shaped — cycles are collapsed, nesting is walked at most **32** levels deep
(deeper values are replaced with `<omitted>`), and a property whose read throws yields `<omitted>` —
and any residual failure degrades to a context of `{ contextRedactionFailed: true }`. Diagnostic
detail MAY be lost; the error's `code` MUST survive.

**The bounds of that guarantee (normative — do not read redaction as a blanket one).** Redaction
covers `context`, and only in the form just described. It does NOT currently cover three cases, each
of which can carry a salt into a serialized error, so a caller MUST NOT treat a `DigSdkError` as
safe to log verbatim when a private-store salt may be in play:

- The error's **`message`** is not redacted, and `toJSON()` emits that message unaltered — so
  `message`, `stack`, `String(err)` and `toJSON()` all expose a salt that reached the message
  (#2640, #2643).
- Redaction matches **lowercase `salt=` only**, so an uppercase or mixed-case parameter
  (`?SALT=…`, `?SaLt=…`) is preserved verbatim. This is reachable through the public API with no
  hand-built error: `parseUrn("urn:dig:chia:…?SALT=<hex>")` and the corresponding
  `DigClient.read({ urn })` both surface it (#2638).
- A context value that is not a string and supplies its own **`toJSON()`** is walked by its own
  properties, not by that method, so a salt returned only from `toJSON()` survives into serialized
  output (#2643).

The **canonical, root-INDEPENDENT** form is `urn:dig:chia:<store_id>/<resource_key>` — the form
whose bytes seed key derivation. `reconstructUrn(storeId, resourceKey)` produces it;
`reconstructUrnWithRoot(...)` produces the root-pinned DISPLAY form `urn:dig:chia:<store_id>:<root>/
<resource_key>`, which is for sharing only and MUST NOT be fed into key derivation.

### 7.2 Retrieval key

The retrieval key is derived purely locally (no network) as:

```
retrieval_key = SHA-256(canonical rootless URN)   // lowercase hex, 64 chars
```

i.e. the SHA-256 of `urn:dig:chia:<store_id>/<resource_key>` (empty key ⇒ `index.html`). It is
**root-independent** — the same resource in any generation of the store maps to the same retrieval
key — and is computed by the read-crypto wasm (`retrievalKey(storeIdHex, resourceKey)`). The AES-256
content key is likewise derived from the canonical rootless URN (plus the salt for a private store)
by the wasm and MUST NOT depend on the root.

### 7.3 JSON-RPC wire (`dig.*`)

`DigClient` calls the dig RPC over JSON-RPC 2.0 (`POST`, `{ jsonrpc:"2.0", id, method, params }`). A
transport failure is `RPC_TRANSPORT`, an HTTP/JSON-RPC error is `RPC_ERROR`, and a structurally
absent/inconsistent result is `RPC_MALFORMED_RESPONSE` (§4 catalogue). This includes the body
itself: a response whose status is success but whose body does not parse as JSON — an empty body, a
truncated one, an HTML error or captive-portal page — is refused with `RPC_MALFORMED_RESPONSE`. This
refusal lives in the shared transport, so it holds for EVERY `dig.*` method, and the SDK MUST
surface it as a coded refusal rather than as the platform's raw parse exception. A read NEVER concludes "not
found": the oblivious host returns indistinguishable ciphertext for any key, so a missing resource
is just opaque bytes that fail to decrypt.

**`dig.getContent`** — stream one resource's ciphertext by retrieval key.

- Params: `{ store_id, root, retrieval_key, offset, length }` (all hex/number; `root` is the trust
  anchor, `retrieval_key` per §7.2).
- Result: `{ total_length, offset, next_offset, complete, ciphertext, inclusion_proof, chunk_lens }`
  — `ciphertext` is **standard base64**; `chunk_lens` the per-chunk plaintext lengths.
- **Chunking:** the client requests `length = 3 MiB` (`3 * 1024 * 1024` bytes) per call — the
  backend caps each response at 3 MiB (the Lambda/API-Gateway response ceiling) — and reassembles by
  looping until `complete` is true or `next_offset` is null, writing each chunk at its returned
  `offset` into a `total_length` buffer. This 3-MiB cap is the shared contract with the RPC.
- **Resource-size ceiling (untrusted-node DoS guard):** the declared `total_length` is bounded
  against a hard ceiling of **512 MiB** (`512 * 1024 * 1024` bytes) BEFORE the reassembly buffer is
  allocated. A node is untrusted (the §5.3 ladder makes an unauthenticated local node the default
  endpoint), so a small response declaring a multi-GiB `total_length` would otherwise force a giant
  allocation ahead of any verification. A declared length above the ceiling — or one the host cannot
  allocate — is refused with `RESOURCE_TOO_LARGE` and no allocation is attempted. NOTE: 512 MiB is an
  SDK-chosen client-side bound, not (yet) a normative wire constant negotiated with the RPC.
- **Per-response ciphertext ceiling:** the ciphertext carried by ONE `dig.getContent` response is
  bounded at **6 MiB** (`2 * 3 MiB`, twice the requested chunk length). The decoded size is computed
  from the base64 length (3 bytes per 4 characters) and checked BEFORE the decode allocates, so a
  response above the ceiling is refused with `RESOURCE_TOO_LARGE` and never decoded. The aggregate
  `total_length` ceiling above does not cover this case: a response may declare a tiny resource and
  still carry an arbitrarily large body.
- **Response-body ceiling (every `dig.*` method):** the RAW body bytes of ANY single JSON-RPC
  response are bounded at **16 MiB** while the body is being READ — the SDK streams the response and
  refuses with `RESOURCE_TOO_LARGE` the moment the budget is exceeded, WITHOUT reading the remainder
  and WITHOUT parsing what it read. It MUST NOT truncate-then-parse: a partial parse would either
  fail as a spurious malformed-response fault or yield a partial result a caller would treat as
  complete. This is the outermost of the three size bounds and the only one that limits what is ever
  resident: the ceilings above run after parsing, so a node may declare `total_length: 100` and
  answer with an arbitrarily large body. 16 MiB is twice the ~8 MiB a base64-encoded 6 MiB
  per-response ciphertext ceiling implies, so every legal response fits.

  A chunk's size MUST be established from the view's INTERNAL SLOTS, never from its `byteLength`,
  `buffer` or `byteOffset` properties: a genuine `Uint8Array` subclass may override any of them while
  satisfying `ArrayBuffer.isView`, and a chunk reporting `0` would switch the ceiling off for the
  whole body.

  A chunk MUST be refused BEFORE it is copied when its own size already exceeds the remaining
  budget. Because the slot-derived size cannot be falsified, the ceiling does not need the copy in
  order to be enforced — and it must not wait for it: deferring the check until after the copy makes
  the bound "16 MiB plus one chunk", which is vacuous while nothing bounds one chunk. A single chunk
  at the runtime's allocation limit would exhaust memory before the guard ran. For a string chunk the
  bound is its `length`, a true LOWER bound on its UTF-8 size (at least one byte per UTF-16 code
  unit), so refusing on it can never reject a body that would have fit.

  Each accepted chunk is then copied into a buffer the SDK owns, and the COPY is what is counted and
  retained — so a producer cannot pin memory the budget never counted, nor change what was counted
  after the fact. A chunk whose bytes cannot be obtained — a non-view, or a detached buffer — MUST be
  refused with `RPC_MALFORMED_RESPONSE`, never skipped.

  The ceiling applies to every body the SDK can MEASURE, not only to a WHATWG stream. `fetch` is an
  injectable option, so `res.body` may be a WHATWG `ReadableStream` (a real `fetch`; read via
  `getReader()`) or a Node `Readable` (`node-fetch` v2, `cross-fetch`; read via `for await`) — both
  are read under the same budget, refused with the same `RESOURCE_TOO_LARGE`, and released early. A
  chunk whose byte length cannot be determined is refused with `RPC_MALFORMED_RESPONSE` rather than
  accepted, because a chunk that misreports its size would otherwise disable the ceiling for the
  remainder of the body.

  **The one documented residue:** an injected `fetch` returning a body that is neither a stream nor
  async-iterable (a fully buffered `Response` shim) cannot be measured before it is parsed. For that
  shape the ceiling is enforced against the declared `content-length` header instead, and an absent
  or unparseable `content-length` bypasses it for that response. This is a property of the injected
  transport, not of the protocol: every mainstream `fetch` implementation returns one of the two
  measurable shapes above.

- **Response-shape validation:** when present, `ciphertext` MUST be a string (an absent or `null`
  `ciphertext` is read as an empty chunk). A non-string (an array, a number, a
  boolean, an object) is refused with `RPC_MALFORMED_RESPONSE` and never decoded — base64 decoding
  coerces its argument, so a non-string would otherwise slip past the size ceiling above, which
  measures the value's `length`. Likewise the returned `offset` MUST be a non-negative integer no
  greater than `total_length`; anything else is refused with `RPC_MALFORMED_RESPONSE` rather than
  used as a write position into the reassembly buffer.
- **Base64 validity:** a `ciphertext` that is a string but not valid base64 — an illegal character,
  or a length that is not a whole number of 4-character quanta — is refused with
  `RPC_MALFORMED_RESPONSE`. Ordinary truncation or corruption produces both forms, so this is a
  routine wire fault rather than an attack-only case, and the SDK MUST surface it as a coded refusal
  rather than as the platform's raw decode exception.
- **Page ceiling:** one resource is reassembled from at most **4096** `dig.getContent` responses. A
  node that has not completed the resource by then is refused with `RESOURCE_TOO_LARGE` — each
  response is well-formed, so this is a client resource ceiling rather than a wire-format fault.
- **Strict forward progress:** while `complete` is false, each returned `next_offset` MUST be
  strictly greater than the offset just requested. A `next_offset` that repeats or rewinds the
  current offset is refused with `RPC_MALFORMED_RESPONSE`; the client MUST NOT loop on it.
- NOTE: like the 512 MiB bound, the 6 MiB per-response ceiling, the 16 MiB response-body ceiling,
  the 4096-page ceiling and the
  refusal codes attached to them are SDK-chosen client-side refusal policy. They are not normative
  wire constants negotiated with the RPC, and a second implementation is not required to match them.

**`dig.getCollection`** — read a collection's public, owner-independent facts.

- Params: `{ launcher_ids: string[], did? }` — the item set is keyed by NFT **launcher ids** (the
  owner-independent anchor), NOT the creator DID; `did` (optional) is echoed back as the declared
  creator.
- Result: a `CollectionMeta` (creator DID, resolved item count, uniform royalty basis points).

**`dig.listCollectionItems`** — read a deterministic paginated page of a collection's items, each
resolved to its CURRENT on-chain state (current owner, royalty, CHIP-0007 metadata).

- Params: `{ launcher_ids: string[], offset?, limit? }` — items return in input launcher-id order;
  `limit` is clamped to the server cap (200); `offset` defaults to 0.
- Result: a `CollectionItemsPage` — `items` plus `next_offset` (null on the last page).

> **KNOWN LIMITATION (endpoint-trusted collection metadata).** `dig.getCollection` /
> `dig.listCollectionItems` return chain metadata (owner, royalty, DID, CHIP-0007 fields) that is
> **ENDPOINT-TRUSTED**: there is currently NO inclusion proof binding these facts to the chain, so the
> reader trusts whatever the resolved node reports. Under the §7.0 local-first ladder this means a
> possibly-untrusted local node could return forged collection metadata. This is documented pending a
> follow-up that adds a verifiable proof mechanism (tracked separately); until then, callers needing
> chain-authoritative owner/royalty facts SHOULD confirm them against the chain independently. (Unlike
> the content readers in §7.3.1, which ARE fail-closed on inclusion.)

### 7.3.2 The miss contract (`-32003` / `-32008` / `-32017`) — NORMATIVE

A node that does not hold the requested content answers with an INSTRUCTION, not a bare failure. A
client MUST distinguish the following, because they carry different and in places opposite meanings.

| Code                                 | Meaning                                                     | Client MUST                             |
| ------------------------------------ | ----------------------------------------------------------- | --------------------------------------- |
| `-32008` `CONTENT_REDIRECT`          | Not held here; `error.data.redirect` names holders          | Re-request, bounded (below)             |
| `-32003` `CONTENT_MISS_RATE_LIMITED` | This requestor is driving THIS node's miss lookups too fast | Back off from that NODE and retry it    |
| `-32017` `CONTENT_MISS_INCONCLUSIVE` | Availability was NOT established (a leg timed out/refused)  | Treat as UNKNOWN; a retry is meaningful |
| `-32004` `RESOURCE_UNAVAILABLE`      | Settled: not held at the requested root                     | Stop                                    |

**`error.data.redirect`** carries `content` (`store_id`, `root`, `retrieval_key`), `providers` (each
a holder `peer_id` PLUS its candidate `{host, port, kind}` addresses), `redirect_depth`, and
`max_redirects`.

**The bound.** A client MUST bound redirects. It MUST count its OWN hops rather than relying on the
served `redirect_depth` to advance, because a set of nodes each answering `redirect_depth: 0` is
well-formed and would otherwise loop forever. The SDK uses
`consumed = max(consumed + 1, servedDepth)` against a ceiling of `REDIRECT_HOP_CAP` (4, equal to
dig-node's). An advertised `max_redirects` MAY lower that ceiling and MUST NOT raise it. The client
MUST echo the resulting depth as `params.redirect_depth`, so the budget is monotone across nodes.

**Trust.** A redirect is a HINT, never an authority (NC-12: every peer is untrusted). A named holder
may not hold the content, may not answer, or may serve something else. Content is accepted because
it verifies against the on-chain merkle root — never because a peer named the peer that served it.
A client MUST apply the same verification to redirected content as to a first-hop answer; the SDK
does so structurally, by returning ciphertext from the redirect loop and gating it in the single
place §7.3.1 already describes.

**Where a redirect sends the request.** The `providers` addresses name DIG peers on the mTLS peer
protocol, which is NOT the JSON-RPC surface a browser client speaks. The SDK therefore re-asks the
next rung of the §5.3 ladder and surfaces the named holders on the resulting error, so a node-class
caller that can dial the peer protocol still receives them. An explicitly-configured endpoint (a
constructor `rpc`, a per-call `opts.rpc`, or `DIG_NODE_URL`) has NO successors: §7.0 precedence
survives the miss contract, and a user's chosen node MUST NOT be silently routed around.

**Back-off scope.** `-32003` is scoped to the NODE, for all content — never to the content. The
node's limiter is a per-requestor bucket on its miss-lookup path, so the refusal says nothing about
the resource. The node states no interval on the wire, so a client supplies one; the SDK starts at
250 ms, the period implied by the node's published refill rate of 4 lookups per second, and doubles.

**Honesty.** A miss that is recovered MUST be invisible. A miss that is not recovered MUST NOT be
reported as absence when absence was never established: the SDK raises
`CONTENT_NO_REACHABLE_HOLDER`, `CONTENT_MISS_RATE_LIMITED` or `CONTENT_AVAILABILITY_UNKNOWN`, each
carrying `retryable: true`.

### 7.3.1 Content-read integrity — oblivious primitives + secure-by-default siblings (HARD RULE)

Decryption success alone does NOT prove chain origin: for a public (saltless) store the content key
is `deriveKey(store_id, resource_key)`, derivable purely from the public URN, so ANY party (including
an untrusted or spoofed node reached via the §7.0 ladder — e.g. the plaintext `localhost` rung) can
serve `Enc(publicKey, arbitrary)` bytes that decrypt cleanly. ONLY `verifyInclusion(ciphertext,
proof, root)` binds content to the on-chain root. The read surface therefore splits into oblivious
primitives and secure-by-default siblings:

- **`read` and `readResource` are OBLIVIOUS primitives**: they return `{ bytes, verified, decrypted }`
  and MUST NOT throw on unverified/undecryptable content (beyond a transport failure, and
  `ROOT_REQUIRED` when no root is supplied/derivable). `decrypted === false` returns the raw served
  ciphertext; `verified === false` means the bytes are NOT chain-bound. They are the deliberate blind
  reads — a decoy is just opaque bytes, so presence stays unknowable — and callers that handle
  unverified bytes themselves (a decoy, self-checked inclusion) use them.
- **`readVerified` and `readText` are SECURE-BY-DEFAULT and MUST be used to RENDER or SERVE bytes.**
  They fail closed:
  - MUST throw `DECRYPT_FAILED` when the served bytes do not decrypt+authenticate under the URN.
  - MUST throw `INCLUSION_UNVERIFIED` when the effective root is **PINNED** (`rootIsPinned(root)`)
    AND `verified === false`; they never return chain-unbacked bytes to a renderer.
  - `rootIsPinned` MUST be **fail-closed**: a root is UNPINNED only when its canonical form (trimmed,
    lowercased, `0x` prefix stripped) is one of the sentinels `""` or `latest`, or the root is
    absent. Every other value — including any rendering the wasm verifier accepts, and any value it
    would reject — MUST read as PINNED and be gated. The predicate's accepted domain MUST NOT be
    narrower than the verifier's: a root that verifies on an honest node but reads as unpinned
    disables the gate silently, whereas over-recognising can only produce a loud
    `INCLUSION_UNVERIFIED`. (This is strictly stronger than hub.dig.net's `/^[0-9a-f]{64}$/i`, which
    gates the canonical and uppercase forms only; every root the hub gates, the SDK gates.)
  - `read` MUST canonicalise the effective root once, before the predicate, the RPC parameter and
    the verifier see it, so no two layers can disagree about what the root is.
  - **Blind-model exception**: when the effective root is UNPINNED, inclusion cannot be proven in the
    oblivious model, so it is ADVISORY — the readers gate on decryption only and MUST NOT throw
    `INCLUSION_UNVERIFIED`. The returned result still carries `verified` for the caller's inspection.
  - `readText` returns the decoded UTF-8 string of the `readVerified` result.

The unpinned exception applies ONLY to the inclusion gate; the decrypt gate is unconditional. A
renderer MUST NOT fall back to the oblivious primitives to bypass these gates. (`CONTENT_UNVERIFIED`
is retained in the taxonomy for back-compat but no path throws it; `INCLUSION_UNVERIFIED` supersedes
it.)

### 7.4 Security properties

- **Blind host / no presence oracle.** The trust ROOT is always caller-supplied (resolved from the
  chain); the host is never the trust anchor. Because the host returns indistinguishable ciphertext
  for any retrieval key, resource presence is UNKNOWABLE from a read.
- **Secure-by-default content reads.** `readVerified`/`readText` refuse content that fails inclusion
  against a PINNED caller-supplied root (`INCLUSION_UNVERIFIED`) and content that does not decrypt
  (`DECRYPT_FAILED`); `read`/`readResource` are the oblivious primitives (§7.3.1). Decryption is not
  authentication — only the inclusion proof binds bytes to the chain — so an untrusted node
  (reachable under the §7.0 ladder) cannot feed attacker plaintext through a renderer that uses the
  secure readers under a pinned root.
- **wasm integrity is per-load-path** (from #1156 finding 2 — mirrors `src/loader.ts` +
  `src/wasm.ts`):
  - **Byte-level SRI (fail-closed)** on the Node path and on any caller-supplied
    `configureWasm({ wasmBytes | wasmUrl })` path: the loader SHA-256s the raw wasm bytes, compares
    them against the pinned digest (`DIG_CLIENT_WASM_SHA256`, mirrored by the package's
    `integrity.json`), and refuses to run on a mismatch.
  - **Pinned-package trust** on the DEFAULT browser (bundler) path: the bundler resolves
    `@dignetwork/dig-capsule-wasm/web` and instantiates the pinned package artifact, so the trust
    anchor there is the package supply chain — NOT byte-level SRI. An app on an untrusted delivery
    path opts into byte-level SRI with `configureWasm({ wasmUrl })`.

---

## 8. Coin management (Paywall) — the shared #410 contract

This section is the contract for how `Paywall` chooses the buyer's coins, how it reports a wallet
that cannot fund a payment, and how it merges coins on the integrator's explicit request. It obeys
the ecosystem coin-management contract (`SYSTEM.md` → chip35_dl_coin → "Coin-management shared
contract"). **Every clause here is specified ahead of its implementation** (dig-sdk PR #20) unless
tagged _(shipped: `file:line`)_; a clause tagged _(open — Qn)_ has its VALUE fixed but a named
decision outstanding, recorded on PR #20, and is not implementable until that decision lands.

### 8.1 The primitives and their owner

- The selection policy, the cap, the three-way result and both consolidation spends are OWNED by
  `@dignetwork/chip35-dl-coin-wasm`: `selectCoins(coins, target, asset, cap?)`,
  `buildCoinConsolidation(spenderKey, coins, cap, fee)`, `buildCatConsolidation(spenderKey, cats,
cap?)` (`chip35_dl_coin_wasm.d.ts` 0.17.1: lines 727, 488, 464). The SDK composes them and MUST
  NOT reimplement, re-sort, pre-filter by value, or otherwise second-guess any of them — a
  restatement in JS is a rival implementation that will diverge.
- The rule, by reference: `selectCoins` orders **high-value-first** (descending `amount`, ties broken
  by coin id ascending), accumulates until the target is covered, and returns one of three outcomes
  (chip35 `core/src/select.rs:80-131`): `{ ok:true, coins, total, change, coinCount, asset }` with
  `coins[0]` the lead coin every builder spends first; `{ ok:false, needsConsolidation:true, … }` —
  the value exists but covering the target needs more than `cap` coins; `{ ok:false,
needsConsolidation:false, … }` — the total is genuinely below the target. The SDK trusts this
  result; a reader MUST NOT conclude the SDK re-checks `total ≥ target` itself.
- `selectCoins`, `buildCoinConsolidation`, `buildCatConsolidation` and the types `SelectCoinsResult`,
  `PaymentAsset`, `Coin`, `Cat`, `CatInfo`, `LineageProof`, `CoinSpend` are available VERBATIM to
  integrators via `@dignetwork/dig-sdk/spend` _(shipped: `src/spend.ts:32` — `export *`; present in
  the resolved chip35 `^0.16.0` d.ts at lines 727/488/464)_. They are the primitives `Paywall`
  composes; an integrator building its own spend flow calls them directly with the same contract.

### 8.2 Units (normative — every amount names its unit)

- XCH amounts are **mojos** (`1 XCH = 10^12 mojos`). CAT amounts are the CAT's **base units** — for
  $DIG, 3 decimals, `1 base unit = 0.001 DIG`. The SDK NEVER converts between XCH and a CAT.
- Every amount crossing the wasm boundary (`target`, `fee`, `total`, `change`, `availableTotal`,
  `required`, `Coin.amount`, `LineageProof.parentAmount`) is a `bigint`. `amount` and `fee` accept
  `number | bigint` at the public API _(shipped: `src/paywall.ts:89-104`)_ and are converted with
  `BigInt()` before use.
- `coinLimit`, `sourceLimit`, `cap`, `coinCount`, `availableCoinCount`, `inputCount` are plain JS
  integer `number`s (counts, never amounts).

### 8.3 Sourcing candidate coins (`sourceLimit`)

- `requestPayment` and `consolidate` source the buyer's candidate coins from the connected wallet
  through `ChiaProvider.getXchCoins(limit)` / `getCatCoins(assetId, limit)` — one
  `chip0002_getAssetCoins` call with `includedLocked: false` _(shipped:
  `src/provider/methods.ts:183-215`)_ — passing **`sourceLimit`** as the wallet `limit`.
  `sourceLimit` is a new optional argument on both calls, default **500** (exported
  `DEFAULT_COIN_SOURCE_LIMIT`; the hub sources with the same figure, `lib/consolidation.ts:87`).
  `coinLimit` MUST NOT be forwarded as the wallet `limit`: the wallet's page order is not value
  order, and truncating at the cap before selecting would defeat high-value-first.
- `sourceLimit` MUST be an integer ≥ 1 and ≥ the effective `coinLimit`/`cap`; otherwise
  `INVALID_ARGUMENT` (`context.value = "sourceLimit"`). A source page smaller than the cap can never
  produce `needsConsolidation:true` and would report a fundable wallet as `INSUFFICIENT_FUNDS`.
- The sourced set is handed WHOLE to `selectCoins`. The wallet's own order is never used to choose.
- A record with `locked === true` is excluded before selection. Because the SDK asks the wallet for
  unlocked coins only, this clause is VACUOUSLY satisfied for a conforming wallet; it exists so a
  wallet that ignores `includedLocked` cannot put a locked coin into a spend.
- **Bound on the counts.** `availableCoinCount` / `availableTotal` in a §8.5 failure describe the
  SOURCED set. When the wallet returned exactly `sourceLimit` records they are LOWER bounds on what
  the wallet holds, and an error message SHOULD say "at least". A wallet that silently pages fewer
  than asked cannot be detected from the count; a reader MUST NOT conclude from these figures that
  the wallet holds no more.

### 8.4 Coercion: CHIP-0002 `SpendableCoin` → wasm `Coin` / `Cat`

The wallet returns CHIP-0002 `SpendableCoin` records — `{ coin: { parent_coin_info, puzzle_hash,
amount }, coinName, puzzle, confirmedBlockIndex, locked, lineageProof? }` (CHIP-0002 §"SpendableCoin",
`chip-0002.md:166-177`), hex strings and JSON numbers. The wasm's `Coin` is camelCase, raw bytes and
`bigint` (`Coin { parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint }`, d.ts 5-9;
chip35 `wasm/src/types.rs:68-74`, `#[serde(rename_all = "camelCase")]` + `serde_bytes`) and does
NOT accept the wire record. Therefore:

- Every sourced record MUST be coerced before it reaches `selectCoins` and before it reaches ANY
  builder. Raw wallet records MUST NOT be forwarded to `buildPayment` / `buildCatPayment` (this
  replaces the forwarding at `src/paywall.ts:277-299`).
- **`Coin` mapping** (the hub's, `lib/consolidation.ts:73-79`, `lib/dig.ts:248-252`):
  `parentCoinInfo = hexToBytes(coin.parent_coin_info)`, `puzzleHash = hexToBytes(coin.puzzle_hash)`,
  `amount = BigInt(coin.amount)`. Hex is accepted with or without `0x` _(shipped:
  `src/hex.ts:30-41`)_. `amount` MUST be accepted as a JSON number OR a decimal string — a wallet
  emits a string above `2^53 − 1` so precision is never lost (hub `lib/spend-convert.ts:199-205`).
  The camelCase spellings `parentCoinInfo` / `puzzleHash` MUST be accepted as aliases of the
  snake_case fields, because wallets vary (hub `lib/types.ts:181-197`).
- **`Cat` mapping** (CAT paths). `Cat { coin, lineageProof?, info }` (d.ts 247-251), `CatInfo {
assetId, hiddenPuzzleHash?, p2PuzzleHash }` (d.ts 240-244), `LineageProof { parentParentCoinInfo,
parentInnerPuzzleHash, parentAmount }` (d.ts 19-23):
  - `coin` — as above.
  - `info.assetId = hexToBytes(args.assetId)`; `info.hiddenPuzzleHash` omitted or `null` (a standard
    CAT).
  - `lineageProof` — from the RECORD's own `lineageProof`: `parentParentCoinInfo =
hexToBytes(lineageProof.parentName)`, `parentInnerPuzzleHash =
hexToBytes(lineageProof.innerPuzzleHash)`, `parentAmount = BigInt(lineageProof.amount)`. This is
    the identical triple the hub reconstructs from the parent spend via coinset
    (`lib/consolidation.ts:421-427`, `lib/dig.ts:299-313`); the SDK has no chain client and takes it
    from the wallet, which is also the source of the coin itself (Sage populates exactly these fields
    from the CAT's `Proof::Lineage` — `crates/sage/src/endpoints/wallet_connect.rs:160-164`).
    Failure direction: a wrong proof makes the CAT spend invalid on-chain and no funds move (closed).
  - A CAT record with no `lineageProof`, or one whose `innerPuzzleHash` is `null` (Sage's eve-proof
    arm, `wallet_connect.rs:155-159`), CANNOT be coerced. The SDK MUST refuse the whole operation
    with a coded `DigSdkError` BEFORE selection or any wallet signing prompt. It MUST NOT silently
    exclude the coin (excluding understates funds and turns a fundable wallet into a false
    `INSUFFICIENT_FUNDS`), and MUST NOT forward a `Cat` with a null proof (the wasm accepts the shape
    and would build an eve spend the wallet is then asked to sign). The same refusal applies to any
    record whose `coin` fields fail to parse. _(open — Q2: the error code; the two codes §4 adds do
    not cover a wallet record the SDK cannot use.)_
  - `info.p2PuzzleHash` MUST be the buyer's INNER (standard p2) puzzle hash — the standard puzzle
    hash of the buyer synthetic key, the value the hub derives with chia-wallet-sdk-wasm's
    `standardPuzzleHash` (`lib/chia-address.ts`, applied at `lib/consolidation.ts:398,428` and
    `lib/dig.ts:278,314`). It is NOT present in the CHIP-0002 record. _(open — Q1: its source. chip35
    0.17.1 exports no key→puzzle-hash helper, and the SDK MUST NOT compute it in JS — that would be a
    rival of chia-sdk's `StandardArgs::curry_tree_hash`. Until Q1 lands, the CAT arms of §8.5 and
    §8.6 are specified but not implementable; the XCH arms do not depend on it.)_
- **Identity mapping.** The `Coin`s a selection returns are mapped back to their source records by
  the triple `(parentCoinInfo, puzzleHash, amount)` — equal to coin-id equality — consuming each
  record once so two records with identical triples map to two distinct records (hub
  `lib/coin-select.ts:99-108,141-155`). A reader MUST NOT conclude the SDK computes coin ids; it does
  not.
- **Single-key bound (what a reader may NOT conclude).** The buyer key is `getPublicKeys()[0]`
  _(shipped: `src/paywall.ts:225-234`)_. The sourced set is every coin the wallet holds for the
  asset, across ALL of its addresses; the SDK does not filter it to the coins that key controls (it
  cannot, without Q1's helper). For a multi-address wallet the §8.5 counts can therefore include
  coins the buyer key cannot sign, and a spend built over such a coin fails at signing or on-chain
  (closed). This is the pre-existing single-address assumption of `Paywall`; §8 neither widens nor
  removes it.

### 8.5 `requestPayment` — capped high-value-first selection and the two failure codes

- `RequestPaymentArgs.coinLimit` is KEPT _(shipped: `src/paywall.ts:105-106`)_ and is the selection
  cap: default **50** (exported `DEFAULT_COIN_CAP`, equal to chip35's `DEFAULT_COIN_CAP`,
  `core/src/select.rs:28`, and to the cap `SYSTEM.md` states). It MUST be an integer ≥ 1; otherwise
  `INVALID_ARGUMENT` (`context.value = "coinLimit"`). The effective cap is passed to `selectCoins`
  EXPLICITLY (never by relying on the wasm's default), so the cap the SDK documents is the cap
  applied.
- Before any wallet RPC, the SDK MUST verify every wasm member the call will need (`selectCoins` and
  the builder for the asset); a missing member is `SPEND_BUILDER_UNAVAILABLE` with `context.builder`
  naming it _(pattern shipped: `src/paywall.ts:269-275`)_. There is NO JavaScript fallback selector
  and NO fallback builder. A wallet is never asked for its coins on a path that cannot complete.
- The target is `amount + fee` for XCH (`buildPayment` reserves the fee from the same coins) and
  `amount` for a CAT (a CAT ring nets to zero; `buildCatPayment` takes no fee — d.ts 473). The asset
  is `{ xch: true }` or `{ assetId: hexToBytes(assetId) }`.
- On `ok: true`, `result.coins` are forwarded VERBATIM, in the wasm's order, as `selected_coins` to
  `buildPayment`; for a CAT, the `Cat` objects mapped back per §8.4 are forwarded in that same order
  to `buildCatPayment`. `coins[0]` is the lead.
- On `ok: false`:
  - `needsConsolidation: true` → throw `DigSdkError` **`NEEDS_CONSOLIDATION`**;
  - `needsConsolidation: false` → throw `DigSdkError` **`INSUFFICIENT_FUNDS`**.
    Both carry `context = { asset, availableCoinCount, availableTotal, required, cap }` copied from the
    wasm result, with `asset` as `{ xch: true }` or `{ assetId: <lowercase hex, no 0x> }` and the
    `bigint` amounts kept as `bigint`. **Privacy bind:** the context carries counts and amounts ONLY —
    never a coin id, `coinName`, parent coin info, puzzle hash, address, public key or the coin list —
    so an error surfaced to a UI cannot enumerate the wallet.
- The two codes are DISTINCT states: `NEEDS_CONSOLIDATION` is recoverable by the buyer's own
  consolidation (§8.6); `INSUFFICIENT_FUNDS` is not, and a UI MUST NOT offer consolidation for it.
- `requestPayment` MUST NEVER call `consolidate()` on the buyer's behalf (§8.6, consent).
- The `PaymentResult` shape is unchanged. A caller that passes no `coinLimit` observes exactly two
  differences from the pre-§8 behaviour: the coins are chosen by value rather than wallet order, and
  a wallet that cannot fund the payment is reported by one of the two codes above instead of by a
  builder or on-chain failure.
- A chip35 builder rejection (its typed `{ code, message }`) propagates unchanged _(shipped: no
  wrapping at `src/paywall.ts:281,292`)_; the SDK does not translate it.

### 8.6 `Paywall.consolidate(args)` — merge the smallest coins into one

```ts
consolidate(args?: {
  assetId?: string;          // CAT tail hex; omit for XCH
  cap?: number;              // default DEFAULT_COIN_CAP (50); integer ≥ 2
  fee?: number | bigint;     // mojos, XCH only; default 0
  sourceLimit?: number;      // default DEFAULT_COIN_SOURCE_LIMIT (500)
}): Promise<{ coinSpends: unknown; signature: string; inputCount: number; outputAmount: bigint }>
```

- Validation, before any wallet RPC: `cap` MUST be an integer ≥ 2 (the wasm cannot merge fewer —
  `core/src/consolidation.rs:31-52`); `fee` MUST be an integer ≥ 0; `fee` given together with
  `assetId` MUST be rejected — a CAT ring carries no fee (`buildCatConsolidation` has no fee
  parameter, d.ts 464; an XCH fee for a CAT merge rides on a separate XCH coin built with `addFee`
  from `/spend`, asserting the lead CAT coin id — the SDK does not build that rider); `sourceLimit`
  per §8.3. Each violation is `INVALID_ARGUMENT` with `context.value` naming the argument.
- The required builder (`buildCoinConsolidation` for XCH, `buildCatConsolidation` for a CAT) MUST be
  present on the wasm before any wallet RPC; otherwise `SPEND_BUILDER_UNAVAILABLE` naming it.
- Coins are sourced (§8.3) and coerced (§8.4). Fewer than two coercible records →
  `INVALID_ARGUMENT` with `context = { value: "coins", coinCount }`. Nothing is signed.
- The WHOLE coerced set is passed to the builder — `buildCoinConsolidation(buyerKey, coins, cap,
BigInt(fee))` or `buildCatConsolidation(buyerKey, cats, cap)`. The wasm chooses the SMALLEST `cap`
  coins (ascending amount, ties by coin id — `core/src/consolidation.rs:31-52`) and self-sends ONE
  output coin to the spender's own puzzle hash (`core/src/consolidation.rs:65-100`). The SDK MUST NOT
  pre-select. A `fee ≥` merged total is rejected by the wasm ("fee must be less than the consolidated
  amount", `consolidation.rs:76-79`) and propagates as that chip35 error; the SDK does not pre-check
  it.
- The returned spends are signed with `provider.signCoinSpends(coinSpends)` (encoding per §8.8).
- Result: `coinSpends` (the spends the wallet signed), `signature` (the wallet's aggregated BLS
  signature, hex), `inputCount = coinSpends.length` (the builders emit exactly one spend per merged
  input), and `outputAmount` — the amount of the single output coin: the sum of the merged inputs'
  `coin.amount` minus `fee` for XCH (mojos), or that sum for a CAT (base units) — the figure the
  builder's own contract fixes (`consolidation.rs:56-64`, `:99`). `outputAmount` is a report, not a
  computation the spend depends on.
- The SDK does NOT push: `ChiaProvider` has no broadcast method, and consolidation is a spend of real
  funds (it pays `fee` mojos and replaces the merged coins with one). The integrator pushes
  `{ coinSpends, signature }` through its own path and waits for confirmation.
- **Consent (North Star §6.0).** Consolidation is a spend, so it is explicit and disclosed: it runs
  ONLY when the integrator calls `consolidate()`, after an explained, dismissible prompt (§8.7).
  `requestPayment` never triggers it. Nothing in §8 runs on any READ path — selection never gates
  reading content.

### 8.7 The integrator loop (informative — SHOULD)

The hub's loop (`features/coin-management/consolidate.ts:57-110`) is the reference shape; an
integrator SHOULD implement it as:

1. call `requestPayment`; on `NEEDS_CONSOLIDATION` continue, on any other error stop;
2. show an honest, dismissible prompt built from `err.context`: how many coins the wallet holds
   (`availableCoinCount`, "at least" when it equals `sourceLimit`), that only the largest `cap` can
   be spent at once, the shortfall against `required`, the cost (`fee` mojos for XCH; a CAT merge is
   fee-less unless the app adds an XCH rider), and that ONE new coin replaces the merged ones.
   Declining surfaces the original `NEEDS_CONSOLIDATION` to the caller — never a silent retry, never
   a pre-ticked or timed prompt;
3. call `consolidate({ assetId?, fee })`, push `{ coinSpends, signature }` through the app's own
   path;
4. wait for on-chain confirmation — e.g. watch any merged input (`coinSpends[i].coin`) become spent;
5. re-run `requestPayment`; repeat from 1 with a bounded number of rounds (the hub uses 8), stopping
   on success, on the user cancelling, or on `INSUFFICIENT_FUNDS`.

### 8.8 Encoding at the wallet boundary _(open — Q3)_

- Coin spends cross the wallet boundary (`chip0002_signCoinSpends`) in the CHIP-0002 wire encoding:
  `{ coin: { parent_coin_info, puzzle_hash, amount }, puzzle_reveal, solution }`, `0x`-prefixed
  lowercase hex, `amount` a JS number when ≤ `2^53 − 1` and a decimal string above it (hub
  `lib/spend-convert.ts:195-215`, `coinSpendToWallet`). The wasm's `CoinSpend` (`Uint8Array` fields,
  `bigint` amount) is NOT JSON-serialisable — `JSON.stringify` throws on a `bigint` — so it cannot
  cross the WalletConnect relay or an extension message channel unconverted. The SDK currently
  forwards it raw (`src/provider/methods.ts:102-119`); this clause is not yet implemented.
- _(open — Q3: where the conversion lives — the `signCoinSpends` boundary, accepting both shapes —
  and which encoding `PaymentResult.coinSpends` / the `consolidate()` result return. Value fixed by
  this clause: the wallet MUST receive the wire encoding.)_

### 8.9 `MonetizationSpends` additions and public constants

- `MonetizationSpends` gains OPTIONAL members `selectCoins?`, `buildCoinConsolidation?`,
  `buildCatConsolidation?` with exactly the d.ts signatures of §8.1. Optional keeps every existing
  injector type-checking (additive); at runtime a missing member is `SPEND_BUILDER_UNAVAILABLE`
  (§8.5, §8.6). An injector that omits `selectCoins` can no longer complete `requestPayment` — the
  production path injects the whole wasm, so this reaches only test spies.
- The main entry exports `DEFAULT_COIN_CAP = 50` and `DEFAULT_COIN_SOURCE_LIMIT = 500`.
  `DEFAULT_COIN_CAP` MUST equal the cap the shared contract states; a change to it is a coordinated
  change (§6), and a test pins the value.

### 8.10 Backward compatibility (this surface)

- `RequestPaymentArgs` gains no required field; `coinLimit` keeps its name and type and now also
  bounds the selection. `PaymentResult` is unchanged. `MonetizationSpends` gains optional members
  only. `consolidate()`, the two constants and the two error codes are additive.
- A caller that never handled `NEEDS_CONSOLIDATION` / `INSUFFICIENT_FUNDS` receives a coded
  `DigSdkError` where it previously received a chip35 builder failure or an on-chain rejection; the
  failure direction is unchanged (closed — no spend is built).
