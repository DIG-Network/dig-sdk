// The ONE predicate behind every #2719 coercion refusal in this package.
//
// `String(v)`, `Number(v)`, `v >>> 0` and template interpolation all reach
// `Array.prototype.join` / `Object.prototype.toString` for a non-scalar, and those recurse once per
// nesting level: a 117 KiB body nested 60 000 deep throws a raw `RangeError` (measured). An uncoded
// `RangeError` from a public export contradicts this package's contract that every failure it
// surfaces is a coded `DigSdkError`, and — thrown while evaluating the ARGUMENTS to a throw — it
// escapes every `catch` the throw site could plausibly have.
//
// It lives in its own leaf module because BOTH the RPC read path (`dig-client.ts`, refusing a
// hostile response field) and the URN parser (`urn.ts`, refusing a hostile argument) must ask the
// same question, while raising DIFFERENT coded errors for it — and `urn.ts` cannot import from
// `dig-client.ts`, which imports `urn.ts`. Sharing the PREDICATE and not the error keeps both
// layers honest without inverting the dependency.

/**
 * True when coercing `v` to a string or number could recurse — i.e. `v` is an object, array, or
 * function.
 *
 * Deliberately NOT "everything that is not a number": a numeric string coerces in constant time and
 * is accepted throughout this package today, so narrowing further would be an unrequested behaviour
 * change. `null` is a scalar here — `String(null)` is total.
 */
export function isNonScalar(v: unknown): v is object {
  return v !== null && (typeof v === "object" || typeof v === "function");
}

/** The name to report for a non-scalar, computed WITHOUT coercing the value itself. */
export function nonScalarTypeName(v: unknown): string {
  return Array.isArray(v) ? "array" : typeof v;
}
