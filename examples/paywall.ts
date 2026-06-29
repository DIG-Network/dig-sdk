// Typecheck harness for the README "Charge for access (Paywall)" example. Compiled (no emit, no run)
// against the built ./dist types to prove the public Paywall API matches the docs. Not shipped.

import { ChiaProvider, Paywall } from "@dignetwork/dig-sdk";

declare const dappOwnerPuzzleHashHex: string;
declare const resourceId: string;
declare const userId: string;
declare const observedPayment: unknown;
declare const nftParentSpend: unknown;

export async function chargeForAccess(): Promise<void> {
  // A connected wallet (prefers the injected DIG Browser wallet; falls back to WalletConnect → Sage).
  const provider = await ChiaProvider.connect({ mode: "injected" });

  // Under a bundler, the chip35 monetization wasm is loaded lazily — nothing to pass.
  const paywall = new Paywall(provider);

  // Charge 0.25 XCH to unlock a resource. The coin spend is built by the canonical wasm and pushed
  // to the wallet to sign — the SDK never hand-rolls a spend.
  const { receipt, signature, nonce } = await paywall.requestPayment({
    amount: 250_000_000_000n,
    owner: dappOwnerPuzzleHashHex,
    memo: `unlock:${resourceId}:${userId}`,
  });
  console.log(signature, nonce, receipt);

  // Charge a CAT (e.g. $DIG) instead of XCH by passing assetId:
  await paywall.requestPayment({
    amount: 100n,
    owner: dappOwnerPuzzleHashHex,
    assetId: "<cat-tail-hash-hex>",
  });

  // Later, gate access by re-checking the on-chain payment against the receipt.
  const verdict = await paywall.verifyReceipt({
    observed: observedPayment,
    owner: dappOwnerPuzzleHashHex,
    minAmount: 250_000_000_000n,
  });
  if (verdict.ok) console.log("access granted");

  // Or gate on holding an NFT / a collection membership instead of a payment.
  const nftAccess = await paywall.proveAccess({
    parentSpend: nftParentSpend,
    owner: dappOwnerPuzzleHashHex,
    nft: "<nft-launcher-id-hex>",
  });
  console.log(nftAccess.ok);
}
