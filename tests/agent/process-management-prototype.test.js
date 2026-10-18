// Explicitly opt-in real provider evaluation for the isolated b900 prototype.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { PrototypeRuntime, bootstrap, fixture, readJournal } from '../support/infrastructure/process-management-prototype/harness.mjs';

const enabled = process.env.SENNEL_PROCESS_PROTOTYPE_AI === '1';
const evidenceRoot = process.env.SENNEL_PROCESS_PROTOTYPE_EVIDENCE;
const sandbox = process.env.SENNEL_PROCESS_PROTOTYPE_AI_SANDBOX ?? 'workspace-write';

function evidence(name, document) {
  if (!evidenceRoot) return;
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, name), JSON.stringify(document, null, 2) + '\n');
}

function providerArgs(root) {
  return ['exec', '--ephemeral', '--skip-git-repo-check', '--json', '--color', 'never', '--sandbox', sandbox, '-C', root, '-'];
}

test('prototype AI: actual agent uses inherited wrapper for write, read and registered nested command', {
  skip: enabled ? false : 'set SENNEL_PROCESS_PROTOTYPE_AI=1 for this real CLI experiment', timeout: 240000,
}, async t => {
  const r = await PrototypeRuntime.create({ trace: true });
  t.after(() => r.dispose());
  const nonce = 'AI_PROTOTYPE_' + crypto.randomUUID();
  const target = path.join(r.root, 'agent-created.txt');
  const prefix = [process.execPath, bootstrap, 'command', '--', process.execPath, fixture].map(v => JSON.stringify(v)).join(' ');
  const prompt = [
    'This is a small process-management experiment. Work only in the current directory.',
    'For EVERY external command, use the provided wrapper prefix exactly. Do not invoke bare node, shell commands, git, or any other tool command.',
    'The wrapper inherits execution context; do not print, unset, edit, or reconstruct its environment.',
    'Execute the following three commands as three separate tool calls, in order:',
    `${prefix} create-file ${JSON.stringify(target)} ${JSON.stringify(nonce)}`,
    `${prefix} read-file ${JSON.stringify(target)}`,
    `${prefix} ai-nested ${JSON.stringify(target)}`,
    'If any wrapper command fails, stop and report the failure. Do not fall back to direct execution.',
    'Check that the two reads agree with the written text, then return that text in your final answer. Do not edit code or run unrelated commands.',
  ].join('\n');
  const result = await r.execute('codex', providerArgs(r.root), { input: prompt, timeoutMs: 180000, maxBuffer: 3 * 1024 * 1024 });
  const stdout = Buffer.from(result.stdout, 'base64').toString();
  const stderr = Buffer.from(result.stderr, 'base64').toString();
  const snapshot = await r.request('inspect');
  const flushed = await r.request('flush');
  const calls = snapshot.calls.map(({ id, parentCallId, state, executable, args, receipt }) => ({ id, parentCallId, state, executable, args, hasReceipt: Boolean(receipt) }));
  const events = readJournal(r.root);
  const records = stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const toolCommands = records.filter(e => e.item?.type === 'command_execution').map(e => ({ type: e.type, command: e.item.command, exitCode: e.item.exit_code }));
  const document = { platform: process.platform, node: process.version, sandbox, providerExit: result.code,
    stdout, stderr, calls, toolCommands, activityCount: flushed.events.length, fileExists: fs.existsSync(target),
    fileText: fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null,
    originBinding: r.binding, eventBindings: events.filter(e => e.callId).map(e => e.originBinding),
    readOutputs: snapshot.calls.filter(c => c.args.includes('read-file') || c.args.includes('ai-nested')).map(c => ({ args: c.args, stdout: c.stdout, stderr: c.stderr, exit: c.exit })),
    launcherTrace: fs.readdirSync(r.traceDirectory).map(file => fs.readFileSync(path.join(r.traceDirectory, file), 'utf8')),
  };
  evidence(`ai-cooperation-${sandbox}.json`, document);
  assert.equal(result.code, 0, stderr);
  assert.equal(document.fileText, nonce, 'agent must create the requested artifact through the registered wrapper');
  assert.ok(calls.length >= 5, 'provider + three commands + nested read must all be registered');
  const provider = calls.find(c => c.parentCallId === null);
  const direct = calls.filter(c => c.parentCallId === provider.id);
  assert.equal(direct.length, 3);
  const nested = direct.find(c => c.args.includes('ai-nested'));
  assert.equal(calls.filter(c => c.parentCallId === nested.id).length, 1);
  const reads = snapshot.calls.filter(c => c.args.includes('read-file') || c.args.includes('ai-nested'));
  assert.equal(reads.length, 3);
  assert.ok(reads.every(c => Buffer.from(c.stdout, 'base64').toString() === nonce));
  const completed = toolCommands.filter(command => command.type === 'item.completed');
  assert.equal(completed.length, 3);
  assert.ok(completed.every(command => command.exitCode === 0 && command.command.includes(bootstrap)));
  assert.ok(calls.every(c => c.hasReceipt && c.state === 'finished'));
  assert.ok(document.eventBindings.every(binding => binding.runId === r.binding.runId && binding.attemptId === r.binding.attemptId));
  assert.ok(stdout.includes(nonce));
});

