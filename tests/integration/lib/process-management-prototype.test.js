// Feasibility evidence for b900. These exercise the prototype, not production Flow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PrototypeRuntime, bootstrap, fixture, directory, readJournal } from '../../support/infrastructure/process-management-prototype/harness.mjs';
import { CONTEXT_ENV, request } from '../../support/infrastructure/process-management-prototype/client.mjs';

async function runtime(t, options) {
  const result = await PrototypeRuntime.create(options);
  t.after(() => result.dispose());
  return result;
}

function waitForFile(file) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(file)) return resolve(fs.readFileSync(file, 'utf8'));
    const watcher = fs.watch(path.dirname(file), () => {
      if (fs.existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(fs.readFileSync(file, 'utf8')); }
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Fixture file was not produced')); }, 8000);
    if (fs.existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(fs.readFileSync(file, 'utf8')); }
  });
}

test('prototype: bytes, stdin, env, cwd and both streams survive independent execution', { timeout: 15000 }, async t => {
  const r = await runtime(t);
  const cwd = path.join(r.root, 'space 日本語'); fs.mkdirSync(cwd);
  const bytes = Buffer.from([0, 255, 10, 13, 65]);
  const output = [];
  const result = await r.runNode([fixture, 'echo'], { cwd, input: bytes, environment: { PROTOTYPE_VALUE: 'quoted " value' }, onOutput: (type, bytes) => output.push([type, bytes]) });
  assert.deepEqual(Buffer.from(result.stdout, 'base64'), bytes);
  assert.equal(Buffer.from(result.stderr, 'base64').toString(), 'quoted " value');
  assert.equal(result.receipt.scope, 'registered-executions');
  assert.equal((await r.request('inspect')).calls[0].cwd, cwd);
  assert.ok(output.some(([stream, bytes]) => stream === 'stdout' && bytes.length === 5));
  const saved = readJournal(r.root).find(e => e.kind === 'result-finalized');
  assert.deepEqual(saved.data, result.receipt);
});

test('prototype: stale binding and invalid invocation are refused before any call is reserved', async t => {
  const r = await runtime(t);
  await assert.rejects(request({ ...r.context, bindingDigest: 'wrong' }, 'start', r.spec(process.execPath, [])), { code: 'BINDING_REJECTED' });
  await assert.rejects(r.request('start', r.spec(process.execPath, [1])), { code: 'INVALID_INVOCATION' });
  assert.equal((await r.request('inspect')).calls.length, 0);
});

test('prototype: normal nonzero exit and spawn failure are distinct recorded outcomes', async t => {
  const r = await runtime(t);
  const exit = await r.runNode(['-e', 'process.exitCode=7']);
  assert.equal(exit.code, 7); assert.equal(exit.kind, 'exited');
  const missing = await r.execute(path.join(r.root, 'missing-executable'), []);
  assert.equal(missing.kind, 'spawn-failed'); assert.equal(missing.code, 'ENOENT');
  assert.ok(missing.receipt);
});

test('prototype: lost start acknowledgement replays one call and conflicting replay refuses', async t => {
  const r = await runtime(t);
  const file = path.join(r.root, 'count');
  const spec = r.spec(process.execPath, ['-e', `require('fs').appendFileSync(${JSON.stringify(file)},'x')`]);
  const socket = net.createConnection({ host: '127.0.0.1', port: r.context.port });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => socket.end(JSON.stringify({ context: r.context, operation: 'start', payload: spec }) + '\n', resolve));
  });
  await r.request('observe', { minimumCalls: 1 });
  socket.destroy();
  await r.request('start', spec);
  const result = await r.request('wait', { callId: spec.callId });
  assert.equal(result.code, 0); assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  await assert.rejects(r.request('start', { ...spec, args: ['-e', 'process.exit(9)'] }), { code: 'REQUEST_CONFLICT' });
  assert.equal(readJournal(r.root).filter(e => e.kind === 'start-intent').length, 1);
});

