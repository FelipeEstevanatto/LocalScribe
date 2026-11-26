import { expect, test } from 'bun:test';
import { joinGraph, stemMixGraph } from '../src/audio-edit';
import { formatEta, TransferMeter, WorkMeter } from '../src/transfer';

test('transfer meter reports speed and time left from cumulative bytes', () => {
  const meter = new TransferMeter();
  meter.update(0, 10_000_000, 0);
  const { bytesPerSecond, etaSeconds, percent } = meter.update(2_000_000, 10_000_000, 1000);
  expect(bytesPerSecond).toBe(2_000_000);
  expect(etaSeconds).toBe(4);
  expect(percent).toBe(20);
});

test('work meter extrapolates the remaining time from average pace', () => {
  const meter = new WorkMeter();
  const start = performance.now();
  const { etaSeconds } = meter.update(0.25, start + 10_000);
  expect(etaSeconds).toBeCloseTo(30, 0);
});

test('time left reads naturally', () => {
  expect(formatEta(null)).toBe('estimating…');
  expect(formatEta(12.2)).toBe('~13s left');
  expect(formatEta(125)).toBe('~2m 05s left');
});

test('joining with a crossfade chains acrossfade and shortens the total', () => {
  const clip = { blob: new Blob(), duration: 10 };
  const { graph, duration } = joinGraph([clip, { ...clip, trimStart: 2 }, clip], 1.5);
  expect(graph).toContain('[1:a:0]atrim=start=2.000000:end=10.000000');
  expect(graph).toContain('[a0][a1]acrossfade=d=1.500000:c1=tri:c2=tri[x1]');
  expect(graph).toContain('[x1][a2]acrossfade=d=1.500000:c1=tri:c2=tri[out]');
  expect(duration).toBeCloseTo(25);
  expect(joinGraph([clip, clip]).graph).toContain('concat=n=2:v=0:a=1[out]');
});

test('stem mix applies linear gains and limits peaks', () => {
  expect(stemMixGraph([1, 0.5])).toContain('[1:a:0]volume=0.5000[stem1]');
  expect(stemMixGraph([1, 0.5])).toContain('amix=inputs=2');
  expect(stemMixGraph([0.7])).toBe('[0:a:0]volume=0.7000,alimiter=limit=0.89:level=false:latency=true[out]');
});
