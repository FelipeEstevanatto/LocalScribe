/**
 * Universal File Converter Studio (VERT feature implementation).
 *
 * Provides batch conversion, format selection,
 * customized format settings (video/audio/image/document), real-time progress,
 * and ZIP exports — running 100% client-side in the browser.
 */

import {
  type ConverterSettings,
  defaultSettings,
  detectFileFormat,
  type FileCategory,
  FORMAT_REGISTRY,
  type FormatMeta,
  getAvailableTargetFormats,
  getDefaultTargetFormat,
} from './converter-catalog';
import { convertFile } from './converter-engine';
import { videoOptions } from './converter-media';
import { formatBytes } from './audio';
import { createZip } from './zip';

export interface ConverterStudioOptions {
  download: (blob: Blob, name: string) => void;
  open: (file: File, studio: 'vision' | 'video' | 'audio' | 'documents') => void;
}

export interface QueueItem {
  id: string;
  file: File;
  sourceCategory: FileCategory;
  sourceExt: string;
  targetExt: string;
  settings: ConverterSettings;
  status: 'idle' | 'converting' | 'done' | 'error';
  progress: number;
  stage: string;
  error?: string;
  resultBlob?: Blob;
  resultName?: string;
  resultSize?: number;
  abortController?: AbortController;
}

let nextId = 0;

