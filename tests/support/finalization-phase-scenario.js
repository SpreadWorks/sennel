import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { createHash } from "node:crypto";
import { AcceptancePhaseScenario } from "./acceptance-phase-scenario.js";
import { container } from "../../src/lib/container.js";
import { FlowOutboxStore, finalizationOutboxIdentity } from "../../src/flow/lib/flow-outbox.js";
import { runGit } from "../../src/lib/git-helpers.js";
import { StepResult } from "../../src/flow/engine/step-result.js";
import { DraftStepSettlementReceipt } from "../../src/flow/definition.js";
import { assertFinalizationPhaseResult, assertFinalizationPhaseSettlementRoundtrip } from "./assertions/finalization-phase-result.js";
import { futurePhaseManifests } from "./structure/phase-manifest.js";
import RunClaimNextActionCommand from "../../src/flow/lib/run-claim-next-action.js";
import { IssueLogDocument } from "../../src/flow/lib/issue-log-store.js";
import { assertCanonicalReportFinalEvidence } from "../../src/flow/lib/canonical-report-artifacts.js";

export const finalizationLeaves = Object.freeze(["finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"]);

/** Phase 04 is the lawful producer. Git, registry, Definition, Store and
 * recovery remain real; only the external docs build process is controlled.
 * Branch execution keeps immutable seeds self-contained (no linked .git file
 * in a clone may point back to a producer's repository). */
export class FinalizationPhaseScenario extends AcceptancePhaseScenario {
  static publicationObserverOptions = { leaves: futurePhaseManifests
    .filter((phase) => ["04", "05"].includes(phase.id)).flatMap((phase) => phase.leaves) };

  static create(t, options = {}) {
    return super.create(t, { config: { lang: "en", type: "base", commands: { gh: "disable" },
      docs: { languages: ["en"], defaultLanguage: "en" } }, ...options });
  }

  static seed(t, options = {}) {
    return super.seed(t, { frontier: "finalize-commit", ...options });
  }

  current() { const state = this.state(); return state.current?.at(-1) ?? state.nextAction()?.nodeId ?? null; }

  async advanceTo(stepId, limit = 64) {
    for (let index = 0; index < limit; index += 1) {
      if (this.current() === stepId) return this.claimFrontier(stepId);
      const outcome = await this.executeCurrent();
      this.reload();
      if (this.current() === stepId) return this.claimFrontier(stepId);
      assert.notEqual(this.current(), null, `production passed the requested ${stepId} frontier`);
      const next = await this.next();
      assert.ok(!["blocked", "await_user_decision", "await_draft_question"].includes(next.directive?.kind),
        `FINALIZATION_FRONTIER_BLOCKED: ${stepId}; current=${this.current()}; ${JSON.stringify({ outcome, directive: next.directive })}`);
      assert.ok(outcome.ok !== false || outcome.errors?.every((entry) => entry.code === "FLOW_DISPATCH_LIMIT_REACHED"),
        `real dispatcher cannot reach ${stepId}: ${JSON.stringify(outcome.errors)}`);
    }
    assert.fail(`real dispatcher did not reach ${stepId}`);
  }

  async claimFrontier(stepId) {
    if (finalizationLeaves.includes(stepId) && this.state().attempt?.nodeId !== stepId) {
      const claimed = await new RunClaimNextActionCommand().execute(this.context());
      assert.equal(claimed.ok, true, `the selected finalization frontier must use its real claim command: ${JSON.stringify(claimed)}`);
      this.reload();
      assert.equal(this.state().attempt.nodeId, stepId);
    }
    return this;
  }

