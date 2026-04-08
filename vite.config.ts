import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), cssInjectedByJsPlugin()],
  clearScreen: false,
  build: {
    rollupOptions: {
      // input: {
      //   main: './index.html',
      //   // Second entry: the in-webview DB integration test page.
      //   // Open via Tauri dev server: http://localhost:1420/src/test/dbTest/mockPage.html
      //   // dbTest: './src/test/dbTest/mockPage.html',
      // },
      input: './index.html',
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "bundle.js",
      }
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
});
