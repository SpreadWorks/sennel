import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { CONTEXT_ENV, request, execute, ProtocolFailure } from './client.mjs';

export const directory = path.dirname(fileURLToPath(import.meta.url));
export const bootstrap = path.join(directory, 'bootstrap.mjs');
export const fixture = path.join(directory, 'fixture.mjs');

export class PrototypeRuntime {
  static async create({ root, binding, clientPath, drainMs = 100, launchAtCaller = true, trace = false } = {}) {
    const value = new this();
    value.root = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-process-prototype-'));
    value.ownsRoot = !root;
    value.binding = binding ?? { runId: crypto.randomUUID(), specId: 'prototype', attemptId: 'attempt-1', contractId: 'contract-1', generation: 1 };
    if (trace) { value.traceDirectory = path.join(value.root, 'trace'); fs.mkdirSync(value.traceDirectory); }
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env[CONTEXT_ENV];
    value.child = fork(path.join(directory, 'coordinator.mjs'), [], {
      cwd: os.tmpdir(), env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    value.stderr = ''; value.child.stderr.on('data', b => { value.stderr += b; });
    value.child.stdout.resume();
    value.exited = once(value.child, 'exit');
    const ready = once(value.child, 'message');
    value.child.send({ root: value.root, binding: value.binding, token: crypto.randomUUID(),
      clientPath: clientPath ?? path.join(directory, 'client.mjs'), drainMs, launchAtCaller, traceDirectory: value.traceDirectory });
    let timer;
    try {
      const [message] = await Promise.race([ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('COORDINATOR_START_TIMEOUT')), 10000);
      })]);
      if (!message.ready) throw new ProtocolFailure(message.code, message.message);
      value.context = message.context;
      value.snapshot = (await request(value.context, 'snapshot')).bytes;
      return value;
    } catch (error) {
      value.child.kill('SIGKILL'); await value.exited;
      if (value.ownsRoot) fs.rmSync(value.root, { recursive: true, force: true });
      throw error;
    } finally { clearTimeout(timer); }
  }
  request(operation, payload, options) { return request(this.context, operation, payload, options); }
  execute(executable, args, options = {}) { return execute(this.context, executable, args, { cwd: this.root, ...options }); }
  runNode(args, options) { return this.execute(process.execPath, args, options); }
  startNode(args, options = {}) {
    const spec = this.spec(process.execPath, args, options);
    return this.request('start', spec).then(() => spec.callId);
  }
  spec(executable, args, options = {}) {
    return { callId: options.callId ?? crypto.randomUUID(), requestId: options.requestId ?? crypto.randomUUID(),
      executable, args, cwd: options.cwd ?? this.root, environment: options.environment ?? {},
      input: Buffer.from(options.input ?? '').toString('base64'), timeoutMs: options.timeoutMs ?? 15000, maxBuffer: options.maxBuffer ?? 1024 * 1024 };
  }
  runSync(executable, args, options = {}) {
    const result = spawnSync(process.execPath, [bootstrap, 'bridge'], {
      cwd: os.tmpdir(), env: { ...process.env, [CONTEXT_ENV]: JSON.stringify(this.context), NODE_OPTIONS: '' },
      input: JSON.stringify({ executable, args, options: { cwd: this.root, ...options } }),
      encoding: 'utf8', timeout: (options.timeoutMs ?? 15000) + 7000, killSignal: 'SIGKILL', maxBuffer: 12 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new ProtocolFailure('BRIDGE_UNCONFIRMED', result.stderr || result.error?.message);
    return JSON.parse(result.stdout);
  }
  runSyncWorker(executable, args, options = {}) {
    this.worker ??= new Worker(new URL('./sync-worker.mjs', import.meta.url), {
      execArgv: [], workerData: { context: this.context, snapshot: this.snapshot },
    });
    const memory = new SharedArrayBuffer((options.maxBuffer ?? 1024 * 1024) * 3 + 65536);
    const state = new SharedArrayBuffer(8); const status = new Int32Array(state);
    this.worker.postMessage({ memory, state, spec: { executable, args, options: { cwd: this.root, ...options } } });
    if (Atomics.wait(status, 0, 0, (options.timeoutMs ?? 15000) + 5000) === 'timed-out') throw new ProtocolFailure('BRIDGE_UNCONFIRMED');
    const result = JSON.parse(Buffer.from(memory, 0, Atomics.load(status, 1)).toString('utf8'));
    if (result.error) throw new ProtocolFailure(result.error.code, result.error.message);
    return result.value;
  }
  async dispose() {
    if (this.worker) { await this.worker.terminate(); this.worker = null; }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { await this.request('shutdown'); }
      catch (error) {
        this.shutdownFailure = { code: error.code, message: error.message };
        this.child.kill('SIGKILL');
      }
      await this.exited;
    }
    if (this.ownsRoot) fs.rmSync(this.root, { recursive: true, force: true });
  }
}

export function readJournal(root) {
  const file = path.join(root, 'execution.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
