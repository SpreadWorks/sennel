import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandLaunchDescriptor, CommandInvocation, NativeExecutableInvocation, NodeScriptInvocation, normalizeCommandInvocation } from '../../../src/lib/command-invocation.js';
import { runCmd } from '../../../src/lib/process.js';
import { resolveExecutableInvocation, WindowsBatchInvocation } from '../../../src/lib/executable-resolution.js';
import { onHook } from '../../../src/lib/hooks.js';
import { validate, loadConfig } from '../../../src/lib/config.js';
import { discoverRegressionCommand, runProcessDetailed, commandIdentityFor, ParsedCommand, ChildProcessExecutionRecord } from '../../../src/flow/lib/test-regression.js';
import { ProcessExecutionRuntime, ProcessExecutionStopReceipt } from '../../../src/lib/process-execution-runtime.js';
import { createTmpDir, removeTmpDir } from '../../support/builders/tmp-dir.js';
import { testTemporaryRoot } from '../../test-environment.js';
import { sanitizeGitRepositoryEnvironment, GitOwnedStagePolicy } from '../../../src/lib/git-repository-environment.js';

test('stored Node invocation preserves literal argv, cwd, environment and stdout after disk readback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-invocation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'child with spaces.cjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.LITERAL}))');
  const args = ['', 'a b', '$HOME', '"quoted"', 'x&y', '日本語', 'C:\\path\\last\\'];
  const invocation = new NodeScriptInvocation({ script, args, cwd: root, env: { ...process.env, LITERAL: '$unchanged;value' } });
  const record = path.join(root, 'command.json');
  fs.writeFileSync(record, JSON.stringify(invocation));
  const restored = CommandInvocation.fromStored(JSON.parse(fs.readFileSync(record, 'utf8')));
  assert.ok(restored instanceof NodeScriptInvocation);
  assert.ok(Object.isFrozen(restored.args));
  const result = runCmd(restored, []);
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args, cwd: root, value: '$unchanged;value' });
});

test('configured command survives disk readback, target append and actual registered execution', async (t) => {
  const root = createTmpDir('sennel-command-config-');
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw error; }
    removeTmpDir(root);
  });
  const cwd = path.join(root, 'selected cwd');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(root, '.sennel'));
  const script = path.join(cwd, 'test script.cjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.LITERAL}));process.stderr.write("configured stderr")');
  const stored = { kind: 'node-script', script, nodeArgs: ['--no-warnings'], args: ['a b', ''], cwd,
    env: { LITERAL: '$value' }, stdio: ['ignore', 'pipe', 'pipe'] };
  const base = { lang: 'ja', type: 'base', docs: { languages: ['ja'], defaultLanguage: 'ja' } };
  fs.writeFileSync(path.join(root, '.sennel', 'config.json'), JSON.stringify({ ...base, test: { command: stored } }));
  const config = loadConfig(root);
  const command = discoverRegressionCommand(root, config).withTargets(['test path.js']);
  assert.ok(command.invocation instanceof NodeScriptInvocation);
  assert.deepEqual(command.invocation.scriptArgs, ['a b', '', 'test path.js']);
  assert.equal(command.invocation.env.LITERAL, '$value');
  assert.throws(() => validate({ ...base, test: { command: 'node test.js' } }), /シェル文字列/);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {} });
  const result = await runtime.enter(() => runProcessDetailed(command, { cwd: root, timeoutMs: 30000 }));
  assert.equal(result.kind, 'passed', result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['a b', '', 'test path.js'], cwd: fs.realpathSync(cwd), value: '$value' });
  assert.equal(result.stderr, 'configured stderr');
  const resultFile = path.join(root, 'execution-result.json');
  fs.writeFileSync(resultFile, JSON.stringify(result));
  const restoredResult = ChildProcessExecutionRecord.fromJSON(JSON.parse(fs.readFileSync(resultFile, 'utf8')));
  assert.deepEqual(restoredResult.command, [process.execPath, '--no-warnings', script, 'a b', '', 'test path.js']);
  assert.equal(restoredResult.kind, 'passed');
  assert.equal(restoredResult.stdout.content, result.stdout);
  await runtime.close();
  const call = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions.at(-1).calls[0];
  const actual = CommandInvocation.fromStored(call.invocation.actualCommand);
  const launch = CommandLaunchDescriptor.fromStored(call.invocation.launch);
  assert.ok(actual instanceof NodeScriptInvocation);
  assert.equal(actual.script, script);
  assert.deepEqual(actual.nodeArgs, ['--no-warnings']);
  assert.deepEqual(actual.scriptArgs, ['a b', '', 'test path.js']);
  assert.equal(actual.env.LITERAL, '$value');
  assert.equal(actual.cwd, cwd);
  assert.deepEqual(actual.stdio, stored.stdio);
  assert.equal(launch.executable, process.execPath);
  assert.deepEqual(launch.args, actual.args);
  assert.equal(launch.cwd, cwd);
  assert.equal(launch.env.LITERAL, '$value');
  assert.deepEqual(launch.stdio, stored.stdio);
  assert.equal(new ProcessExecutionStopReceipt(call.receipt).stopEvidence.confirmed, true);
});

