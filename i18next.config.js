// i18next-cli config (v1.67.x) — CI tooling for the i18n pipeline.
// Docs: https://github.com/i18next/i18next-cli
//
// The two translation files (en/vi) are committed and hand-maintained; this
// tooling only CHECKS them in CI (`npm run i18n:check`) — extraction writes
// nothing unless run manually with the same commands.
export default {
  locales: ["en", "vi"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    // Tests contain i18n-shaped strings (mock t(), assertions, fake keys)
    // that must never leak into the resource files.
    ignore: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/*.spec.ts",
      "src/**/*.spec.tsx",
      "src/**/__tests__/**",
    ],
    output: "src/locales/{{language}}/{{namespace}}.json",
    defaultNS: "translation",
    primaryLanguage: "en",
    secondaryLanguages: ["vi"],
    // Dynamic keys built via template literals (CacheManagerModal renders
    // `cache.label.${id}` with a typed CacheCategoryId union) cannot be
    // statically resolved by the extractor — without this pattern the
    // `removeUnusedKeys` pass would delete cache.label.* from the files.
    preservePatterns: ["cache.label.*"],
    // Hand-maintained resource files are the source of truth: never let the
    // extractor DELETE keys it cannot see in code (dynamic keys, keyPrefix
    // usage, template literals beyond cache.label.*). It only ADDS missing
    // keys; removal is a manual decision.
    removeUnusedKeys: false,
    // Files are hand-maintained with insertion order (slice-by-slice). Sorting
    // would rewrite every file on first run for zero semantic gain — extract
    // must be a no-op on a clean tree.
    sort: false,
  },
};
