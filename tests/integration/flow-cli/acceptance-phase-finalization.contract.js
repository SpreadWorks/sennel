import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { after, before, describe, mock, test } from "node:test";

import RunRetroCommand from "../../../src/flow/lib/run-retro.js";
import RunReportCommand from "../../../src/flow/lib/run-report.js";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import RunRecoverFinalizationCommand from "../../../src/flow/lib/run-recover-finalization.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { FlowOutboxStore, finalizationOutboxIdentity } from "../../../src/flow/lib/flow-outbox.js";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { assertAcceptanceFinalRegressionEvidence } from "../../support/assertions/acceptance-final-regression.js";
import { shellPrintChildProcessRecord } from "../../support/infrastructure/child-process-record.js";
import { runGit } from "../../../src/lib/git-helpers.js";

function externalCalls(flow) {
  return { workers: flow.requests.length, reviews: flow.phaseReviews.length,
    acceptance: flow.acceptanceCalls.length };
}

function readReport(flow) {
  const artifact = flow.manager.readArtifact({ specId: flow.specId, logicalKey: "report",
    consumerNodeId: "report" });
  return { descriptor: artifact.descriptor, value: JSON.parse(artifact.bytes.toString("utf8")) };
}

/** Only the gh process is replaced. The real command, pending publication,
 * canonical outbox, registry error handling and receipt readback remain intact. */
class ReportRemote {
  #original;
  #mock;
  #bodies = [];
  calls = [];
  queryUnavailable = false;
  losePostResponse = false;

  constructor(t, flow) {
    this.#original = childProcess.spawnSync;
    this.#mock = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command !== "gh") return this.#original(command, args, options);
      this.calls.push([...args]);
      if (args[0] === "--version") return this.#result(0, "gh version fixture\n");
      if (args[0] === "issue" && args[1] === "view") {
        return this.queryUnavailable ? this.#result(1, "", "remote confirmation unavailable")
          : this.#result(0, this.#bodies.join("\n"));
      }
      assert.deepEqual(args.slice(0, 3), ["issue", "comment", String(flow.state().issue)]);
      const identity = finalizationOutboxIdentity(flow.manager.loadReadOnly(flow.specId), "report");
      const pending = readReport(flow).value;
      assert.equal(pending.data.delivery.status, "pending", "pending report is durable before remote submission");
      assert.equal(pending.data.delivery.idempotencyKey, identity.idempotencyKey);
      assert.equal(new FlowOutboxStore(flow.manager).status(identity).status, "pending");
      const body = args[args.indexOf("--body") + 1];
      assert.ok(body.endsWith(`<!-- sennel:${identity.idempotencyKey} -->`));
      this.#bodies.push(body);
      if (this.losePostResponse) return this.#result(1, "", "remote response lost after submission");
      return this.#result(0, "fixture comment posted\n");
    });
    syncBuiltinESMExports();
    t.after(() => { this.#mock.mock.restore(); syncBuiltinESMExports(); });
  }

  #result(status, stdout, stderr = "") {
    return { status, signal: null, error: undefined, stdout, stderr };
  }

  get submissions() { return this.calls.filter((args) => args[0] === "issue" && args[1] === "comment").length; }
  get confirmations() { return this.calls.filter((args) => args[0] === "issue" && args[1] === "view").length; }
}

