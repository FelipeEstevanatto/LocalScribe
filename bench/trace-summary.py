"""Summarise a Chrome trace written by bench/video-heavy.mjs --trace.

    python bench/trace-summary.py temp/perf/traces/V12-1080-css-cpu4-cpu4.json [--top 15]

Prints the renderer main-thread self time per function (from the sampling
profiler in the trace), the longest main-thread tasks, and total task time.
Standard library only; streams nothing, so large traces need some RAM.
"""
import json, sys, collections

path = sys.argv[1]
top = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 15
data = json.load(open(path, encoding='utf8'))
events = data['traceEvents'] if isinstance(data, dict) else data

threads = {(e['pid'], e['tid']): e['args']['name'] for e in events if e.get('name') == 'thread_name'}
mains = {k for k, v in threads.items() if v == 'CrRendererMain'}

# Pick the renderer main thread with the most task time.
task_time = collections.Counter()
for e in events:
    if e.get('ph') == 'X' and e.get('name') == 'RunTask' and (e.get('pid'), e.get('tid')) in mains:
        task_time[(e['pid'], e['tid'])] += e.get('dur', 0)
main = task_time.most_common(1)[0][0]
print(f'main thread {main}, RunTask total {task_time[main] / 1e6:.1f} s')

long = sorted((e for e in events if e.get('ph') == 'X' and e.get('name') == 'RunTask' and (e.get('pid'), e.get('tid')) == main and e.get('dur', 0) > 50000), key=lambda e: -e['dur'])
print(f'long tasks over 50 ms: {len(long)}, total {sum(e["dur"] for e in long) / 1e3:.0f} ms, top: {[round(e["dur"] / 1e3) for e in long[:8]]}')

# Sampling profile: ProfileChunk events carry nodes and samples with time deltas.
nodes = {}
self_time = collections.Counter()
for e in events:
    if e.get('name') != 'ProfileChunk' or e.get('pid') != main[0]:
        continue
    chunk = e['args']['data'].get('cpuProfile', {})
    for node in chunk.get('nodes', []):
        frame = node['callFrame']
        url = frame.get('url', '').split('/')[-1].split('?')[0]
        nodes[node['id']] = f"{frame.get('functionName') or '(anonymous)'} {url}:{frame.get('lineNumber', -1) + 1}"
    samples = chunk.get('samples', [])
    deltas = e['args']['data'].get('timeDeltas', [])
    for sample, delta in zip(samples, deltas):
        self_time[sample] += max(0, delta)
named = collections.Counter()
for node_id, micros in self_time.items():
    named[nodes.get(node_id, str(node_id))] += micros
total = sum(named.values()) or 1
print(f'sampled self time {total / 1e6:.1f} s; top {top}:')
for name, micros in named.most_common(top):
    print(f'  {micros / 1e3:9.0f} ms {micros / total * 100:5.1f}%  {name}')
