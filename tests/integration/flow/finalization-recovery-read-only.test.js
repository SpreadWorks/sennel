import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, it, mock } from "node:test";

import RunReportCommand from "../../../src/flow/lib/run-report.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunRecoverFinalizationCommand from "../../../src/flow/lib/run-recover-finalization.js";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import {
  FinalizationDurableProofFact,
  FinalizationMainAuthorityFact,
  FinalizationOperationLockFact,
  FinalizationOutboxFact,
  FinalizationPreSyncFact,
  FinalizationRecoveryFacts,
  FinalizationRecoveryTargetFact,
  InterruptedFinalizeSyncRuntimeLogFact,
  resolveFinalizationRecovery,
} from "../../../src/flow/definition.js";
import { FlowOutboxStore, finalizationOutboxIdentity } from "../../../src/flow/lib/flow-outbox.js";
import { RuntimeLogBlockWriter, runtimeLogFileForContext } from "../../../src/lib/runtime-log.js";
import { RepositoryFlowOperationLock } from "../../../src/lib/repository-maintenance-lock.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { CanonicalNextActionScenario, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const SPEC_ID = "001-read-only";
const RUN_ID = "run-read-only";

function files(root) {
  const result = new Map();
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, name.name);
      if (name.isDirectory()) visit(full);
      else result.set(path.relative(root, full), fs.readFileSync(full));
    }
  };
  visit(root);
  return result;
}

function assertSameFiles(before, after) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, bytes] of before) assert.deepEqual(after.get(file), bytes, file);
}

function context(root, manager) {
  return {
    root,
    executionRoot: root,
    mainRoot: root,
    specId: SPEC_ID,
    config: {},
    flowManager: manager,
    flowState: manager.loadReadOnly(SPEC_ID),
    flowCommandBoundary: false,
  };
}

function finalizationScenario(root, manager, { issue = null } = {}) {
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "README.md"), "finalization recovery fixture\n");
  commitAll(root, "fixture source");
  return new CanonicalNextActionScenario({ flowManager: manager, specId: SPEC_ID, runId: RUN_ID,
    issue, execution: { mode: "direct", baseBranch: "main" },
    specRecord: { requirements: [{ id: "R1", desc: "Exercise finalization recovery.", task_ids: ["T1"], testable: false }] },
  }).create({ tasks: [{ id: "T1", title: "Fixture Task", goal: "Exercise finalization recovery.",
    origin: "plan", added_round: 0, status: "pending" }] });
}

async function setupInterruptedRecovery(root, manager) {
  const scenario = await finalizationScenario(root, manager).atFlowStepWithProducers("finalize-sync");
  const state = manager.loadReadOnly(SPEC_ID);
  const identity = finalizationOutboxIdentity(state, "finalize-sync");
  new FlowOutboxStore(manager, { specId: SPEC_ID }).begin(identity);
  const runtimeReceipt = {
    runId: RUN_ID,
    sequence: 1,
    command: "flow run finalize-sync",
    startedAt: "2026-08-24T00:00:00.000Z",
    complete: false,
  };
  const log = runtimeLogFileForContext({ root, specId: SPEC_ID });
  fs.mkdirSync(path.dirname(log.filePath), { recursive: true });
  fs.writeFileSync(log.filePath, [
    `===== start runId=${runtimeReceipt.runId} sequence=${runtimeReceipt.sequence} attempt=1 command="${runtimeReceipt.command}" startedAt="${runtimeReceipt.startedAt}" exitCode="" endedAt="" =====`,
    "[stderr] interrupted",
    "",
  ].join("\n"));
  return { scenario, state, identity, runtimeReceipt };
}

async function setupExactReportRecovery(manager) {
  const root = manager.executionRoot();
  await finalizationScenario(root, manager, { issue: 123 }).atFlowStepWithProducers("report");
  const state = manager.loadReadOnly(SPEC_ID);
  const identity = finalizationOutboxIdentity(state, "report");
  const outbox = new FlowOutboxStore(manager, { specId: SPEC_ID });
  const entry = outbox.begin(identity);
  const original = childProcess.spawnSync;
  const external = mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (command === "gh") return { status: 1, signal: null, stdout: "", stderr: "injected delivery interruption" };
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => new RunReportCommand().execute({ ...context(root, manager), flowOutboxEntry: entry }),
      /failed to post report/);
  } finally { external.mock.restore(); syncBuiltinESMExports(); }
  outbox.fail(identity, new Error("report post-hook interrupted"));
  return { identity, outbox };
}