describe("d538 real producer to regression and report consumer contracts", { concurrency: false }, () => {
  let ordinary;
  let linked;
  const seedCleanups = [];
  after(() => { for (const cleanup of seedCleanups.reverse()) cleanup(); });
  before(async () => {
    const scope = { mock, after(cleanup) { seedCleanups.push(cleanup); } };
    ordinary = await AcceptancePhaseScenario.seed(scope, { frontier: "retro" });
    linked = await AcceptancePhaseScenario.seed(scope, { frontier: "retro", issue: 538,
      issueSnapshot: "# Acceptance fixture issue\nImplement the required behavior.\n" });
  });
  function scenario(context, options = {}) {
    return AcceptancePhaseScenario.fromSeed(context, options.issue === 538 ? linked : ordinary);
  }

for (const stale of [false, true]) {
  test(`A04 retro ${stale ? "stale" : "current"} preview leaves canonical evidence and execution counts unchanged`, async (t) => {
    const flow = scenario(t);
    await flow.advanceTo("retro");
    flow.reload();
    const execution = flow.commandArtifact("test.execute", "retro");
    const review = flow.commandArtifact("test.result.review", "retro");
    assert.equal(review.payload.testExecute.producerActivityId, execution.descriptor.activityId);
    if (stale) fs.appendFileSync(path.join(flow.root, "src/implementation.js"), "// external source drift after Gate\n");
    const before = flow.snapshot();
    const calls = externalCalls(flow);
    const preview = await new RunRetroCommand().execute({ ...flow.context(), dryRun: true });
    assert.deepEqual(flow.reload().snapshot(), before,
      "RETRO_PREVIEW_MUTATED_CANONICAL: dry-run must not apply the stale evidence rewind");
    assert.deepEqual(externalCalls(flow), calls);
    assert.equal(preview.result, "dry-run");
    assert.equal(flow.manager.readProducerArtifact({ specId: flow.specId, nodeId: "retro", logicalKey: "retro", optional: true }), null);
  });
}

test("A04 normal Retro source drift refreshes the actual test producer with a new Attempt and preserves old history", async (t) => {
  const flow = scenario(t);
  await flow.advanceTo("retro");
  flow.reload();
  const before = flow.commandArtifact("test.execute", "retro");
  const previousExecution = flow.manager.activityLedger(flow.specId)
    .find((activity) => activity.id === before.descriptor.activityId);
  assert.equal(previousExecution.nodeId, "test-execute");
  const activities = flow.manager.activityLedger(flow.specId);
  fs.appendFileSync(path.join(flow.root, "src/implementation.js"), "// changed source requires new test evidence\n");
  const recovered = await flow.runRegistered("retro");
  assert.equal(recovered.result, "recovered");
  flow.reload();
  assert.equal(flow.current(), "test-execute");
  assert.notEqual(flow.state().attempt.id, previousExecution.attemptId);
  assert.equal(flow.manager.readArtifact({ specId: flow.specId, logicalKey: "retro",
    consumerNodeId: "acceptance-review", optional: true }), null);
  await flow.advanceTo("retro");
  flow.reload();
  const refreshed = flow.commandArtifact("test.execute", "retro");
  assert.notEqual(refreshed.descriptor.activityId, before.descriptor.activityId);
  assert.notEqual(refreshed.payload.repairFingerprint, before.payload.repairFingerprint);
  assert.equal(flow.commandArtifact("test.result.review", "retro").payload.testExecute.producerActivityId, refreshed.descriptor.activityId);
  const history = flow.manager.activityLedger(flow.specId);
  for (const activity of activities) assert.ok(history.some((entry) => entry.id === activity.id));
  flow.assertResults(["retro"]);
});

test("A06 Definition's exact failed-regression choice preserves FAIL and residual risk through actual report publication", async (t) => {
  const flow = scenario(t);
  await flow.advanceTo("final-regression");
  flow.reload();
  const script = path.join(flow.root, "project-tests", "regression.sh");
  fs.writeFileSync(script, ["printf '%s\\n' 'current behavior failed' >&2", shellPrintChildProcessRecord({
    command: ["node", "--test", "project-tests/smoke.test.js"],
    stderr: "ERR_ASSERTION\nsrc/implementation.js: required behavior is missing\n",
  }), "exit 1", ""].join("\n"));
  const configPath = path.join(flow.root, ".sennel", "config.json");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {
    lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
  };
  fs.writeFileSync(configPath, JSON.stringify({ ...config, test: { ...config.test,
    command: "sh project-tests/regression.sh", timeout: 5 } }));
  const executions = [];
  const execute = childProcess.execFile;
  const observed = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    if (options.cwd === flow.root) executions.push([command, ...args]);
    return execute(command, args, options, callback);
  });
  syncBuiltinESMExports();
  t.after(() => { observed.mock.restore(); syncBuiltinESMExports(); });
  const failed = await flow.runRegistered("final-regression");
  assert.equal(failed.result, "fail");
  flow.reload();
  const first = flow.commandArtifact("final.regression", "final-regression");
  assertAcceptanceFinalRegressionEvidence(flow, first, { result: "fail", exitCode: 1,
    failureKind: "caused_by_current_change" });
  const before = flow.snapshot();
  const refused = await flow.runRegistered("final-regression", { recordAndProceed: true,
    recordCategory: "out_of_scope", recordEvidence: "No exact user Action yet", remainingRisk: "Regression remains red" });
  assert.equal(refused.ok, false);
  assert.match(refused.errors[0].messages.join("\n"), /Definition selected repair/);
  assert.deepEqual(flow.reload().snapshot(), before, "unselected acceptance must preserve the failed Attempt and budget");
  const claim = await new RunClaimNextActionCommand().execute(flow.context());
  assert.equal(claim.ok, true, JSON.stringify(claim));
  flow.reload();
  const retry = await flow.runRegistered("final-regression");
  assert.equal(retry.result, "fail");
  flow.reload();
  const latest = flow.commandArtifact("final.regression", "final-regression");
  assertAcceptanceFinalRegressionEvidence(flow, latest, { result: "fail", exitCode: 1,
    failureKind: "caused_by_current_change" });
  assert.notEqual(latest.descriptor.activityId, first.descriptor.activityId);
  const firstExecution = flow.manager.activityLedger(flow.specId)
    .find((activity) => activity.id === first.descriptor.activityId);
  const latestExecution = flow.manager.activityLedger(flow.specId)
    .find((activity) => activity.id === latest.descriptor.activityId);
  assert.equal(firstExecution.nodeId, "final-regression");
  assert.equal(latestExecution.nodeId, "final-regression");
  assert.notEqual(latestExecution.attemptId, firstExecution.attemptId);
  assert.equal(executions.length, 2);
  const action = await flow.next();
  assert.equal(action.directive.kind, "await_user_decision");
  assert.equal(action.directive.actionPrompt.choices[0].actionId, "ACCEPT_FINAL_REGRESSION_FAILURE");
  const risk = "The complete regression remains red for the explicitly accepted failure.";
  const accepted = await flow.runRegistered("final-regression", { recordAndProceed: true,
    recordCategory: "out_of_scope", recordEvidence: "The exact current failed execution is explicitly accepted.", remainingRisk: risk });
  assert.equal(accepted.result, "fail");
  assert.equal(accepted.failedRecorded, true);
  flow.reload();
  assert.equal(flow.current(), "report");
  const final = flow.commandArtifact("final.regression", "report");
  assertAcceptanceFinalRegressionEvidence(flow, final, { result: "fail", exitCode: 1,
    failureKind: "caused_by_current_change" });
  assert.equal(final.payload.result, "fail");
  assert.equal(final.payload.remainingRisk, risk);
  assert.deepEqual(final.payload.recordAndProceed.executionBinding, latest.payload.executionBinding,
    "acceptance does not execute or reinterpret the failed project command");
  assert.equal(executions.length, 2, "the exact explicit acceptance cannot re-execute the failed regression");
  const reportClaim = await new RunClaimNextActionCommand().execute(flow.context());
  assert.equal(reportClaim.ok, true, JSON.stringify(reportClaim));
  flow.reload();
  assert.equal(flow.state().attempt.nodeId, "report");
  const reported = await flow.runRegistered("report");
  assert.equal(reported.result, "ok", JSON.stringify(reported));
  flow.reload();
  const report = readReport(flow).value;
  assert.equal(report.data.tests.finalRegression.result, "fail");
  assert.equal(report.data.tests.finalRegression.remainingRisk, risk);
  assert.ok(report.text.includes(risk));
  flow.assertResults(["final-regression", "report"]);
});

