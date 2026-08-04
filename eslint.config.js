import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "dist-ssr",
      "node_modules",
      ".playwright-mcp",
      "src-tauri",
      ".opencode",
      ".superpowers",
      ".github",
      "docs",
      "public",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.strictTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true },
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...reactHooks.configs.flat["recommended-latest"].rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", disallowTypeAnnotations: false },
      ],
    },
  },
  {
    files: ["vite.config.ts", "vitest.config.ts", "postcss.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
