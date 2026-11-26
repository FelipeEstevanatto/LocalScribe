import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { seoPages } from './scripts/seo-plugin';
import { ffmpegMultithread } from './scripts/ffmpeg-mt-plugin';

/** Serve /video-editor/ from the app shell while running `vite dev`. */
function videoEditorDevRoute(): Plugin {
  return {
    name: 'localscribe-video-editor-route',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = request.url ?? '';
        if (/^\/video-editor\/?(?:\?|$)/.test(url)) {
          const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
          request.url = `/index.html${query}`;
        }
        next();
      });
    },
  };
}

/**
 * GitHub Pages-friendly config.
 *
 * `base: './'` keeps every generated asset URL relative, so the site works at
 * https://<user>.github.io/<repo>/ without hard-coding the repository name.
 *
 * ONNX Runtime Web is imported dynamically from its self-contained WebGPU
 * bundle. Vite emits that bundle's WASM asset next to the JS chunk and rewrites
 * the URL, so the runtime is served from this origin (no third-party CDN).
 */
export default defineConfig({
  base: './',
  plugins: [tailwindcss(), seoPages(), ffmpegMultithread(), videoEditorDevRoute()],
  worker: { format: 'es' },
  // Local dev and preview can send isolation headers directly. GitHub Pages
  // cannot, so public/coi-serviceworker.js provides the same headers there.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    // ORT ships its own ESM loader and dynamic WASM asset URL. Pre-bundling it
    // can break that relative reference in dev.
    // phonon-tts finds its worker and WASM files next to itself via
    // import.meta.url, which pre-bundling would move.
    exclude: ['onnxruntime-web', 'phonon-tts'],
    include: ['jassub'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
  },
});
