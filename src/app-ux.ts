/**
 * App-wide conveniences: drop a file anywhere and pick a tool, open files
 * from the operating system ("Open with" for the installed app), a keyboard
 * shortcut sheet, one-time tips per tool, and the engine storage card.
 */

import { isSupportedFile, isVideoFile } from './audio';
import { translateUi } from './i18n';
import { getStorageInfo } from './model';
import { MUSIC_MODEL_CACHE, MUSIC_MODEL_VARIANTS } from './music-model';
import { formatBytes } from './transfer';
import { deleteVideoProject, listVideoProjects } from './video-projects';

export interface OpenTarget {
  label: string;
  hint: string;
  run: (files: File[]) => void;
}

export interface OpenHandlers {
  transcribe: (file: File) => void;
  queue: (files: File[]) => void;
  studio: (file: File, tool: string) => void;
  studioBatch: (files: File[]) => void;
  studioJoin: (files: File[]) => void;
  video: (files: File[]) => void;
  vision: (file: File) => void;
  documents: (files: File[]) => void;
  ttsReference: (file: File) => void;
}

const isImage = (file: File) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
const isCaption = (file: File) => /\.(srt|vtt)$/i.test(file.name);
const isDocument = (file: File) => isImage(file) || file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

/** Tools that can open these files, best match first. */
export function targetsFor(files: File[], open: OpenHandlers): OpenTarget[] {
  const media = files.filter(isSupportedFile);
  const images = files.filter(isImage);
  const captions = files.filter(isCaption);
  const videos = media.filter(isVideoFile);
  const documents = files.filter(isDocument);
  const targets: OpenTarget[] = [];
  if (documents.length) {
    targets.push({ label: 'OCR & redact', hint: 'Read text, black out sensitive areas', run: () => open.documents(documents) });
  }
  if (videos.length || (media.length && images.length) || captions.length) {
    targets.push({ label: 'Video editor', hint: 'Multi-track video, audio, captions', run: open.video });
  }
  if (media.length === 1) {
    const [file] = media;
    targets.push(
      { label: 'Transcribe', hint: 'Speech to text with timestamps', run: () => open.transcribe(file) },
      { label: 'Remove vocals', hint: 'Split voice and music', run: () => open.studio(file, 'remover') },
      { label: 'Change key or tempo', hint: 'Pitch & tempo', run: () => open.studio(file, 'pitch') },
      { label: 'Cut or trim', hint: 'Audio cutter with fades', run: () => open.studio(file, 'cutter') },
      { label: 'Find key & BPM', hint: 'Music analysis', run: () => open.studio(file, 'keybpm') },
      { label: 'Use as voice to clone', hint: 'Text to speech reference', run: () => open.ttsReference(file) },
    );
  } else if (media.length > 1) {
    targets.push(
      { label: `Transcribe all ${media.length}`, hint: 'Batch in Audio to text', run: () => open.queue(media) },
      { label: `Process all ${media.length}`, hint: 'Convert, normalize, or separate', run: () => open.studioBatch(media) },
      { label: 'Join into one track', hint: 'Audio joiner with crossfades', run: () => open.studioJoin(media) },
    );
  }
  if (images.length === 1 && !media.length) {
    targets.push(
      { label: 'Vision studio', hint: 'Remove background, depth, objects', run: () => open.vision(images[0]) },
      { label: 'Make a video from it', hint: 'Add audio to a still image', run: open.video },
    );
  }
  return targets;
}

