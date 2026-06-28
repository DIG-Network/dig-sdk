// Minimal `dig.toml` reader for the framework adapters.
//
// `digstore deploy` reads its config from a project's `dig.toml` (digstore-cli/src/dig_toml.rs).
// The adapters need the SAME few top-level keys so a project's `dig.toml` is the single source of
// truth across the CLI and the plugins. Rather than pull in a TOML parser dependency for ~7 flat
// `key = "value"` lines, we parse just those keys ourselves. We accept BOTH the canonical
// kebab-case key and the snake_case alias, exactly like digstore's `#[serde(rename/alias)]`.
//
// Anything beyond these keys (tables, arrays, nested values) is intentionally ignored — the
// adapters only forward the deploy-relevant scalars to `digstore deploy`, which re-reads the full
// file authoritatively.

/** The deploy-relevant subset of `dig.toml`, in the adapters' camelCase shape. */
export interface DigTomlConfig {
  storeId?: string;
  outputDir?: string;
  buildCommand?: string;
  message?: string;
  network?: string;
  remote?: string;
  waitTimeout?: number;
}

// Map each canonical/alias TOML key onto the camelCase field. kebab-case is canonical (it is what
// `digstore new` writes); snake_case is the tolerated alias. When both appear, the canonical
// kebab-case key wins (it is applied last).
const KEY_MAP: Record<string, keyof DigTomlConfig> = {
  store_id: "storeId",
  "store-id": "storeId",
  output_dir: "outputDir",
  "output-dir": "outputDir",
  build_command: "buildCommand",
  "build-command": "buildCommand",
  message: "message",
  network: "network",
  remote: "remote",
  wait_timeout: "waitTimeout",
  "wait-timeout": "waitTimeout",
};

// Apply snake_case first then kebab-case so the canonical kebab form overrides the alias.
const APPLY_ORDER = Object.keys(KEY_MAP).sort((a) =>
  a.includes("-") ? 1 : -1,
);

/** Strip a `# comment` that is not inside a quoted value. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/** Unquote a TOML scalar: `"x"` / `'x'` → `x`; a bare token is returned trimmed. */
function unquote(raw: string): string {
  const v = raw.trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse the deploy-relevant keys out of a `dig.toml` string. Unknown keys, tables, and nested
 * structures are ignored. Returns only the keys actually present (so it composes cleanly under the
 * precedence rules in resolveDeployConfig).
 */
export function parseDigToml(text: string): DigTomlConfig {
  // Collect raw (canonical-or-alias) string values keyed by the TOML key as written.
  const raw: Record<string, string> = {};
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = stripComment(lineRaw).trim();
    if (!line || line.startsWith("[")) continue; // skip blanks + table headers
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in KEY_MAP)) continue;
    raw[key] = unquote(line.slice(eq + 1));
  }

  const out: DigTomlConfig = {};
  for (const key of APPLY_ORDER) {
    const value = raw[key];
    const field = KEY_MAP[key];
    if (value === undefined || field === undefined) continue;
    if (field === "waitTimeout") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) out.waitTimeout = n;
    } else {
      out[field] = value;
    }
  }
  return out;
}
