import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Serve the multithreaded FFmpeg core byte-for-byte at `ffmpeg-mt/`.
 *
 * Its thread workers are classic scripts that `import()` the core by URL, so
 * the files must not pass through Vite's transform pipeline (which injects
 * static imports) or be renamed with hashes. In dev a middleware streams them
 * from node_modules; in a build they are copied next to the app.
 */
const FILES = ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'];
const PREFIX = 'ffmpeg-mt/';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
};

export function ffmpegMultithread(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  const source = (file: string) => path.join(root, 'node_modules/@ffmpeg/core-mt/dist/esm', file);
  return {
    name: 'localscribe-ffmpeg-mt',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = (request.url ?? '').split('?')[0];
        const index = url.indexOf('/' + PREFIX);
        const file = index >= 0 ? url.slice(index + PREFIX.length + 1) : '';
        if (!FILES.includes(file)) return next();
        try {
          const body = await readFile(source(file));
          response.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
          response.setHeader('Content-Length', String(body.byteLength));
          // Worker scripts in an isolated page need the same isolation headers.
          response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          response.end(body);
        } catch (error) {
          next(error);
        }
      });
    },
    async writeBundle() {
      await mkdir(path.join(outDir, PREFIX), { recursive: true });
      await Promise.all(FILES.map((file) => copyFile(source(file), path.join(outDir, PREFIX, file))));
    },
  };
}
