import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;
const outDir = process.env.PAGE_OUT_DIR_ABS;
const page = process.env.PAGE!;
console.log("Building page:", page, "at", outDir);
export default defineConfig({
  plugins: [react(), cssInjectedByJsPlugin(), viteSingleFile()],
  resolve: {
    alias: {
      "@ts-src": path.resolve(process.cwd(), "src"),
    },
  },
  root: "pages",
  build: {
    outDir: outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: {
        main: page
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
});
