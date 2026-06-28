// Typecheck harness for the README "Connect a wallet + sign" and "Build + sign a store spend"
// examples. Compiled (no emit, no run) against the built ./dist types to prove the public API
// matches the docs. Not shipped (excluded from the npm package).

import { ChiaProvider } from "@dignetwork/dig-sdk";
import * as spend from "@dignetwork/dig-sdk/spend";

declare function showWalletConnectQr(uri: string): void;

export async function connectAndSign(): Promise<void> {
  // Prefers the injected DIG Browser wallet; falls back to WalletConnect → Sage.
  const provider = await ChiaProvider.connect({
    mode: "auto",
    walletConnect: {
      projectId: "<walletconnect-cloud-project-id>",
      metadata: {
        name: "My DIG dapp",
        description: "Built with @dignetwork/dig-sdk",
        url: "https://my-dapp.example",
        icons: ["https://my-dapp.example/icon.png"],
      },
      onUri: (uri) => showWalletConnectQr(uri),
    },
  });

  console.log("connected via", provider.backend);
  const address = await provider.getAddress();
  console.log("address", address);

  const { publicKey, signature } = await provider.signMessage("Login to My DIG dapp");
  console.log(publicKey, signature);

  const xch = await provider.getXchBalance();
  console.log("xch balance (mojos)", xch);
}

export async function buildAndSignSpend(): Promise<void> {
  spend.init();
  const provider = await ChiaProvider.connect({ mode: "injected" });
  // coinSpends would come from a builder call (e.g. spend.mintStore(...)).
  const aggregatedSignature = await provider.signCoinSpends([]);
  console.log(aggregatedSignature);
}