test('prototype: registered child and grandchild settle before their logical parent', { timeout: 15000 }, async t => {
  const r = await runtime(t);
  const id = await r.startNode([fixture, 'nested', '1']);
  await r.request('observe', { minimumCalls: 3, stdoutIncludes: 'ready:leaf' });
  const result = await r.request('stop', { callId: id });
  assert.ok(result.receipt);
  const snapshot = await r.request('inspect');
  assert.equal(snapshot.calls.length, 3);
  assert.ok(snapshot.calls.every(c => c.receipt && !c.accepting));
  const root = snapshot.calls.find(c => c.id === id);
  const child = snapshot.calls.find(c => c.parentCallId === root.id);
  const leaf = snapshot.calls.find(c => c.parentCallId === child.id);
  const exits = snapshot.events.filter(e => e.kind === 'exit-observed').map(e => e.callId);
  assert.ok(exits.indexOf(leaf.id) < exits.indexOf(child.id));
  assert.ok(exits.indexOf(child.id) < exits.indexOf(root.id));
  assert.deepEqual(root.receipt.children.map(c => c.callId), [child.id]);
  const requests = snapshot.events.filter(e => e.kind === 'stop-requested');
  assert.equal(new Set(requests.map(e => e.data.id)).size, 1, 'one subtree shares one stop operation');
  assert.equal(new Set(requests.map(e => e.data.deadline)).size, 1, 'child depth cannot reset the deadline');
});

test('prototype: wrapper request inherited by an unregistered child is refused after parent exit', async t => {
  const r = await runtime(t);
  const file = path.join(r.root, 'late-result');
  await r.runNode([fixture, 'create-late-child', file]);
  assert.equal(await waitForFile(file), 'ADMISSION_CLOSED');
  assert.equal((await r.request('inspect')).calls.length, 1);
});

test('prototype: direct exit has a finite drain when an unmanaged descendant holds its pipe', async t => {
  const r = await runtime(t);
  const file = path.join(r.root, 'unmanaged-finished');
  const result = await r.runNode([fixture, 'unregistered-pipe', file]);
  assert.equal(result.code, 0); assert.equal(result.outputState, 'incomplete');
  assert.equal(fs.existsSync(file), false, 'receipt cannot claim the unmanaged child exited');
  assert.equal(result.receipt.children.length, 0);
  assert.equal(await waitForFile(file), 'finished');
});

test('prototype: synchronous bridge completes while Activity lock is held, then events flush once', async t => {
  const r = await runtime(t);
  const lock = path.join(r.root, 'activity.lock'); fs.writeFileSync(lock, 'owned-by-fixture', { flag: 'wx' });
  const result = r.runSync(process.execPath, ['-e', 'process.stdout.write("sync-ok")']);
  assert.equal(Buffer.from(result.stdout, 'base64').toString(), 'sync-ok');
  await assert.rejects(r.request('flush'), { code: 'ACTIVITY_BUSY' });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'owned-by-fixture');
  fs.unlinkSync(lock);
  const first = await r.request('flush'); const again = await r.request('flush');
  assert.ok(first.events.length >= 3); assert.deepEqual(again, first);
  assert.equal(new Set(first.events.map(e => e.id)).size, first.events.length);
  assert.ok(first.events.every(e => e.originBinding.attemptId === 'attempt-1'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.root, 'activity.json'))), first);
});

test('prototype: persistent worker preserves synchronous bytes and completion without a process per call', async t => {
  const r = await runtime(t);
  for (const value of ['first', 'second']) {
    const result = r.runSyncWorker(process.execPath, [fixture, 'echo'], { input: value });
    assert.equal(Buffer.from(result.stdout, 'base64').toString(), value);
    assert.ok(result.receipt);
  }
  assert.equal((await r.request('inspect')).calls.length, 2);
});

test('prototype: missing receipt remains unconfirmed after a real exit and blocks owner release', async t => {
  const r = await runtime(t);
  await r.request('fault');
  await assert.rejects(r.runNode(['-e', 'process.stdout.write("done")']), { code: 'EXECUTION_UNCONFIRMED' });
  const snapshot = await r.request('inspect');
  assert.equal(snapshot.calls[0].state, 'unconfirmed'); assert.equal(snapshot.calls[0].receipt, null);
  assert.ok(snapshot.events.some(e => e.kind === 'exit-observed'));
  assert.equal(snapshot.events.some(e => e.kind === 'result-finalized'), false);
  await assert.rejects(r.request('shutdown'), { code: 'EXECUTION_UNCONFIRMED' });
  assert.equal(fs.existsSync(path.join(r.root, 'owner.lock')), true);
});