  initialize() {
    if (!this.options.prepared && !this.seedClone) {
      // A normal project excludes runtime locks and temporary process files.
      // Produce this repository input before any dispatcher effect; a clone
      // keeps the immutable producer's Git tree and ignore rules unchanged.
      fs.writeFileSync(path.join(this.root, ".gitignore"), "/.tmp/\n/.sennel/*\n!/.sennel/config.json\n!/.sennel/output/\n");
      this.write("docs/overview.md", "Existing tracked documentation.\n");
      this.git(["add", ".gitignore", "docs/overview.md"]);
      this.git(["commit", "-m", "test: finalization documentation baseline"]);
    }
    super.initialize();
    this.seedActivityIds = new Set(this.seedClone
      ? this.manager.activityLedger(this.specId).map((activity) => activity.id) : []);
    this.docsCalls = [];
    this.ghCalls = [];
    this.docsMode = this.options.docsMode ?? "built";
    const previousGet = container.get.bind(container);
    this.finalizationConfig = mock.method(container, "get", (name) => name === "config"
      ? this.options.config : previousGet(name));
    const original = childProcess.spawnSync;
    this.docsProcess = mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command === "gh" && this.options.ghProcess) {
        this.ghCalls.push([...args]);
        return this.options.ghProcess(args, options, this);
      }
      if (command !== process.execPath || !String(args[0]).endsWith("/src/docs.js") || args[1] !== "build") {
        return original(command, args, options);
      }
      const outbox = this.outbox("finalize-sync");
      assert.equal(outbox.status, "pending", "docs effects need the actual saved pending outbox");
      this.docsCalls.push({ args: [...args], cwd: options.cwd, env: { ...options.env },
        identity: this.identity("finalize-sync").toJSON(), outbox });
      if (this.docsMode === "failed") return { status: 23, stdout: "docs build output\n", stderr: "docs build failed\n", signal: null };
      if (this.docsMode === "built") {
        fs.mkdirSync(path.join(options.cwd, "docs"), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, "docs", "overview.md"), "Generated from the merged implementation.\n");
      }
      return { status: 0, stdout: "docs build output\n", stderr: "", signal: null };
    });
    syncBuiltinESMExports();
  }

  git(args) {
    const result = runGit(args, { cwd: this.root });
    assert.equal(result.ok, true, `real Git fixture operation failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  write(relativePath, bytes) {
    const target = path.join(this.root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  createLocalRemote() {
    const remote = path.join(this.root, ".tmp", "remote.git");
    this.git(["init", "--bare", remote]);
    this.git(["remote", "add", "origin", remote]);
    return remote;
  }

  identity(stepId) { return finalizationOutboxIdentity(this.state(), stepId); }
  outbox(stepId) { return new FlowOutboxStore(this.manager).status(this.identity(stepId)); }
  report(consumerNodeId = "finalize-commit") {
    const artifact = this.manager.readArtifact({ specId: this.specId, logicalKey: "report", consumerNodeId });
    return { ...artifact, document: JSON.parse(artifact.bytes.toString("utf8")) };
  }

  assertCommitEvidence() {
    assertCanonicalReportFinalEvidence({ flowManager: this.manager, specId: this.specId,
      report: this.report().document });
  }

  syncFailureDiagnostics() {
    const stepId = "finalize-sync";
    const identity = this.identity(stepId);
    const outbox = this.outbox(stepId);
    assert.equal(outbox.status, "failed");
    const artifact = this.manager.readArtifact({ specId: this.specId,
      logicalKey: "issue.log", consumerNodeId: "finalize-cleanup" });
    const audit = new IssueLogDocument(JSON.parse(artifact.bytes));
    const entries = audit.entries.filter((entry) => entry.issueLogId === identity.idempotencyKey);
    assert.equal(entries.length, 1,
      `FINALIZATION_SYNC_AUDIT_MISSING: the actual sync failure needs exactly one issue-log audit for ${identity.idempotencyKey}`);
    const entry = entries[0];
    assert.equal(entry.step, stepId, "FINALIZATION_SYNC_AUDIT_SOURCE_MISMATCH: the outbox audit must belong to finalize-sync");
    assert.equal(entry.reason, outbox.failure, "FINALIZATION_SYNC_AUDIT_FAILURE_MISMATCH: the audit must retain the actual outbox failure");
    assert.ok(Array.isArray(entry.diagnostics),
      `FINALIZATION_SYNC_DIAGNOSTICS_MISSING: the issue-log audit ${identity.idempotencyKey} must retain the original build/diff diagnostics`);
    return entry.diagnostics;
  }
  gitSnapshot() {
    const untracked = this.git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")
      .filter((name) => name && !name.startsWith(".tmp/") && !name.includes("/.runtime/"))
      .map((name) => [name, createHash("sha256").update(fs.readFileSync(path.join(this.root, name))).digest("hex")]);
    return { head: this.git(["rev-parse", "HEAD"]), main: this.git(["rev-parse", "main"]),
      refs: this.git(["show-ref"]), index: this.git(["diff", "--cached", "--binary"]),
      unstaged: this.git(["diff", "--binary"]), untracked,
      dirty: this.git(["status", "--porcelain=v1", "--untracked-files=all"]) };
  }

  assertResults(nodeIds, { terminal = true, expectedKinds = {} } = {}) {
    if (nodeIds.every((id) => !finalizationLeaves.includes(id))) return super.assertResults(nodeIds, { terminal });
    const state = this.state();
    for (const stepId of nodeIds) {
      const candidates = this.manager.activityLedger(this.specId).filter((entry) => entry.nodeId === stepId
        && entry.result?.stepResult && (terminal
          ? entry.result.draftSettlementReceipt?.settlementKind !== "execution"
          : entry.result.draftSettlementReceipt?.settlementKind === "execution"));
      assert.ok(candidates.length, `FINALIZATION_PHASE_RESULT_MISSING: real ${stepId} command must save its dedicated StepResult and exact durable receipt`);
      const activity = candidates.at(-1);
      const result = StepResult.fromStored(stepId, activity.result.stepResult.toJSON?.() ?? activity.result.stepResult);
      if (expectedKinds[stepId] !== undefined) assert.equal(result.kind, expectedKinds[stepId],
        `the actual ${stepId} effect must preserve its specific semantic Result`);
      assertFinalizationPhaseResult(result);
      const settlement = assertFinalizationPhaseSettlementRoundtrip(result);
      DraftStepSettlementReceipt.assertStored(activity.result.draftSettlementReceipt, { result, settlement,
        binding: { runId: state.runId, specId: state.specId, stepId,
          attempt: { id: activity.attemptId, sequence: activity.sequence } } });
      const durable = this.manager.readCurrentStepSettlement({ specId: this.specId, stepId, completed: terminal });
      assert.ok(durable?.receipt, "the reconstructed manager must read the exact command settlement");
      assert.equal(durable.receipt.id, activity.result.draftSettlementReceipt.id);
      assert.deepEqual(durable.result.toJSON(), result.toJSON());
      if (!this.seedActivityIds.has(activity.id)) {
        const observed = this.publicationObserver.authenticate(this.manager, activity, result, settlement);
        assert.equal(observed.receipt.id, durable.receipt.id);
        if (settlement.kind === "target-connection") {
          assert.equal(observed.afterState.current?.at(-1) ?? observed.afterState.nextAction()?.nodeId,
            durable.receipt.targetStepId);
        }
      } else {
        // The seed's real producer saved this claim before copying. Readback
        // authenticates its canonical receipt; this instance cannot claim to
        // have observed that previous process's original saving arguments.
        assert.equal(terminal, false, "terminal finalization publication must be observed in the consuming instance");
      }
      if (settlement.kind !== "target-connection") {
        assert.equal(durable.receipt.connector, null);
        assert.equal(durable.receipt.targetStepId, null);
      }
    }
  }

  close() {
    this.docsProcess?.mock.restore();
    this.finalizationConfig?.mock.restore();
    syncBuiltinESMExports();
    super.close();
  }
}
