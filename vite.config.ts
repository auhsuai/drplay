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
  
  // Ở production chỉ drop 'debugger'. KHÔNG drop 'console'.
  // WHY: logger.ts monkeypatch console ở RUNTIME (initLogger tại main.tsx) —
  //   - console.log/info/debug -> no-op (im lặng ở prod)
  //   - console.warn/error     -> redact secret qua sanitizeArg (ẩn link/id/token)
  // esbuild.drop:['console'] xoá MỌI lời gọi console.* ở build-time (Vite/esbuild),
  // nên monkeypatch không bao giờ chạy -> mất TOÀN BỘ observability lỗi production
  // và biến nhánh PROD của logger.ts thành dead code. Bảo mật vẫn đảm bảo vì logger
  // đã redact. Nguồn: REFACTOR_MASTER_PLAN.md "Chuẩn tham chiếu 2026" (L33) +
  // vitejs/vite docs (config/shared-options.md `esbuild.drop`; guide/migration.md).
  // Vite 8 (rolldown/oxc) đổi sang build.rolldownOptions...drop* nhưng hành vi drop giữ nguyên.
  // => KHÔNG tự thêm lại 'console' vào drop; muốn tắt log prod hãy sửa logger.ts.
  esbuild: {
    drop: command === 'build' ? ['debugger'] : undefined,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-i18next', 'i18next', 'dexie', 'dexie-react-hooks', '@tauri-apps/api']
        }
      }
    }
  }
}));
