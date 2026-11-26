// Dev server config for long benchmark runs:
//   bunx vite --config bench/vite.bench.config.ts --host 127.0.0.1 --port 5174 --strictPort
//
// Same app config, but without HMR and without watching bench/ and temp/, so
// writing exports, fixtures or bench scripts never reloads a page mid-run, and
// with @ffmpeg/core pre-bundled so the first FFmpeg use does not trigger a
// dependency re-optimisation reload. App behaviour is unchanged.
import { mergeConfig } from 'vite';
import base from '../vite.config';

export default mergeConfig(base, {
  server: {
    hmr: false,
    watch: { ignored: ['**/bench/**', '**/temp/**', '**/dist/**'] },
  },
  optimizeDeps: { include: ['@ffmpeg/core'] },
});
