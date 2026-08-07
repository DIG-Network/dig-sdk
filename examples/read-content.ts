// Typecheck harness for the README "Read verified, encrypted content in 5 lines" example.
// Compiled (no emit, no run) against the built ./dist types via tsconfig.examples.json to prove the
// public API matches the docs. Not shipped (excluded from the npm package).

import { DigClient } from "@dignetwork/dig-sdk";

export async function readContent(): Promise<void> {
  const dig = new DigClient(); // defaults to https://rpc.dig.net

  // Rendering/serving? Use the secure-by-default readers (fail closed on decrypt/inclusion failure).
  const text0 = await dig.readVerified({
    urn: "urn:dig:chia:<storeId>/index.html",
    root: "<onchain-root-hex>",
  });
  console.log(new TextDecoder().decode(text0.bytes));

  // The oblivious primitive: advisory flags, never throws on unverified/undecryptable content.
  const { bytes, decrypted, verified } = await dig.read({
    urn: "urn:dig:chia:<storeId>/index.html",
    root: "<onchain-root-hex>",
  });
  console.log(decrypted, verified, new TextDecoder().decode(bytes));

  // Private store: salt inline in the URN, or passed explicitly.
  const text = await dig.readText({
    urn: "urn:dig:chia:<storeId>/secret.txt",
    root: "<onchain-root-hex>",
    salt: "<hex-salt>",
  });
  console.log(text);

  // Derive the URN's keys client-side (nothing sent to the network).
  const keys = await dig.deriveUrnKeys({
    urn: "urn:dig:chia:<storeId>/index.html",
  });
  console.log(keys.retrievalKey, keys.decryptionKey);
}
