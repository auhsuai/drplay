import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default environment stays "node" so existing pure-util tests are unaffected.
    // React component/hook tests opt into jsdom via the per-file pragma:
    //   // @vitest-environment jsdom
    environment: "node",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 15_000,
  },
  coverage: {
    provider: "v8",
    reporter: ["text", "html"],
    include: ["src/**/*.{ts,tsx}"],
    exclude: [
      "src/**/*.test.*",
      "src/test-setup.ts",
      "src/vite-env.d.ts",
      "src/main.tsx",
      "src/locales/**",
      "src/data/**",
    ],
    thresholds: {
      lines: 65,
      functions: 62,
      statements: 63,
      branches: 52,
    },
  },
});
