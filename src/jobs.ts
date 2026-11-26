/**
 * Job tray: long tasks (separation, exports, transcription) keep running when
 * you switch tools. The tray lists them with progress, the sidebar marks the
 * tool that owns each one, the tab title shows overall progress, and a
 * browser notification fires when a job ends while you are elsewhere.
 */

export interface JobHandle {
  update: (fraction: number, detail?: string) => void;
  finish: (message: string, ok?: boolean) => void;
}

interface Job {
  id: number;
  label: string;
  view: string;
  fraction: number | null;
  detail: string;
  started: number;
  done: boolean;
  ok: boolean;
  element: HTMLElement;
}

/** Jobs shorter than this never appear, so quick actions stay quiet. */
const SHOW_AFTER_MS = 1200;
const LINGER_MS = 8000;

export function setupJobTray(options: { navigate: (view: string) => void; currentView: () => string; viewTitle: (view: string) => string }) {
  const jobs: Job[] = [];
  let nextId = 0;
  const baseTitle = document.title;

  const tray = document.createElement('section');
  tray.className = 'job-tray hidden';
  tray.setAttribute('aria-label', 'Background jobs');
  tray.setAttribute('aria-live', 'polite');
  const head = document.createElement('div');
  head.className = 'job-tray-head';
  const title = document.createElement('p');
  title.textContent = 'Running';
  const notify = document.createElement('button');
  notify.type = 'button';
  notify.className = 'job-notify';
  notify.textContent = 'Notify me when done';
  notify.addEventListener('click', async () => {
    await Notification.requestPermission().catch(() => 'denied');
    render();
  });
  head.append(title, notify);
  const list = document.createElement('div');
  list.className = 'job-list';
  tray.append(head, list);
  document.body.append(tray);

  function visible(job: Job): boolean {
    return job.done || performance.now() - job.started >= SHOW_AFTER_MS;
  }

  function render(): void {
    const shown = jobs.filter(visible);
    tray.classList.toggle('hidden', !shown.length);
    const running = shown.filter((job) => !job.done);
    title.textContent = running.length ? `Running · ${running.length}` : 'Finished';
    notify.classList.toggle('hidden', !('Notification' in window) || Notification.permission !== 'default' || !running.length);
    list.replaceChildren(...shown.map((job) => job.element));
    for (const job of shown) paint(job);

    // Mark sidebar links whose tool has a running job.
    const busy = new Set(jobs.filter((job) => !job.done).map((job) => job.view));
    for (const link of document.querySelectorAll<HTMLElement>('#sidebar [data-view-link]')) {
      link.classList.toggle('has-job', busy.has(link.dataset.viewLink ?? ''));
    }
    const progress = running.map((job) => job.fraction).filter((value): value is number => value !== null);
    document.title = running.length
      ? `(${progress.length ? Math.round((progress.reduce((a, b) => a + b, 0) / progress.length) * 100) + '%' : '…'}) ${baseTitle}`
      : baseTitle;
  }

  function paint(job: Job): void {
    const [label, detail, track, open] = job.element.children as unknown as [HTMLElement, HTMLElement, HTMLElement, HTMLButtonElement];
    label.textContent = job.label;
    detail.textContent = job.done ? job.detail : `${job.fraction === null ? '' : Math.round(job.fraction * 100) + '% · '}${job.detail}`;
    const bar = track.firstElementChild as HTMLElement;
    bar.style.width = `${job.done ? 100 : Math.round((job.fraction ?? 0) * 100)}%`;
    bar.classList.toggle('progress-indeterminate', !job.done && job.fraction === null);
    job.element.classList.toggle('job-failed', job.done && !job.ok);
    job.element.classList.toggle('job-done', job.done && job.ok);
    open.classList.toggle('hidden', options.currentView() === job.view);
  }

  // Show jobs that just crossed the delay.
  setInterval(() => {
    if (jobs.some((job) => !job.done)) render();
  }, 500);
  window.addEventListener('hashchange', () => render());

  function start(label: string, view: string): JobHandle {
    const element = document.createElement('div');
    element.className = 'job';
    const name = document.createElement('p');
    name.className = 'job-label';
    const detail = document.createElement('p');
    detail.className = 'job-detail';
    const track = document.createElement('div');
    track.className = 'progress-track';
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    track.append(bar);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'job-open';
    open.textContent = `Open ${options.viewTitle(view)}`;
    open.addEventListener('click', () => options.navigate(view));
    element.append(name, detail, track, open);
    const job: Job = { id: ++nextId, label, view, fraction: null, detail: '', started: performance.now(), done: false, ok: true, element };
    jobs.push(job);
    render();
    return {
      update(fraction, text) {
        if (job.done) return;
        job.fraction = Math.max(0, Math.min(1, fraction));
        if (text) job.detail = text;
        if (visible(job)) paint(job);
        render();
      },
      finish(message, ok = true) {
        if (job.done) return;
        const wasVisible = visible(job);
        job.done = true;
        job.ok = ok;
        job.detail = message;
        if (!wasVisible) {
          jobs.splice(jobs.indexOf(job), 1);
          render();
          return;
        }
        render();
        const away = document.hidden || options.currentView() !== job.view;
        if (away && 'Notification' in window && Notification.permission === 'granted') {
          const notification = new Notification(ok ? `${label} · done` : `${label} · stopped`, { body: message, tag: `job-${job.id}` });
          notification.onclick = () => {
            window.focus();
            options.navigate(job.view);
            notification.close();
          };
        }
        setTimeout(() => {
          const index = jobs.indexOf(job);
          if (index >= 0) jobs.splice(index, 1);
          render();
        }, LINGER_MS);
      },
    };
  }

  return { start };
}
