// Minimal executable model of b900, not a replacement for the production runtime.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { CONTEXT_ENV, MAX_FRAME, ProtocolFailure } from './client.mjs';

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

class StopOperation {
  constructor(session, reason) {
    this.id = crypto.randomUUID(); this.session = session; this.reason = reason;
    this.startedAt = performance.now(); this.deadline = this.startedAt + 3000;
    Object.freeze(this);
  }
  remaining() { return Math.max(0, this.deadline - performance.now()); }
}

class MailboxReply extends EventEmitter {
  constructor(file) { super(); this.file = file; this.destroyed = false; }
  write(bytes) { fs.appendFileSync(this.file, bytes); }
  end(bytes) { this.write(bytes); this.destroyed = true; this.emit('close'); }
}

class OriginBinding {
  constructor(value) {
    for (const field of ['runId', 'specId', 'attemptId', 'contractId', 'generation']) {
      if (value[field] == null) throw new ProtocolFailure('INVALID_BINDING');
    }
    this.value = structuredClone(value);
    Object.freeze(this.value); Object.freeze(this);
  }
}

class ExclusiveOwner {
  constructor(file, session) { this.file = file; this.session = session; }
  acquire() {
    try { fs.writeFileSync(this.file, JSON.stringify({ session: this.session }), { flag: 'wx' }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new ProtocolFailure('OWNER_UNCONFIRMED');
      throw error;
    }
  }
  release() {
    if (JSON.parse(fs.readFileSync(this.file, 'utf8')).session !== this.session) throw new ProtocolFailure('OWNER_CHANGED');
    fs.unlinkSync(this.file);
  }
}

class ExecutionJournal {
  constructor(root, binding, session) {
    this.root = root; this.binding = binding; this.session = session;
    this.file = path.join(root, 'execution.jsonl');
    this.events = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  }
  append(call, kind, data = {}) {
    const event = {
      id: `${this.session}:${this.events.length + 1}`, sequence: this.events.length + 1,
      session: this.session, callId: call?.id ?? null, parentCallId: call?.parentId ?? null,
      originBinding: this.binding.value, audit: call?.audit ?? 'execution-only', kind,
      at: new Date().toISOString(), data: structuredClone(data),
    };
    const fd = fs.openSync(this.file, 'a');
    try { fs.writeSync(fd, JSON.stringify(event) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    this.events.push(event);
    return event;
  }
  activity() {
    const file = path.join(this.root, 'activity.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { lifecycle: 'active', events: [], cutoff: null };
  }
  flush({ finalize = false } = {}) {
    const lock = new ExclusiveOwner(path.join(this.root, 'activity.lock'), crypto.randomUUID());
    try { lock.acquire(); }
    catch (error) {
      if (error.code === 'OWNER_UNCONFIRMED') throw new ProtocolFailure('ACTIVITY_BUSY');
      throw error;
    }
    try {
      const current = this.activity();
      const known = new Map(current.events.map(event => [event.id, digest(event)]));
      const pending = this.events.filter(event => event.audit === 'flow' && !known.has(event.id));
      if (current.lifecycle === 'finalized' && pending.length) throw new ProtocolFailure('FINALIZED_ACTIVITY_REFUSED');
      for (const event of this.events) {
        if (known.has(event.id) && known.get(event.id) !== digest(event)) throw new ProtocolFailure('EVENT_CONFLICT');
      }
      current.events.push(...pending);
      if (finalize) {
        current.lifecycle = 'finalized';
        current.cutoff = { sequence: this.events.length, eventIds: current.events.map(e => e.id) };
      }
      const file = path.join(this.root, 'activity.json');
      const temp = `${file}.${crypto.randomUUID()}`;
      fs.writeFileSync(temp, JSON.stringify(current));
      fs.renameSync(temp, file);
      return current;
    } finally { lock.release(); }
  }
}

class CommandInvocation {
  constructor(payload) {
    if (typeof payload.executable !== 'string' || !Array.isArray(payload.args)
      || payload.args.some(v => typeof v !== 'string') || !path.isAbsolute(payload.cwd)
      || !Number.isFinite(payload.timeoutMs) || payload.timeoutMs <= 0
      || !Number.isInteger(payload.maxBuffer) || payload.maxBuffer < 1) throw new ProtocolFailure('INVALID_INVOCATION');
    Object.assign(this, payload);
  }
}

class RegisteredCall extends EventEmitter {
  constructor(coordinator, invocation, parentId, audit) {
    super();
    this.coordinator = coordinator; this.invocation = invocation;
    this.id = invocation.callId; this.parentId = parentId; this.audit = audit;
    this.requestDigest = digest(invocation); this.state = 'intent'; this.accepting = true;
    this.stdout = Buffer.alloc(0); this.stderr = Buffer.alloc(0); this.outputState = 'complete';
    this.exit = null; this.receipt = null; this.child = null; this.stopRequested = false;
    this.deadline = performance.now() + invocation.timeoutMs;
    this.grant = crypto.randomUUID();
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }
  view() {
    return {
      id: this.id, parentCallId: this.parentId, state: this.state, accepting: this.accepting,
      executable: this.invocation.executable, args: this.invocation.args, cwd: this.invocation.cwd,
      audit: this.audit, deadline: this.deadline, session: this.coordinator.session,
      stdout: this.stdout.toString('base64'), stderr: this.stderr.toString('base64'),
      outputState: this.outputState, exit: this.exit, receipt: this.receipt,
    };
  }
  start() {
    const c = this.coordinator;
    c.journal.append(this, 'start-intent', { executable: this.invocation.executable, args: this.invocation.args, cwd: this.invocation.cwd });
    this.state = 'launching';
    if (this.delegated) {
      this.executorToken = crypto.randomUUID();
      this.timer = setTimeout(() => { c.stop(this.id, 'deadline').catch(error => this.unconfirmed(error)); }, Math.max(1, this.deadline - performance.now()));
      return;
    }
    // Reserved context is generated after ordinary environment overrides.
    const env = { ...process.env, ...this.invocation.environment,
      [CONTEXT_ENV]: JSON.stringify(c.context(this.id, this.grant)) };
    delete env.NODE_OPTIONS;
    this.child = spawn(this.invocation.executable, this.invocation.args, {
      cwd: this.invocation.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') this.coordinator.journal.append(this, 'stdin-error', { code: error.code });
    });
    this.child.stdout.on('data', b => this.output('stdout', b));
    this.child.stderr.on('data', b => this.output('stderr', b));
    this.child.once('spawn', () => {
      this.started = true; this.state = 'running'; c.journal.append(this, 'started'); c.changed();
    });
    this.child.once('error', error => {
      if (this.exit !== null) return;
      this.accepting = false;
      if (this.started || this.child.pid != null) { this.unconfirmed(new ProtocolFailure('LIVE_CHILD_CONTROL_ERROR', error.message)); return; }
      this.exit = { kind: 'spawn-failed', code: error.code, signal: null };
      c.journal.append(this, 'spawn-failed', this.exit);
      this.settle().catch(error => this.unconfirmed(error));
    });
    this.child.once('exit', (code, signal) => {
      this.accepting = false;
      this.exit = { kind: 'exited', code, signal };
      c.journal.append(this, 'exit-observed', this.exit); c.changed();
      this.settle().catch(error => this.unconfirmed(error));
    });
    this.child.once('close', () => { this.streamsClosed = true; this.emit('streams-closed'); });
    this.child.stdin.end(Buffer.from(this.invocation.input, 'base64'));
    this.timer = setTimeout(() => {
      c.stop(this.id, 'deadline').catch(error => this.unconfirmed(error));
    }, Math.max(1, this.deadline - performance.now()));
  }
  output(stream, bytes) {
    const available = Math.max(0, this.invocation.maxBuffer - this.stdout.length - this.stderr.length);
    const accepted = bytes.subarray(0, available);
    this[stream] = Buffer.concat([this[stream], accepted]);
    if (accepted.length) this.emit('output', stream, accepted);
    if (bytes.length > available && !this.stopRequested) {
      this.outputState = 'truncated';
      this.coordinator.stop(this.id, 'output-limit').catch(error => this.unconfirmed(error));
    }
    this.coordinator.changed();
  }
  async drain() {
    if (this.delegated) return;
    if (this.streamsClosed) return;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.removeListener('streams-closed', done); resolve(); };
      const timer = setTimeout(() => {
        if (this.outputState === 'complete') this.outputState = 'incomplete';
        this.child.stdout.destroy(); this.child.stderr.destroy(); done();
      }, this.coordinator.drainMs);
      this.once('streams-closed', done);
    });
  }
  async settle() {
    clearTimeout(this.timer);
    if (this.state === 'unconfirmed') return;
    await this.coordinator.stopChildren(this.id, 'parent-exited');
    await this.drain();
    if (this.coordinator.failFinalizeOnce) {
      this.coordinator.failFinalizeOnce = false;
      throw new ProtocolFailure('RECEIPT_PERSISTENCE_FAILED');
    }
    const children = [...this.coordinator.calls.values()].filter(c => c.parentId === this.id);
    if (children.some(child => !child.receipt)) throw new ProtocolFailure('CHILD_STOP_UNCONFIRMED');
    this.receipt = {
      scope: 'registered-executions', callId: this.id, session: this.coordinator.session,
      originBinding: this.coordinator.binding.value, exit: this.exit,
      children: children.map(c => ({ callId: c.id, digest: digest(c.receipt) })), outputState: this.outputState,
    };
    const event = this.coordinator.journal.append(this, 'result-finalized', this.receipt);
    this.receiptEventId = event.id; this.state = 'finished';
    this.resolveDone(this.result()); this.coordinator.changed();
  }
  result() {
    return { kind: this.exit?.kind ?? 'unconfirmed', code: this.exit?.code ?? null,
      signal: this.exit?.signal ?? null, stdout: this.stdout.toString('base64'), stderr: this.stderr.toString('base64'),
      outputState: this.outputState, receipt: this.receipt, state: this.state };
  }
  unconfirmed(error) {
    clearTimeout(this.timer); this.accepting = false; this.state = 'unconfirmed'; this.receipt = null;
    this.coordinator.journal.append(this, 'stop-unconfirmed', { code: error.code ?? 'UNKNOWN' });
    this.resolveDone(this.result()); this.coordinator.changed();
  }
}

class Coordinator {
  constructor(config) {
    this.root = config.root; this.session = crypto.randomUUID(); this.token = config.token;
    this.launchAtCaller = config.launchAtCaller !== false;
    this.traceDirectory = config.traceDirectory;
    this.binding = new OriginBinding(config.binding); this.calls = new Map(); this.bus = new EventEmitter();
    this.bus.setMaxListeners(100); this.accepting = true; this.controlAccepting = true; this.drainMs = config.drainMs ?? 100;
    this.snapshot = fs.readFileSync(config.clientPath); this.revision = crypto.createHash('sha256').update(this.snapshot).digest('hex');
    this.owner = new ExclusiveOwner(path.join(this.root, 'owner.lock'), this.session); this.owner.acquire();
    this.journal = new ExecutionJournal(this.root, this.binding, this.session);
    this.journal.append(null, 'coordinator-started');
    this.mailbox = path.join(this.root, 'mailbox'); fs.mkdirSync(this.mailbox, { recursive: true });
    this.snapshotFile = path.join(this.root, 'snapshot.mjs'); fs.writeFileSync(this.snapshotFile, this.snapshot);
    this.inflight = new Set();
  }
  context(parentCallId = null, token = this.token) {
    return { port: this.port, token, parentCallId, session: this.session, bindingDigest: digest(this.binding.value), revision: this.revision,
      transport: parentCallId === null ? 'tcp' : 'mailbox', mailbox: this.mailbox, snapshotFile: this.snapshotFile, launchAtCaller: this.launchAtCaller, traceDirectory: this.traceDirectory };
  }
  changed() { this.bus.emit('changed'); }
  authenticate(context) {
    if (context?.session !== this.session || context.bindingDigest !== digest(this.binding.value)) throw new ProtocolFailure('BINDING_REJECTED');
    if (context.parentCallId === null && context.token === this.token) return null;
    const parent = this.calls.get(context.parentCallId);
    if (!parent || context.token !== parent.grant) throw new ProtocolFailure('CAPABILITY_REJECTED');
    return parent;
  }
  assertRoot(parent) { if (parent !== null) throw new ProtocolFailure('CONTROL_AUTHORITY_REQUIRED'); }
  call(id) { const call = this.calls.get(id); if (!call) throw new ProtocolFailure('CALL_NOT_FOUND'); return call; }
  reserve(payload, parent, audit = 'flow', delegated = false) {
    const invocation = new CommandInvocation(payload);
    const known = this.calls.get(invocation.callId);
    if (known) {
      if (known.requestDigest !== digest(invocation) || known.parentId !== (parent?.id ?? null) || known.audit !== audit || Boolean(known.delegated) !== delegated) throw new ProtocolFailure('REQUEST_CONFLICT');
      return known;
    }
    if ((audit === 'flow' && !this.accepting) || (audit !== 'flow' && !this.controlAccepting) || (parent && !parent.accepting)) throw new ProtocolFailure('ADMISSION_CLOSED');
    const call = new RegisteredCall(this, invocation, parent?.id ?? null, audit);
    call.delegated = delegated;
    this.calls.set(call.id, call); call.start(); this.changed(); return call;
  }
  async stopChildren(parentId, reason, operation = new StopOperation(this.session, reason)) {
    for (const child of [...this.calls.values()].filter(c => c.parentId === parentId && !c.receipt && c.state !== 'unconfirmed')) await this.stop(child.id, reason, operation);
  }
  async stop(id, reason, operation = new StopOperation(this.session, reason)) {
    const call = this.call(id); call.accepting = false;
    if (call.receipt || call.state === 'unconfirmed') return call.result();
    if (call.stopPromise) return call.stopPromise;
    call.stopRequested = true;
    call.stopPromise = (async () => {
      let timer;
      this.journal.append(call, 'stop-requested', { ...operation, reason });
      const result = await Promise.race([(async () => {
        await this.stopChildren(id, reason, operation);
        if ([...this.calls.values()].some(child => child.parentId === id && !child.receipt)) {
          call.unconfirmed(new ProtocolFailure('CHILD_STOP_UNCONFIRMED')); return call.result();
        }
        if (!call.exit && call.state !== 'unconfirmed') {
          call.forceAuthorized = true;
          if (call.delegated) return call.done;
          this.journal.append(call, 'force-requested');
          if (this.failKillOnce) {
            this.failKillOnce = false;
            call.child.emit('error', Object.assign(new Error('Injected child_process kill failure'), { code: 'EACCES' }));
          } else call.child.kill('SIGKILL');
        }
        return call.done;
      })(), new Promise(resolve => {
        timer = setTimeout(() => { call.unconfirmed(new ProtocolFailure('STOP_DEADLINE_EXPIRED')); resolve(call.result()); }, operation.remaining());
      })]);
      clearTimeout(timer); return result;
    })();
    return call.stopPromise;
  }
  async until(predicate, timeoutMs = 10000) {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const changed = () => { if (predicate()) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new ProtocolFailure('OBSERVATION_TIMEOUT')); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.bus.removeListener('changed', changed); };
      this.bus.on('changed', changed); changed();
    });
  }
  async handle(context, operation, payload, socket) {
    if (operation.startsWith('executor-')) {
      const call = this.call(context.executorCallId);
      if (!call.delegated || context.session !== this.session || context.bindingDigest !== digest(this.binding.value)
        || context.token !== call.executorToken) throw new ProtocolFailure('EXECUTOR_AUTHORITY_REJECTED');
      if (operation === 'executor-claim') {
        if (call.receipt) return { result: call.result() };
        if (call.state === 'unconfirmed' || (call.executorInstance && call.executorInstance !== payload.instanceId)) throw new ProtocolFailure('EXECUTOR_ALREADY_CLAIMED');
        call.executorInstance = payload.instanceId;
        this.journal.append(call, 'executor-claimed', { instanceId: payload.instanceId });
        return { claimed: true };
      }
      if (operation === 'executor-control') return { stop: Boolean(call.forceAuthorized), session: this.session, deadline: call.deadline };
      if (operation === 'executor-started') {
        if (!call.executorInstance) throw new ProtocolFailure('EXECUTOR_CLAIM_REQUIRED');
        if (call.state !== 'launching') throw new ProtocolFailure('EXECUTOR_STATE_CONFLICT');
        call.started = true; call.state = 'running'; this.journal.append(call, 'started', { handleOwner: 'launch-site-executor' }); this.changed();
        return { recorded: true };
      }
      if (operation === 'executor-output') {
        if (!['stdout', 'stderr'].includes(payload.stream)) throw new ProtocolFailure('INVALID_OUTPUT_STREAM');
        call.output(payload.stream, Buffer.from(payload.data, 'base64')); return { recorded: true };
      }
      if (operation === 'executor-force-requested') { this.journal.append(call, 'force-requested', { handleOwner: 'launch-site-executor' }); return { recorded: true }; }
      if (operation === 'executor-unconfirmed') { call.unconfirmed(new ProtocolFailure(payload.code)); return { recorded: true }; }
      if (operation === 'executor-exit') {
        if (payload.observation.kind === 'spawn-failed' && call.started) throw new ProtocolFailure('INVALID_EXIT_OBSERVATION');
        call.accepting = false; call.exit = payload.observation; call.outputState = payload.outputState;
        this.journal.append(call, call.exit.kind === 'spawn-failed' ? 'spawn-failed' : 'exit-observed', call.exit); this.changed();
        await call.settle(); return call.result();
      }
      throw new ProtocolFailure('UNKNOWN_EXECUTOR_OPERATION');
    }
    const parent = this.authenticate(context);
    if (operation === 'snapshot') return { revision: this.revision, bytes: this.snapshot.toString('base64') };
    if (operation === 'start') {
      if (parent && this.launchAtCaller) throw new ProtocolFailure('LAUNCH_SITE_REQUIRED');
      return { callId: this.reserve(payload, parent).id };
    }
    if (operation === 'start-delegated') {
      const call = this.reserve(payload, parent, 'flow', true);
      return { callId: call.id, remainingMs: Math.max(0, call.deadline - performance.now()), childContext: this.context(call.id, call.grant), executorContext: {
        ...this.context(call.id, call.executorToken), executorCallId: call.id,
      } };
    }
    if (operation === 'wait') {
      const call = this.call(payload.callId);
      if (parent && call.parentId !== parent.id) throw new ProtocolFailure('CALL_AUTHORITY_REJECTED');
      const output = (type, bytes) => { if (!socket.destroyed) socket.write(JSON.stringify({ type, data: bytes.toString('base64') }) + '\n'); };
      output('stdout', call.stdout); output('stderr', call.stderr); call.on('output', output);
      try { return await call.done; } finally { call.removeListener('output', output); }
    }
    this.assertRoot(parent);
    if (operation === 'inspect') return { session: this.session, accepting: this.accepting, calls: [...this.calls.values()].map(c => c.view()), events: this.journal.events, activity: this.journal.activity() };
    if (operation === 'observe') {
      await this.until(() => {
        const calls = [...this.calls.values()];
        if (payload.minimumCalls && calls.length < payload.minimumCalls) return false;
        if (payload.stdoutIncludes && !calls.some(c => c.stdout.toString().includes(payload.stdoutIncludes))) return false;
        if (payload.callId && payload.state && this.call(payload.callId).state !== payload.state) return false;
        return true;
      }, payload.timeoutMs ?? 10000);
      return { calls: [...this.calls.values()].map(c => c.view()) };
    }
    if (operation === 'stop') return this.stop(payload.callId, 'requested');
    if (operation === 'fault') {
      if (payload.kind === 'kill-error') this.failKillOnce = true; else this.failFinalizeOnce = true;
      return { armed: true };
    }
    if (operation === 'maintenance') return { callId: this.reserve(payload, null, 'execution-only').id };
    if (operation === 'flush') return this.journal.flush();
    if (operation === 'finalize') {
      this.accepting = false;
      if ([...this.calls.values()].some(c => c.audit === 'flow' && !c.receipt)) throw new ProtocolFailure('EXECUTION_UNCONFIRMED');
      return this.journal.flush({ finalize: true });
    }
    if (operation === 'shutdown') {
      this.accepting = false; this.controlAccepting = false;
      const stop = new StopOperation(this.session, 'shutdown');
      for (const call of this.calls.values()) if (!call.receipt && call.state !== 'unconfirmed') await this.stop(call.id, 'shutdown', stop);
      if ([...this.calls.values()].some(c => !c.receipt)) throw new ProtocolFailure('EXECUTION_UNCONFIRMED');
      this.journal.append(null, 'coordinator-closed');
      this.owner.release();
      this.closed = true;
      socket.once('close', () => { clearInterval(this.mailboxTimer); this.server.close(); process.disconnect?.(); });
      return { closed: true };
    }
    throw new ProtocolFailure('UNKNOWN_OPERATION');
  }
  async listen() {
    this.server = net.createServer(socket => {
      let pending = Buffer.alloc(0); let dispatched = false;
      socket.on('error', error => { this.lastSocketError = error.code; });
      socket.on('data', chunk => {
        if (dispatched) return;
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > MAX_FRAME) { socket.destroy(); return; }
        const end = pending.indexOf(10); if (end < 0) return;
        dispatched = true;
        Promise.resolve().then(() => {
          const { context, operation, payload } = JSON.parse(pending.subarray(0, end));
          return this.handle(context, operation, payload, socket);
        }).then(value => { if (!socket.destroyed) socket.end(JSON.stringify({ type: 'result', value }) + '\n'); }, error => {
          if (!socket.destroyed) socket.end(JSON.stringify({ type: 'error', code: error.code ?? 'PROTOTYPE_FAILURE', message: error.message }) + '\n');
        });
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.port = this.server.address().port;
    this.mailboxTimer = setInterval(() => {
      for (const file of fs.readdirSync(this.mailbox).filter(file => /^[a-f0-9-]+\.request$/.test(file))) {
        if (this.inflight.has(file)) continue;
        this.inflight.add(file);
        const source = path.join(this.mailbox, file);
        const reply = new MailboxReply(source.replace(/\.request$/, '.response'));
        Promise.resolve().then(() => {
          const bytes = fs.readFileSync(source);
          if (bytes.length > MAX_FRAME) throw new ProtocolFailure('FRAME_TOO_LARGE');
          const { context, operation, payload } = JSON.parse(bytes);
          return this.handle(context, operation, payload, reply);
        }).then(value => reply.end(JSON.stringify({ type: 'result', value }) + '\n'), error => {
          reply.end(JSON.stringify({ type: 'error', code: error.code ?? 'PROTOTYPE_FAILURE', message: error.message }) + '\n');
        }).finally(() => { fs.unlinkSync(source); this.inflight.delete(file); });
      }
    }, 10);
    this.mailboxTimer.unref();
    return this.context();
  }
  async ownerLost() {
    if (this.closed) return;
    this.accepting = false; this.controlAccepting = false;
    this.journal.append(null, 'owner-disconnected');
    const operation = new StopOperation(this.session, 'owner-disconnected');
    for (const call of this.calls.values()) if (!call.receipt && call.state !== 'unconfirmed') await this.stop(call.id, operation.reason, operation);
    const confirmed = [...this.calls.values()].every(call => call.receipt);
    this.journal.append(null, 'owner-loss-settled', { confirmed });
    if (confirmed) this.owner.release();
    clearInterval(this.mailboxTimer);
    this.server.close();
  }
}

process.once('message', async config => {
  try {
    const coordinator = new Coordinator(config);
    const context = await coordinator.listen();
    process.once('disconnect', () => coordinator.ownerLost().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; }));
    process.send({ ready: true, context });
  } catch (error) { process.send({ ready: false, code: error.code, message: error.message }); process.disconnect(); }
});
