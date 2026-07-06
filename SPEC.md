# dig-sdk — normative specification

This is the authoritative contract for **`@dignetwork/dig-sdk`**'s wallet-connector surface —
`ChiaProvider`, the two `WalletTransport` backends (injected `window.chia` / WalletConnect→Sage),
and the connector-selection API (`ConnectOptions`, `ChiaProvider.listConnectors`). An independent
reimplementation of this surface MUST behave as described here. Keywords **MUST**, **MUST NOT**,
**SHOULD**, and **MAY** are used in the RFC 2119 sense. Field/type names are the exported public
surface and are stable contracts.

The SDK's other pillars — `DigClient` (read-crypto), `Paywall` (monetization), the `/spend`
CHIP-0035 re-export, and the Vite/Next framework adapters — are documented in `README.md`; their
normative contracts land in this file as they are substantially touched.

---

## 1. Wallet transports

A `WalletTransport` is the low-level channel `ChiaProvider` issues CHIP-0002 RPCs through. Exactly
two backends exist:

| `backend` | Description |
|---|---|
| `"injected"` | The DIG Browser's in-process wallet (or a compatible CHIP-0002 extension) exposed as `window.chia`. No relay, no pairing, no QR. |
| `"walletconnect"` | WalletConnect v2 → Sage, over the WalletConnect relay. Requires `@walletconnect/sign-client` (optional peer dependency). |

Every `WalletTransport` implementation MUST expose:

| Member | Contract |
|---|---|
| `backend` | The `WalletBackend` this transport is (`"injected"` \| `"walletconnect"`), fixed at construction. |
| `chain` | The CAIP-2 chain id this transport is bound to. |
| `topic` | A session identifier: the real WalletConnect relay topic, or the fixed sentinel `"injected"` for the injected backend. |
| `supports(method): boolean` | True iff the active session grants `method`. An empty/unknown grant set MUST be treated as "granted" (fail open on capability, fail closed on the actual RPC). |
| `request(method, params): Promise<unknown>` | Issue one CHIP-0002 RPC. MUST reject with a `DigSdkError` (never a bare `Error`) when the method is unsupported or the transport fails. |
| `disconnect(): Promise<void>` | Best-effort teardown. MUST NOT throw for an already-torn-down session. |

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

| `mode` value | Resolution | Backward compatibility |
|---|---|---|
| `"auto"` (default when `mode` is omitted) | Try the injected transport first; if unavailable, fall back to WalletConnect. Never asks the caller. | The pre-#63 default; unchanged. |
| `"injected"` | Require the injected transport. Reject `NO_INJECTED_WALLET` if unavailable. | Pre-#63 value; unchanged. |
| `"browser-wallet"` | **Alias of `"injected"`** — identical resolution and identical `NO_INJECTED_WALLET` failure. Exists as the chooser-facing connector id (see §3). | Added by #63; purely additive. |
| `"walletconnect"` | Require the WalletConnect transport. Reject `WC_OPTIONS_REQUIRED` if `walletConnect` options are absent. | Unchanged. |

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
codes" and mirrored by `capabilities().errorCodes`; the codes this surface can throw are:

| Code | Thrown when | Context |
|---|---|---|
| `NO_INJECTED_WALLET` | `mode: "injected"` or `mode: "browser-wallet"` found no usable `window.chia`. | `mode` (the caller's raw value), `acceptAnyInjected` |
| `WC_OPTIONS_REQUIRED` | WalletConnect was needed (`mode: "walletconnect"`, or the WC leg of `"auto"`) but no `walletConnect` options were supplied. | `mode` (the caller's raw value) |
| `WC_DEPENDENCY_MISSING` | The optional `@walletconnect/sign-client` peer dependency is not installed/usable. | — |
| `METHOD_NOT_SUPPORTED` | The active transport/session does not grant the requested CHIP-0002 method. | `method` |
| `WALLET_TIMEOUT` | A WalletConnect RPC exceeded `requestTimeoutMs` without a response. | `method`, `timeoutMs` |

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
