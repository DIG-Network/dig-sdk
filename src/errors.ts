// The SDK's typed error taxonomy — the machine-readable failure contract.
//
// Every failure the SDK surfaces is a `DigSdkError` (an `Error` subclass) carrying a STABLE,
// documented `.code` (UPPER_SNAKE) plus structured context fields. An agent (or a UI) can branch on
// `err.code` instead of string-matching the human `.message`, and the catalogue is discoverable from
// the `.d.ts` via the exported `DIG_SDK_ERROR_CODES` const and the `DigSdkErrorCode` union.
//
// The codes are symbolic and never derived from the human message — the message is for humans, the
// code is for machines. Keep this catalogue and the README "Error codes" table in lockstep.

/**
 * The stable error-code catalogue. Each value is an UPPER_SNAKE symbolic string that callers may
 * branch on. Frozen so it can't be mutated at runtime; the README documents each meaning.
 */
import { redactUrnSalt, REDACTED_SALT } from "./urn.js";

export const DIG_SDK_ERROR_CODES = Object.freeze({
  // ---- provider / connect (provider/chia-provider.ts, provider/*) ----
  /** WalletConnect was requested/needed but no `walletConnect` options were supplied. */
  WC_OPTIONS_REQUIRED: "WC_OPTIONS_REQUIRED",
  /** `mode: "injected"` (or the injected leg of `auto`) found no usable `window.chia`. */
  NO_INJECTED_WALLET: "NO_INJECTED_WALLET",
  /** The optional `@walletconnect/sign-client` peer dependency is not installed/usable. */
  WC_DEPENDENCY_MISSING: "WC_DEPENDENCY_MISSING",
  /** The active wallet session/transport does not grant the requested method. */
  METHOD_NOT_SUPPORTED: "METHOD_NOT_SUPPORTED",
  /** A wallet RPC timed out (e.g. Sage did not respond within the per-request timeout). */
  WALLET_TIMEOUT: "WALLET_TIMEOUT",
  /** The wallet returned no public keys / no key to sign with. */
  WALLET_NO_KEYS: "WALLET_NO_KEYS",

  // ---- read-crypto / RPC (dig-client.ts, loader.ts) ----
  /** A content read needs a confirmed on-chain root and none was supplied/derivable. */
  ROOT_REQUIRED: "ROOT_REQUIRED",
  /** The resource did not decrypt+authenticate under this URN (wrong key/salt, or a decoy). */
  DECRYPT_FAILED: "DECRYPT_FAILED",
  /**
   * The served content did not verify against a PINNED on-chain root — its inclusion proof failed.
   * The secure-by-default readers (`readVerified`/`readText`) throw this when the effective root is
   * pinned (anything but an explicit unpinned sentinel) and `verified === false`, rather than return
   * chain-unbacked bytes: decryption success alone proves only "knows a public key", NOT chain
   * origin, so an untrusted/spoofed node (e.g. a plaintext `localhost` under the §5.3 ladder) could
   * otherwise serve attacker plaintext. Under an UNPINNED / "latest" root inclusion cannot be
   * checked in the blind model, so it is advisory and this is NOT thrown (the blind-model exception).
   * Callers that deliberately want the raw advisory bytes use the oblivious `read`/`readResource`
   * (which return `{ verified, decrypted }` and never throw on unverified content).
   */
  INCLUSION_UNVERIFIED: "INCLUSION_UNVERIFIED",
  /**
   * DEPRECATED (retained for back-compat). The old blanket "unverified content" code the pre-#2262
   * fail-closed `read`/`readText` threw for ANY `verified === false`. The nuanced replacement is
   * `INCLUSION_UNVERIFIED` (thrown only under a PINNED root). No SDK code path throws this anymore;
   * kept in the catalogue so existing `err.code === "CONTENT_UNVERIFIED"` branches still type-check.
   */
  CONTENT_UNVERIFIED: "CONTENT_UNVERIFIED",
  /** The dig RPC could not be reached (network/transport failure). */
  RPC_TRANSPORT: "RPC_TRANSPORT",
  /** The dig RPC responded with an HTTP error or a JSON-RPC `error` object. */
  RPC_ERROR: "RPC_ERROR",
  /** The dig RPC returned a malformed / inconsistent payload (e.g. chunk-length mismatch). */
  RPC_MALFORMED_RESPONSE: "RPC_MALFORMED_RESPONSE",
  /**
   * A node declared a resource `total_length` above the protocol ceiling (or one the host cannot
   * allocate). Refused BEFORE allocating, so an untrusted node (the §5.3 ladder makes an
   * unauthenticated local node the default endpoint) cannot force a giant allocation as a cheap DoS.
   */
  RESOURCE_TOO_LARGE: "RESOURCE_TOO_LARGE",
  /** The read-crypto wasm failed its SRI integrity check — fail closed. */
  WASM_INTEGRITY: "WASM_INTEGRITY",
  /** The read-crypto wasm could not be loaded (fetch/resolve failure). */
  WASM_LOAD_FAILED: "WASM_LOAD_FAILED",

  // ---- paywall / spends (paywall.ts) ----
  /** The canonical chip35 wasm builder for this operation is unavailable (never hand-rolled). */
  SPEND_BUILDER_UNAVAILABLE: "SPEND_BUILDER_UNAVAILABLE",
  /** No secure random source was available to generate a payment nonce. */
  NO_SECURE_RANDOM: "NO_SECURE_RANDOM",

  // ---- deploy / adapters (adapters/run.ts, adapters/deploy.ts) ----
  /** The `digstore` binary could not be spawned (not installed / not on PATH). */
  DIGSTORE_NOT_FOUND: "DIGSTORE_NOT_FOUND",
  /** `digstore deploy` exited non-zero. */
  DEPLOY_FAILED: "DEPLOY_FAILED",
  /** `digstore deploy --json` output could not be parsed into a capsule result. */
  DEPLOY_OUTPUT_UNPARSEABLE: "DEPLOY_OUTPUT_UNPARSEABLE",

  // ---- argument validation (shared) ----
  /** An argument was malformed (e.g. a non-hex string, a bad URN, mutually-exclusive options). */
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
} as const);