test("A07 unlinked report preview does not publish, claim an outbox or change the source frontier", async (t) => {
  const flow = scenario(t);
  await flow.advanceTo("report");
  flow.reload();
  const before = flow.snapshot();
  const calls = externalCalls(flow);
  const preview = await flow.runRegistered("report", { dryRun: true });
  assert.equal(preview.result, "dry-run");
  assert.deepEqual(flow.reload().snapshot(), before);
  assert.deepEqual(externalCalls(flow), calls);
  assert.equal(flow.manager.readProducerArtifact({ specId: flow.specId, nodeId: "report", logicalKey: "report", optional: true }), null);
});

test("A07 linked report publishes pending before delivery and reload observes the same completed outbox identity", async (t) => {
  const flow = scenario(t, { issue: 538, issueSnapshot: "# Acceptance fixture issue\nImplement the required behavior.\n" });
  const remote = new ReportRemote(t, flow);
  await flow.advanceTo("report");
  flow.reload();
  assert.equal(flow.state().issue, 538);
  const identity = finalizationOutboxIdentity(flow.manager.loadReadOnly(flow.specId), "report");
  const delivered = await flow.runRegistered("report");
  assert.equal(delivered.result, "ok");
  flow.reload();
  const report = readReport(flow).value;
  assert.equal(report.data.delivery.status, "done");
  assert.equal(report.data.delivery.idempotencyKey, identity.idempotencyKey);
  const outbox = new FlowOutboxStore(flow.manager).status(identity);
  assert.equal(outbox.status, "done");
  assert.equal(outbox.idempotencyKey, identity.idempotencyKey);
  assert.equal(remote.submissions, 1);
  assert.equal(remote.confirmations, 1);
  assert.equal(flow.current(), "finalize-commit");
  flow.assertResults(["report"]);
});