export function setupOpenMenu(open: OpenHandlers, shouldHandleDrop: () => boolean) {
  const dialog = document.createElement('dialog');
  dialog.className = 'open-menu';
  dialog.setAttribute('aria-label', 'Open with');
  document.body.append(dialog);

  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay hidden';
  overlay.innerHTML = '<div><p class="text-lg font-semibold text-white">Drop to open</p><p class="mt-1 text-sm text-slate-300">Choose a tool next. Nothing is uploaded.</p></div>';
  document.body.append(overlay);

  function show(files: File[]): void {
    const targets = targetsFor(files, open);
    dialog.replaceChildren();
    const title = document.createElement('p');
    title.className = 'open-menu-title';
    title.textContent = files.length === 1 ? `Open “${files[0].name}” in…` : `Open ${files.length} files in…`;
    dialog.append(title);
    if (!targets.length) {
      const none = document.createElement('p');
      none.className = 'text-sm text-slate-400';
      none.textContent = 'No tool here can open this kind of file.';
      dialog.append(none);
    }
    for (const target of targets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'open-menu-item';
      button.innerHTML = '<span></span><small></small>';
      button.querySelector('span')!.textContent = target.label;
      button.querySelector('small')!.textContent = target.hint;
      button.addEventListener('click', () => {
        dialog.close();
        target.run(files);
      });
      dialog.append(button);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-ghost mt-1 w-full justify-center';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => dialog.close());
    dialog.append(cancel);
    dialog.showModal();
    (dialog.querySelector('.open-menu-item') as HTMLElement | null)?.focus();
  }

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  let depth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    depth += 1;
    if (shouldHandleDrop()) overlay.classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.add('hidden');
  });
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    depth = 0;
    overlay.classList.add('hidden');
    // Tools with their own drop zones handle the drop and prevent the default.
    if (event.defaultPrevented) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    show(files);
  });

  // Files opened from the OS with the installed app ("Open with LocalScribe").
  const launch = (window as unknown as {
    launchQueue?: { setConsumer: (consumer: (params: { files: FileSystemFileHandle[] }) => void) => void };
  }).launchQueue;
  launch?.setConsumer(async ({ files }) => {
    if (!files?.length) return;
    const opened = await Promise.all(files.map((handle) => handle.getFile()));
    show(opened);
  });

  return { show };
}

/* Shortcut sheet ------------------------------------------------------------ */

const SHORTCUTS: [string, [string, string][]][] = [
  ['Anywhere', [['?', 'Show this list'], ['Esc', 'Close dialogs']]],
  ['Audio studio', [
    ['Space', 'Play or pause'], ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'], ['← →', 'Seek 5 s (Shift: 1 s) on the waveform'],
    ['M', 'Add a marker at the playhead'], ['[ ]', 'Previous / next marker'], ['R or double-click', 'Select between markers'],
    ['Ctrl + scroll', 'Zoom the waveform'], ['Shift + drag', 'Move the selection'],
  ]],
  ['Video editor', [
    ['Space', 'Play or pause'], ['← →', 'Seek 5 s (Shift: 1 s)'], ['S', 'Split at the playhead'],
    ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'], ['Delete', 'Remove the selected clip'],
    ['Home / End', 'Jump to the start or end'], ['Alt ← →', 'Nudge the selected video'],
    ['Alt ↑ ↓', 'Move the selected video to another track'],
    ['Ctrl + scroll', 'Zoom the timeline'], ['+ / −', 'Zoom in or out'],
  ]],
  ['Audio to text', [['Space', 'Play or pause the source while reviewing'], ['Click a segment', 'Jump to that moment']]],
];

export function setupShortcutSheet(): { open: () => void } {
  const dialog = document.createElement('dialog');
  dialog.className = 'shortcut-sheet';
  dialog.setAttribute('aria-labelledby', 'shortcut-title');
  dialog.innerHTML = `<div class="flex items-center justify-between gap-3"><h2 id="shortcut-title" class="text-base font-semibold text-white">Keyboard shortcuts</h2><button type="button" class="icon-btn" aria-label="Close">✕</button></div>${SHORTCUTS.map(([group, rows]) => `
    <section class="mt-4"><p class="field-label">${group}</p><dl class="shortcut-grid">${rows.map(([keys, action]) => `<dt>${keys.split(' / ').map((part) => `<kbd class="kbd">${part}</kbd>`).join(' / ')}</dt><dd>${action}</dd>`).join('')}</dl></section>`).join('')}`;
  dialog.querySelector('button')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (event.key !== '?' || target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    if (dialog.open) dialog.close();
    else dialog.showModal();
  });
  return { open: () => dialog.showModal() };
}

/* First-run tips -------------------------------------------------------------- */

const TIPS: Record<string, string> = {
  transcribe: 'Drop any audio or video, even WMA, AMR, or MKV. Pick a model above; it downloads once and then works offline.',
  audio: 'Open a file once and every tab works on it. Each change is a new version, so Ctrl+Z always gets you back. Press ? for shortcuts.',
  tts: 'Pick a voice and press Generate. Voice cloning needs a short, clean clip and the words spoken in it.',
};
const TIP_KEY = 'localscribe.tips.seen';

