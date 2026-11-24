import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PrototypeRuntime } from './harness.mjs';

const samples = Number(process.argv[2] ?? 20);
const r = await PrototypeRuntime.create();
try {
  const summary = [];
  for (const [name, executable, args] of [['node-empty', process.execPath, ['-e', '']], ['git-version', 'git', ['--version']]]) {
    for (const [mode, invoke] of [
      ['direct-sync', () => { const result = spawnSync(executable, args, { cwd: r.root, timeout: 10000, killSignal: 'SIGKILL' }); if (result.status !== 0) throw result.error ?? new Error(result.stderr.toString()); }],
      ['node-process-bridge', () => r.runSync(executable, args)],
      ['persistent-worker-bridge', () => r.runSyncWorker(executable, args)],
      ['async-client', () => r.execute(executable, args)],
    ]) {
      await invoke();
      const times = [];
      for (let i = 0; i < samples; i++) { const started = performance.now(); await invoke(); times.push(performance.now() - started); }
      times.sort((a,b) => a-b);
      summary.push({ name, mode, samples, averageMs: times.reduce((a,b)=>a+b,0)/samples, medianMs: times[Math.floor(samples/2)], p95Ms: times[Math.min(samples-1,Math.floor(samples*.95))] });
    }
  }
  const report = { platform: process.platform, arch: process.arch, node: process.version, summary };
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { await r.dispose(); }