test("A07 lost report delivery response retains pending evidence and exact recovery confirms remote success without duplicate submission", async (t) => {
  const flow = scenario(t, { issue: 538 });
  const remote = new ReportRemote(t, flow);
  await flow.advanceTo("report");
  flow.reload();
  const identity = finalizationOutboxIdentity(flow.manager.loadReadOnly(flow.specId), "report");
  remote.losePostResponse = true;
  const failed = await flow.runRegistered("report");
  assert.equal(failed.ok, false);
  assert.match(failed.errors[0].messages.join("\n"), /remote response lost after submission/);
  flow.reload();
  assert.equal(readReport(flow).value.data.delivery.status, "pending");
  assert.equal(new FlowOutboxStore(flow.manager).status(identity).status, "failed");
  assert.equal(flow.state().findNode("report").status === "done", false);
  assert.equal(remote.submissions, 1);
  remote.losePostResponse = false;
  const recovery = await new RunRecoverFinalizationCommand().execute(flow.context());
  assert.equal(recovery.ok, true, "REPORT_RECOVERY_NOT_ADMITTED: Definition must provide exact recovery for the persisted pending delivery");
  flow.reload();
  await flow.runRegistered("report");
  flow.reload();
  assert.equal(remote.submissions, 1);
  assert.equal(remote.confirmations, 2);
  assert.equal(new FlowOutboxStore(flow.manager).status(identity).status, "done");
  assert.equal(readReport(flow).value.data.delivery.idempotencyKey, identity.idempotencyKey);
  assert.equal(flow.current(), "finalize-commit");
  flow.assertResults(["report"]);
});

test("A07 pending report preview makes zero remote calls and preserves the failed delivery exactly", async (t) => {
  const flow = scenario(t, { issue: 538 });
  const remote = new ReportRemote(t, flow);
  await flow.advanceTo("report");
  remote.queryUnavailable = true;
  const failed = await flow.runRegistered("report");
  assert.equal(failed.ok, false);
  assert.match(failed.errors[0].messages.join("\n"), /remote confirmation unavailable/);
  flow.reload();
  const pending = readReport(flow);
  assert.equal(pending.value.data.delivery.status, "pending");
  const before = flow.snapshot();
  const calls = remote.calls.length;
  const identity = finalizationOutboxIdentity(flow.manager.loadReadOnly(flow.specId), "report");
  const entry = new FlowOutboxStore(flow.manager).status(identity);
  let preview;
  let error;
  try { preview = await new RunReportCommand().execute({ ...flow.context(), dryRun: true, flowOutboxEntry: entry }); }
  catch (failure) { error = failure; }
  assert.equal(remote.calls.length, calls, "REPORT_PREVIEW_REMOTE_CALL: pending delivery must not be resumed by preview");
  assert.equal(error, undefined, "pending preview must return a preview without delivery failure");
  assert.equal(preview.result, "dry-run");
  assert.equal(remote.submissions, 0);
  assert.deepEqual(flow.reload().snapshot(), before);
  assert.equal(readReport(flow).descriptor.activityId, pending.descriptor.activityId);
});

