// Deterministic fixture corpus for the performance audit.
//
//   bun bench/perf-fixtures.ts [--set core|full] [--out temp/perf/fixtures]
//
// "core" (about 120 MB) is what bench/video-heavy.mjs and the page modules
// need. "full" adds the long speech, music, 4K60, portrait, VFR, 10-bit, MKV,
// AVI/WMV, image and document inputs from the brief (several GB; check free
// space first). Every command is printed and written to <out>/commands.json.
// ffmpeg must be on PATH. Existing files are skipped.
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const set = flag('--set', 'core');
const out = flag('--out', 'temp/perf/fixtures');
mkdirSync(out, { recursive: true });
const JFK = 'public/samples/jfk.wav';

type Job = { file: string; args: string[]; set: 'core' | 'full' };
const v = (size: string, rate: number, seconds: number, src = 'testsrc2') =>
  ['-f', 'lavfi', '-i', `${src}=size=${size}:rate=${rate}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds)];
const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-shortest'];

const jobs: Job[] = [
  // Core set used by the editor benchmark seed.
  { set: 'core', file: 'v1080p30-10s.mp4', args: [...v('1920x1080', 30, 10), ...h264] },
  { set: 'core', file: 'v2160p30-10s.mp4', args: [...v('3840x2160', 30, 10), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-shortest'] },
  { set: 'core', file: 'mandel1080p30-15s.mp4', args: [...v('1920x1080', 30, 15, 'mandelbrot'), ...h264] },
  { set: 'core', file: 'vp9-1080p-10s.webm', args: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '10', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '4M'] },
  { set: 'core', file: 'hevc-1080p-10s.mp4', args: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '10', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1'] },
  { set: 'core', file: 'speech-5min.wav', args: ['-i', JFK, '-filter_complex', 'aloop=loop=-1:size=2e9,atrim=0:300', '-ar', '16000', '-ac', '1'] },
  // Full set.
  { set: 'full', file: 'speech-30s.wav', args: ['-i', JFK, '-filter_complex', 'aloop=loop=-1:size=2e9,atrim=0:30', '-ar', '16000', '-ac', '1'] },
  { set: 'full', file: 'speech-30min.wav', args: ['-i', JFK, '-filter_complex', 'aloop=loop=-1:size=2e9,atrim=0:1800', '-ar', '16000', '-ac', '1'] },
  { set: 'full', file: 'speech-2h.wav', args: ['-i', JFK, '-filter_complex', 'aloop=loop=-1:size=2e9,atrim=0:7200', '-ar', '16000', '-ac', '1'] },
  { set: 'full', file: 'speech-5min.mp3', args: ['-i', join(out, 'speech-5min.wav'), '-c:a', 'libmp3lame', '-b:a', '128k'] },
  { set: 'full', file: 'speech-5min.m4a', args: ['-i', join(out, 'speech-5min.wav'), '-c:a', 'aac', '-b:a', '128k'] },
  { set: 'full', file: 'speech-5min.opus', args: ['-i', join(out, 'speech-5min.wav'), '-c:a', 'libopus', '-b:a', '64k'] },
  { set: 'full', file: 'speech-5min.flac', args: ['-i', join(out, 'speech-5min.wav'), '-c:a', 'flac'] },
  { set: 'full', file: 'speech-pauses-5min.wav', args: ['-i', JFK, '-filter_complex', 'apad=pad_dur=8,aloop=loop=-1:size=2e9,atrim=0:300', '-ar', '16000', '-ac', '1'] },
  { set: 'full', file: 'speech-noisy-5min.wav', args: ['-i', join(out, 'speech-5min.wav'), '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.05:sample_rate=16000', '-filter_complex', 'amix=inputs=2:duration=first', '-ar', '16000', '-ac', '1'] },
  { set: 'full', file: 'music-3min.wav', args: ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100', '-i', JFK, '-filter_complex', '[1]aloop=loop=-1:size=2e9,atrim=0:180,aresample=44100[v];[0]atrim=0:180[s];[s][v]amix=inputs=2,pan=stereo|c0=c0|c1=c0', '-t', '180'] },
  { set: 'full', file: 'v1080p60-1min.mp4', args: [...v('1920x1080', 60, 60), ...h264] },
  { set: 'full', file: 'v2160p60-1min.mp4', args: [...v('3840x2160', 60, 60), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] },
  // V14 source (20 x 3 min, looped) and the 2160p60 source for V12 at 60 fps: bitrate-capped to keep projects storable.
  { set: 'full', file: 'v1080p30-3min-4M.mp4', args: [...v('1920x1080', 30, 180), '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '8M', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-shortest'] },
  { set: 'full', file: 'v1080p30-5min.mp4', args: [...v('1920x1080', 30, 300), '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '8M', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-shortest'] },
  { set: 'full', file: 'v2160p60-20s.mp4', args: [...v('3840x2160', 60, 20), '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '40M', '-maxrate', '40M', '-bufsize', '80M', '-pix_fmt', 'yuv420p', '-g', '120', '-c:a', 'aac', '-b:a', '128k', '-shortest'] },
  { set: 'full', file: 'portrait-1080x1920-10s.mp4', args: [...v('1080x1920', 30, 10), ...h264] },
  { set: 'full', file: 'av1-1080p-10s.mp4', args: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '10', '-c:v', 'libsvtav1', '-preset', '12'] },
  { set: 'full', file: 'yuv420p10-1080p-10s.mp4', args: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '10', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1'] },
  { set: 'full', file: 'vfr-1080p-10s.mp4', args: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-t', '10', '-vf', "select='not(mod(n\\,3))+lt(n\\,120)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast'] },
  { set: 'full', file: 'legacy.avi', args: [...v('640x360', 30, 10), '-c:v', 'mpeg4', '-c:a', 'mp3', '-shortest'] },
  { set: 'full', file: 'legacy.wmv', args: [...v('640x360', 30, 10), '-c:v', 'wmv2', '-c:a', 'wmav2', '-shortest'] },
  { set: 'full', file: 'image-12mp.jpg', args: ['-f', 'lavfi', '-i', 'mandelbrot=size=4000x3000', '-frames:v', '1', '-q:v', '3'] },
  { set: 'full', file: 'image-1mp.jpg', args: ['-f', 'lavfi', '-i', 'mandelbrot=size=1152x864', '-frames:v', '1', '-q:v', '3'] },
  // mandelbrot cannot render 8000x6000 directly; upscale the 12 MP render.
  { set: 'full', file: 'image-48mp.jpg', args: ['-f', 'lavfi', '-i', 'mandelbrot=size=4000x3000', '-vf', 'scale=8000:6000:flags=bicubic', '-frames:v', '1', '-q:v', '3'] },
  { set: 'full', file: 'image-alpha-12mp.png', args: ['-f', 'lavfi', '-i', 'testsrc2=size=4000x3000', '-vf', 'format=rgba,geq=r=r(X\\,Y):a=255*gt(X\\,2000)', '-frames:v', '1'] },
];

const run = jobs.filter((job) => set === 'full' || job.set === 'core');
const record: { file: string; command: string; bytes: number; ms: number; skipped?: boolean; error?: string }[] = [];
for (const job of run) {
  const target = join(out, job.file);
  const command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...job.args, target];
  if (existsSync(target)) {
    record.push({ file: job.file, command: command.join(' '), bytes: statSync(target).size, ms: 0, skipped: true });
    continue;
  }
  const start = performance.now();
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8' });
  const ms = Math.round(performance.now() - start);
  record.push({ file: job.file, command: command.join(' '), bytes: existsSync(target) ? statSync(target).size : 0, ms, ...(result.status ? { error: result.stderr.trim().slice(0, 400) } : {}) });
  console.error(`${job.file}: ${result.status ? 'failed' : 'ok'} in ${ms} ms`);
}
writeFileSync(join(out, 'commands.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify({ set, out, files: record.length, failed: record.filter((entry) => entry.error).map((entry) => entry.file) }));
