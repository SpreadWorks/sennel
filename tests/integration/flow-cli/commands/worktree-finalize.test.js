/** Public finalization CLI outcomes; physical worktree conflict/recovery is
 * owned by the actual Prepare-backed F04 finalization phase contracts. */
import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FinalizationPhaseScenario } from "../../../support/finalization-phase-scenario.js";
import { SeedCleanupScope } from "../../../support/builders/seed-work-root.js";
import { CanonicalPersistenceSnapshot } from "../../../support/assertions/canonical-persistence.js";
import RunFinalizeCleanupCommand from "../../../../src/flow/lib/run-finalize-cleanup.js";
import { CanonicalLatestReport } from "../../../../src/flow/lib/run-report-show.js";
import { RuntimeChildExecution } from "../../../../src/lib/runtime-package.js";

const FLOW_ENTRY = fileURLToPath(new URL("../../../../src/cli-main.js", import.meta.url));
const seedScope = new SeedCleanupScope(after, mock);
let mergeSeed;

async function phaseAt(t, frontier) {
  mergeSeed ??= FinalizationPhaseScenario.seed(seedScope, { frontier: "finalize-merge",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null } });
  const flow = FinalizationPhaseScenario.fromSeed(t, await mergeSeed);
  await flow.advanceTo(frontier);
  return flow;
}

function runCli(args, root) {
  const result = RuntimeChildExecution.runSync(FLOW_ENTRY, ["flow", ...args], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
  }, spawnSync);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe("flow run finalize-cleanup — self-contained envelope (spec 251)", () => {
  it("emits ok:true with report=null and REPORT_MISSING when completed cleanup cannot read its report projection", async (t) => {
    const flow = await phaseAt(t, "finalize-cleanup");
    const completed = runCli(["run", "finalize-cleanup"], flow.root);
    assert.equal(completed.ok, true);
    flow.reload();
    assert.equal(flow.state().lifecycle.state, "finalized");
    const source = flow.report("finalize-cleanup");
    const before = new CanonicalPersistenceSnapshot(flow.manager, flow.specId);
    const saved = flow.manager.readCurrentStepSettlement({ specId: flow.specId,
      stepId: "finalize-cleanup", completed: true });
    const reportFile = flow.manager.specLocation(flow.specId).artifact("report");
    const read = fs.readFileSync;
    const unavailable = Object.assign(new Error("The report projection read is unavailable."), { code: "EIO" });
    let failedReads = 0;
    let projectingReport = false;
    const project = CanonicalLatestReport.read;
    const projection = t.mock.method(CanonicalLatestReport, "read", (...args) => {
      projectingReport = true;
      try { return project(...args); }
      finally { projectingReport = false; }
    });
    const fault = t.mock.method(fs, "readFileSync", (file, ...args) => {
      if (projectingReport && file === reportFile) { failedReads += 1; throw unavailable; }
      return read(file, ...args);
    });
    let envelope;
    try {
      envelope = JSON.parse(JSON.stringify(new RunFinalizeCleanupCommand()
        .projectCompletedReceipt(flow.context(), saved.receipt)));
    } finally { fault.mock.restore(); projection.mock.restore(); }
    assert.ok(failedReads > 0, "the real report projection must reach the failing filesystem boundary");
    assert.equal(envelope.ok, true);
    assert.equal(envelope.type, "run");
    assert.equal(envelope.key, "finalize-cleanup");
    assert.equal(envelope.data.report, null);
    const warning = envelope.errors.find((error) => error.code === "REPORT_MISSING");
    assert.ok(warning);
    assert.equal(warning.level, "warn");
    before.assertUnchanged(flow.manager, flow.specId, "unavailable completed-report projection");
    assert.deepEqual(flow.report("finalize-cleanup"), source);
  });

  it("writes .sennel/last-finalized-spec and clears .active-flow", async (t) => {
    const flow = await phaseAt(t, "finalize-cleanup");

    runCli(["run", "finalize-cleanup"], flow.root);

    const pointer = path.join(flow.root, ".sennel", "last-finalized-spec");
    assert.ok(fs.existsSync(pointer), "last-finalized-spec pointer must be written");
    assert.equal(fs.readFileSync(pointer, "utf8").trim(), flow.specId);
    const activeFlow = path.join(flow.root, ".sennel", ".active-flow");
    if (fs.existsSync(activeFlow)) {
      const content = fs.readFileSync(activeFlow, "utf8").trim();
      assert.ok(content === "" || content === "[]" || !content.includes(flow.specId),
        `.active-flow must not still reference the finalized spec (got: ${content})`);
    }
  });

  it("flow get status returns active:false after cleanup (R17 post-cleanup inactive)", async (t) => {
    const flow = await phaseAt(t, "finalize-cleanup");
    runCli(["run", "finalize-cleanup"], flow.root);

    const envelope = runCli(["get", "status"], flow.root);

    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.active, false, "flow get status must report active:false post-cleanup");
  });

  it("completes cleanup with an explicit warning when docs sync previously failed", async (t) => {
    const flow = await phaseAt(t, "finalize-sync");
    flow.docsMode = "failed";
    const failed = await flow.runRegistered("finalize-sync");
    assert.equal(failed.ok, false);
    flow.reload();
    assert.equal(flow.outbox("finalize-sync").status, "failed");
    assert.equal(flow.current(), "finalize-cleanup");
    assert.equal(flow.docsCalls.length, 1);
    flow.assertResults(["finalize-sync"], {
      expectedKinds: { "finalize-sync": "finalize-sync-skipped-with-warning" },
    });

    const envelope = runCli(["run", "finalize-cleanup"], flow.root);

    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.outcome, "completed_with_warnings", JSON.stringify(envelope));
    assert.equal(envelope.data.finalizeWarnings[0].code, "FINALIZE_SYNC_FAILED");
    assert.ok(envelope.errors.some((error) => error.code === "FINALIZE_SYNC_FAILED"));
  });
});

describe("flow run finalize-merge — shared CLI route (spec 478)", () => {
  it("executes the finalize-merge CLI route before the main-side cleanup route", async (t) => {
    const flow = await phaseAt(t, "finalize-merge");

    const envelope = runCli(["run", "finalize-merge"], flow.root);

    assert.equal(envelope.ok, true);
    assert.equal(envelope.key, "finalize-merge");
    assert.equal(envelope.data.strategy, "skip");
  });
});
