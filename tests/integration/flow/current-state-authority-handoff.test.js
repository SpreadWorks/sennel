import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildCurrentFlowDefinition } from "../../../src/flow/definition.js";
import { ActivityTransition, CurrentAttempt, CurrentFlowStateAdoptionBoundary, CurrentFlowStateStore, FlowActivity } from "../../../src/flow/lib/current-flow-state.js";
import { FlowVersionAuthorityScope, FlowVersionLocation } from "../../../src/lib/flow-version.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { FileLock } from "../../../src/lib/file-lock.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("current-state-authority-");
  t.after(() => removeTmpDir(root));
  const directory = path.join(root, "state");
  const definition = buildCurrentFlowDefinition();
  const boundary = new CurrentFlowStateAdoptionBoundary({ definition });
  return { root, directory, definition, boundary };
}

// Reuse the legal create -> start_attempt sequence from the foundation suite.
function startActivity(state) {
  const currentPath = state.nextAction().path;
  const node = state.findNode(currentPath.at(-1));
  const contract = state.definition.contractFor(node.id, state.root);
  const attempt = new CurrentAttempt({ id: "handoff-attempt", nodeId: node.id,
    sequence: node.attemptSequence + 1, startedAt: "2026-08-07T00:00:00.000Z",
    consumption: { semantic: 0, tooling: 0 }, failure: null, blocker: null, incomplete: [],
    operationClaims: [{ operation: "execute", resources: [...contract.resourceContract.required] }],
  });
  return new FlowActivity({ id: "handoff-start", nodeId: node.id, nodeKey: node.key,
    attemptId: attempt.id, sequence: attempt.sequence, confirmationOrder: state.confirmationOrder + 1,
    type: "attempt_started",
    transition: new ActivityTransition({ operation: "start_attempt", nodeId: node.id, task: null, attempt,
      status: null, policy: null, outbox: null, approval: null, nonblocking: null }),
    result: null, timing: { startedAt: "2026-08-07T00:00:00.000Z", finishedAt: "2026-08-07T00:00:00.000Z", durationMs: 0 },
    failure: null, provider: null, model: null, effort: null, usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null, note: null, reviewPublication: null,
  });
}

test("Current Store creates, appends a legal Activity and reloads the same state through retained authorities", (t) => {
  const { directory, definition, boundary } = fixture(t);
  const store = new CurrentFlowStateStore({ directory, definition });
  const created = store.create(boundary.createFresh());
  const started = store.apply({ activity: startActivity(created) });
  const reloaded = new CurrentFlowStateStore({ directory, definition });
  assert.equal(started.confirmationOrder, 2);
  assert.deepEqual(reloaded.load().toJSON(), started.toJSON());
  assert.equal(reloaded.journal.read().length, 2);
});

test("Current Store constructor refuses a replaced ensured root before creating a lock namespace", (t) => {
  const { root, directory, definition } = fixture(t);
  const backup = path.join(root, "original-state");
  const resolve = RealDirectoryAuthority.resolve;
  let replaced = false;
  t.mock.method(RealDirectoryAuthority, "resolve", function (target, options = {}) {
    const authority = resolve.call(this, target, options);
    if (!replaced && path.resolve(target) === directory && options.create) {
      fs.renameSync(directory, backup);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "foreign.txt"), "foreign directory");
      replaced = true;
    }
    return authority;
  });
  let failure;
  try { new CurrentFlowStateStore({ directory, definition }); } catch (error) { failure = error; }
  assert.equal(replaced, true);
  assert.deepEqual(fs.readdirSync(directory), ["foreign.txt"]);
  assert.equal(fs.readFileSync(path.join(directory, "foreign.txt"), "utf8"), "foreign directory");
  assert.equal(failure?.code, "CURRENT_FLOW_STATE_LOCK_AUTHORITY_INVALID");
});

