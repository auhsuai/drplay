import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default environment stays "node" so existing pure-util tests are unaffected.
    // React component/hook tests opt into jsdom via the per-file pragma:
    //   // @vitest-environment jsdom
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
