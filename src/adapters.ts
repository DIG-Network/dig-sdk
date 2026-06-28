// @dignetwork/dig-sdk adapter CORE — the framework-agnostic, side-effect-free building blocks the
// Vite plugin (`@dignetwork/dig-sdk/vite`) and the Next static-export adapter
// (`@dignetwork/dig-sdk/next`) are composed from. Importing this module pulls in NO framework
// (no Vite, no Next) and spawns nothing — it is pure config/argv/string logic, so it unit-tests
// without a real build and is safe to import anywhere.
//
// The pure pieces:
//   • dig.toml reader      — parse the deploy-relevant keys from a project's dig.toml.
//   • config resolution    — compose options > env > dig.toml > defaults into one config.
//   • deploy glue          — argv + env for `digstore deploy --json`, and result parsing.
//   • dev-shim generator   — the eval-free `window.chia` dev stub string.

export { parseDigToml, type DigTomlConfig } from "./adapters/dig-toml.js";
export {
  resolveDeployConfig,
  type AdapterOptions,
  type ResolvedDeployConfig,
  type ResolveInput,
} from "./adapters/config.js";
export {
  buildDeployArgs,
  buildDeployEnv,
  parseDeployResult,
  type DeployArgsOptions,
  type DeployResult,
} from "./adapters/deploy.js";
export {
  devShimScript,
  DEV_SHIM_MARKER,
  type DevShimOptions,
} from "./adapters/dev-shim.js";

// The runtime deploy runner (spawns `digstore`). Node-only; lives here so both adapters reuse it.
export { runDeploy, type RunDeployOptions } from "./adapters/run.js";
