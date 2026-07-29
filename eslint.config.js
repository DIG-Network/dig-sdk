// Flat-config ESLint for the dig-sdk library (CLAUDE.md §2.4a).
// `npm run lint` is a CI gate that must pass with ZERO errors. Formatting concerns are deferred to
// Prettier via eslint-config-prettier (the last extends wins, disabling every stylistic rule).
//
// Two linting surfaces, each with its own globals:
//   - src/**/*.ts       the library source (browser + Node 18+ dual target)
//   - test/**/*.mjs     the node:test unit suites + example harnesses
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Generated output + third-party trees are never linted.
    ignores: ["dist", "coverage", ".nyc_output"],
  },
  {
    // The dual-target library source.
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The node:test unit suites + typechecked example harnesses.
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["test/**/*.mjs", "examples/**/*.ts", "*.config.{js,ts,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  // Defer all stylistic rules to Prettier — MUST stay last.
  prettier,
);
