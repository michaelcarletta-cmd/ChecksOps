import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // The two rules eslint-plugin-react-hooks 5 recommended; version 7's recommended set adds the
      // React Compiler rules, which would change what this repository lints.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // New in eslint 10's js.configs.recommended; off so the eslint 10 upgrade lints exactly what eslint 9 did.
      // Enabling them (28 and 13 findings on 2026-11-02) is a separate change.
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
);