export function setupConverterStudio(root: HTMLElement, options: ConverterStudioOptions) {
  // Elements
  const dropZone = root.querySelector<HTMLElement>('#converter-drop-zone')!;
  const fileInput = root.querySelector<HTMLInputElement>('#converter-file-input')!;
  const browseBtn = root.querySelector<HTMLButtonElement>('#converter-browse-btn')!;
  const queueSection = root.querySelector<HTMLElement>('#converter-queue-section')!;
  const queueList = root.querySelector<HTMLElement>('#converter-queue-list')!;
  const queueCount = root.querySelector<HTMLElement>('#converter-queue-count')!;
  const convertAllBtn = root.querySelector<HTMLButtonElement>('#converter-convert-all')!;
  const cancelAllBtn = root.querySelector<HTMLButtonElement>('#converter-cancel-all')!;
  const downloadZipBtn = root.querySelector<HTMLButtonElement>('#converter-download-zip')!;
  const clearAllBtn = root.querySelector<HTMLButtonElement>('#converter-clear-all')!;
  const batchTargetBtn = root.querySelector<HTMLButtonElement>('#converter-batch-target-btn')!;
  const batchTargetLabel = root.querySelector<HTMLElement>('#converter-batch-target-label')!;

  // Modals
  const formatModal = root.querySelector<HTMLElement>('#converter-format-modal')!;
  const formatModalClose = root.querySelector<HTMLButtonElement>('#converter-format-close')!;
  const formatSearch = root.querySelector<HTMLInputElement>('#converter-format-search')!;
  const formatTabs = root.querySelector<HTMLElement>('#converter-format-tabs')!;
  const formatGrid = root.querySelector<HTMLElement>('#converter-format-grid')!;

  const settingsModal = root.querySelector<HTMLElement>('#converter-settings-modal')!;
  const settingsModalClose = root.querySelector<HTMLButtonElement>('#converter-settings-close')!;
  const settingsForm = root.querySelector<HTMLFormElement>('#converter-settings-form')!;
  const settingsTitle = root.querySelector<HTMLElement>('#converter-settings-title')!;
  const settingsVideoGroup = root.querySelector<HTMLElement>('#converter-settings-video-group')!;
  const settingsAudioGroup = root.querySelector<HTMLElement>('#converter-settings-audio-group')!;
  const settingsImageGroup = root.querySelector<HTMLElement>('#converter-settings-image-group')!;
  const settingsDocumentGroup = root.querySelector<HTMLElement>('#converter-settings-document-group')!;
  const pageMode = root.querySelector<HTMLSelectElement>('#conv-d-pages')!;
  const pageRange = root.querySelector<HTMLInputElement>('#conv-d-range')!;

  // State
  let queue: QueueItem[] = [];
  let batch: AbortController | null = null;
  const active = new Set<QueueItem>();
  const isConverting = () => batch !== null || active.size > 0;
  let activeFormatPickerItemId: string | null = null; // null means batch target
  let activeSettingsItemId: string | null = null;
  let activeFormatTab: 'all' | FileCategory = 'all';

  // ---------------------------------------------------------------------------
  // Queue Management
  // ---------------------------------------------------------------------------

  function addFiles(files: FileList | File[]) {
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const detected = detectFileFormat(file);
      const targetExt = getDefaultTargetFormat(detected.category, detected.ext);

      queue.push({
        id: `item-${++nextId}`,
        file,
        sourceCategory: detected.category,
        sourceExt: detected.ext,
        targetExt,
        settings: defaultSettings(),
        status: targetExt ? 'idle' : 'error',
        progress: 0,
        stage: 'Ready',
        error: targetExt ? undefined : 'Unsupported input format.',
      });
    }

    render();
  }

  function removeItem(id: string) {
    const item = queue.find((q) => q.id === id);
    if (item?.status === 'converting') {
      item.abortController?.abort();
    }
    queue = queue.filter((q) => q.id !== id);
    render();
  }

  function clearQueue() {
    for (const item of queue) {
      if (item.status === 'converting') {
        item.abortController?.abort();
      }
    }
    queue = [];
    render();
  }

  // ---------------------------------------------------------------------------
  // Conversion Lifecycle
  // ---------------------------------------------------------------------------

  async function convertSingleItem(item: QueueItem, inBatch = false) {
    if (!item.targetExt || !queue.includes(item) || active.size || (batch && !inBatch)) return;
    active.add(item);

    item.status = 'converting';
    item.progress = 5;
    item.stage = 'Initializing';
    item.error = undefined;
    item.abortController = new AbortController();
    renderItem(item);

    try {
      const result = await convertFile(
        item.file,
        item.targetExt,
        item.settings,
        item.abortController.signal,
        (p) => {
          item.progress = Math.round(p.ratio * 100);
          item.stage = p.stage;
          renderItem(item);
        },
      );

      item.abortController.signal.throwIfAborted();
      item.status = 'done';
      item.progress = 100;
      item.stage = 'Completed';
      item.resultBlob = result.blob;
      item.resultName = result.name;
      item.resultSize = result.blob.size;
    } catch (err) {
      if (item.abortController?.signal.aborted) {
        item.status = 'idle';
        item.progress = 0;
        item.stage = 'Cancelled';
      } else {
        item.status = 'error';
        item.progress = 0;
        item.stage = 'Failed';
        item.error = err instanceof Error ? err.message : 'Conversion failed';
      }
    } finally {
      item.abortController = undefined;
      active.delete(item);
      renderItem(item);
      updateActionButtons();
    }
  }

  async function convertAll() {
    if (isConverting()) return;
    const pending = queue.filter(item => item.targetExt && (item.status === 'idle' || item.status === 'error'));
    if (!pending.length) return;

    const controller = new AbortController();
    batch = controller;
    updateActionButtons();
    try {
      for (const item of pending) {
        if (controller.signal.aborted) break;
        await convertSingleItem(item, true);
      }
    } finally {
      batch = null;
      updateActionButtons();
    }
  }

  function cancelAll() {
    batch?.abort();
    for (const item of active) item.abortController?.abort();
  }

  // ---------------------------------------------------------------------------
  // Export & Download
  // ---------------------------------------------------------------------------

  function downloadItem(id: string) {
    const item = queue.find((q) => q.id === id);
    if (item?.resultBlob && item.resultName) {
      options.download(item.resultBlob, item.resultName);
    }
  }

  async function downloadAllZip() {
    const doneItems = queue.filter((q) => q.status === 'done' && q.resultBlob && q.resultName);
    if (doneItems.length === 0) return;

    if (doneItems.length === 1) {
      downloadItem(doneItems[0].id);
      return;
    }

    downloadZipBtn.disabled = true;
    downloadZipBtn.textContent = 'Packaging ZIP...';

    try {
      const files = doneItems.map((q) => ({ name: q.resultName!, blob: q.resultBlob! }));
      const zipBlob = await createZip(files);
      options.download(zipBlob, `converted-files-${Date.now()}.zip`);
    } finally {
      downloadZipBtn.disabled = false;
      downloadZipBtn.textContent = 'Download All (ZIP)';
    }
  }

  function handoffItem(id: string, studio: 'vision' | 'video' | 'audio' | 'documents') {
    const item = queue.find((q) => q.id === id);
    if (!item?.resultBlob || !item.resultName || item.resultBlob.type === 'application/zip') return;
    const file = new File([item.resultBlob], item.resultName, { type: item.resultBlob.type });
    options.open(file, studio);
  }

  // ---------------------------------------------------------------------------
  // Format Picker Dialog
  // ---------------------------------------------------------------------------

  function openFormatPicker(itemId: string | null) {
    activeFormatPickerItemId = itemId;
    formatSearch.value = '';
    activeFormatTab = 'all';

    // Set active tab UI
    for (const tab of formatTabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      const isCurrent = tab.dataset.tab === 'all';
      tab.classList.toggle('bg-indigo-500', isCurrent);
      tab.classList.toggle('text-white', isCurrent);
      tab.classList.toggle('text-slate-400', !isCurrent);
    }

    renderFormatGrid();
    formatModal.classList.remove('hidden');
    formatSearch.focus();
  }

  function closeFormatPicker() {
    formatModal.classList.add('hidden');
    activeFormatPickerItemId = null;
  }

  function renderFormatGrid() {
    formatGrid.innerHTML = '';
    const query = formatSearch.value.trim().toLowerCase();

    let formats: FormatMeta[] = [];
    if (activeFormatPickerItemId) {
      const item = queue.find((q) => q.id === activeFormatPickerItemId);
      if (item) {
        formats = getAvailableTargetFormats(item.sourceCategory, item.sourceExt);
      }
    } else {
      const targets = queue.flatMap(item => getAvailableTargetFormats(item.sourceCategory, item.sourceExt));
      formats = [...new Map(targets.map(format => [format.id, format])).values()];
    }

    // Filter by Tab
    if (activeFormatTab !== 'all') {
      formats = formats.filter((f) => f.category === activeFormatTab);
    }

    // Filter by Search Query
    if (query) {
      formats = formats.filter(
        (f) =>
          f.id.toLowerCase().includes(query) ||
          f.label.toLowerCase().includes(query) ||
          f.description.toLowerCase().includes(query),
      );
    }

    if (formats.length === 0) {
      formatGrid.innerHTML = `<p class="col-span-full py-8 text-center text-sm text-slate-500">No formats match your search.</p>`;
      return;
    }

    for (const fmt of formats) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'flex flex-col items-start rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left transition hover:border-indigo-400/40 hover:bg-indigo-400/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/40';

      const categoryBadgeColor: Record<FileCategory, string> = {
        video: 'bg-rose-500/15 text-rose-300 border-rose-500/20',
        audio: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
        image: 'bg-sky-500/15 text-sky-300 border-sky-500/20',
        document: 'bg-amber-500/15 text-amber-300 border-amber-500/20',
      };

      btn.innerHTML = `
        <div class="flex w-full items-center justify-between">
          <span class="font-semibold text-white">${fmt.label}</span>
          <span class="rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider border ${categoryBadgeColor[fmt.category]}">${fmt.category}</span>
        </div>
        <span class="mt-1 text-xs text-slate-400">${fmt.description}</span>
      `;

      btn.addEventListener('click', () => {
        selectTargetFormat(fmt.id);
        closeFormatPicker();
      });

      formatGrid.appendChild(btn);
    }
  }

  function selectTargetFormat(formatId: string) {
    if (activeFormatPickerItemId) {
      const item = queue.find((q) => q.id === activeFormatPickerItemId);
      if (item && item.status !== 'converting') {
        item.targetExt = formatId;
        item.status = 'idle';
        item.progress = 0;
        item.stage = 'Ready';
        item.resultBlob = undefined;
        renderItem(item);
      }
    } else {
      // Batch Apply
      batchTargetLabel.textContent = formatId.toUpperCase();
      for (const item of queue) {
        // Only set if target is compatible or general
        const available = getAvailableTargetFormats(item.sourceCategory, item.sourceExt);
        if (item.status !== 'converting' && available.some((f) => f.id === formatId)) {
          item.targetExt = formatId;
          item.status = 'idle';
          item.progress = 0;
          item.stage = 'Ready';
          item.resultBlob = undefined;
        }
      }
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Settings Modal Dialog
  // ---------------------------------------------------------------------------

  function openSettings(itemId: string) {
    const item = queue.find((q) => q.id === itemId);
    if (!item?.targetExt || item.status === 'converting') return;
    activeSettingsItemId = itemId;

    const targetMeta = FORMAT_REGISTRY[item.targetExt];
    const category = targetMeta?.category || item.sourceCategory;

    settingsTitle.textContent = `Conversion Settings: ${item.file.name} -> ${item.targetExt.toUpperCase()}`;

    // Hide all groups first
    settingsVideoGroup.classList.add('hidden');
    settingsAudioGroup.classList.add('hidden');
    settingsImageGroup.classList.add('hidden');
    settingsDocumentGroup.classList.add('hidden');
    pageRange.disabled = true;

    if (category === 'video' && item.targetExt !== 'gifv') {
      settingsVideoGroup.classList.remove('hidden');
      populateVideoSettings(item.settings);
      const available = videoOptions(item.targetExt);
      restrictOptions('conv-v-codec', available.codecs, 'auto');
      restrictOptions('conv-v-audio', available.audio, 'keep');
      updateVideoSettings();
    } else if (category === 'audio') {
      // Audio or video-to-audio extraction
      settingsAudioGroup.classList.remove('hidden');
      populateAudioSettings(item.settings);
      const fixedRate = ({ amr: [], opus: ['48000'], weba: ['48000'], wma: ['44100'], ac3: ['48000', '44100'] } as Record<string, string[]>)[item.targetExt];
      restrictOptions('conv-a-samplerate', fixedRate ? ['source', ...fixedRate] : null, 'source');
      restrictOptions('conv-a-channels', item.targetExt === 'amr' ? ['source', 'mono'] : null, 'source');
    } else if (item.sourceExt === 'pdf') {
      settingsDocumentGroup.classList.remove('hidden');
      populateDocumentSettings(item.settings);
      const raster = category === 'image';
      root.querySelector('#conv-d-dpi')?.closest('.field')?.classList.toggle('hidden', !raster);
    } else if (category === 'image' || item.sourceCategory === 'image') {
      settingsImageGroup.classList.remove('hidden');
      populateImageSettings(item.settings);
    } else {
      return;
    }

    settingsModal.classList.remove('hidden');
  }

  function restrictOptions(id: string, values: readonly string[] | null, fallback: string) {
    const select = root.querySelector<HTMLSelectElement>('#' + id)!;
    for (const option of select.options) option.disabled = !!values && !values.includes(option.value);
    if (select.selectedOptions[0]?.disabled) select.value = fallback;
  }

  function closeSettings() {
    settingsModal.classList.add('hidden');
    activeSettingsItemId = null;
  }

  function populateVideoSettings(s: ConverterSettings) {
    (root.querySelector('#conv-v-res') as HTMLSelectElement).value = s.video.resolution;
    (root.querySelector('#conv-v-codec') as HTMLSelectElement).value = s.video.codec;
    (root.querySelector('#conv-v-fps') as HTMLSelectElement).value = s.video.fps;
    (root.querySelector('#conv-v-crf') as HTMLInputElement).value = String(s.video.crf);
    (root.querySelector('#conv-v-crf-val') as HTMLElement).textContent = String(s.video.crf);
    (root.querySelector('#conv-v-audio') as HTMLSelectElement).value = s.video.audioStream;
    (root.querySelector('#conv-v-abitrate') as HTMLSelectElement).value = s.video.audioBitrate;
  }

  function populateAudioSettings(s: ConverterSettings) {
    (root.querySelector('#conv-a-bitrate') as HTMLSelectElement).value = s.audio.bitrate;
    (root.querySelector('#conv-a-samplerate') as HTMLSelectElement).value = s.audio.sampleRate;
    (root.querySelector('#conv-a-channels') as HTMLSelectElement).value = s.audio.channels;
    (root.querySelector('#conv-a-volume') as HTMLInputElement).value = String(s.audio.volume);
    (root.querySelector('#conv-a-volume-val') as HTMLElement).textContent = `${Math.round(s.audio.volume * 100)}%`;
  }

  function populateImageSettings(s: ConverterSettings) {
    (root.querySelector('#conv-i-quality') as HTMLInputElement).value = String(s.image.quality);
    (root.querySelector('#conv-i-quality-val') as HTMLElement).textContent = `${s.image.quality}%`;
    (root.querySelector('#conv-i-resize') as HTMLSelectElement).value = s.image.resizeMode;
    (root.querySelector('#conv-i-scale') as HTMLSelectElement).value = String(s.image.scalePercent);
    (root.querySelector('#conv-i-aspect') as HTMLInputElement).checked = s.image.keepAspectRatio;
    (root.querySelector('#conv-i-grayscale') as HTMLInputElement).checked = s.image.grayscale;
    (root.querySelector('#conv-i-bg') as HTMLSelectElement).value = s.image.backgroundColor;
    (root.querySelector('#conv-i-rotation') as HTMLSelectElement).value = String(s.image.rotation);
  }

  function populateDocumentSettings(s: ConverterSettings) {
    (root.querySelector('#conv-d-dpi') as HTMLSelectElement).value = String(s.document.dpi);
    pageMode.value = s.document.pageSelection;
    pageRange.value = s.document.pageRange ?? '';
    showPageRange();
  }

  function saveSettings() {
    if (!activeSettingsItemId) return;
    const item = queue.find((q) => q.id === activeSettingsItemId);
    if (!item || item.status === 'converting') return;

    const value = <T extends string>(id: string): T => root.querySelector<HTMLSelectElement | HTMLInputElement>('#' + id)!.value as T;
    const checked = (id: string): boolean => root.querySelector<HTMLInputElement>('#' + id)!.checked;
    const { video, audio, image, document } = item.settings;
    if (!settingsVideoGroup.classList.contains('hidden')) {
      video.resolution = value('conv-v-res');
      video.codec = value('conv-v-codec');
      video.fps = value('conv-v-fps');
      video.crf = Number(value('conv-v-crf'));
      video.audioStream = value('conv-v-audio');
      video.audioBitrate = value('conv-v-abitrate');
      if (video.codec === 'copy') {
        video.resolution = 'source';
        video.fps = 'source';
      }
    } else if (!settingsAudioGroup.classList.contains('hidden')) {
      audio.bitrate = value('conv-a-bitrate');
      audio.sampleRate = value('conv-a-samplerate');
      audio.channels = value('conv-a-channels');
      audio.volume = Number(value('conv-a-volume'));
    } else if (!settingsImageGroup.classList.contains('hidden')) {
      image.quality = Number(value('conv-i-quality'));
      image.resizeMode = value('conv-i-resize');
      image.scalePercent = Number(value('conv-i-scale')) as typeof image.scalePercent;
      image.keepAspectRatio = checked('conv-i-aspect');
      image.grayscale = checked('conv-i-grayscale');
      image.backgroundColor = value('conv-i-bg');
      image.rotation = Number(value('conv-i-rotation')) as typeof image.rotation;
    } else if (!settingsDocumentGroup.classList.contains('hidden')) {
      document.dpi = Number(value('conv-d-dpi')) as typeof document.dpi;
      document.pageSelection = value('conv-d-pages');
      document.pageRange = pageRange.value;
    }

    if (item.status === 'done' || item.status === 'error') {
      item.status = 'idle';
      item.progress = 0;
      item.stage = 'Ready';
      item.resultBlob = undefined;
      renderItem(item);
    }
    closeSettings();
  }

  // ---------------------------------------------------------------------------
  // Rendering UI
  // ---------------------------------------------------------------------------

  function render() {
    const count = queue.length;
    queueCount.textContent = count ? `${count} ${count === 1 ? 'file' : 'files'}` : '';

    if (count === 0) {
      queueSection.classList.add('hidden');
      queueList.innerHTML = '';
      return;
    }

    queueSection.classList.remove('hidden');
    queueList.innerHTML = '';

    for (const item of queue) {
      const el = createItemElement(item);
      queueList.appendChild(el);
    }

    updateActionButtons();
  }

  function renderItem(item: QueueItem) {
    const existing = queueList.querySelector<HTMLElement>(`[data-queue-id="${item.id}"]`);
    if (!existing) return;

    const updated = createItemElement(item);
    existing.replaceWith(updated);
    updateActionButtons();
  }

  function createItemElement(item: QueueItem): HTMLElement {
    const row = document.createElement('div');
    row.dataset.queueId = item.id;
    row.className =
      'flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#0b1220]/90 p-4 transition shadow-lg shadow-black/20';

    const categoryIcons: Record<FileCategory, string> = {
      video: `<svg class="h-5 w-5 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>`,
      audio: `<svg class="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/></svg>`,
      image: `<svg class="h-5 w-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`,
      document: `<svg class="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
    };

    let deltaBadge = '';
    if (item.status === 'done' && item.resultSize && item.file.size) {
      const delta = Math.round(((item.resultSize - item.file.size) / item.file.size) * 100);
      const isSmaller = delta < 0;
      deltaBadge = `
        <span class="rounded px-2 py-0.5 text-[11px] font-semibold ${isSmaller ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700/50 text-slate-300'}">
          ${formatBytes(item.resultSize)} (${isSmaller ? '' : '+'}${delta}%)
        </span>
      `;
    }

    let statusHtml = '';
    if (item.status === 'converting') {
      statusHtml = `
        <div class="mt-2 w-full">
          <div class="flex justify-between text-xs text-indigo-300 mb-1">
            <span>${item.stage}</span>
            <span>${item.progress}%</span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div class="h-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-200" style="width: ${item.progress}%"></div>
          </div>
        </div>
      `;
    } else if (item.status === 'error') {
      statusHtml = `
        <p class="converter-error mt-1 text-xs text-rose-400"></p>
      `;
    }

    row.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-3">
        <!-- File Info -->
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/5 border border-white/10">
            ${categoryIcons[item.sourceCategory]}
          </div>
          <div class="min-w-0 flex-1">
            <p class="converter-item-name truncate text-sm font-medium text-white"></p>
            <div class="flex items-center gap-2 text-xs text-slate-400">
              <span>${formatBytes(item.file.size)}</span>
              <span>•</span>
              <span class="converter-source-ext uppercase tracking-wider font-semibold text-slate-300"></span>
              ${deltaBadge}
            </div>
          </div>
        </div>

        <!-- Target & Controls -->
        <div class="flex items-center gap-2 shrink-0">
          <!-- Target selector button -->
          <div class="flex items-center rounded-xl border border-white/10 bg-white/5 p-1">
            <span class="px-2 text-xs text-slate-400">to</span>
            <button type="button" class="btn-target flex items-center gap-1.5 rounded-lg bg-indigo-500/20 border border-indigo-400/30 px-2.5 py-1 text-xs font-semibold text-indigo-200 hover:bg-indigo-500/30 focus:outline-none">
              <span>${item.targetExt.toUpperCase() || 'Unavailable'}</span>
              <svg class="h-3.5 w-3.5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19 9-7 7-7-7"/></svg>
            </button>
          </div>

          <!-- Settings Button -->
          <button type="button" class="btn-settings icon-btn rounded-xl" title="Conversion Settings">
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>

          <!-- Action buttons based on status -->
          ${
            item.status === 'done'
              ? `
            <button type="button" class="btn-download btn-secondary text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/10">
              <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              <span>Save</span>
            </button>
            <button type="button" class="btn-handoff btn-ghost" title="Open in Studio">
              <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </button>
          `
              : item.status === 'converting'
              ? `
            <button type="button" class="btn-cancel-single icon-btn text-rose-400 hover:text-rose-300" title="Cancel">
              <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          `
              : `
            <button type="button" class="btn-convert-single btn-secondary">Convert</button>
            <button type="button" class="btn-remove icon-btn text-slate-500 hover:text-rose-400" title="Remove">
              <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          `
          }
        </div>
      </div>
      ${statusHtml}
    `;

    const name = row.querySelector<HTMLElement>('.converter-item-name')!;
    name.title = item.file.name;
    name.textContent = item.file.name;
    row.querySelector<HTMLElement>('.converter-source-ext')!.textContent = item.sourceExt;
    const error = row.querySelector<HTMLElement>('.converter-error');
    if (error) error.textContent = item.error || 'Conversion failed.';
    for (const button of row.querySelectorAll<HTMLButtonElement>('.btn-target, .btn-settings')) {
      button.disabled = !item.targetExt || item.status === 'converting';
    }
    const settingsButton = row.querySelector<HTMLButtonElement>('.btn-settings')!;
    settingsButton.hidden = !item.targetExt || item.targetExt === 'gifv' || (item.sourceCategory === 'document' && item.sourceExt !== 'pdf');
    const handoffButton = row.querySelector<HTMLButtonElement>('.btn-handoff');
    if (handoffButton) handoffButton.hidden = item.resultBlob?.type === 'application/zip';

    // Event listeners
    row.querySelector('.btn-target')?.addEventListener('click', () => openFormatPicker(item.id));
    row.querySelector('.btn-settings')?.addEventListener('click', () => openSettings(item.id));
    row.querySelector('.btn-remove')?.addEventListener('click', () => removeItem(item.id));
    row.querySelector('.btn-convert-single')?.addEventListener('click', () => void convertSingleItem(item));
    row.querySelector('.btn-cancel-single')?.addEventListener('click', () => item.abortController?.abort());
    row.querySelector('.btn-download')?.addEventListener('click', () => downloadItem(item.id));
    row.querySelector('.btn-handoff')?.addEventListener('click', () => {
      const targetMeta = FORMAT_REGISTRY[item.targetExt];
      const cat = targetMeta?.category || 'document';
      if (cat === 'video') handoffItem(item.id, 'video');
      else if (cat === 'audio') handoffItem(item.id, 'audio');
      else if (cat === 'image') handoffItem(item.id, 'vision');
      else handoffItem(item.id, 'documents');
    });

    return row;
  }

  function updateActionButtons() {
    const hasItems = queue.length > 0;
    const hasDone = queue.some((q) => q.status === 'done');
    const hasPending = queue.some(q => q.targetExt && (q.status === 'idle' || q.status === 'error'));

    const busy = isConverting();
    convertAllBtn.disabled = !hasPending || busy;
    cancelAllBtn.classList.toggle('hidden', !busy);
    batchTargetBtn.disabled = busy;
    for (const button of queueList.querySelectorAll<HTMLButtonElement>('.btn-convert-single')) {
      button.disabled = busy || !queue.find(item => item.id === button.closest<HTMLElement>('[data-queue-id]')?.dataset.queueId)?.targetExt;
    }
    downloadZipBtn.disabled = !hasDone;
    clearAllBtn.disabled = !hasItems || busy;
  }

  // ---------------------------------------------------------------------------
  // Event Bindings
  // ---------------------------------------------------------------------------

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) addFiles(fileInput.files);
    fileInput.value = '';
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target instanceof Node && !browseBtn.contains(e.target) && e.target !== fileInput) fileInput.click();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer?.files) {
      addFiles(e.dataTransfer.files);
    }
  });

  convertAllBtn.addEventListener('click', () => void convertAll());
  cancelAllBtn.addEventListener('click', () => cancelAll());
  downloadZipBtn.addEventListener('click', () => void downloadAllZip());
  clearAllBtn.addEventListener('click', () => clearQueue());

  batchTargetBtn.addEventListener('click', () => openFormatPicker(null));

  // Format Modal Events
  formatModalClose.addEventListener('click', closeFormatPicker);
  formatSearch.addEventListener('input', renderFormatGrid);

  for (const tab of formatTabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    tab.addEventListener('click', () => {
      activeFormatTab = tab.dataset.tab as any;
      for (const t of formatTabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
        const isCurrent = t === tab;
        t.classList.toggle('bg-indigo-500', isCurrent);
        t.classList.toggle('text-white', isCurrent);
        t.classList.toggle('text-slate-400', !isCurrent);
      }
      renderFormatGrid();
    });
  }

  // Settings Modal Events
  const videoCodec = root.querySelector<HTMLSelectElement>('#conv-v-codec')!;
  function updateVideoSettings() {
    const copying = videoCodec.value === 'copy';
    for (const id of ['conv-v-res', 'conv-v-fps', 'conv-v-crf']) {
      root.querySelector<HTMLSelectElement | HTMLInputElement>('#' + id)!.disabled = copying;
    }
  }
  videoCodec.addEventListener('change', updateVideoSettings);

  function showPageRange() {
    const visible = pageMode.value === 'range';
    root.querySelector('#conv-d-range-field')?.classList.toggle('hidden', !visible);
    pageRange.disabled = !visible;
    pageRange.required = visible;
  }
  pageMode.addEventListener('change', showPageRange);
  settingsModalClose.addEventListener('click', closeSettings);
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
  });

  // Range Slider Readouts
  const crfSlider = root.querySelector<HTMLInputElement>('#conv-v-crf');
  const crfVal = root.querySelector<HTMLElement>('#conv-v-crf-val');
  crfSlider?.addEventListener('input', () => {
    if (crfVal) crfVal.textContent = crfSlider.value;
  });

  const volSlider = root.querySelector<HTMLInputElement>('#conv-a-volume');
  const volVal = root.querySelector<HTMLElement>('#conv-a-volume-val');
  volSlider?.addEventListener('input', () => {
    if (volVal) volVal.textContent = `${Math.round(Number(volSlider.value) * 100)}%`;
  });

  const qualSlider = root.querySelector<HTMLInputElement>('#conv-i-quality');
  const qualVal = root.querySelector<HTMLElement>('#conv-i-quality-val');
  qualSlider?.addEventListener('input', () => {
    if (qualVal) qualVal.textContent = `${qualSlider.value}%`;
  });

  return {
    activity(): { tone: 'busy' | 'ready'; label: string } | null {
      if (isConverting()) return { tone: 'busy', label: 'Converting files' };
      const doneCount = queue.filter((q) => q.status === 'done').length;
      if (doneCount > 0) return { tone: 'ready', label: `${doneCount} converted` };
      return null;
    },
    addFiles,
  };
}
