import { defineConfig } from 'vite';

// Harness-only server: no HMR full-page reloads while a long benchmark runs.
export default defineConfig({
  server: {
    hmr: false,
  },
});
