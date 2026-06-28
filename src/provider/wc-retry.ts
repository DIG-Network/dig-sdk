// The transient-relay-publish detector — the double-prompt safety boundary. Lives in its own
// dependency-free module (no @walletconnect/sign-client) so it can be unit-tested under
// `node --test`. Ported verbatim in spirit from hub.dig.net/apps/web/lib/wc-retry.js.
//
// A WalletConnect request can fail in two very different ways:
//   • the relay failed to PUBLISH the request (it never reached the wallet) — safe to retry, the
//     wallet never saw it, so a retry can't double-prompt or double-sign; OR
//   • the wallet/user rejected, or the response timed out — NOT safe to retry.
// Only the first is transient. This predicate decides which.

/** True iff `err` looks like a transient relay-publish failure (request never reached the wallet). */
export function isTransientPublishError(err: unknown): boolean {
  const msg = (
    err instanceof Error ? err.message : typeof err === "string" ? err : ""
  ).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("publish") ||
    msg.includes("failed or timed out to publish") ||
    msg.includes("websocket connection failed") ||
    msg.includes("connection closed") ||
    msg.includes("socket stalled") ||
    msg.includes("request reset")
  );
}