test('regression identity distinguishes complete configured invocation semantics after readback', () => {
  const invocation = new NodeScriptInvocation({ script: 'tests/run.js', args: ['literal'], cwd: '/configured', env: { FIRST: '1', SECOND: '2' } });
  const identity = (value) => commandIdentityFor(new ParsedCommand({ invocation: CommandInvocation.fromStored(value), source: 'test.command' })).toJSON();
  const stored = JSON.parse(JSON.stringify(invocation));
  const baseline = identity(stored);
  assert.match(baseline.resolvedConfigDigest, /^[a-f0-9]{64}$/);
  assert.equal(identity({ ...stored, env: { SECOND: '2', FIRST: '1' } }).resolvedConfigDigest, baseline.resolvedConfigDigest);
  const alternatives = [
    { ...stored, cwd: '/different' },
    { ...stored, stdio: ['ignore', 'pipe', 'pipe'] },
    { ...stored, env: { FIRST: 'changed', SECOND: '2' } },
    { ...stored, args: ['different'] },
    new NativeExecutableInvocation({ executable: process.execPath, args: invocation.args, cwd: stored.cwd, env: stored.env }).toJSON(),
  ];
  for (const alternative of alternatives) assert.notEqual(identity(alternative).resolvedConfigDigest, baseline.resolvedConfigDigest);
});

test('invocation rejects shell legacy, unknown codec fields, mutable overrides and ambiguous environment names', () => {
  for (const stored of ['node test.js', { kind: 'native', executable: 'node', args: [], shell: true }]) {
    assert.throws(() => CommandInvocation.fromStored(stored), { code: 'COMMAND_INVOCATION_INVALID' });
  }
  const invocation = new NativeExecutableInvocation({ executable: 'git', args: ['status'] });
  assert.throws(() => normalizeCommandInvocation(invocation, [], { env: {} }), { code: 'COMMAND_INVOCATION_INVALID' });
  assert.throws(() => sanitizeGitRepositoryEnvironment({ PATH: 'a', Path: 'b' }), { code: 'COMMAND_INVOCATION_INVALID' });
  const clean = sanitizeGitRepositoryEnvironment({ git_dir: 'evil', Git_Config_Count: '1', git_config_key_0: 'core.worktree', PATH: 'safe' });
  assert.equal(clean.git_dir, undefined);
  assert.equal(clean.Git_Config_Count, undefined);
  assert.equal(clean.git_config_key_0, undefined);
  const policy = new GitOwnedStagePolicy({ repositoryRoot: process.cwd(), indexFile: path.resolve('owned-index') });
  assert.equal(policy.environment({ git_index_file: 'evil' }).GIT_INDEX_FILE, path.resolve('owned-index'));
});

test('restoration isolates system attributes without altering ordinary archive policy', () => {
  const restore = new GitOwnedStagePolicy({ repositoryRoot: process.cwd(),
    attributesFile: path.resolve('owned-attributes'), restore: true });
  const archive = new GitOwnedStagePolicy({ repositoryRoot: process.cwd(), attributesFile: path.resolve('archive-attributes') });
  assert.equal(restore.environment({ git_attr_nosystem: '0' }).GIT_ATTR_NOSYSTEM, '1');
  assert.equal(restore.environment({}).GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(archive.environment({ GIT_ATTR_NOSYSTEM: '1' }).GIT_ATTR_NOSYSTEM, undefined);
  assert.deepEqual(archive.arguments(['archive', 'HEAD']), ['-c', `core.attributesFile=${path.resolve('archive-attributes')}`, 'archive', 'HEAD']);
});


test('configured hook expands placeholders inside literal argv and returns captured child output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-hook-invocation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'hook.cjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  fs.mkdirSync(path.join(root, '.sennel'));
  fs.writeFileSync(path.join(root, '.sennel', 'config.json'), JSON.stringify({
    lang: 'en', type: 'base', docs: { languages: ['en'], defaultLanguage: 'en' },
    flow: { hooks: { PostWorktree: new NodeScriptInvocation({ script, args: ['{{CWD}}', '$HOME;echo injected', ''] }) } },
  }));
  const result = await onHook('PostWorktree', { CWD: root });
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(JSON.parse(result.output), [root, '$HOME;echo injected', '']);
});


