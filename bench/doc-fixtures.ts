// Document fixtures for the performance audit (text and scanned PDFs, a
// privacy batch of 100 mixed files).
//
//   bun bench/doc-fixtures.ts [--out temp/perf/fixtures/docs]
//
// Text PDFs are written with pdf-lib (a project dependency). Scanned pages are
// JPEGs rendered by ffmpeg drawtext (deterministic), embedded one per page.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = resolve(outIndex >= 0 ? args[outIndex + 1] : 'temp/perf/fixtures/docs');
mkdirSync(out, { recursive: true });

const LINES = [
  'Invoice 2026-0042 for consulting services rendered in October.',
  'Contact: Jane Example, jane.example@example.com, +1 555 0100.',
  'Account reference GB82 WEST 1234 5698 7654 32 (sample IBAN).',
  'The quick brown fox jumps over the lazy dog near the river bank.',
  'Payment is due within 30 days of the invoice date shown above.',
];

async function textPdf(pages: number): Promise<string> {
  const file = join(out, `text-${pages}p.pdf`);
  if (existsSync(file)) return file;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 0; page < pages; page += 1) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Page ${page + 1}`, { x: 50, y: 800, size: 16, font });
    for (let line = 0; line < 30; line += 1) p.drawText(LINES[(page + line) % LINES.length], { x: 50, y: 760 - line * 22, size: 11, font });
  }
  writeFileSync(file, await doc.save());
  return file;
}

function pageImage(index: number): string {
  const file = join(out, 'scan', `page-${index % 10}.jpg`);
  if (existsSync(file)) return file;
  mkdirSync(join(out, 'scan'), { recursive: true });
  const font = 'C\\:/Windows/Fonts/arial.ttf';
  const draws = LINES.concat(LINES).map((line, row) => `drawtext=fontfile='${font}':text='${line.replace(/[:']/g, ' ')}':x=120:y=${200 + row * 90}:fontsize=40:fontcolor=black`).join(',');
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=2480x3508', '-vf', `${draws},noise=alls=8:allf=t`, '-frames:v', '1', '-q:v', '4', file]);
  return file;
}

async function scannedPdf(pages: number): Promise<string> {
  const file = join(out, `scanned-${pages}p.pdf`);
  if (existsSync(file)) return file;
  const doc = await PDFDocument.create();
  for (let page = 0; page < pages; page += 1) {
    const image = await doc.embedJpg(readFileSync(pageImage(page)));
    const p = doc.addPage([595, 842]);
    p.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  }
  writeFileSync(file, await doc.save());
  return file;
}

const made: string[] = [];
for (const pages of [3, 30, 200]) made.push(await textPdf(pages));
for (const pages of [3, 30, 200]) made.push(await scannedPdf(pages));

// Privacy batch: 100 mixed files (JPEG photos, PDFs, WAV clips).
const batch = join(out, 'privacy-100');
mkdirSync(batch, { recursive: true });
const sources = [resolve('temp/perf/fixtures/image-1mp.jpg'), join(out, 'text-3p.pdf'), resolve('temp/perf/fixtures/speech-30s.wav')];
for (let index = 0; index < 100; index += 1) {
  const source = sources[index % sources.length];
  const target = join(batch, `file-${String(index + 1).padStart(3, '0')}.${source.split('.').pop()}`);
  if (!existsSync(target)) copyFileSync(source, target);
}
console.log(JSON.stringify({ out, made, privacyBatch: batch }));
