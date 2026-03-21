import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  test: {
    environment: 'jsdom',
    globals: true,
    // Only the mocked unit tests run under vitest; the integration tests
    // (testDb.tsx / testMain.tsx) run inside the Tauri webview.
    include: ['src/test/**/*.unit.test.{ts,tsx}'],
  },
  build: {
    rollupOptions: {
      input: {
        main: './index.html',
        // Second entry: the in-webview DB integration test page.
        // Open via Tauri dev server: http://localhost:1420/src/test/dbTest/mockPage.html
        dbTest: './src/test/dbTest/mockPage.html',
      },
    },
  },
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
      ignored: ["**/src-tauri/**"],
    },
  },
}));