test('Windows installed npm shim resolves its declared Node entry without changing literal provider flags', (t) => {
  const shim = String.raw`C:\tools\provider.cmd`;
  const script = String.raw`C:\tools\node_modules\provider\cli.js`;
  t.mock.method(fs, 'existsSync', (candidate) => candidate === shim || candidate === script);
  t.mock.method(fs, 'readFileSync', (candidate) => {
    assert.equal(candidate, shim);
    // npm/cmd-shim's generated no-extra-args Node template (lib/index.js).
    return String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\node_modules\provider\cli.js" %*
`;
  });
  const args = ['--json', 'literal & value', '', '"quoted"'];
  const command = new NativeExecutableInvocation({ executable: 'provider', args, cwd: String.raw`C:\work`, env: { Path: String.raw`C:\tools` } });
  const resolved = resolveExecutableInvocation(command, { platform: 'win32' });
  assert.ok(resolved instanceof NodeScriptInvocation);
  assert.equal(resolved.script, script);
  assert.deepEqual(resolved.scriptArgs, args);
  assert.deepEqual(resolved.env, command.env);
});


test('Windows batch adapter preserves the stored literal invocation and disables interpreter auto-run and delayed expansion', (t) => {
  const batch = String.raw`C:\tools\custom.cmd`;
  t.mock.method(fs, 'existsSync', (candidate) => candidate === batch);
  t.mock.method(fs, 'readFileSync', () => '@echo off\r\necho %*\r\n');
  const original = new NativeExecutableInvocation({ executable: 'custom', args: ['', 'a b', '%PATH%', '!value!', 'x&y', '"quoted"', '日本語'],
    cwd: String.raw`C:\work`, env: { Path: String.raw`C:\tools`, LITERAL: '$value' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const adapted = resolveExecutableInvocation(original, { platform: 'win32', environment: { ComSpec: String.raw`C:\Windows\System32\cmd.exe` } });
  assert.ok(adapted instanceof WindowsBatchInvocation);
  assert.equal(adapted.executable, String.raw`C:\Windows\System32\cmd.exe`);
  assert.deepEqual(adapted.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.equal(adapted.processOptions().windowsVerbatimArguments, true);
  assert.deepEqual(adapted.toJSON(), original.toJSON());
  const launch = CommandLaunchDescriptor.fromStored(JSON.parse(JSON.stringify(adapted.resolvedLaunch())));
  assert.equal(launch.executable, adapted.executable);
  assert.deepEqual(launch.args, adapted.args);
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.deepEqual(launch.env, original.env);
  assert.deepEqual(launch.stdio, original.stdio);
  assert.ok(Object.isFrozen(launch.args));
  assert.throws(() => CommandLaunchDescriptor.fromStored({ ...launch.toJSON(), kind: 'native' }), { code: 'COMMAND_INVOCATION_INVALID' });
  assert.deepEqual(adapted.env, original.env);
  assert.deepEqual(adapted.stdio, original.stdio);
  assert.ok(CommandInvocation.fromStored(adapted.toJSON()) instanceof NativeExecutableInvocation);
});

test('Windows batch execution retains real literal argv, stdin and normal status', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-batch-invocation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.cjs');
  const batch = path.join(root, 'wrapper.cmd');
  fs.writeFileSync(target, "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input}));process.stderr.write('diagnostic');process.exitCode=7;});");
  fs.writeFileSync(batch, `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`);
  const args = ['', 'a b', '%PATH%', '!value!', 'x&y', '"quoted"', '日本語', 'C:\\trailing\\'];
  const result = runCmd(new NativeExecutableInvocation({ executable: batch, args, cwd: root }), [], { input: 'stdin bytes' });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args, input: 'stdin bytes' });
  assert.equal(result.stderr, 'diagnostic');
});
