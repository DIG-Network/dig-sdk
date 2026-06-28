// The canonical CHIP-0002 / chia wallet method surface — the SINGLE source of truth shared by both
// transports (injected window.chia and WalletConnect→Sage) so they can never drift. Extracted +
// genericized from hub.dig.net's apps/web/lib/wallet-methods.js (the hub's "#40" parity list),
// with the hub-app specifics removed.
//
// A method present in one transport but not the other is a real bug: a WalletConnect session that
// omits (say) `chia_takeOffer` rejects the offer flow LOCALLY (SignClient never sends it), while
// the same flow works against an injected wallet — an asymmetry the user experiences as "works in
// one place, silently fails in the other". Keeping ONE list shared makes parity structural.

/** The canonical CHIP-0002 / chia method names the SDK negotiates with the wallet. */
export const WALLET_METHODS = [
  "chip0002_connect",
  "chip0002_chainId",
  "chip0002_getPublicKeys",
  "chip0002_getAssetCoins",
  "chip0002_getAssetBalance",
  "chip0002_signCoinSpends",
  "chip0002_signMessage",
  "chia_getAddress",
  "chia_signMessageByAddress",
  "chia_takeOffer",
] as const;

/** Union of the canonical wallet method names. */
export type WalletMethod = (typeof WALLET_METHODS)[number];

/**
 * Message-signing methods in preference order. `signMessage` tries the first one the active
 * session granted: `chia_signMessageByAddress` (sign by address, the login-challenge path) with
 * `chip0002_signMessage` (sign by public key) as the fallback — both are negotiated so a session
 * grants whichever the wallet supports.
 */
export const SIGN_METHODS = [
  "chia_signMessageByAddress",
  "chip0002_signMessage",
] as const;

/** Default Chia chain id (CAIP-2). Mainnet — there is no testnet flow. */
export const DEFAULT_CHAIN = "chia:mainnet";
