// Executable design experiment; production Sennel does not import this module.
// Kept self-contained so the exact bytes can be delivered as a data URL.
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const CONTEXT_ENV = 'SENNEL_PROCESS_PROTOTYPE_CONTEXT';
export const MAX_FRAME = 12 * 1024 * 1024;

export class ProtocolFailure extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

// The same framed request/reply contract through sandbox-writable files.
// The authoritative registry remains coordinator-owned; these are transport files.
class MailboxChannel extends EventEmitter {
  constructor(directory) {
    super(); this.directory = directory; this.id = crypto.randomUUID(); this.offset = 0; this.destroyed = false;
    this.response = path.join(directory, this.id + '.response');
    queueMicrotask(() => this.emit('connect'));
    this.timer = setInterval(() => {
      try {
        const bytes = fs.readFileSync(this.response);
        if (bytes.length > this.offset) {
          const chunk = bytes.subarray(this.offset); this.offset = bytes.length; this.emit('data', chunk);
        }
      } catch (error) { if (error.code !== 'ENOENT') this.emit('error', error); }
    }, 10);
  }
  write(bytes) {
    const temp = path.join(this.directory, this.id + '.incoming');
    try {
      fs.writeFileSync(temp, bytes, { flag: 'wx' });
      fs.renameSync(temp, path.join(this.directory, this.id + '.request'));
    } catch (error) { this.emit('error', error); }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; clearInterval(this.timer);
    try { fs.unlinkSync(this.response); } catch (error) { if (error.code !== 'ENOENT') this.emit('error', error); }
    this.emit('close');
  }
}

export function request(context, operation, payload = {}, { timeoutMs = 15000, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const socket = context.transport === 'mailbox'
      ? new MailboxChannel(context.mailbox)
      : net.createConnection({ host: '127.0.0.1', port: context.port });
    let pending = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new ProtocolFailure('COMMUNICATION_UNCONFIRMED')), timeoutMs);
    socket.once('connect', () => socket.write(JSON.stringify({ context, operation, payload }) + '\n'));
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_FRAME) return finish(new ProtocolFailure('FRAME_TOO_LARGE'));
      for (;;) {
        const end = pending.indexOf(10);
        if (end < 0) break;
        const bytes = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        let frame;
        try { frame = JSON.parse(bytes.toString('utf8')); }
        catch (error) { return finish(new ProtocolFailure('INVALID_RESPONSE', error.message)); }
        if (frame.type === 'stdout' || frame.type === 'stderr') onOutput?.(frame.type, Buffer.from(frame.data, 'base64'));
        else if (frame.type === 'error') finish(new ProtocolFailure(frame.code, frame.message));
        else if (frame.type === 'result') finish(null, frame.value);
      }
    });
    socket.once('error', (error) => finish(new ProtocolFailure('COMMUNICATION_UNCONFIRMED', error.message)));
    socket.once('close', () => {
      if (!settled) finish(new ProtocolFailure('COMMUNICATION_UNCONFIRMED'));
    });
  });
}

export async function execute(context, executable, args, options = {}) {
  const callId = options.callId ?? crypto.randomUUID();
  const requestId = options.requestId ?? crypto.randomUUID();
  const spec = {
    callId, requestId, executable, args, cwd: options.cwd ?? process.cwd(),
    input: Buffer.from(options.input ?? '').toString('base64'),
    environment: options.environment ?? {}, timeoutMs: options.timeoutMs ?? 15000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  };
  if (context.parentCallId !== null && context.launchAtCaller !== false) return executeAtLauncher(context, spec, options);
  await request(context, 'start', spec, options);
  const result = await request(context, 'wait', { callId }, { ...options, timeoutMs: (options.timeoutMs ?? 15000) + 5000 });
  if (result.state !== 'finished' || !result.receipt) throw new ProtocolFailure('EXECUTION_UNCONFIRMED');
  return result;
}

// External wrapper executes inside its caller's sandbox/context. The coordinator
// owns registration and evidence, while this launcher owns the real child handle.
class LauncherOutput {
  constructor(context, spec, accept) {
    this.spec = spec; this.accept = accept; this.size = 0; this.truncated = false;
    this.files = ['stdout', 'stderr'].map(stream => ({ stream, file: path.join(context.mailbox, spec.callId + '.' + stream), offset: 0 }));
    this.descriptors = this.files.map(({ file }) => fs.openSync(file, 'wx'));
  }
  releaseDescriptors() { for (const fd of this.descriptors) fs.closeSync(fd); this.descriptors = []; }
  collect() {
    for (const item of this.files) {
      const fd = fs.openSync(item.file, 'r');
      try {
        const length = fs.fstatSync(fd).size;
        while (item.offset < length) {
          const buffer = Buffer.alloc(Math.min(65536, length - item.offset));
          const read = fs.readSync(fd, buffer, 0, buffer.length, item.offset); item.offset += read;
          if (read === 0) break;
          const accepted = buffer.subarray(0, Math.min(read, Math.max(0, this.spec.maxBuffer - this.size)));
          this.size += accepted.length;
          if (accepted.length) this.accept(item.stream, accepted);
          if (accepted.length < read) this.truncated = true;
        }
      } finally { fs.closeSync(fd); }
    }
  }
  close() { this.releaseDescriptors(); for (const { file } of this.files) fs.unlinkSync(file); }
}