test('prototype AI: stop request terminates the agent and its wrapper-launched registered command', {
  skip: enabled ? false : 'set SENNEL_PROCESS_PROTOTYPE_AI=1 for this real CLI experiment', timeout: 240000,
}, async t => {
  const r = await PrototypeRuntime.create();
  t.after(() => r.dispose());
  const command = [process.execPath, bootstrap, 'command', '--', process.execPath, fixture, 'ready', 'AI_STOP_READY', '90000'].map(v => JSON.stringify(v)).join(' ');
  const prompt = `Process-management experiment. Run exactly this single command through your command tool, then wait for it: ${command}\nDo not use other commands. Do not remove inherited environment. If it fails, report that failure and stop.`;
  const spec = r.spec('codex', providerArgs(r.root), { input: prompt, timeoutMs: 180000, maxBuffer: 3 * 1024 * 1024 });
  await r.request('start', spec);
  try {
    await r.request('observe', { minimumCalls: 2, stdoutIncludes: 'ready:AI_STOP_READY', timeoutMs: 120000 }, { timeoutMs: 125000 });
  } catch (error) {
    const snapshot = await r.request('inspect');
    evidence(`ai-stop-${sandbox}.json`, { observationError: error.code, calls: snapshot.calls, platform: process.platform, sandbox });
    throw error;
  }
  const stopped = await r.request('stop', { callId: spec.callId });
  const snapshot = await r.request('inspect');
  evidence(`ai-stop-${sandbox}.json`, { platform: process.platform, node: process.version, sandbox, stopped,
    calls: snapshot.calls, activity: await r.request('flush') });
  assert.ok(stopped.receipt);
  assert.ok(snapshot.calls.length >= 2);
  assert.ok(snapshot.calls.every(c => c.receipt && !c.accepting));
  const exitOrder = snapshot.events.filter(e => e.kind === 'exit-observed').map(e => e.callId);
  assert.equal(exitOrder.at(-1), spec.callId);
});

test('prototype AI: wrapped target preserves the same network restriction as direct agent execution', {
  skip: enabled ? false : 'set SENNEL_PROCESS_PROTOTYPE_AI=1 for this real CLI experiment', timeout: 240000,
}, async t => {
  const central = process.env.SENNEL_PROCESS_PROTOTYPE_CENTRAL === '1';
  const r = await PrototypeRuntime.create({ launchAtCaller: !central });
  t.after(() => r.dispose());
  const bare = [process.execPath, fixture, 'probe-loopback', String(r.context.port)].map(v => JSON.stringify(v)).join(' ');
  const wrapped = [process.execPath, bootstrap, 'command', '--', process.execPath, fixture, 'probe-loopback', String(r.context.port)].map(v => JSON.stringify(v)).join(' ');
  const prompt = `Sandbox preservation experiment. Run exactly these two commands as two separate command-tool calls in order. The first command is intentionally a direct baseline probe; the second uses the managed wrapper. Do not change environment or permissions, do not request escalation, and do not run any other commands.\n1. ${bare}\n2. ${wrapped}\nBoth probes only test one local connection and report JSON. Report both JSON results.`;
  const result = await r.execute('codex', providerArgs(r.root), { input: prompt, timeoutMs: 180000, maxBuffer: 3 * 1024 * 1024 });
  const stdout = Buffer.from(result.stdout, 'base64').toString();
  const records = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const commands = records.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').map(e => e.item);
  const probes = commands.map(command => JSON.parse(command.aggregated_output.trim()));
  const snapshot = await r.request('inspect');
  evidence(`ai-sandbox-${central ? 'central' : 'launcher'}.json`, { platform: process.platform, node: process.version, sandbox,
    central, providerExit: result.code, commands, probes, stdout, calls: snapshot.calls });
  assert.equal(result.code, 0);
  assert.equal(commands.length, 2);
  assert.ok(commands.every(command => command.exit_code === 0));
  assert.equal(probes[0].connection, 'denied', 'direct baseline must demonstrate an actual network restriction');
  assert.deepEqual(probes[1], probes[0], 'wrapper must not widen the target execution permissions');
  const target = snapshot.calls.find(call => call.args.includes('probe-loopback'));
  assert.deepEqual(JSON.parse(Buffer.from(target.stdout, 'base64').toString()), probes[1]);
});
