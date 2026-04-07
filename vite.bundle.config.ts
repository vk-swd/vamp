import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

export default defineConfig({
  plugins: [react(), cssInjectedByJsPlugin()],
  build: {
    outDir: "dist-bundle",
    rollupOptions: {
      input: "src/main.tsx",
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "bundle.js",
      },
    },
  },
});