test('prototype: coordinator crash leaves unknown ownership and never reclaims from a PID', async t => {
  const r = await runtime(t);
  const file = path.join(r.root, 'bounded-child-finished');
  const id = await r.startNode([fixture, 'ready', 'bounded', '700', file]);
  await r.request('observe', { stdoutIncludes: 'ready:bounded' });
  r.child.kill('SIGKILL'); await r.exited;
  const events = readJournal(r.root).filter(e => e.callId === id);
  assert.ok(events.some(e => e.kind === 'started'));
  assert.equal(events.some(e => e.kind === 'result-finalized'), false);
  await assert.rejects(PrototypeRuntime.create({ root: r.root }), { code: 'OWNER_UNCONFIRMED' });
  assert.equal(await waitForFile(file), 'finished');
  assert.equal(fs.existsSync(path.join(r.root, 'owner.lock')), true);
});

test('prototype: real owner IPC loss fences admission and stops a live registered child', async t => {
  const r = await runtime(t);
  const id = await r.startNode([fixture, 'ready', 'owner-loss']);
  await r.request('observe', { stdoutIncludes: 'ready:owner-loss' });
  r.child.disconnect(); await r.exited;
  const events = readJournal(r.root);
  assert.ok(events.some(e => e.kind === 'owner-disconnected'));
  assert.ok(events.some(e => e.callId === id && e.kind === 'result-finalized'));
  assert.equal(events.find(e => e.kind === 'owner-loss-settled').data.confirmed, true);
  assert.equal(fs.existsSync(path.join(r.root, 'owner.lock')), false);
});

test('prototype: an error on a running child cannot become a spawn-failed receipt', async t => {
  const r = await runtime(t);
  const file = path.join(r.root, 'failed-kill-child-finished');
  const id = await r.startNode([fixture, 'ready', 'kill-error', '650', file]);
  await r.request('observe', { stdoutIncludes: 'ready:kill-error' });
  await r.request('fault', { kind: 'kill-error' });
  const result = await r.request('stop', { callId: id });
  assert.equal(result.state, 'unconfirmed'); assert.equal(result.receipt, null);
  const snapshot = await r.request('inspect');
  assert.equal(snapshot.events.some(e => e.kind === 'spawn-failed'), false);
  assert.equal(snapshot.events.some(e => e.kind === 'result-finalized'), false);
  assert.equal(await waitForFile(file), 'finished');
});

test('prototype: a fresh coordinator projects durable pending events once after clean ownership transfer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-replay-'));
  let first, second;
  t.after(async () => { await second?.dispose(); await first?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  first = await PrototypeRuntime.create({ root });
  await first.runNode(['-e', 'process.stdout.write("before-restart")']);
  const expected = readJournal(root).filter(event => event.audit === 'flow');
  assert.equal(fs.existsSync(path.join(root, 'activity.json')), false);
  await first.request('shutdown'); await first.exited;
  second = await PrototypeRuntime.create({ root, binding: first.binding });
  const projected = await second.request('flush');
  assert.deepEqual(projected.events, expected);
  assert.deepEqual(await second.request('flush'), projected);
});

test('prototype: deadlines survive request replay and coordinator stops the actual child', async t => {
  const r = await runtime(t);
  const spec = r.spec(process.execPath, [fixture, 'ready', 'deadline'], { timeoutMs: 350 });
  await r.request('start', spec);
  const before = (await r.request('inspect')).calls[0].deadline;
  await r.request('start', spec);
  assert.equal((await r.request('inspect')).calls[0].deadline, before);
  const result = await r.request('wait', { callId: spec.callId });
  assert.ok(result.receipt);
  assert.ok((await r.request('inspect')).events.some(e => e.kind === 'stop-requested' && e.data.reason === 'deadline'));
});