/** The union of every stable SDK error code. Branch on `err.code` against these. */
export type DigSdkErrorCode =
  (typeof DIG_SDK_ERROR_CODES)[keyof typeof DIG_SDK_ERROR_CODES];

/** Structured, code-specific context attached to a {@link DigSdkError}. All fields optional. */
export interface DigSdkErrorContext {
  /** The dig RPC method involved (RPC_* errors). */
  rpcMethod?: string;
  /** The HTTP status returned (RPC_ERROR on a non-2xx). */
  httpStatus?: number;
  /** The JSON-RPC error code returned by the server (RPC_ERROR). */
  rpcCode?: number;
  /** The `digstore` process exit code (DEPLOY_FAILED). */
  exitCode?: number | null;
  /** The wallet method that was unsupported (METHOD_NOT_SUPPORTED). */
  method?: string;
  /** The connection mode in play (provider errors). */
  mode?: string;
  /** The offending value (INVALID_ARGUMENT — e.g. the bad hex / URN). */
  value?: string;
  /** The expected vs actual SRI digest (WASM_INTEGRITY). */
  expected?: string;
  actual?: string;
  /** Any further structured detail; kept open so codes can carry extra fields. */
  [key: string]: unknown;
}

/**
 * The SDK's typed error. Always thrown (never a bare `Error`) so consumers can branch on `.code`.
 *
 * @example
 * try {
 *   await dig.read({ urn });
 * } catch (e) {
 *   if (e instanceof DigSdkError && e.code === "ROOT_REQUIRED") promptForRoot();
 *   else throw e;
 * }
 */
/**
 * A brand stamped on every {@link DigSdkError}. The SDK ships several independently-bundled entry
 * points (index, adapters, vite, next, dig-client), each of which inlines its own copy of this
 * module — so two `DigSdkError`s can have DIFFERENT class identities across bundles and a plain
 * `instanceof` would miss one. {@link isDigSdkError} brand-checks instead, so a coded error thrown
 * from `@dignetwork/dig-sdk/adapters` is still recognized by `isDigSdkError` imported from the main
 * entry. Non-enumerable so it never shows up in `toJSON()` / spreads.
 */
const DIG_SDK_ERROR_BRAND = "__dignetwork_dig_sdk_error__";

/** The placeholder a context value is replaced with when it is not safely representable. */
const OMITTED = "<omitted>";

/**
 * How many levels deep {@link redactContext} walks a `context` value before replacing the rest with
 * {@link OMITTED}. Error context is DIAGNOSTIC — a handful of levels carries everything a human or
 * an agent reads — while an unbounded walk recurses once per level of an attacker-shaped object.
 * 32 is far above any context the SDK's own throw sites author and far below any host's call-stack
 * frame budget, so the walk terminates on every runtime regardless of the input's depth (#2719).
 */
const MAX_CONTEXT_DEPTH = 32;

/**
 * Redact any private-store salt from every string in a context value (recursively), at the SINGLE
 * point context is stored on an error. A per-call-site redaction is one a future throw site forgets;
 * doing it here means every {@link DigSdkError} — whatever its code or fields — is safe to log.
 *
 * Bounded in BOTH directions a hostile object can be shaped: `seen` collapses cycles, and `depth`
 * stops a deeply nested (acyclic) object. The depth bound is the load-bearing one — a hostile RPC
 * response is nested, not cyclic, and an unbounded walk blew the stack from INSIDE the constructor
 * (#2719), turning a throw site that was correctly refusing hostile input into an uncoded
 * `RangeError` escaping the SDK's whole public surface.
 */
