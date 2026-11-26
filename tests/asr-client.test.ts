import { afterEach, expect, test } from 'bun:test';
import { AsrClient, type AsrRequest, type AsrResponse } from '../src/asr-client';

const originalWorker = globalThis.Worker;

class TestWorker {
  static latest: TestWorker;
  terminated = false;
  request?: AsrRequest;
  messages: AsrRequest[] = [];
  onmessage: ((event: { data: AsrResponse }) => void) | null = null;

  constructor() {
    TestWorker.latest = this;
  }

  postMessage(request: AsrRequest, transfer: Transferable[]): void {
    const clone = structuredClone(request, { transfer });
    this.request = clone;
    this.messages.push(clone);
  }

  reply(data: AsrResponse): void {
    this.onmessage?.({ data });
  }

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => { globalThis.Worker = originalWorker; });

test('worker inference preserves the source buffer and the loaded engine across cancel', async () => {
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  const client = new AsrClient({ modelId: 'moonshine-tiny', variantId: 'q8', clean: false, useWebGPU: false });
  const loaded = client.load();
  const worker = TestWorker.latest;
  worker.reply({ type: 'loaded', backend: 'wasm' });
  await loaded;

  const samples = Float32Array.of(1, 2, 3);
  const controller = new AbortController();
  let partial = '';
  const run = client.transcribe(samples.subarray(1), {
    signal: controller.signal,
    onPartial: (text) => { partial = text; },
  });
  expect(worker.request).toEqual({ type: 'transcribe', id: 1, samples: Float32Array.of(2, 3) });
  expect([...samples]).toEqual([1, 2, 3]);
  worker.reply({ type: 'partial', id: 1, text: 'kept' });
  controller.abort();
  await expect(run).rejects.toHaveProperty('name', 'AbortError');
  expect(partial).toBe('kept');
  expect(worker.messages).toContainEqual({ type: 'cancel', id: 1 });
  // Cancelling keeps the worker and its ONNX sessions alive.
  expect(worker.terminated).toBe(false);
  expect(client.backend).toBe('wasm');

  const same = client.transcribe(samples);
  expect(TestWorker.latest).toBe(worker);
  expect(worker.request).toEqual({ type: 'transcribe', id: 2, samples: Float32Array.of(1, 2, 3) });
  worker.reply({ type: 'partial', id: 1, text: 'stale' });
  expect(partial).toBe('kept');
  worker.reply({ type: 'result', id: 2, result: { text: 'done', frames: 1, tokenCount: 1 } });
  await expect(same).resolves.toHaveProperty('text', 'done');
  await client.dispose();
  expect(worker.terminated).toBe(true);
});
