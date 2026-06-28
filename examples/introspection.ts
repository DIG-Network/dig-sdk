// Typecheck harness for the README "Machine-readable surface (for agents)" section: SDK_VERSION,
// capabilities()/describe(), and the typed error taxonomy (DigSdkError + isDigSdkError). Compiled
// (no emit, no run) against the built ./dist types via tsconfig.examples.json to prove the public
// API matches the docs. Not shipped (excluded from the npm package).

import {
  SDK_VERSION,
  capabilities,
  describe,
  DigClient,
  DigSdkError,
  isDigSdkError,
  DIG_SDK_ERROR_CODES,
  type DigSdkErrorCode,
  type SdkCapabilities,
} from "@dignetwork/dig-sdk";

export function introspect(): void {
  console.log(SDK_VERSION); // "0.1.0"

  const cap: SdkCapabilities = capabilities(); // alias: describe()
  console.log(cap.name, cap.version, cap.defaultRpc);
  for (const m of cap.modules) console.log(m.name, m.entry, m.summary);
  console.log(cap.walletMethods, cap.signMethods, cap.transports, cap.chains);
  console.log(cap.errorCodes); // === Object.values(DIG_SDK_ERROR_CODES)

  // describe() is the same function.
  const same: boolean = describe === capabilities;
  console.log(same);

  // The error catalogue is a typed const + union.
  const code: DigSdkErrorCode = DIG_SDK_ERROR_CODES.ROOT_REQUIRED;
  console.log(code);
}

export async function handleErrors(urn: string): Promise<void> {
  try {
    await new DigClient().read({ urn });
  } catch (e) {
    if (isDigSdkError(e, "ROOT_REQUIRED")) {
      console.log("need a confirmed on-chain root");
    } else if (isDigSdkError(e, "RPC_TRANSPORT")) {
      console.log("content network unreachable; retry later");
    } else if (isDigSdkError(e)) {
      // A coded SDK error — branch on err.code / inspect err.context, or serialize it.
      const err: DigSdkError = e;
      console.log(err.code, err.context, err.toJSON());
    } else {
      throw e;
    }
  }
}
