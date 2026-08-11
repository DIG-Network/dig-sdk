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
`DigClient` consumes is normatively specified in §7.

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
codes" and mirrored by `capabilities().errorCodes`; the codes this surface can throw are:

| Code                    | Thrown when                                                                                                                 | Context                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `NO_INJECTED_WALLET`    | `mode: "injected"` or `mode: "browser-wallet"` found no usable `window.chia`.                                               | `mode` (the caller's raw value), `acceptAnyInjected` |
| `WC_OPTIONS_REQUIRED`   | WalletConnect was needed (`mode: "walletconnect"`, or the WC leg of `"auto"`) but no `walletConnect` options were supplied. | `mode` (the caller's raw value)                      |
| `WC_DEPENDENCY_MISSING` | The optional `@walletconnect/sign-client` peer dependency is not installed/usable.                                          | —                                                    |
| `METHOD_NOT_SUPPORTED`  | The active transport/session does not grant the requested CHIP-0002 method.                                                 | `method`                                             |
| `WALLET_TIMEOUT`        | A WalletConnect RPC exceeded `requestTimeoutMs` without a response.                                                         | `method`, `timeoutMs`                                |

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

- `<store_id>` and the optional `<root>` are each **exactly 64 lowercase-normalized hex chars** (a
  32-byte SHA-256). `parseUrn` accepts mixed case and normalizes; emitters MUST lowercase.
- `<root>` is OPTIONAL and, when present, is ONLY a trust anchor (which generation to verify
  against) — it MUST NOT affect the retrieval or decryption keys (§7.2).
- `<resource_key>` is the path within the store; an empty resource key resolves to the default view
  `index.html`.
- `?salt=<hex>` carries the private-store secret salt (lowercased); absent for a public store.

**Query handling (normative).** Everything from the FIRST `?` is the query and is NOT part of
`<resource_key>`. Within it, `salt` is read as an ordinary query PARAMETER — in ANY position
(`?salt=<hex>`, `?salt=<hex>&x=1`, `?x=1&salt=<hex>`) — and the remainder of the query is discarded,
because no other parameter addresses a resource. A `salt` value that is not hex is not a salt.

A parser MUST NOT read `salt` in final position only. Doing so left the secret inside
`<resource_key>`, which is BOTH a key-derivation input and a field copied onto every returned read
result — so such a URN leaked the salt and simultaneously derived a key that could not decrypt
anything (#2518).

Only the query is removed. `#` is NOT a delimiter: a `<resource_key>` may contain a literal `#`
(`notes#1.md` is a valid, working key) and MUST be preserved verbatim. The consequence, and it is a
contract rather than an oversight: a `<resource_key>` cannot contain a literal `?`.

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
  per-response ciphertext ceiling implies, so every legal response fits. When an injected `fetch`
  returns a non-streaming `Response` shim (no `body` readable stream), the ceiling is enforced
  against the declared `content-length` header instead; an absent or unparseable `content-length`
  bypasses the ceiling for that response.
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
