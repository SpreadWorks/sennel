import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreCommandRegistry } from '../../../src/lib/command-registry.js';
import { CliInvocationPolicy } from '../../../src/lib/cli-invocation-policy.js';
import { NodeScriptInvocation } from '../../../src/lib/command-invocation.js';
import { runCmd } from '../../../src/lib/process.js';
import { ProcessExecutionRuntime } from '../../../src/lib/process-execution-runtime.js';
import { FlowTargetBinding } from '../../../src/lib/flow-target-guard.js';
import { testTemporaryRoot } from '../../test-environment.js';
import { CanonicalFlowFixture, makeFlowManager } from '../../support/infrastructure/flow-setup.js';
import { CanonicalPersistenceSnapshot, StoredFlowPersistenceSnapshot } from '../../support/assertions/canonical-persistence.js';
import { removeQuiescentRuntimeFixture } from '../../support/infrastructure/runtime-fixture-cleanup.js';

test('inspection storage requires trusted route metadata and a declared option position', () => {
  for (const argv of [['upgrade', '--dry-run'], ['migrate', 'specs', '--to', '4', '--dry-run'], ...['build', 'enrich', 'data', 'readme', 'translate', 'agents', 'changelog'].map((name) => ['docs', name, '--dry-run']), ['help'], ['check', 'freshness'], ['flow', 'get', 'status'], ['flow', 'query'], ['docs', 'forge', '--prompt', 'draft', '--dry-run']]) {
    assert.equal(new CliInvocationPolicy(coreCommandRegistry, argv).readOnly, true, JSON.stringify(argv));
  }
  for (const argv of [['unknown-plugin', '--dry-run'], ['docs', 'unknown', '--help'], ['docs', 'forge', '--prompt', '--dry-run'], ['docs', 'forge', '--unknown', '--dry-run'], ['flow', 'set', 'request', '--dry-run'], ['command', '--', 'tool', '--help']]) {
    assert.equal(new CliInvocationPolicy(coreCommandRegistry, argv).readOnly, false, JSON.stringify(argv));
  }
});

test('only trusted core migration metadata bypasses ordinary runtime initialization', () => {
  for (const argv of [['migrate', 'layout', '--to', '1'], ['migrate', 'specs', '--to', '5', '--dry-run']]) {
    assert.equal(new CliInvocationPolicy(coreCommandRegistry, argv).migration, true);
  }
  for (const argv of [['unknown-plugin', 'migrate'], ['docs', 'build', '--dry-run'], ['command', '--', 'migrate']]) {
    assert.equal(new CliInvocationPolicy(coreCommandRegistry, argv).migration, false);
  }
});

test('context metric writes use normal storage while pure Flow queries and context help use inspection storage', () => {
  for (const argv of [['flow', 'get', 'context'], ['flow', 'get', 'context', 'docs/context.md', '--raw']]) {
    assert.equal(new CliInvocationPolicy(coreCommandRegistry, argv).readOnly, false, JSON.stringify(argv));
  }
  for (const argv of [['flow', 'get', 'status'], ['flow', 'get', 'next-action'], ['flow', 'get', 'context', '--help']]) {
    assert.equal(new CliInvocationPolicy(coreCommandRegistry, argv).readOnly, true, JSON.stringify(argv));
  }
});

function tree(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) { files.push([relative, 'directory']); visit(absolute); }
      else files.push([relative, fs.readFileSync(absolute, 'base64')]);
    }
  };
  visit(root);
  return files;
}