export function showTipFor(view: string): void {
  const text = TIPS[view];
  const host = document.getElementById(`view-${view === 'models' ? 'transcribe' : view}`);
  if (!text || !host || host.querySelector('.tip-banner')) return;
  let seen: string[] = [];
  try { seen = JSON.parse(localStorage.getItem(TIP_KEY) ?? '[]'); } catch { /* storage unavailable */ }
  if (seen.includes(view)) return;
  const banner = document.createElement('div');
  banner.className = 'tip-banner';
  banner.setAttribute('role', 'note');
  const body = document.createElement('p');
  body.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn';
  close.setAttribute('aria-label', 'Dismiss tip');
  close.textContent = '✕';
  close.addEventListener('click', () => {
    banner.remove();
    try { localStorage.setItem(TIP_KEY, JSON.stringify([...seen, view])); } catch { /* storage unavailable */ }
  });
  banner.append(body, close);
  host.prepend(banner);
}

/* Engine storage -------------------------------------------------------------- */

export async function renderEngineStorage(container: HTMLElement, multithreaded: () => boolean): Promise<void> {
  container.replaceChildren();
  const [info, projects] = await Promise.all([
    getStorageInfo().catch(() => ({ available: false, usage: 0, quota: 0, persisted: false })),
    listVideoProjects().catch(() => []),
  ]);
  const projectBytes = projects.reduce((sum, project) => sum + (project.bytes || 0), 0);
  const used = info.available ? Math.max(info.usage, projectBytes) : projectBytes;
  const other = Math.max(0, used - projectBytes);
  const projectShare = used > 0 ? Math.min(100, (projectBytes / used) * 100) : 0;
  const quotaShare = info.available && info.quota > 0 ? Math.min(100, (used / info.quota) * 100) : 0;

  const summary = document.createElement('div');
  summary.className = 'storage-summary';
  const head = document.createElement('div');
  head.className = 'storage-summary-head';
  const headline = document.createElement('div');
  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = 'Browser storage used';
  const total = document.createElement('p');
  total.className = 'storage-summary-total';
  total.textContent = formatBytes(used);
  const note = document.createElement('p');
  note.className = 'storage-summary-note';
  if (!info.available) {
    note.textContent = 'The browser does not expose a site-wide storage estimate.';
  } else if (info.quota > 0) {
    const share = document.createElement('span');
    share.textContent = `${quotaShare < 10 ? quotaShare.toFixed(1) : Math.round(quotaShare)}% · ${formatBytes(info.quota)}`;
    const persistence = document.createElement('span');
    persistence.className = 'storage-note-badge';
    persistence.textContent = info.persisted ? 'Persistent' : 'Best effort';
    note.append(share, persistence);
  } else {
    note.textContent = 'Site quota unknown';
  }
  headline.append(label, total, note);
  const projectsStat = document.createElement('div');
  projectsStat.className = 'storage-summary-project';
  const projectsLabel = document.createElement('span');
  projectsLabel.textContent = 'Video projects';
  const projectsValue = document.createElement('strong');
  projectsValue.textContent = `${projects.length} · ${formatBytes(projectBytes)}`;
  projectsStat.append(projectsLabel, projectsValue);
  head.append(headline, projectsStat);

  const meter = document.createElement('div');
  meter.className = 'storage-meter';
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', `Video projects ${formatBytes(projectBytes)}; models and other data ${formatBytes(other)}`);
  const projectPart = document.createElement('span');
  projectPart.className = 'storage-meter-projects';
  projectPart.style.width = `${projectShare}%`;
  const otherPart = document.createElement('span');
  otherPart.className = 'storage-meter-other';
  otherPart.style.width = `${100 - projectShare}%`;
  meter.append(projectPart, otherPart);

  const legend = document.createElement('div');
  legend.className = 'storage-legend';
  const legendItem = (className: string, name: string, value: number): HTMLElement => {
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = className;
    const text = document.createElement('span');
    text.textContent = name;
    const amount = document.createElement('span');
    amount.className = 'storage-legend-value';
    amount.textContent = `· ${formatBytes(value)}`;
    item.append(dot, text, amount);
    return item;
  };
  legend.append(
    legendItem('is-projects', 'Video projects', projectBytes),
    legendItem('is-other', 'Models & other data', other),
  );
  summary.append(head, meter, legend);
  container.append(summary);

  const projectsSection = document.createElement('section');
  projectsSection.className = 'storage-projects';
  const projectsHead = document.createElement('div');
  projectsHead.className = 'storage-section-head';
  const projectsTitleWrap = document.createElement('div');
  const projectsTitle = document.createElement('h3');
  projectsTitle.textContent = 'Video editor projects';
  const projectsHint = document.createElement('p');
  projectsHint.textContent = 'Timelines and media saved in IndexedDB on this browser.';
  projectsTitleWrap.append(projectsTitle, projectsHint);
  const projectsTotal = document.createElement('span');
  projectsTotal.className = 'storage-section-total';
  projectsTotal.textContent = `${projects.length} · ${formatBytes(projectBytes)}`;
  projectsHead.append(projectsTitleWrap, projectsTotal);
  projectsSection.append(projectsHead);
  if (!projects.length) {
    const empty = document.createElement('p');
    empty.className = 'storage-empty';
    empty.textContent = 'No video projects saved yet. Use Save project in the Video editor to keep a timeline here.';
    projectsSection.append(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'storage-project-list';
    for (const project of projects) {
      const item = document.createElement('div');
      item.className = 'storage-project-row';
      const text = document.createElement('div');
      text.className = 'min-w-0';
      const name = document.createElement('p');
      name.className = 'storage-project-name';
      name.textContent = project.name;
      const meta = document.createElement('p');
      meta.className = 'storage-project-meta';
      const locale = document.documentElement.lang || undefined;
      const updated = new Date(project.updatedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
      const picture = document.createElement('span');
      picture.textContent = project.width > 0 ? `${project.width}×${project.height} · ${project.fps} fps` : 'Audio only';
      meta.append(picture, document.createTextNode(` · ${updated}`));
      text.append(name, meta);
      const size = document.createElement('span');
      size.className = 'storage-project-size';
      size.textContent = project.bytes > 0 ? formatBytes(project.bytes) : 'Size unavailable';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'storage-project-delete';
      remove.title = `${translateUi('Delete')} ${project.name}`;
      remove.setAttribute('aria-label', `${translateUi('Delete')} ${project.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', async () => {
        if (!confirm(translateUi('Delete this video project? This cannot be undone.'))) return;
        remove.disabled = true;
        try {
          await deleteVideoProject(project.id);
          await renderEngineStorage(container, multithreaded);
        } catch {
          remove.disabled = false;
        }
      });
      item.append(text, size, remove);
      list.append(item);
    }
    projectsSection.append(list);
  }
  container.append(projectsSection);

  const engines = document.createElement('section');
  engines.className = 'storage-engines';
  const enginesHead = document.createElement('div');
  enginesHead.className = 'storage-section-head';
  const enginesTitleWrap = document.createElement('div');
  const enginesTitle = document.createElement('h3');
  enginesTitle.textContent = 'Models, engines & decoders';
  const enginesHint = document.createElement('p');
  enginesHint.textContent = 'Downloads and built-in runtimes used by the audio and video tools.';
  enginesTitleWrap.append(enginesTitle, enginesHint);
  enginesHead.append(enginesTitleWrap);
  engines.append(enginesHead);

  const rows: HTMLElement[] = [];
  const row = (name: string, detail: string, action?: { label: string; run: () => Promise<void> }) => {
    const item = document.createElement('div');
    item.className = 'engine-row';
    const text = document.createElement('div');
    text.className = 'min-w-0';
    text.innerHTML = '<p class="truncate text-sm font-medium text-white"></p><p class="text-[11px] text-slate-400"></p>';
    text.children[0].textContent = name;
    text.children[1].textContent = detail;
    item.append(text);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-ghost';
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        await action.run();
        await renderEngineStorage(container, multithreaded);
      });
      item.append(button);
    }
    rows.push(item);
  };

  let cache: Cache | null = null;
  try { cache = await caches.open(MUSIC_MODEL_CACHE); } catch { /* storage unavailable */ }
  for (const spec of Object.values(MUSIC_MODEL_VARIANTS)) {
    const stored = cache ? await cache.match(spec.url) : undefined;
    row(`Vocal remover · ${spec.label}`, stored ? `${formatBytes(spec.bytes)} saved on this device` : `Not downloaded · ${formatBytes(spec.bytes)}`, stored && cache
      ? { label: 'Delete', run: async () => { await cache!.delete(spec.url); } }
      : undefined);
  }
  row('Media engine', `Mediabunny/WebCodecs fast path · FFmpeg ${multithreaded() ? 'multithreaded' : 'single-threaded'} fallback on demand (about 33 MB)`);
  row('Video encoder (WebCodecs)', typeof VideoEncoder !== 'undefined' ? 'Built into this browser · uses hardware encoding when available · no download' : 'Not available in this browser · video exports use FFmpeg instead');
  engines.append(...rows);
  container.append(engines);
}