function recoveryFacts({
  stepId = "report",
  status = "missing",
  durable = false,
  lock = "available",
  runtimeReceipt = null,
  preSyncState = null,
  exactRecoveryReceipt = null,
  authorityRoot = "/main",
} = {}) {
  const persisted = status === "missing" ? {} : {
    idempotencyKey: "flow-outbox-v1:run:flow:report:report",
    status,
    attempt: 1,
    failure: status === "failed" ? "post-hook failed" : null,
    exactRecoveryReceipt,
  };
  return new FinalizationRecoveryFacts({
    target: new FinalizationRecoveryTargetFact({ scope: "flow", stepId }),
    outbox: new FinalizationOutboxFact(persisted),
    durableProof: new FinalizationDurableProofFact({ durable }),
    operationLock: new FinalizationOperationLockFact({ status: lock }),
    mainAuthority: new FinalizationMainAuthorityFact({ mainRoot: "/main", authorityRoot }),
    interruptedRuntimeLog: new InterruptedFinalizeSyncRuntimeLogFact({ receipt: runtimeReceipt }),
    preSync: new FinalizationPreSyncFact({ state: preSyncState }),
  });
}

describe("Definition-owned finalization recovery decisions", () => {
  const interruptedReceipt = Object.freeze({
    runId: "run",
    sequence: 1,
    command: "flow run finalize-sync",
    startedAt: "2026-08-24T00:00:00.000Z",
    complete: false,
  });
  const cases = [
    ["missing outbox", {}, "ordinary-execute"],
    ["pending outbox", { status: "pending" }, "ordinary-execute"],
    ["interrupted pending sync", { stepId: "finalize-sync", status: "pending", runtimeReceipt: interruptedReceipt }, "interrupted-sync-settlement"],
    ["busy interrupted sync", { stepId: "finalize-sync", status: "pending", runtimeReceipt: interruptedReceipt, lock: "busy" }, "blocked"],
    ["foreign interrupted sync authority", { stepId: "finalize-sync", status: "pending", runtimeReceipt: interruptedReceipt, authorityRoot: "/worktree" }, "blocked"],
    ["non-durable report failure", { status: "failed" }, "blocked"],
    ["durable report failure", { status: "failed", durable: true }, "exact-outbox-recovery"],
    ["pre-sync conflict", { stepId: "finalize-merge", status: "failed", preSyncState: "needs-repair" }, "pre-sync-conflict-repair"],
    ["unavailable pre-sync state", { stepId: "finalize-merge", status: "failed", preSyncState: "unavailable" }, "blocked"],
    ["consumed exact recovery", {
      status: "failed",
      durable: true,
      exactRecoveryReceipt: {
        idempotencyKey: "flow-outbox-v1:run:flow:report:report",
        attempt: 1,
        failure: "post-hook failed",
        recoveryKey: null,
      },
    }, "exhausted"],
  ];
  for (const [name, input, expected] of cases) {
    it(`selects ${expected} for ${name}`, () => {
      assert.equal(resolveFinalizationRecovery(recoveryFacts(input)).operation, expected);
    });
  }
});

