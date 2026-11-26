/**
 * Interactive accuracy-vs-size map for the Models page.
 *
 * The data is a pinned static snapshot from the public Open ASR / Open TTS
 * leaderboards. Nothing is fetched at runtime: the chart works offline and adds
 * no network requests to a privacy-first page.
 */

import {
  MODEL_CHART_DATASETS,
  type ModelChartDataset,
  type ModelChartPoint,
} from './model-chart-data';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 760;
const HEIGHT = 430;
const MARGIN = { top: 30, right: 24, bottom: 60, left: 58 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

type ChartFilter = 'all' | 'app' | 'candidates';
type DatasetId = 'asr' | 'tts';

let activeDatasetId: DatasetId = 'asr';
let activeFilter: ChartFilter = 'all';
let showPublisher = true;
let showFrontier = true;
let pinnedPointId: string | null = null;
let lastSelectedModelId: string | undefined;

export interface ModelChartOptions {
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
}

interface PlacedLabel {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface LabelPosition {
  x: number;
  y: number;
  anchor: 'start' | 'end' | 'middle';
  box: PlacedLabel;
  leader: boolean;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node as SVGElementTagNameMap[K];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatParams(value: number): string {
  const millions = value * 1000;
  if (millions < 10) return `${millions.toFixed(1)}M`;
  if (millions < 1000) return `${Math.round(millions)}M`;
  return `${value.toFixed(value < 10 ? 1 : 0)}B`;
}

function formatScore(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatRtfx(value: number): string {
  if (value >= 1000) return `${Math.round(value).toLocaleString()}×`;
  return `${value.toFixed(value < 10 ? 2 : 1)}×`;
}

function formatDownload(value: number): string {
  return `${Math.round(value).toLocaleString()} MB`;
}

function datasetById(id: DatasetId): ModelChartDataset {
  return MODEL_CHART_DATASETS.find((entry) => entry.id === id) ?? MODEL_CHART_DATASETS[0];
}

function visiblePoints(dataset: ModelChartDataset): ModelChartPoint[] {
  return dataset.points.filter((point) => {
    if (point.source === 'publisher' && !showPublisher) return false;
    if (activeFilter === 'app') return point.status === 'shipping';
    if (activeFilter === 'candidates') return point.status !== 'other';
    return true;
  });
}

function paretoFrontier(points: ModelChartPoint[]): ModelChartPoint[] {
  const sorted = points
    .filter((point) => point.source === 'leaderboard')
    .slice()
    .sort((a, b) => a.paramsB - b.paramsB);
  const frontier: ModelChartPoint[] = [];
  let best = Number.POSITIVE_INFINITY;
  for (const point of sorted) {
    if (point.score < best) {
      frontier.push(point);
      best = point.score;
    }
  }
  return frontier;
}

function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;
  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] ?? next;
    const control1X = current[0] + (next[0] - previous[0]) / 6;
    const control1Y = current[1] + (next[1] - previous[1]) / 6;
    const control2X = next[0] - (after[0] - current[0]) / 6;
    const control2Y = next[1] - (after[1] - current[1]) / 6;
    path += ` C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${next[0]} ${next[1]}`;
  }
  return path;
}

function intersects(a: PlacedLabel, b: PlacedLabel): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function placeLabel(
  point: { x: number; y: number },
  text: string,
  placed: PlacedLabel[],
): LabelPosition | null {
  const width = Math.max(26, text.length * 5.6);
  const offsets: Array<{
    dx: number;
    dy: number;
    anchor: 'start' | 'end' | 'middle';
    leader?: boolean;
  }> = [
    { dx: 9, dy: 3, anchor: 'start' },
    { dx: -9, dy: 3, anchor: 'end' },
    { dx: 0, dy: -11, anchor: 'middle' },
    { dx: 0, dy: 17, anchor: 'middle' },
    { dx: 24, dy: 3, anchor: 'start', leader: true },
    { dx: -24, dy: 3, anchor: 'end', leader: true },
    { dx: 0, dy: -27, anchor: 'middle', leader: true },
    { dx: 0, dy: 33, anchor: 'middle', leader: true },
    { dx: 44, dy: -10, anchor: 'start', leader: true },
    { dx: -44, dy: -10, anchor: 'end', leader: true },
  ];

  for (const offset of offsets) {
    const x = point.x + offset.dx;
    const y = point.y + offset.dy;
    const box: PlacedLabel =
      offset.anchor === 'start'
        ? { x1: x - 3, y1: y - 9, x2: x + width, y2: y + 5 }
        : offset.anchor === 'end'
          ? { x1: x - width, y1: y - 9, x2: x + 3, y2: y + 5 }
          : { x1: x - width / 2, y1: y - 11, x2: x + width / 2, y2: y + 5 };
    const inBounds =
      box.x1 >= MARGIN.left + 2 &&
      box.x2 <= WIDTH - MARGIN.right - 2 &&
      box.y1 >= MARGIN.top + 2 &&
      box.y2 <= HEIGHT - MARGIN.bottom - 2;
    if (!inBounds) continue;
    if (placed.some((existing) => intersects(existing, box))) continue;
    placed.push(box);
    return {
      x,
      y,
      anchor: offset.anchor,
      box,
      leader: offset.leader ?? false,
    };
  }
  return null;
}

function tooltipHtml(dataset: ModelChartDataset, point: ModelChartPoint): string {
  const badge =
    point.status === 'candidate'
      ? '<span class="model-chart-tip-badge is-candidate">Candidate</span>'
      : point.status === 'shipping'
        ? '<span class="model-chart-tip-badge is-shipping">In this app</span>'
        : '';
  const source =
    point.source === 'publisher'
      ? '<span class="model-chart-tip-source is-publisher">Publisher-reported · not directly comparable</span>'
      : `<span class="model-chart-tip-source">${escapeHtml(dataset.sourceLabel)}</span>`;

  const rows = [
    ['Parameters', formatParams(point.paramsB)],
    point.downloadMB ? ['Download', formatDownload(point.downloadMB)] : null,
    point.languages ? ['Languages', point.languages.toLocaleString()] : null,
    point.license ? ['License', point.license] : null,
    point.rtfx ? ['RTFx', `${formatRtfx(point.rtfx)} batched`] : null,
    point.utmos ? ['UTMOS', point.utmos.toFixed(2)] : null,
  ].filter((row): row is [string, string] => row !== null);

  return `
    <div class="model-chart-tip-head">
      <p class="model-chart-tip-name">${escapeHtml(point.name)}</p>
      ${badge}
    </div>
    <p class="model-chart-tip-score"><strong>${formatScore(point.score)}</strong> ${escapeHtml(dataset.scoreLabel)}</p>
    <dl class="model-chart-tip-list">
      ${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
    </dl>
    ${point.note ? `<p class="model-chart-tip-note">${escapeHtml(point.note)}</p>` : ''}
    ${source}
  `;
}

export function renderModelChart(
  container: HTMLElement,
  options: ModelChartOptions = {},
): void {
  const selectedId = options.selectedModelId;
  if (selectedId && selectedId !== lastSelectedModelId) {
    activeDatasetId = 'asr';
  }
  lastSelectedModelId = selectedId;
  const dataset = datasetById(activeDatasetId);
  const hasPublisher = dataset.points.some((point) => point.source === 'publisher');
  const sourceNote = hasPublisher
    ? 'Hollow diamond points use publisher-reported averages on different test sets and are shown for scale, not direct ranking.'
    : 'All plotted values use the leaderboard’s evaluation set.';
  const notPlotted =
    dataset.id === 'asr'
      ? 'Whisper Tiny / Base / Small, Omnilingual ASR 300M and Whistle — no directly comparable leaderboard row.'
      : 'Reverb and Kitten TTS 2 — no directly comparable leaderboard row.';
  pinnedPointId = null;

  container.innerHTML = `
    <div class="model-chart-shell">
      <div class="model-chart-head">
        <div>
          <h3 class="model-chart-title">${escapeHtml(dataset.title)}</h3>
          <p class="model-chart-subtitle">${escapeHtml(dataset.subtitle)}</p>
        </div>
        <a class="model-chart-stamp" href="${dataset.sourceUrl}" target="_blank" rel="noreferrer">${escapeHtml(dataset.sourceLabel)} · Nov 2026 ↗</a>
      </div>

      <div class="model-chart-tabs" role="tablist" aria-label="Model type">
        ${MODEL_CHART_DATASETS.map(
          (entry) => `
            <button
              type="button"
              role="tab"
              data-dataset="${entry.id}"
              aria-selected="${entry.id === dataset.id}"
              aria-controls="model-chart-panel"
              class="${entry.id === dataset.id ? 'is-active' : ''}"
            >${escapeHtml(entry.label)}</button>
          `,
        ).join('')}
      </div>

      <div class="model-chart-controls">
        <div class="model-chart-filters" role="group" aria-label="Filter models">
          ${(
            [
              ['all', 'All models'],
              ['app', 'In this app'],
              ['candidates', 'In app + candidates'],
            ] as Array<[ChartFilter, string]>
          )
            .map(
              ([value, label]) => `
                <button
                  type="button"
                  data-filter="${value}"
                  aria-pressed="${activeFilter === value}"
                  class="${activeFilter === value ? 'is-active' : ''}"
                >${label}</button>
              `,
            )
            .join('')}
        </div>
        <div class="model-chart-toggles">
          ${hasPublisher ? `<label><input type="checkbox" data-toggle="publisher" ${showPublisher ? 'checked' : ''} /> Publisher-reported</label>` : ''}
          <label><input type="checkbox" data-toggle="frontier" ${showFrontier ? 'checked' : ''} /> Pareto frontier</label>
        </div>
      </div>

      <div class="model-chart-plot" id="model-chart-panel" role="tabpanel">
        <div class="model-chart-tooltip" role="status" aria-live="polite" hidden></div>
      </div>

      <div class="model-chart-legend" aria-hidden="true">
        <span><i class="model-chart-key is-shipping"></i> In this app</span>
        <span><i class="model-chart-key is-candidate"></i> Candidate</span>
        <span><i class="model-chart-key is-other"></i> Other open model</span>
        ${hasPublisher ? '<span><i class="model-chart-key is-publisher"></i> Publisher-reported</span>' : ''}
        <span><i class="model-chart-key is-frontier"></i> Pareto frontier</span>
      </div>

      <p class="model-chart-note">
        Lower is better: the y-axis is error rate, so the best models sit toward the top-left.
        The x-axis is logarithmic. ${escapeHtml(dataset.sourceLabel)} values are a pinned snapshot
        from 20 November 2026. ${sourceNote} RTFx is the leaderboard's batched
        throughput, not a measurement of speed in this browser.
      </p>
      <p class="model-chart-note model-chart-note-muted">
        Not shown from this app: ${notPlotted}
      </p>
    </div>
  `;

  const plot = container.querySelector<HTMLDivElement>('.model-chart-plot');
  const tooltip = container.querySelector<HTMLDivElement>('.model-chart-tooltip');
  if (!plot || !tooltip) return;

  const visible = visiblePoints(dataset);
  const frontier = paretoFrontier(visible);

  const xMin = Math.min(...dataset.xTicks) * 0.82;
  const xMax = Math.max(...dataset.xTicks) * 1.18;
  const logMin = Math.log10(xMin);
  const logMax = Math.log10(xMax);
  const xScale = (paramsB: number): number => {
    const ratio = (Math.log10(Math.max(paramsB, xMin)) - logMin) / (logMax - logMin);
    return MARGIN.left + Math.max(0, Math.min(1, ratio)) * PLOT_WIDTH;
  };
  const yScale = (score: number): number => {
    const [minimum, maximum] = dataset.yDomain;
    const ratio = (score - minimum) / (maximum - minimum);
    return MARGIN.top + Math.max(0, Math.min(1, ratio)) * PLOT_HEIGHT;
  };

  const svg = svgElement('svg', {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: 'group',
    'aria-label': `${dataset.title}: ${dataset.subtitle}`,
  });
  svg.classList.add('model-chart-svg');

  const defs = svgElement('defs');
  const gradient = svgElement('linearGradient', {
    id: 'model-chart-frontier-line',
    x1: '0%',
    y1: '0%',
    x2: '100%',
    y2: '0%',
  });
  gradient.append(
    svgElement('stop', { offset: '0%', 'stop-color': '#22d3ee', 'stop-opacity': '0.15' }),
    svgElement('stop', { offset: '45%', 'stop-color': '#22d3ee', 'stop-opacity': '0.95' }),
    svgElement('stop', { offset: '100%', 'stop-color': '#818cf8', 'stop-opacity': '0.9' }),
  );
  const areaGradient = svgElement('linearGradient', {
    id: 'model-chart-frontier-area',
    x1: '0%',
    y1: '0%',
    x2: '0%',
    y2: '100%',
  });
  areaGradient.append(
    svgElement('stop', { offset: '0%', 'stop-color': '#22d3ee', 'stop-opacity': '0.16' }),
    svgElement('stop', { offset: '100%', 'stop-color': '#22d3ee', 'stop-opacity': '0' }),
  );
  defs.append(gradient, areaGradient);
  svg.append(defs);

  // Grid and axes.
  const grid = svgElement('g', { class: 'model-chart-grid' });
  for (const tick of dataset.yTicks) {
    const y = yScale(tick);
    grid.append(
      svgElement('line', {
        x1: MARGIN.left,
        y1: y,
        x2: WIDTH - MARGIN.right,
        y2: y,
      }),
    );
  }
  for (const tick of dataset.xTicks) {
    const x = xScale(tick);
    grid.append(
      svgElement('line', {
        x1: x,
        y1: MARGIN.top,
        x2: x,
        y2: HEIGHT - MARGIN.bottom,
      }),
    );
  }
  svg.append(grid);

  const axes = svgElement('g', { class: 'model-chart-axis' });
  axes.append(
    svgElement('line', {
      x1: MARGIN.left,
      y1: MARGIN.top,
      x2: MARGIN.left,
      y2: HEIGHT - MARGIN.bottom,
    }),
    svgElement('line', {
      x1: MARGIN.left,
      y1: HEIGHT - MARGIN.bottom,
      x2: WIDTH - MARGIN.right,
      y2: HEIGHT - MARGIN.bottom,
    }),
  );
  for (const tick of dataset.yTicks) {
    const label = svgElement('text', {
      x: MARGIN.left - 10,
      y: yScale(tick),
      'text-anchor': 'end',
      'dominant-baseline': 'middle',
    });
    label.textContent = dataset.id === 'tts' ? `${tick.toFixed(1)}%` : `${tick}%`;
    axes.append(label);
  }
  for (const tick of dataset.xTicks) {
    const label = svgElement('text', {
      x: xScale(tick),
      y: HEIGHT - MARGIN.bottom + 18,
      'text-anchor': 'middle',
    });
    label.textContent = formatParams(tick);
    axes.append(label);
  }
  const yTitle = svgElement('text', {
    x: MARGIN.left,
    y: MARGIN.top - 13,
    'text-anchor': 'start',
    class: 'model-chart-axis-title',
  });
  yTitle.textContent = dataset.yAxisLabel;
  const xTitle = svgElement('text', {
    x: WIDTH - MARGIN.right,
    y: HEIGHT - 10,
    'text-anchor': 'end',
    class: 'model-chart-axis-title',
  });
  xTitle.textContent = dataset.xAxisLabel;
  axes.append(yTitle, xTitle);
  svg.append(axes);

  // Pareto frontier.
  if (showFrontier && frontier.length > 1) {
    const frontierPoints: Array<[number, number]> = frontier.map((point) => [
      xScale(point.paramsB),
      yScale(point.score),
    ]);
    const path = smoothPath(frontierPoints);
    const last = frontierPoints[frontierPoints.length - 1];
    const first = frontierPoints[0];
    const area = `${path} L ${last[0]} ${HEIGHT - MARGIN.bottom} L ${first[0]} ${HEIGHT - MARGIN.bottom} Z`;
    svg.append(
      svgElement('path', {
        d: area,
        fill: 'url(#model-chart-frontier-area)',
        class: 'model-chart-frontier-area',
      }),
    );
    svg.append(
      svgElement('path', {
        d: path,
        class: 'model-chart-frontier-glow',
      }),
      svgElement('path', {
        d: path,
        class: 'model-chart-frontier',
      }),
    );
    const frontierLabel = svgElement('text', {
      x: Math.min(last[0] + 10, WIDTH - MARGIN.right - 4),
      y: Math.max(last[1] - 10, MARGIN.top + 10),
      'text-anchor': last[0] > WIDTH - MARGIN.right - 130 ? 'end' : 'start',
      class: 'model-chart-frontier-label',
    });
    frontierLabel.textContent = 'Pareto frontier';
    svg.append(frontierLabel);
  }

  // Points and labels.
  const pointsLayer = svgElement('g');
  const labelsLayer = svgElement('g');
  const placedLabels: PlacedLabel[] = [];
  const frontierIds = new Set(frontier.map((point) => point.id));
  const sorted = visible.slice().sort((a, b) => b.score - a.score);

  for (const point of sorted) {
    const x = xScale(point.paramsB);
    const y = yScale(point.score);
    const group = svgElement('g', {
      class: [
        'model-chart-point',
        `is-${point.status}`,
        `is-${point.source}`,
        point.id === selectedId ? 'is-selected' : '',
      ]
        .filter(Boolean)
        .join(' '),
      tabindex: 0,
      role: 'button',
      transform: `translate(${x} ${y})`,
      'aria-label': `${point.name}: ${formatScore(point.score)} ${dataset.scoreLabel}, ${formatParams(
        point.paramsB,
      )} parameters${point.status === 'shipping' ? ', in this app' : ''}`,
    });
    group.dataset.pointId = point.id;

    group.append(
      svgElement('circle', { class: 'model-chart-halo', r: 11 }),
      svgElement('circle', { class: 'model-chart-selection', r: 9 }),
    );

    if (point.source === 'publisher') {
      group.append(
        svgElement('path', {
          class: 'model-chart-dot',
          d: 'M 0 -5.2 L 5.2 0 L 0 5.2 L -5.2 0 Z',
        }),
      );
    } else {
      group.append(svgElement('circle', { class: 'model-chart-dot', r: 4.6 }));
    }

    const show = (clientX: number, clientY: number): void => {
      if (tooltip.dataset.pointId !== point.id) {
        tooltip.innerHTML = tooltipHtml(dataset, point);
        tooltip.dataset.pointId = point.id;
      }
      tooltip.hidden = false;
      const width = 252;
      const height = tooltip.offsetHeight || 150;
      let left = clientX + 14;
      let top = clientY - 12;
      if (left + width > window.innerWidth - 8) left = clientX - width - 14;
      if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8;
      tooltip.style.left = `${Math.max(8, left)}px`;
      tooltip.style.top = `${Math.max(8, top)}px`;
      for (const other of pointsLayer.querySelectorAll('.model-chart-point')) {
        other.classList.toggle('is-hovered', other === group);
      }
    };

    group.addEventListener('pointerenter', (event) => show(event.clientX, event.clientY));
    group.addEventListener('pointermove', (event) => show(event.clientX, event.clientY));
    group.addEventListener('focus', () => {
      const rect = group.getBoundingClientRect();
      show(rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    group.addEventListener('blur', () => {
      if (pinnedPointId || tooltip.dataset.pointId !== point.id) return;
      tooltip.hidden = true;
      group.classList.remove('is-hovered');
    });
    group.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      group.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    group.addEventListener('click', (event) => {
      event.stopPropagation();
      pinnedPointId = point.id;
      show(event.clientX, event.clientY);
      if (point.catalogModelId && options.onSelectModel) {
        options.onSelectModel(point.catalogModelId);
      }
    });

    pointsLayer.append(group);
  }

  const labelRank = (point: ModelChartPoint): number =>
    point.id === selectedId
      ? 0
      : point.status === 'candidate'
        ? 1
        : point.status === 'shipping'
          ? 2
          : 3;
  const labelPoints = visible
    .filter(
      (point) =>
        point.status !== 'other' || frontierIds.has(point.id) || point.id === selectedId,
    )
    .slice()
    .sort((a, b) => labelRank(a) - labelRank(b) || a.score - b.score);

  for (const point of labelPoints) {
    const label = placeLabel(
      { x: xScale(point.paramsB), y: yScale(point.score) + (point.labelOffsetY ?? 0) },
      point.short,
      placedLabels,
    );
    if (!label) continue;
    if (label.leader) {
      labelsLayer.append(
        svgElement('line', {
          x1: xScale(point.paramsB),
          y1: yScale(point.score),
          x2: label.x,
          y2: label.y - 3,
          class: 'model-chart-label-line',
        }),
      );
    }
    const text = svgElement('text', {
      x: label.x,
      y: label.y,
      'text-anchor': label.anchor,
      class: 'model-chart-label',
    });
    text.textContent = point.short;
    labelsLayer.append(text);
  }

  if (visible.length === 0) {
    const empty = svgElement('text', {
      x: WIDTH / 2,
      y: HEIGHT / 2,
      'text-anchor': 'middle',
      class: 'model-chart-empty',
    });
    empty.textContent = 'No models match these filters.';
    pointsLayer.append(empty);
  }

  svg.append(pointsLayer, labelsLayer);
  plot.prepend(svg);

  // Tab and filter controls.
  for (const button of container.querySelectorAll<HTMLButtonElement>('[data-dataset]')) {
    button.addEventListener('click', () => {
      activeDatasetId = button.dataset.dataset as DatasetId;
      renderModelChart(container, options);
    });
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>('[data-filter]')) {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.filter as ChartFilter;
      if (activeFilter !== 'all') showPublisher = true;
      renderModelChart(container, options);
    });
  }
  const publisherToggle = container.querySelector<HTMLInputElement>('[data-toggle="publisher"]');
  publisherToggle?.addEventListener('change', () => {
    showPublisher = publisherToggle.checked;
    renderModelChart(container, options);
  });
  const frontierToggle = container.querySelector<HTMLInputElement>('[data-toggle="frontier"]');
  frontierToggle?.addEventListener('change', () => {
    showFrontier = frontierToggle.checked;
    renderModelChart(container, options);
  });

  plot.addEventListener('click', (event) => {
    if (event.target !== plot && event.target !== svg) return;
    pinnedPointId = null;
    tooltip.hidden = true;
    for (const other of pointsLayer.querySelectorAll('.model-chart-point')) {
      other.classList.remove('is-hovered');
    }
  });
  plot.addEventListener('pointerleave', () => {
    if (pinnedPointId || tooltip.hidden) return;
    tooltip.hidden = true;
    for (const other of pointsLayer.querySelectorAll('.model-chart-point')) {
      other.classList.remove('is-hovered');
    }
  });
}