test('prototype: wrapper uses captured implementation after disk edit and refuses wrong revision', async t => {
  const rootRuntime = await runtime(t);
  const copied = path.join(rootRuntime.root, 'captured-client.mjs');
  fs.copyFileSync(path.join(directory, 'client.mjs'), copied);
  const r = await runtime(t, { clientPath: copied });
  fs.writeFileSync(copied, 'throw new Error("disk edit must not execute");');
  const result = r.runSync(process.execPath, ['-e', 'process.stdout.write("fixed")']);
  assert.equal(Buffer.from(result.stdout, 'base64').toString(), 'fixed');
  const before = (await r.request('inspect')).calls.length;
  const rejected = spawnSync(process.execPath, [bootstrap, 'command', '--', process.execPath, '-e', 'process.exit(0)'], {
    env: { ...process.env, NODE_OPTIONS: '', [CONTEXT_ENV]: JSON.stringify({ ...r.context, revision: crypto.randomUUID() }) }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(rejected.status, 125); assert.match(rejected.stderr, /SNAPSHOT_REVISION_MISMATCH/);
  assert.equal((await r.request('inspect')).calls.length, before);
});

test('prototype: output limit stops the command and records truncation independently', async t => {
  const r = await runtime(t);
  const result = await r.runNode(['-e', 'process.stdout.write("x".repeat(100000));setTimeout(()=>{},10000)'], { maxBuffer: 1024 });
  assert.equal(Buffer.from(result.stdout, 'base64').length, 1024);
  assert.equal(result.outputState, 'truncated'); assert.ok(result.receipt);
});

test('prototype: finalization cutoff excludes writer maintenance and forbids business admission', async t => {
  const r = await runtime(t);
  await r.runNode(['-e', 'process.stdout.write("business")']);
  const final = await r.request('finalize'); assert.equal(final.lifecycle, 'finalized');
  await assert.rejects(r.runNode(['-e', 'process.exit(0)']), { code: 'ADMISSION_CLOSED' });
  const spec = r.spec(process.execPath, [fixture, 'probe-control']);
  await r.request('maintenance', spec);
  const result = await r.request('wait', { callId: spec.callId });
  assert.equal(Buffer.from(result.stdout, 'base64').toString(), 'CONTROL_AUTHORITY_REQUIRED');
  assert.deepEqual(await r.request('flush'), final);
  const snapshot = await r.request('inspect');
  assert.ok(snapshot.events.some(e => e.callId === spec.callId && e.audit === 'execution-only'));
  assert.equal(final.events.some(e => e.callId === spec.callId), false);
});

test('prototype: delegated result replay and concurrent claims never launch a command twice', async t => {
  const r = await runtime(t);
  const once = path.join(r.root, 'once');
  const replay = await r.runNode([fixture, 'delegate-replay', once]);
  const receipts = JSON.parse(Buffer.from(replay.stdout, 'base64'));
  assert.deepEqual(receipts.first, receipts.second);
  assert.equal(fs.readFileSync(once, 'utf8'), 'x');
  const raceFile = path.join(r.root, 'race');
  const race = await r.runNode([fixture, 'delegate-race', raceFile]);
  const outcomes = JSON.parse(Buffer.from(race.stdout, 'base64'));
  assert.deepEqual(outcomes.sort(), ['EXECUTOR_ALREADY_CLAIMED', 'finished'].sort());
  assert.equal(fs.readFileSync(raceFile, 'utf8'), 'x');
});

test('prototype: external execution grants cannot request central respawn and local output preserves bytes', async t => {
  const r = await runtime(t);
  const probe = await r.runNode([fixture, 'probe-central']);
  assert.equal(Buffer.from(probe.stdout, 'base64').toString(), 'LAUNCH_SITE_REQUIRED');
  assert.equal((await r.request('inspect')).calls.length, 1);
  const bytes = Buffer.from([0, 255, 13, 10]);
  const echoed = await r.runNode([fixture, 'delegate-echo', bytes.toString('base64')]);
  const value = JSON.parse(Buffer.from(echoed.stdout, 'base64'));
  assert.deepEqual(Buffer.from(value.stdout, 'base64'), bytes);
  assert.equal(Buffer.from(value.stderr, 'base64').toString(), 'local-stderr');
});