function redactContext<T>(
  value: T,
  seen: WeakMap<object, unknown> = new WeakMap(),
  depth = 0,
): T {
  if (typeof value === "string") {
    // `redactUrnSalt` is pure and non-throwing by contract; this try/catch is a hard guarantee that
    // error CONSTRUCTION can never itself throw or (worse) construct another DigSdkError from
    // unredacted input — on any failure fall back to the fully-redacted placeholder, never the raw
    // (possibly salted) string.
    try {
      return redactUrnSalt(value) as T;
    } catch {
      return REDACTED_SALT as T;
    }
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_CONTEXT_DEPTH) return OMITTED as T;
  // A cyclic `context` would otherwise recurse until the stack blows — a RangeError thrown from
  // error CONSTRUCTION, outside the string-only try/catch above and outside any `catch` the throw
  // site could plausibly have (#2518). `context` is authored by SDK throw sites rather than by
  // untrusted input, so this is hardening, not a live exploit path. Memoizing the redacted copy
  // (rather than merely marking nodes visited) also PRESERVES the input's sharing/cycle structure,
  // so a self-referential context survives redaction as a self-referential result.
  const cached = seen.get(value);
  if (cached !== undefined) return cached as T;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const v of value) out.push(redactContext(v, seen, depth + 1));
    return out as T;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const k of ownEnumerableKeys(value)) {
    // A property read can itself throw (an accessor on an attacker-shaped object), which would
    // propagate out of the constructor. Read each property defensively and record the failure as a
    // placeholder rather than losing the whole error.
    try {
      defineDataProperty(
        out,
        k,
        redactContext((value as Record<string, unknown>)[k], seen, depth + 1),
      );
    } catch {
      defineDataProperty(out, k, OMITTED);
    }
  }
  return out as T;
}

/**
 * Write `value` at `key` as an ordinary own data property — never through a setter.
 *
 * `out[key] = value` is not an assignment for every key. `out["__proto__"]` reaches the accessor on
 * `Object.prototype` and REPLACES the copy's prototype instead of creating a property, which loses
 * the subtree from `JSON.stringify` (silently discarded diagnostics) and, for a `null` value, hands
 * the consumer a null-prototype object that throws on `hasOwnProperty`. `defineProperty` writes the
 * slot the redaction copy is supposed to have, whatever the key is called.
 *
 * This is not a pollution fix — the target is a fresh object and the subtree is already redacted
 * before it is written — but a redaction pass must not be able to lose or booby-trap the diagnostics
 * it exists to make safe.
 */
function defineDataProperty(
  out: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(out, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Own enumerable string keys of `value`, or none if the object refuses enumeration. */
function ownEnumerableKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

/**
 * Redact `context`, guaranteeing the caller gets a value back. The bounds inside
 * {@link redactContext} already make a throw unreachable for every shape we know of; this is the
 * last line, because a throw HERE happens during error CONSTRUCTION — inside a `throw new
 * DigSdkError(...)` a call site cannot wrap — and would replace a coded, catchable failure with an
 * uncoded one (#2719). Losing the diagnostic context is always the better trade.
 */
function safeRedactContext(context: DigSdkErrorContext): DigSdkErrorContext {
  try {
    return redactContext(context);
  } catch {
    return { contextRedactionFailed: true };
  }
}

export class DigSdkError extends Error {
  /** The stable machine code (UPPER_SNAKE). Branch on this, not the message. */
  readonly code: DigSdkErrorCode;
  /** Structured, code-specific context (rpcMethod, httpStatus, exitCode, …). */
  readonly context: DigSdkErrorContext;

  constructor(
    code: DigSdkErrorCode,
    message: string,
    context: DigSdkErrorContext = {},
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "DigSdkError";
    this.code = code;
    // Redact any private-store salt from context here so no throw site can ever leak it (#2303).
    this.context = safeRedactContext(context);
    // Set `cause` directly (rather than via the ES2022 Error options arg) so the lib target stays
    // ES2020 while still preserving the underlying error for diagnostics.
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Brand the instance (non-enumerable) so isDigSdkError recognizes it across bundle boundaries.
    Object.defineProperty(this, DIG_SDK_ERROR_BRAND, {
      value: true,
      enumerable: false,
    });
    // Preserve a correct prototype chain when compiled to ES5-ish targets / across realms.
    Object.setPrototypeOf(this, DigSdkError.prototype);
  }

  /** A JSON-friendly view of the error: `{ code, message, context }`. */
  toJSON(): {
    code: DigSdkErrorCode;
    message: string;
    context: DigSdkErrorContext;
  } {
    return { code: this.code, message: this.message, context: this.context };
  }
}

/**
 * True iff `e` is a {@link DigSdkError} (optionally with a specific `code`). Uses a non-enumerable
 * BRAND rather than `instanceof` so it recognizes coded errors thrown from any of the SDK's
 * separately-bundled entry points (the main entry and `/adapters` inline distinct class identities).
 */
export function isDigSdkError(
  e: unknown,
  code?: DigSdkErrorCode,
): e is DigSdkError {
  const branded =
    e instanceof DigSdkError ||
    (typeof e === "object" &&
      e !== null &&
      (e as Record<string, unknown>)[DIG_SDK_ERROR_BRAND] === true);
  return branded && (code === undefined || (e as DigSdkError).code === code);
}
