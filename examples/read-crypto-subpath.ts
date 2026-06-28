// Typechecked example: the standalone read-crypto subpath (#16). Verifies
// `@dignetwork/dig-sdk/dig-client` exposes just the read path with types.

import {
  DigClient,
  DEFAULT_RPC,
  DIG_CLIENT_WASM_SHA256,
  parseUrn,
  type ReadResult,
} from "@dignetwork/dig-sdk/dig-client";

void (DEFAULT_RPC as string);
void (DIG_CLIENT_WASM_SHA256 as string);

export async function readOne(urn: string, root: string): Promise<ReadResult> {
  const parsed = parseUrn(urn);
  void parsed.storeId;
  const dig = new DigClient();
  return dig.read({ urn, root });
}
