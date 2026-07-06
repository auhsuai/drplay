import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  
  // BEST PRACTICE: Xóa hoàn toàn console trong bản Production từ khâu Build (tiết kiệm dung lượng và bảo mật tuyệt đối)
  esbuild: {
    drop: command === 'build' ? (['console', 'debugger'] as any) : undefined,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-i18next', 'i18next', 'dexie', 'dexie-react-hooks', '@tauri-apps/api'],
          utils: ['music-metadata-browser'] // if there's any other large deps
        }
      }
    }
  }
}));
