import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const SHARED_TEST_BROWSER_FOLDER = process.env.SHARED_TEST_BROWSER_FOLDER;

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: SHARED_TEST_BROWSER_FOLDER,
    rollupOptions: {
      input: 'test.html',
    },
  },
});