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
  /** The dig RPC could not be reached (network/transport failure). */
  RPC_TRANSPORT: "RPC_TRANSPORT",
  /** The dig RPC responded with an HTTP error or a JSON-RPC `error` object. */
  RPC_ERROR: "RPC_ERROR",
  /** The dig RPC returned a malformed / inconsistent payload (e.g. chunk-length mismatch). */
  RPC_MALFORMED_RESPONSE: "RPC_MALFORMED_RESPONSE",
  /** The vendored read-crypto wasm failed its SRI integrity check — fail closed. */
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
export type DigSdkErrorCode = (typeof DIG_SDK_ERROR_CODES)[keyof typeof DIG_SDK_ERROR_CODES];

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
    this.context = context;
    // Set `cause` directly (rather than via the ES2022 Error options arg) so the lib target stays
    // ES2020 while still preserving the underlying error for diagnostics.
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Brand the instance (non-enumerable) so isDigSdkError recognizes it across bundle boundaries.
    Object.defineProperty(this, DIG_SDK_ERROR_BRAND, { value: true, enumerable: false });
    // Preserve a correct prototype chain when compiled to ES5-ish targets / across realms.
    Object.setPrototypeOf(this, DigSdkError.prototype);
  }

  /** A JSON-friendly view of the error: `{ code, message, context }`. */
  toJSON(): { code: DigSdkErrorCode; message: string; context: DigSdkErrorContext } {
    return { code: this.code, message: this.message, context: this.context };
  }
}

/**
 * True iff `e` is a {@link DigSdkError} (optionally with a specific `code`). Uses a non-enumerable
 * BRAND rather than `instanceof` so it recognizes coded errors thrown from any of the SDK's
 * separately-bundled entry points (the main entry and `/adapters` inline distinct class identities).
 */
export function isDigSdkError(e: unknown, code?: DigSdkErrorCode): e is DigSdkError {
  const branded =
    e instanceof DigSdkError ||
    (typeof e === "object" && e !== null && (e as Record<string, unknown>)[DIG_SDK_ERROR_BRAND] === true);
  return branded && (code === undefined || (e as DigSdkError).code === code);
}