test("A07 report persistence failure preserves the admitted Attempt, catalog and outbox before commit", async (t) => {
  const flow = scenario(t);
  await flow.advanceTo("report");
  let ctx = flow.context();
  await FLOW_COMMANDS.run.report.pre(ctx);
  flow.reload();
  ctx = { ...ctx, ...flow.context() };
  const generated = await new RunReportCommand().execute(ctx);
  const before = flow.snapshot();
  let injected = false;
  const failure = new Error("injected report canonical write failure");
  flow.reload({ versionStoreFaultInjector({ phase }) {
    if (!injected && phase === "before-current-flow-state-temp-write") { injected = true; throw failure; }
  } });
  ctx = { ...ctx, ...flow.context() };
  await assert.rejects(() => FLOW_COMMANDS.run.report.post(ctx, generated), (error) => error === failure);
  assert.equal(injected, true, "the fault must reach the production canonical save boundary");
  flow.reload();
  assert.deepEqual(flow.snapshot(), before);
  assert.equal(flow.manager.readProducerArtifact({ specId: flow.specId, nodeId: "report", logicalKey: "report", optional: true }), null);
  assert.equal(flow.current(), "report");
});

test("A07 commit response loss reuses the exact report receipt without regenerating or republishing", async (t) => {
  const flow = scenario(t);
  await flow.advanceTo("report");
  const ctx = flow.context();
  await FLOW_COMMANDS.run.report.pre(ctx);
  const generated = await new RunReportCommand().execute(ctx);
  const lost = new Error("caller lost the response after canonical report commit");
  await assert.rejects(async () => {
    await FLOW_COMMANDS.run.report.post(ctx, generated);
    throw lost;
  }, (error) => error === lost);
  flow.reload();
  const committed = flow.snapshot();
  const published = readReport(flow);
  const calls = externalCalls(flow);
  assert.equal(flow.current(), "finalize-commit");
  const current = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "report", completed: true });
  assert.ok(current?.receipt, "REPORT_EXACT_RECEIPT_MISSING: a completed report must survive lost acknowledgement as an exact durable settlement");
  assert.equal(current.result.kind, "report-generated");
  await FLOW_COMMANDS.run.report.post({ ...ctx, flowManager: flow.manager }, generated);
  flow.reload();
  assert.deepEqual(flow.snapshot(), committed);
  assert.equal(readReport(flow).descriptor.activityId, published.descriptor.activityId);
  assert.equal(flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "report", completed: true }).receipt.id, current.receipt.id);
  assert.deepEqual(externalCalls(flow), calls);
  flow.assertResults(["report"]);
});

test("A07 actual finalize-commit admission rejects a report whose bound source changed before staging", async (t) => {
  const flow = scenario(t);
  await flow.advanceTo("report");
  await flow.runRegistered("report");
  flow.reload();
  assert.equal(flow.current(), "finalize-commit");
  const report = readReport(flow).value;
  const source = report.data.binding.sourceArtifacts.find((entry) => entry.path.endsWith("spec.json"));
  assert.ok(source, "the actual generated report must bind its canonical Spec source");
  // Malformed external mutation is a boundary rejection input, never a legal
  // replacement Spec producer. The lawful Spec-change scenario is separate.
  fs.appendFileSync(path.join(flow.root, source.path), "\n");
  const beforeHead = runGit(["rev-parse", "HEAD"], { cwd: flow.root });
  assert.equal(beforeHead.ok, true, beforeHead.stderr);
  const beforeIndex = runGit(["diff", "--cached", "--binary"], { cwd: flow.root });
  assert.equal(beforeIndex.ok, true, beforeIndex.stderr);
  let rejected;
  let rejection;
  try { rejected = await flow.runRegistered("finalize-commit", { message: "test: acceptance handoff" }); }
  catch (error) { rejection = error; }
  assert.equal(rejection !== undefined || rejected.ok === false, true,
    "FINALIZE_REPORT_ADMISSION_MISSING: the actual commit consumer must validate the accepted report source binding before staging");
  const errors = rejection ? [{ code: rejection.code, messages: [rejection.message] }] : rejected.errors;
  assert.ok(errors.some((error) => error.code === "REPORT_BINDING_STALE"
    || error.messages.some((message) => /(?:hash|source|binding).*?(?:stale|changed|mismatch)|(?:stale|changed|mismatch).*?(?:hash|source|binding)/i.test(message)
      || message.includes("artifact content does not match the catalog") && message.includes("spec.json"))),
    "the refusal must identify changed source evidence, not an unrelated setup failure");
  assert.equal(runGit(["rev-parse", "HEAD"], { cwd: flow.root }).stdout, beforeHead.stdout);
  assert.equal(runGit(["diff", "--cached", "--binary"], { cwd: flow.root }).stdout, beforeIndex.stdout);
});

});
