import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runMigrationHook } from "../../../src/flow/lib/run-finalize.js";
import RunFinalizeCommitCommand, { executeFinalizeCommitInput } from "../../../src/flow/lib/run-finalize-commit.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function hook(root, specFile, source) {
  const script = path.join(root, path.dirname(specFile), "scripts", "finalize-migration.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, source);
  return script;
}

function canonicalFixture(t) {
  const root = createTmpDir("finalize-migration-canonical-");
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { removeTmpDir(root); }
  });
  initGitRepo(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "/.sennel/\n/specs/\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/value.js"), "export const value = 1;\n");
  commitAll(root, "test: migration baseline");
  const manager = makeFlowManager(root);
  const flow = new CanonicalFlowFixture({ flowManager: manager, specId: "migration", runId: "migration-run" }).create();
  const ctx = { root, mainRoot: root, executionRoot: root, repositoryRoot: root,
    flowManager: manager, flowState: flow.state(), specId: flow.specId };
  const snapshot = () => ({ state: manager.canonicalState(flow.specId).toJSON(),
    activities: manager.activityLedger(flow.specId), catalog: manager.artifactCatalog(flow.specId).toJSON() });
  return { root, manager, flow, ctx, snapshot, onCleanup: (cleanup) => cleanups.push(cleanup) };
}

test("migration hook produces one managed receipt and finishes its real output at the supplied execution checkout", async (t) => {
  const root = createTmpDir("finalize-migration-managed-");
  const executionRoot = path.join(root, "execution");
  fs.mkdirSync(executionRoot);
  let runtime;
  t.after(async () => {
    try { if (runtime && !runtime.closed) await runtime.close(); }
    finally { removeTmpDir(root); }
  });
  const specFile = "specs/current/spec.json";
  const script = hook(root, specFile,
    'require("node:fs").writeFileSync("migration-output.json", JSON.stringify({ cwd: process.cwd(), script: __filename }));');
  const output = path.join(executionRoot, "migration-output.json");
  assert.equal(fs.existsSync(output), false);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot,
    runId: "migration-managed", specId: "current" });
  await runtime.enter(() => runMigrationHook(root, specFile, executionRoot));
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), { cwd: executionRoot, script });
  const execution = runtime.inspect().executions.at(-1);
  assert.equal(execution.calls.length, 1, "the user migration is a recorded physical command");
  const call = execution.calls[0];
  assert.equal(call.invocation.kind, "command");
  assert.equal(call.receipt.stopEvidence.status, "confirmed");
  assert.equal(call.receipt.checkoutIdentity.executionRoot, executionRoot);
  assert.equal(call.outcome.code, 0);
  await runtime.close();
  assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: root, executionRoot }).slot, null);
});

test("optional absent migration performs no physical invocation and nonzero exit keeps the existing assertOk contract", async (t) => {
  const root = createTmpDir("finalize-migration-exit-");
  let runtime;
  t.after(async () => {
    try { if (runtime && !runtime.closed) await runtime.close(); }
    finally { removeTmpDir(root); }
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  await runtime.enter(async () => {
    assert.equal(await runMigrationHook(root, null), undefined);
    assert.equal(await runMigrationHook(root, "specs/absent/spec.json"), undefined);
  });
  assert.equal(runtime.inspect().executions.at(-1).calls.length, 0);
  const specFile = "specs/exit/spec.json";
  const script = hook(root, specFile, 'process.stderr.write("migration fixture failure");process.exit(23);');
  await assert.rejects(runtime.enter(() => runMigrationHook(root, specFile)), (error) => {
    assert.equal(error instanceof ProcessExecutionControlFailure, false);
    assert.ok(error.message.startsWith(`finalize migration script failed: ${script}: `));
    assert.match(error.message, /exit=23/);
    assert.match(error.message, /migration fixture failure/);
    return true;
  });
  assert.equal(runtime.inspect().executions.at(-1).calls[0].receipt.stopEvidence.status, "confirmed");
});

test("direct commit BUSY refuses before effect preparation or canonical mutation and the existing selection rejects an unselected Step", async (t) => {
  const value = canonicalFixture(t);
  const before = value.snapshot();
  const owner = await ProcessExecutionRuntime.acquire({ mainRoot: value.root,
    runId: value.ctx.flowState.runId, specId: value.flow.specId });
  value.onCleanup(async () => { if (!owner.closed) await owner.close(); });
  const command = new RunFinalizeCommitCommand();
  const prepareEffect = command.prepareEffect;
  let preparations = 0;
  t.mock.method(command, "prepareEffect", function (...args) {
    preparations += 1;
    return prepareEffect.apply(this, args);
  });
  await assert.rejects(command.execute(value.ctx),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_BUSY");
  assert.equal(preparations, 0);
  assert.deepEqual(value.snapshot(), before);
  assert.equal(owner.inspect().executions.at(-1).calls.length, 0);
  assert.throws(() => executeFinalizeCommitInput({ ctx: value.ctx, stepId: "finalize-commit", command: "finalize-commit" }),
    (error) => error instanceof StepAdmissionRefusal
      && error.message === "Finalization direct execution differs from the selected Action");
  assert.deepEqual(value.snapshot(), before);
});

test("migration helper preserves typed intent refusal without running user code or manufacturing a stop receipt", async (t) => {
  const root = createTmpDir("finalize-migration-control-");
  const specFile = "specs/current/spec.json";
  const output = path.join(root, "forbidden-migration-output");
  const script = hook(root, specFile, `require("node:fs").writeFileSync(${JSON.stringify(output)}, "forbidden");`);
  const scriptBytes = fs.readFileSync(script);
  let armed = false;
  let runtime;
  t.after(async () => {
    try { if (runtime && !runtime.closed) await assert.rejects(runtime.close(), ProcessExecutionControlFailure); }
    finally { removeTmpDir(root); }
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, runId: "migration-control", specId: "current",
    faultInjector({ phase }) {
      if (armed && phase === "before-runtime-fsync") throw new Error("migration intent fsync unavailable");
    } });
  const registry = runtime.store.file.read();
  armed = true;
  await assert.rejects(runtime.enter(() => runMigrationHook(root, specFile)),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_REGISTRY_FAILED");
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readFileSync(script), scriptBytes);
  assert.deepEqual(runtime.store.file.read(), registry, "an unpersisted intent cannot manufacture a physical stop receipt");
  assert.throws(() => ProcessExecutionRuntime.inspect({ mainRoot: root }), { code: "PROCESS_EXECUTION_DURABILITY_UNCERTAIN" });
  await assert.rejects(ProcessExecutionRuntime.acquire({ mainRoot: root }),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_BUSY");
  assert.deepEqual(runtime.store.file.read(), registry);
});
