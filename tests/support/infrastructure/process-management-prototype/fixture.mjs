import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import crypto from 'node:crypto';
import { CONTEXT_ENV, execute, request } from './client.mjs';

const [mode, ...args] = process.argv.slice(2);
const currentFile = fileURLToPath(import.meta.url);
function signal(file, content) {
  fs.writeFileSync(file + '.pending', content);
  fs.renameSync(file + '.pending', file);
}
const context = process.env[CONTEXT_ENV] ? JSON.parse(process.env[CONTEXT_ENV]) : null;
if (mode === 'echo') {
  for await (const chunk of process.stdin) process.stdout.write(chunk);
  process.stderr.write(process.env.PROTOTYPE_VALUE ?? '');
} else if (mode === 'ready') {
  process.stdout.write('ready:' + args[0]);
  setTimeout(() => { if (args[2]) signal(args[2], 'finished'); process.exit(0); }, Number(args[1] ?? 10000));
} else if (mode === 'nested') {
  const depth = Number(args[0]);
  process.stdout.write(`depth:${depth}\n`);
  const result = depth > 0
    ? await execute(context, process.execPath, [currentFile, 'nested', String(depth - 1)], { timeoutMs: 15000 })
    : await execute(context, process.execPath, [currentFile, 'ready', 'leaf'], { timeoutMs: 15000 });
  if (!result.receipt) process.exitCode = 125;
} else if (mode === 'unregistered-pipe') {
  // External-tool internal child, deliberately outside the registry guarantee.
  spawn(process.execPath, ['-e', `setTimeout(()=>{const fs=require('fs');fs.writeFileSync(${JSON.stringify(args[0] + '.pending')},'finished');fs.renameSync(${JSON.stringify(args[0] + '.pending')},${JSON.stringify(args[0])})},1000)`], { stdio: ['ignore', process.stdout, process.stderr] }).unref();
  process.stdout.write('direct-exit');
} else if (mode === 'late-child') {
  await delay(100);
  try {
    await execute(JSON.parse(args[0]), process.execPath, ['-e', 'process.stdout.write("unexpected")']);
    signal(args[1], 'unexpected');
  } catch (error) { signal(args[1], error.code); }
} else if (mode === 'create-late-child') {
  spawn(process.execPath, [currentFile, 'late-child', JSON.stringify(context), args[0]], { stdio: 'ignore' }).unref();
} else if (mode === 'create-file') {
  fs.writeFileSync(path.resolve(args[0]), args[1]); process.stdout.write('written');
} else if (mode === 'read-file') {
  process.stdout.write(fs.readFileSync(path.resolve(args[0])));
} else if (mode === 'ai-nested') {
  const result = await execute(context, process.execPath, [currentFile, 'read-file', args[0]]);
  process.stdout.write(Buffer.from(result.stdout, 'base64'));
} else if (mode === 'probe-control') {
  try { await request(context, 'maintenance', {}); }
  catch (error) { process.stdout.write(error.code); }
} else if (mode === 'delegate-replay' || mode === 'delegate-race') {
  const options = { callId: crypto.randomUUID(), requestId: crypto.randomUUID() };
  const command = ['-e', `require('fs').appendFileSync(${JSON.stringify(args[0])},'x');process.stdout.write('once')`];
  if (mode === 'delegate-race') {
    const release = args[0] + '.release';
    const gated = [currentFile, 'gated-write', args[0], release];
    const launches = [execute(context, process.execPath, gated, options), execute(context, process.execPath, gated, options)];
    await Promise.race(launches.map(launch => launch.then(() => { throw new Error('gated child finished before release'); }, () => null)));
    signal(release, 'release');
    const results = await Promise.allSettled(launches);
    process.stdout.write(JSON.stringify(results.map(result => result.status === 'fulfilled' ? 'finished' : result.reason.code)));
  } else {
    const first = await execute(context, process.execPath, command, options);
    const second = await execute(context, process.execPath, command, options);
    process.stdout.write(JSON.stringify({ first: first.receipt, second: second.receipt }));
  }
} else if (mode === 'gated-write') {
  let completed = false;
  const finish = () => {
    if (completed || !fs.existsSync(args[1])) return;
    completed = true; watcher.close(); fs.appendFileSync(args[0], 'x'); process.stdout.write('once');
  };
  const watcher = fs.watch(path.dirname(args[1]), finish); finish();
} else if (mode === 'probe-central') {
  try {
    await request(context, 'start', { callId: crypto.randomUUID(), requestId: crypto.randomUUID(),
      executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
      timeoutMs: 1000, maxBuffer: 1024, input: '', environment: {} });
    process.stdout.write('unexpected');
  } catch (error) { process.stdout.write(error.code); }
} else if (mode === 'delegate-echo') {
  const result = await execute(context, process.execPath, [currentFile, 'echo'], {
    input: Buffer.from(args[0], 'base64'), environment: { PROTOTYPE_VALUE: 'local-stderr' },
  });
  process.stdout.write(JSON.stringify(result));
} else if (mode === 'probe-loopback') {
  await new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(args[0]) });
    const timer = setTimeout(() => { socket.destroy(); process.stdout.write(JSON.stringify({ connection: 'timeout' })); resolve(); }, 3000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); process.stdout.write(JSON.stringify({ connection: 'allowed' })); resolve(); });
    socket.once('error', error => { clearTimeout(timer); socket.destroy(); process.stdout.write(JSON.stringify({ connection: 'denied', code: error.code })); resolve(); });
  });
} else {
  throw new Error('Unknown fixture mode');
}