async function executeAtLauncher(context, spec, options) {
  const requestedAt = performance.now();
  const permit = await request(context, 'start-delegated', spec, options);
  const executor = permit.executorContext;
  const claim = await request(executor, 'executor-claim', { instanceId: crypto.randomUUID() });
  if (claim.result) {
    for (const stream of ['stdout', 'stderr']) options.onOutput?.(stream, Buffer.from(claim.result[stream], 'base64'));
    return claim.result;
  }
  const trace = (kind, data = {}) => {
    if (context.traceDirectory) fs.appendFileSync(path.join(context.traceDirectory, spec.callId + '.jsonl'), JSON.stringify({ kind, ...data }) + '\n');
  };
  trace('launcher', { executable: spec.executable, args: spec.args, remainingMs: permit.remainingMs });
  let child, started = false, observation, failed, outputState = 'complete';
  let outputQueue = Promise.resolve(); let forceRequested = false; let polling = false;
  const report = (operation, payload = {}) => request(executor, operation, payload);
  const output = new LauncherOutput(context, spec, (stream, accepted) => {
    trace('output', { stream, bytes: accepted.length });
    options.onOutput?.(stream, accepted);
    outputQueue = outputQueue.then(() => report('executor-output', { stream, data: accepted.toString('base64') }));
  });
  const ended = new Promise((resolve, reject) => {
    child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd, env: { ...process.env, ...spec.environment, [CONTEXT_ENV]: JSON.stringify(permit.childContext) },
      shell: false, stdio: ['pipe', ...output.descriptors],
    });
    output.releaseDescriptors();
    child.once('spawn', () => { trace('spawn'); started = true; outputQueue = outputQueue.then(() => report('executor-started')); });
    child.once('error', error => {
      if (started || child.pid != null) { failed = new ProtocolFailure('LIVE_CHILD_CONTROL_ERROR', error.message); reject(failed); }
      else { observation = { kind: 'spawn-failed', code: error.code, signal: null }; resolve(); }
    });
    child.once('exit', (code, signal) => { trace('exit', { code, signal }); observation = { kind: 'exited', code, signal }; resolve(); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failed = error; });
    child.stdin.end(Buffer.from(spec.input, 'base64'));
  });
  const timer = setInterval(async () => {
    if (polling || observation || failed) return;
    polling = true;
    try {
      output.collect();
      if (output.truncated) { outputState = 'truncated'; child.kill('SIGKILL'); }
      const control = await report('executor-control');
      if (control.stop && !forceRequested) {
        forceRequested = true;
        await report('executor-force-requested'); child.kill('SIGKILL');
      }
    } catch (error) { failed = error; child.kill('SIGKILL'); }
    finally { polling = false; }
  }, 20);
  const deadlineTimer = setTimeout(() => { forceRequested = true; child.kill('SIGKILL'); },
    Math.max(1, permit.remainingMs - (performance.now() - requestedAt)));
  try {
    await ended;
    clearInterval(timer); clearTimeout(deadlineTimer);
    output.collect(); if (output.truncated) outputState = 'truncated';
    await outputQueue;
    if (failed) throw failed;
    const result = await report('executor-exit', { observation, outputState });
    if (result.state !== 'finished' || !result.receipt) throw new ProtocolFailure('EXECUTION_UNCONFIRMED');
    return result;
  } catch (error) {
    clearInterval(timer); clearTimeout(deadlineTimer);
    if (!observation) child.kill('SIGKILL');
    await report('executor-unconfirmed', { code: error.code ?? 'LAUNCHER_UNKNOWN' }).catch(reportError => { failed = reportError; });
    throw error;
  } finally { output.close(); }
}

export async function main(context, argv) {
  if (argv[0] === 'bridge') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = await execute(context, spec.executable, spec.args, spec.options);
    process.stdout.write(JSON.stringify(result));
    return;
  }
  if (argv[0] !== 'command' || argv[1] !== '--' || !argv[2]) throw new ProtocolFailure('INVALID_COMMAND_ARGUMENTS');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const result = await execute(context, argv[2], argv.slice(3), {
    input: Buffer.concat(chunks), timeoutMs: 90000,
    onOutput(stream, bytes) { process[stream].write(bytes); },
  });
  process.exitCode = result.kind === 'exited' && result.code !== null ? result.code : 125;
}