test("Current Store uses a typed Version location's retained repository before initial namespace creation", (t) => {
  const { root, definition } = fixture(t);
  const repositoryRoot = path.join(root, "repository");
  fs.mkdirSync(repositoryRoot);
  const location = new FlowVersionLocation({ repositoryRoot, authorityScope: FlowVersionAuthorityScope.canonical(),
    specId: "current-handoff", version: 1 });
  const runtimeLockLocation = location.runtimeLock("runtime.lock.current-flow-state");
  fs.renameSync(repositoryRoot, path.join(root, "original-repository"));
  fs.mkdirSync(repositoryRoot);
  fs.writeFileSync(path.join(repositoryRoot, "foreign.txt"), "foreign repository");
  let failure;
  try { new CurrentFlowStateStore({ directory: location.directory, definition, runtimeLockLocation }); }
  catch (error) { failure = error; }
  assert.deepEqual(fs.readdirSync(repositoryRoot), ["foreign.txt"]);
  assert.equal(fs.readFileSync(path.join(repositoryRoot, "foreign.txt"), "utf8"), "foreign repository");
  assert.equal(failure?.code, "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID");
});

for (const operation of ["create", "apply"]) {
  test(`Current Store ${operation} refuses root replacement after Activity append before writing foreign state`, (t) => {
    const { root, directory, definition, boundary } = fixture(t);
    const backup = path.join(root, "original-state");
    let armed = operation === "create";
    let replaced = false;
    const store = new CurrentFlowStateStore({ directory, definition, faultInjector({ phase }) {
      if (armed && !replaced && phase === "activity-appended") {
        fs.renameSync(directory, backup);
        if (operation === "apply") fs.cpSync(backup, directory, { recursive: true });
        else fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, "foreign.txt"), "foreign state owner");
        replaced = true;
      }
    } });
    const fresh = boundary.createFresh();
    const initial = operation === "apply" ? store.create(fresh) : null;
    const originalBytes = initial === null ? null : fs.readFileSync(store.statePath);
    armed = true;
    let failure;
    try {
      if (operation === "create") store.create(fresh);
      else store.apply({ activity: startActivity(initial) });
    } catch (error) { failure = error; }
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(path.join(directory, "foreign.txt"), "utf8"), "foreign state owner");
    if (operation === "create") {
      assert.equal(fs.existsSync(store.statePath), false);
      assert.deepEqual(fs.readdirSync(directory), ["foreign.txt"]);
    } else {
      assert.deepEqual(fs.readFileSync(store.statePath), originalBytes);
      assert.deepEqual(fs.readFileSync(path.join(backup, "flow.json")), originalBytes);
    }
    const journal = fs.readFileSync(path.join(backup, "activities.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
    assert.equal(journal.length, operation === "create" ? 1 : 2);
    assert.equal(journal.at(-1).confirmationOrder, operation === "create" ? 1 : 2);
    assert.ok(failure instanceof Error);
  });
}

test("Current Store reads refuse a replaced root after lock admission before opening foreign state bytes", (t) => {
  const { root, directory, definition, boundary } = fixture(t);
  const store = new CurrentFlowStateStore({ directory, definition });
  store.create(boundary.createFresh());
  const runExclusive = FileLock.prototype.runExclusive;
  const open = fs.openSync;
  const foreignReads = [];
  let replaced = false;
  t.mock.method(FileLock.prototype, "runExclusive", function (operation, ...args) {
    return runExclusive.call(this, (...operationArgs) => {
      if (this === store.lock && !replaced) {
        fs.renameSync(directory, path.join(root, "original-state"));
        fs.mkdirSync(directory);
        fs.writeFileSync(store.statePath, "foreign state");
        replaced = true;
      }
      return operation(...operationArgs);
    }, ...args);
  });
  t.mock.method(fs, "openSync", (target, ...args) => {
    if (replaced && target === store.statePath) foreignReads.push(target);
    return open(target, ...args);
  });
  let failure;
  try { store.load(); } catch (error) { failure = error; }
  assert.equal(replaced, true);
  assert.deepEqual(foreignReads, []);
  assert.ok(failure instanceof Error);
});