describe("finalization recovery next-action projection", () => {
  let root;
  afterEach(() => root && removeTmpDir(root));

  it("does not claim an ordinary pending action while projecting it", async () => {
    root = createTmpDir("fe70-next-action-ordinary-");
    const manager = makeFlowManager(root);
    await finalizationScenario(root, manager).beforeFlowStepWithProducers("report");
    const before = files(root);
    const result = await new GetNextActionCommand().execute(context(root, manager));

    assert.equal(result.step, "report");
    assert.equal(result.directive.kind, "execute_command");
    assert.equal(result.directive.actionId, "CLAIM_NEXT_ACTION");
    assertSameFiles(before, files(root));
    const claimed = await new RunClaimNextActionCommand().execute(context(root, manager));
    assert.equal(claimed.ok, true);
    assert.equal(manager.loadReadOnly(SPEC_ID).currentNodeId, "report");
    const claimedFiles = files(root);
    const stale = await new RunClaimNextActionCommand().execute(context(root, manager));
    assert.equal(stale.ok, false);
    assertSameFiles(claimedFiles, files(root));
  });

  it("uses the same explicit claim boundary for a non-finalization worker", async () => {
    root = createTmpDir("fe70-next-action-worker-");
    const manager = makeFlowManager(root);
    new CanonicalNextActionScenario({ flowManager: manager, specId: SPEC_ID, runId: RUN_ID })
      .create()
      .beforeFlowStep("draft");
    const before = files(root);
    const projection = await new GetNextActionCommand().execute(context(root, manager));

    assert.equal(projection.step, "draft");
    assert.equal(projection.directive.actionId, "CLAIM_NEXT_ACTION");
    assertSameFiles(before, files(root));
    const claimed = await new RunClaimNextActionCommand().execute(context(root, manager));
    assert.equal(claimed.ok, true);
    assert.equal(manager.loadReadOnly(SPEC_ID).currentNodeId, "draft");
  });

  it("projects interrupted finalize-sync settlement without changing canonical state or the runtime log", async () => {
    root = createTmpDir("fe70-next-action-interrupted-");
    const manager = makeFlowManager(root);
    const { identity } = await setupInterruptedRecovery(root, manager);
    const before = files(root);
    const result = await new GetNextActionCommand().execute(context(root, manager));

    assert.equal(result.directive.kind, "execute_command");
    assert.equal(result.directive.actionId, "RECOVER_INTERRUPTED_FINALIZE_SYNC");
    assert.match(result.directive.nextAction, /flow run recover-finalization/);
    assertSameFiles(before, files(root));
    const recovered = await new RunRecoverFinalizationCommand().execute(context(root, manager));
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    const recoveredState = manager.loadReadOnly(SPEC_ID);
    assert.equal(recoveredState.currentNodeId, "finalize-cleanup");
    assert.equal(manager.canonicalState(SPEC_ID).findNode("finalize-sync").attemptSequence, 1);
    assert.equal(new FlowOutboxStore(manager, { specId: SPEC_ID }).status(identity).status, "failed");
    const recoveryActivities = manager.activityLedger(SPEC_ID)
      .filter((activity) => activity.transition.operation === "recover_interrupted_finalize_sync");
    assert.equal(recoveryActivities.length, 1);
    const issueLog = JSON.parse(manager.readArtifact({
      specId: SPEC_ID,
      logicalKey: "issue.log",
      consumerNodeId: "finalize-cleanup",
    }).bytes.toString("utf8"));
    assert.equal(issueLog.entries.at(-1).trigger, "interrupted");
    const settled = files(root);
    const replay = await new RunRecoverFinalizationCommand().execute(context(root, manager));
    assert.equal(replay.ok, false);
    assertSameFiles(settled, files(root));
  });

  it("retains interrupted-sync advice after a nested diagnostic closes without changing saved state", async () => {
    root = createTmpDir("runtime-log-nested-sync-");
    const manager = makeFlowManager(root);
    await setupInterruptedRecovery(root, manager);
    const child = new RuntimeLogBlockWriter({
      root,
      flowId: SPEC_ID,
      runId: RUN_ID,
      command: "flow get status",
    });
    child.capture("stdout", "nested diagnostic finished\n");
    child.close(0);
    const reloaded = makeFlowManager(root);
    const before = files(root);

    const result = await new GetNextActionCommand().execute(context(root, reloaded));

    assert.equal(result.directive.kind, "execute_command");
    assert.equal(result.directive.actionId, "RECOVER_INTERRUPTED_FINALIZE_SYNC");
    assert.match(result.directive.nextAction, /flow run recover-finalization/);
    assertSameFiles(before, files(root));
  });

  it("projects a busy recovery lock as Definition-owned blocked state without changing files", async () => {
    root = createTmpDir("fe70-next-action-lock-busy-");
    const manager = makeFlowManager(root);
    await setupInterruptedRecovery(root, manager);
    const lock = new RepositoryFlowOperationLock({ mainRoot: root });
    lock.acquire();
    try {
      const before = files(root);
      const result = await new GetNextActionCommand().execute(context(root, manager));
      assert.equal(result.directive.kind, "blocked");
      assert.equal(result.directive.code, "FINALIZATION_RECOVERY_LOCK_BUSY");
      assertSameFiles(before, files(root));
    } finally {
      lock.release();
    }
  });

  it("holds the main operation lock across the live finalize-sync lifecycle boundary", async () => {
    root = createTmpDir("fe70-next-action-live-sync-");
    const manager = makeFlowManager(root);
    await setupInterruptedRecovery(root, manager);
    const ctx = context(root, manager);
    const lifecycle = FLOW_COMMANDS.run["finalize-sync"];

    await lifecycle.pre(ctx);
    try {
      const during = await new GetNextActionCommand().execute(ctx);
      assert.equal(during.directive.kind, "blocked");
      assert.equal(during.directive.code, "FINALIZATION_RECOVERY_LOCK_BUSY");
    } finally {
      const busy = new Error("release live sync fixture");
      busy.code = "REPOSITORY_FLOW_OPERATION_BUSY";
      await lifecycle.onError(ctx, busy);
    }

    const interrupted = await new GetNextActionCommand().execute(context(root, manager));
    assert.equal(interrupted.directive.actionId, "RECOVER_INTERRUPTED_FINALIZE_SYNC");
  });

  it("leaves every durable file unchanged when interrupted settlement fails before Activity append", async () => {
    root = createTmpDir("fe70-next-action-interrupted-pre-append-");
    let inject = false;
    const manager = makeFlowManager(root, {
      versionStoreFaultInjector({ phase, activity }) {
        if (inject && activity?.transition.operation === "recover_interrupted_finalize_sync" && phase === "activity-ready-to-append") {
          throw new Error("injected interrupted recovery pre-append failure");
        }
      },
    });
    await setupInterruptedRecovery(root, manager);
    const before = files(root);
    inject = true;
    const recovered = await new RunRecoverFinalizationCommand().execute(context(root, manager));
    assert.equal(recovered.ok, false);
    assert.match(recovered.errors[0].messages[0], /injected interrupted recovery pre-append failure/);
    assertSameFiles(before, files(root));
  });

  it("replays the same composite Activity after a journal-first crash", async () => {
    root = createTmpDir("fe70-next-action-interrupted-replay-");
    let inject = false;
    const crashingManager = makeFlowManager(root, {
      versionStoreFaultInjector({ phase, activity }) {
        if (inject && activity?.transition.operation === "recover_interrupted_finalize_sync" && phase === "activity-appended") {
          throw new Error("injected interrupted recovery journal-first crash");
        }
      },
    });
    await setupInterruptedRecovery(root, crashingManager);
    inject = true;
    const crashed = await new RunRecoverFinalizationCommand().execute(context(root, crashingManager));
    assert.equal(crashed.ok, false);

    const reloaded = makeFlowManager(root);
    const projection = await new GetNextActionCommand().execute(context(root, reloaded));
    assert.equal(projection.directive.actionId, "RECOVER_INTERRUPTED_FINALIZE_SYNC");
    const recovered = await new RunRecoverFinalizationCommand().execute(context(root, reloaded));
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(reloaded.loadReadOnly(SPEC_ID).currentNodeId, "finalize-cleanup");
    assert.equal(reloaded.activityLedger(SPEC_ID)
      .filter((activity) => activity.transition.operation === "recover_interrupted_finalize_sync").length, 1);
  });

  it("rejects a foreign interrupted runtime receipt before changing canonical files", async () => {
    root = createTmpDir("fe70-next-action-interrupted-foreign-");
    const manager = makeFlowManager(root);
    const { runtimeReceipt } = await setupInterruptedRecovery(root, manager);
    const before = files(root);
    assert.throws(() => manager.recoverInterruptedFinalizeSync({
      specId: SPEC_ID,
      runtimeLog: { ...runtimeReceipt, runId: "run-foreign" },
    }), /does not match the active Flow/);
    assertSameFiles(before, files(root));
  });

  it("leaves an exact durable outbox recovery failed until its explicit command consumes it", async () => {
    root = createTmpDir("fe70-next-action-exact-");
    const manager = makeFlowManager(root);
    const { identity, outbox } = await setupExactReportRecovery(manager);
    const before = files(root);
    const projection = await new GetNextActionCommand().execute(context(root, manager));

    assert.equal(projection.directive.actionId, "RECOVER_REPORT_OUTBOX");
    assert.match(projection.directive.nextAction, /flow run recover-finalization/);
    assertSameFiles(before, files(root));

    const recovered = await new RunRecoverFinalizationCommand().execute(context(root, manager));
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(outbox.status(identity).status, "pending");
    const resumed = await new GetNextActionCommand().execute(context(root, manager));
    assert.equal(resumed.step, "report");
    assert.notEqual(resumed.directive.kind, "blocked");
  });

  it("replays one exact outbox recovery receipt after a journal-first crash", async () => {
    root = createTmpDir("fe70-next-action-exact-replay-");
    let inject = false;
    const crashingManager = makeFlowManager(root, {
      versionStoreFaultInjector({ phase, activity }) {
        if (inject && activity?.transition.operation === "reopen_outbox" && phase === "activity-appended") {
          throw new Error("injected exact recovery journal-first crash");
        }
      },
    });
    const { identity } = await setupExactReportRecovery(crashingManager);
    inject = true;
    const crashed = await new RunRecoverFinalizationCommand().execute(context(root, crashingManager));
    assert.equal(crashed.ok, false);

    const reloaded = makeFlowManager(root);
    const projection = await new GetNextActionCommand().execute(context(root, reloaded));
    assert.equal(projection.directive.actionId, "RECOVER_REPORT_OUTBOX");
    const recovered = await new RunRecoverFinalizationCommand().execute(context(root, reloaded));
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    const entry = new FlowOutboxStore(reloaded, { specId: SPEC_ID }).status(identity);
    assert.equal(entry.status, "pending");
    assert.ok(entry.exactRecoveryReceipt);
    assert.equal(reloaded.activityLedger(SPEC_ID)
      .filter((activity) => activity.transition.operation === "reopen_outbox").length, 1);
  });
});