test('public inspection and declared dry-run with enabled logging leave the selected project byte-for-byte unchanged', (t) => {
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-inspect-cli-'));
  t.after(() => fs.rmSync(executionRoot, { recursive: true, force: true }));
  const project = path.join(executionRoot, 'project');
  fs.mkdirSync(path.join(project, '.sennel'), { recursive: true });
  fs.writeFileSync(path.join(project, '.sennel', 'config.json'), JSON.stringify({ lang: 'en', type: 'base', docs: { languages: ['en'], defaultLanguage: 'en' }, logs: { enabled: true } }));
  const before = tree(project);
  for (const args of [['help', 'command'], ['docs', 'forge', '--prompt', 'inspect only', '--dry-run'], ['docs', 'init', '--dry-run'], ['upgrade', '--dry-run'], ['migrate', 'layout', '--to', '1', '--dry-run']]) {
    const invocation = new NodeScriptInvocation({ script: fileURLToPath(new URL('../../../src/sennel.js', import.meta.url)),
      args, cwd: executionRoot,
      env: { ...process.env, SENNEL_WORK_ROOT: project, SENNEL_SOURCE_ROOT: project } });
    const result = runCmd(invocation, [], { repositoryRoot: executionRoot, timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    if (args[0] === 'help') assert.match(result.stdout, /sennel command --/);
    else if (args[1] === 'forge') assert.match(result.stdout, /dry-run/);
    assert.deepEqual(tree(project), before);
  }
});

/** Public CLI fixtures keep launcher control outside the inspected project. */
class PublicFlowInspectionFixture {
  constructor(t, prefix) {
    this.executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.project = path.join(this.executionRoot, 'project');
    this.owner = null;
    t.after(async () => {
      try { await this.owner?.close(); }
      catch (cause) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw cause; }
      if (removeQuiescentRuntimeFixture({ mainRoot: this.project, cleanup() {} })) {
        removeQuiescentRuntimeFixture({ mainRoot: this.executionRoot,
          cleanup: () => fs.rmSync(this.executionRoot, { recursive: true, force: true }) });
      }
    });
    fs.mkdirSync(path.join(this.project, '.sennel'), { recursive: true });
    this.marker = path.join(this.executionRoot, 'unexpected-provider');
    const provider = path.join(this.executionRoot, 'provider.cjs');
    fs.writeFileSync(provider, `require('node:fs').writeFileSync(${JSON.stringify(this.marker)},'called');process.exitCode=19;`);
    fs.writeFileSync(path.join(this.project, '.sennel', 'config.json'), JSON.stringify({
      lang: 'en', type: 'base', docs: { languages: ['en'], defaultLanguage: 'en' },
      logs: { enabled: true },
      agent: { default: 'preview-fixture', providers: { 'preview-fixture': {
        command: process.execPath, args: [provider],
      } } },
    }));
    fs.writeFileSync(path.join(this.project, 'input.txt'), 'Preview source remains unchanged.\n');
    this.manager = makeFlowManager(this.project);
  }

  invoke(args) {
    const invocation = new NodeScriptInvocation({ script: fileURLToPath(new URL('../../../src/sennel.js', import.meta.url)),
      args, cwd: this.executionRoot,
      env: { ...process.env, SENNEL_WORK_ROOT: this.project, SENNEL_SOURCE_ROOT: this.project } });
    return runCmd(invocation, [], { repositoryRoot: this.executionRoot, timeout: 60000 });
  }
}

test('public flow sync dry-run returns one JSON plan without provider or project and canonical writes while normal admission is busy', async (t) => {
  const fixture = new PublicFlowInspectionFixture(t, 'sennel-sync-preview-cli-');
  const { project, marker, manager } = fixture;
  const selected = new CanonicalFlowFixture({ flowManager: manager,
    specId: 'sync-preview-cli', runId: 'sync-preview-cli-run' }).create();
  fixture.owner = await ProcessExecutionRuntime.acquire({ mainRoot: project,
    runId: selected.state().runId, specId: selected.specId });
  const canonical = new CanonicalPersistenceSnapshot(manager, selected.specId);
  const before = new StoredFlowPersistenceSnapshot(project);
  const result = fixture.invoke(['flow', 'run', 'sync', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.result, 'dry-run');
  assert.deepEqual(envelope.data.changed, []);
  assert.deepEqual(Object.keys(envelope.data.artifacts), ['plan']);
  assert.match(envelope.data.artifacts.plan, /build[\s\S]*review[\s\S]*add[\s\S]*commit/);
  assert.equal(fs.existsSync(marker), false, 'preview must not execute the configured provider');
  before.assertUnchanged();
  canonical.assertUnchanged(manager, selected.specId, 'public flow sync preview');
});


test('public canonical Review dry-run refuses without provider, lease, project metadata or canonical mutation', (t) => {
  const fixture = new PublicFlowInspectionFixture(t, 'sennel-review-preview-cli-');
  const { project, manager, marker } = fixture;
  const selected = new CanonicalFlowFixture({ flowManager: manager,
    specId: 'review-preview-cli', runId: 'review-preview-cli-run' }).create().registerActive().activate('spec-review');
  const state = manager.canonicalState(selected.specId);
  assert.equal(state.current.at(-1), 'spec-review');
  assert.equal(state.nextAction().nodeId, 'spec-review');
  const guards = FlowTargetBinding.capture({ flowState: manager.loadReadOnly(selected.specId),
    mainRoot: project, authorityRoot: project }).guardArguments();
  const canonical = new CanonicalPersistenceSnapshot(manager, selected.specId);
  const before = new StoredFlowPersistenceSnapshot(project);
  const result = fixture.invoke(['flow', 'run', 'review', '--phase', 'spec', '--dry-run', ...guards]);
  assert.equal(result.status, 1, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.ok(envelope.errors.some((error) => error.code === 'CANONICAL_REVIEW_DRY_RUN_REQUIRES_PREVIEW_BOUNDARY'), JSON.stringify(envelope));
  assert.equal(fs.existsSync(marker), false, 'dry-run refusal must not execute the configured provider');
  canonical.assertUnchanged(manager, selected.specId, 'public Review dry-run refusal');
  const after = new StoredFlowPersistenceSnapshot(project);
  const metadata = (snapshot) => new Map(snapshot.snapshots.flatMap((directory) => directory.entries.map((entry) => [
    path.relative(snapshot.root, path.resolve(directory.root, directory.relativePath, entry.name)),
    { kind: entry.kind, revision: entry.revision, dev: entry.dev, ino: entry.ino, mode: entry.mode },
  ])));
  const previousEntries = metadata(before);
  const currentEntries = metadata(after);
  const changed = [...new Set([...previousEntries.keys(), ...currentEntries.keys()])].sort()
    .filter((relativePath) => JSON.stringify(previousEntries.get(relativePath)) !== JSON.stringify(currentEntries.get(relativePath)))
    .map((relativePath) => ({ relativePath, before: previousEntries.get(relativePath) ?? null,
      after: currentEntries.get(relativePath) ?? null }));
  t.diagnostic(JSON.stringify({ changedEntryCount: changed.length, changedEntries: changed.slice(0, 50),
    truncated: changed.length > 50 }));
  before.assertUnchanged();
});

test('public artifact full cache miss renders the cataloged record without provider, project cache or canonical mutation', (t) => {
  const fixture = new PublicFlowInspectionFixture(t, 'sennel-artifact-inspection-cli-');
  const { project, manager, marker } = fixture;
  const goal = 'Render this exact cataloged inspection goal without project writes.';
  const selected = new CanonicalFlowFixture({ flowManager: manager,
    specId: 'artifact-inspection-cli', runId: 'artifact-inspection-cli-run',
    specRecord: { goal } }).create().registerActive();
  const cache = path.join(selected.location().directory, '.runtime', 'views', 'spec.record.full.md');
  assert.equal(fs.existsSync(cache), false, 'the public reader must exercise a real cache miss');
  const canonical = new CanonicalPersistenceSnapshot(manager, selected.specId);
  const before = new StoredFlowPersistenceSnapshot(project);
  const result = fixture.invoke(['flow', 'get', 'artifact', 'spec.record', '--mode', 'full']);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.ok(envelope.data.markdown.includes(goal));
  assert.equal(envelope.data.markdown.startsWith('<!--'), false, 'cache metadata is not rendered');
  assert.equal(fs.existsSync(marker), false, 'full rendering must not execute the configured provider');
  canonical.assertUnchanged(manager, selected.specId, 'public artifact full inspection');
  before.assertUnchanged();
});
