import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { createTmpDir, removeTmpDir } from "../../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../../support/infrastructure/git-repo.js";
import {
  canonicalImplReviewArtifact,
  CanonicalFlowFixture,
  draftDocumentWithPendingQuestions,
  FlowAtStepFixture,
  makeFlowManager,
} from "../../../support/infrastructure/flow-setup.js";
import {
  FlowTargetBinding,
  FlowTargetExpectation,
} from "../../../../src/lib/flow-target-guard.js";
import { ArtifactViewService } from "../../../../src/flow/lib/artifact-view-service.js";
import { splitArtifactViewSummary } from "../../../../src/flow/lib/artifact-view-summary.js";
import {
  FlowDispatchSession,
  FlowDispatchTarget,
} from "../../../../src/flow/lib/dispatch-invocation.js";
import { attachCanonicalCommandResultArtifact } from "../../../../src/flow/lib/canonical-command-result.js";
import RunRepairPlanGateCommand from "../../../../src/flow/lib/run-repair-plan-gate.js";

const SENNEL = path.resolve("src/sennel.js");

class DispatchFlowScenario {
  constructor(root, {
    step = "draft",
    autoApprove = false,
    pending = false,
    specId = "001-dispatch",
    runId = "run-dispatch",
  } = {}) {
    this.root = root;
    this.manager = makeFlowManager(root);
    const fixtureInput = {
      flowManager: this.manager,
      specId,
      runId,
      request: "Verify canonical dispatch boundaries.",
      execution: { mode: "direct" },
      autoApprove,
      specRecord: { goal: "Dispatch fixture", requirements: [] },
    };
    this.fixture = pending
      ? new CanonicalFlowFixture(fixtureInput).create().registerActive().settleBefore(step)
      : new FlowAtStepFixture({ ...fixtureInput, targetStep: step }).create();
    this.state = this.fixture.state();
  }

  binding() {
    return FlowTargetBinding.capture({
      flowState: this.state,
      mainRoot: this.root,
      authorityRoot: this.root,
    }).serialize();
  }

  args(extra = []) {
    return [
      SENNEL,
      "flow",
      "run",
      "dispatch",
      "--expect-run-id",
      this.state.runId,
      "--expect-spec",
      this.state.specId,
      ...extra,
    ];
  }
}

function installWorker(root, {
  delayMs = 75,
  holdForRelease = false,
  captureInput = false,
  failAfterCapture = false,
} = {}) {
  const worker = path.join(root, "serial-worker.mjs");
  const workDir = path.join(root, ".tmp");
  const count = path.join(workDir, "worker-count.txt");
  const lock = path.join(workDir, "worker.lock");
  const overlap = path.join(workDir, "worker-overlap.txt");
  const release = path.join(workDir, "worker.release");
  const prompt = path.join(workDir, "worker-prompt.txt");
  const invocation = path.join(workDir, "worker-invocation.json");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(worker, [
    'import fs from "node:fs";',
    `const countFile=${JSON.stringify(count)};`,
    `const lockFile=${JSON.stringify(lock)};`,
    `const overlapFile=${JSON.stringify(overlap)};`,
    `const releaseFile=${JSON.stringify(release)};`,
    'if (fs.existsSync(lockFile)) fs.writeFileSync(overlapFile, "overlap\\n");',
    'fs.writeFileSync(lockFile, String(process.pid));',
    'const previous=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,"utf8")):0;',
    'fs.writeFileSync(countFile, String(previous+1));',
    ...(captureInput ? [
      `fs.writeFileSync(${JSON.stringify(prompt)},process.argv.at(-1)||"");`,
      `fs.writeFileSync(${JSON.stringify(invocation)},process.env.SENNEL_FLOW_DISPATCH_INVOCATION||"");`,
    ] : []),
    ...(failAfterCapture ? ['throw new Error("intentional worker capture failure");'] : []),
    holdForRelease
      ? 'const releaseDeadline=Date.now()+10_000; while (!fs.existsSync(releaseFile)) { if (Date.now() >= releaseDeadline) { fs.rmSync(lockFile,{force:true}); throw new Error("timed out waiting for worker release"); } await new Promise((resolve)=>setTimeout(resolve,10)); }'
      : `await new Promise((resolve)=>setTimeout(resolve,${delayMs}));`,
    'fs.rmSync(lockFile,{force:true});',
    'process.stdout.write("premature normal worker response");',
  ].join("\n"));
  fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel/config.json"), `${JSON.stringify({
    lang: "ja",
    type: "base",
    docs: { languages: ["ja"], defaultLanguage: "ja" },
    agent: {
      default: "test-worker",
      workDir: ".tmp",
      timeout: 30,
      providers: {
        "test-worker": { command: process.execPath, args: [worker, "{{PROMPT}}"] },
      },
    },
  }, null, 2)}\n`);
  return { count, lock, overlap, release, prompt, invocation };
}

function installSummaryAgent(root) {
  const workDir = path.join(root, ".tmp");
  const worker = path.join(root, "artifact-summary-agent.mjs");
  const responses = path.join(workDir, "artifact-summary-responses.json");
  const calls = path.join(workDir, "artifact-summary-calls.txt");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(responses, "[]\n");
  fs.writeFileSync(worker, [
    'import fs from "node:fs";',
    `const responsesFile=${JSON.stringify(responses)};`,
    `const callsFile=${JSON.stringify(calls)};`,
    'const queue=JSON.parse(fs.readFileSync(responsesFile,"utf8"));',
    'const index=fs.existsSync(callsFile)?Number(fs.readFileSync(callsFile,"utf8")):0;',
    'if (typeof queue[index] !== "string") throw new Error("unexpected artifact summary request");',
    'fs.writeFileSync(callsFile,String(index+1));',
    'process.stdout.write(queue[index]);',
  ].join("\n"));
  fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel/config.json"), `${JSON.stringify({
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
    agent: {
      default: "artifact-summary-agent",
      workDir: ".tmp",
      timeout: 30,
      providers: {
        "artifact-summary-agent": { command: process.execPath, args: [worker, "{{PROMPT}}"] },
      },
    },
  }, null, 2)}\n`);
  return {
    calls,
    setResponses(values) {
      fs.writeFileSync(responses, `${JSON.stringify(values)}\n`);
    },
    callCount() {
      return fs.existsSync(calls) ? Number(fs.readFileSync(calls, "utf8")) : 0;
    },
  };
}

function ensureGitRepository(root) {
  if (fs.existsSync(path.join(root, ".git"))) return;
  // Dispatch fingerprints product worktree changes, while Flow state and
  // runtime logs are generated control-plane data. Mirror the project ignore
  // boundary so an approval token does not become stale merely because the
  // preceding boundary wrote its own runtime log.
  fs.writeFileSync(path.join(root, ".gitignore"), [
    ".sennel/*",
    "!.sennel/config.json",
    ".tmp/",
    "**/.runtime/",
    "",
  ].join("\n"));
  initGitRepo(root);
  commitAll(root, "initial dispatch fixture");
}

function invocationOptions(root) {
  return {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, SENNEL_WORK_ROOT: root },
  };
}

function invokeCli(root, args) {
  ensureGitRepository(root);
  const result = spawnSync(process.execPath, args, invocationOptions(root));
  return {
    ...result,
    envelope: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

function invoke(scenario, extra = []) {
  return invokeCli(scenario.root, scenario.args(extra));
}

function invokeFlow(root, args) {
  return invokeCli(root, [SENNEL, "flow", ...args]);
}

function attemptHistory(logicalKey, payload) {
  return Buffer.from(`${JSON.stringify({
    attempts: [{ attempt: 1, artifact: { logicalKey, payload } }],
  }, null, 2)}\n`, "utf8");
}

function acceptanceDecisionScenario(root) {
  const manager = makeFlowManager(root);
  const created = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "002-acceptance-decision",
    runId: "run-acceptance-decision",
    request: "Verify read-only acceptance decision views.",
    execution: { mode: "direct" },
    specRecord: {
      goal: "Render the cataloged acceptance review.",
      requirements: [{ id: "R1", desc: "Show the acceptance evidence.", task_ids: ["T1"] }],
    },
  }).create().addTask({
    id: "T1",
    title: "Render acceptance evidence",
    goal: "Keep the acceptance decision view bound to its Requirement.",
    parent: null,
    origin: "plan",
    added_round: 0,
    status: "pending",
    acceptance: ["The acceptance evidence is visible."],
  }).registerActive();
  const repairFingerprint = "a".repeat(64);
  const implReview = canonicalImplReviewArtifact(created.state(), { blockingFindings: [{
    findingKey: "source-F1",
    title: "Cataloged acceptance source",
    failureMode: "unresolved_acceptance_source",
    file: null,
    issue: "An original cataloged finding remains visible.",
    detail: "This detail comes from the authoritative implementation-review attempt.",
    suggestion: "Resolve the source finding before a later review.",
    requirementId: "R1",
    guardrailId: null,
    disposition: "informational",
    rationale: "The cataloged acceptance source remains unresolved.",
  }] });
  const sourceFinding = implReview.blockingFindings[0];
  const deferred = {
    findingId: "F1",
    sourceStep: "impl-review",
    sourceArtifact: "steps/impl/review/result.json",
    sourceFindingId: sourceFinding.findingId,
    finalDisposition: "still_open",
    evidenceRefs: [`steps/impl/review/result.json#${sourceFinding.findingId}`],
  };
  created.activate("impl-review");
  manager.publishArtifacts({
    specId: created.specId,
    nodeId: "impl-review",
    artifactWrites: [
      {
        logicalKey: "impl.review",
        mediaType: "application/json",
        bytes: attemptHistory("impl.review", implReview),
      },
      {
        logicalKey: "flow.findings",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify({
          version: 2,
          entries: [{
            findingId: deferred.findingId,
            sourceStep: deferred.sourceStep,
            sourceArtifact: deferred.sourceArtifact,
            sourceFindingId: deferred.sourceFindingId,
            runId: created.state().runId,
            fingerprint: "b".repeat(64),
            disposition: "deferred",
            rationale: "The finding remains visible for an explicit decision.",
            retryExhausted: true,
            attempts: 5,
            round: 1,
            completionKind: "deferred",
            finalDisposition: deferred.finalDisposition,
          }],
        }, null, 2)}\n`, "utf8"),
      },
    ],
  });
  created.activate("acceptance-review");
  manager.publishArtifacts({
    specId: created.specId,
    nodeId: "acceptance-review",
    artifactWrites: [{
      logicalKey: "acceptance.review",
      mediaType: "application/json",
      bytes: attemptHistory("acceptance.review", {
        version: 2,
        repairFingerprint,
        mechanicalBlockers: [],
        hardBlockers: [deferred],
        requirementJudgments: [{
          requirementId: "R1",
          status: "notVerifiable",
          requestRefs: ["flow.request"],
          requirementRefs: ["spec.json#R1"],
          diffRefs: [],
          repairRefs: ["acceptance:no-repair"],
          testRefs: [],
          missingEvidence: ["An explicit risk decision is required."],
        }],
        deferredFindings: [deferred],
        userDecision: null,
        verdict: "user_decision_required",
      }),
    }],
  });
  created.activate("acceptance-decision");
  const state = created.state();
  return {
    manager,
    state,
    location: created.location(),
    binding: FlowTargetBinding.capture({
      flowState: state,
      mainRoot: root,
      authorityRoot: root,
    }).serialize(),
  };
}

function draftQuestionScenario(root) {
  const manager = makeFlowManager(root);
  const created = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "003-draft-question",
    runId: "run-draft-question",
    request: "Verify guarded draft-question continuation.",
    execution: { mode: "direct" },
  }).create().registerActive().activate("draft");
  manager.publishArtifacts({
    specId: created.specId,
    nodeId: "draft",
    artifactWrites: [{
      logicalKey: "draft",
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(draftDocumentWithPendingQuestions(), null, 2)}\n`, "utf8"),
    }],
  });
  created.activate("draft-refine");
  const state = created.state();
  return {
    manager,
    state,
    binding: FlowTargetBinding.capture({
      flowState: state,
      mainRoot: root,
      authorityRoot: root,
    }).serialize(),
  };
}

function relativeTree(directory, { excludeViews = false } = {}) {
  const values = [];
  const walk = (current, prefix = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (excludeViews && relative === ".runtime/views") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        values.push([relative, fs.readFileSync(absolute).toString("base64")]);
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return values;
}

function decisionSnapshot(location) {
  const flowState = fs.readFileSync(location.flowStateFile, "utf8");
  const activities = fs.readFileSync(location.activitiesFile, "utf8");
  const parsedState = JSON.parse(flowState);
  const approvalReceipts = activities.trim() === ""
    ? []
    : activities.trim().split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "dispatch_approval_recorded")
      .map((entry) => entry.transition.approval);
  return {
    flowState,
    activities,
    metrics: parsedState.metrics ?? null,
    approvalReceipts,
    versionWithoutViews: relativeTree(location.directory, { excludeViews: true }),
  };
}

function viewSnapshot(location) {
  return relativeTree(path.join(location.directory, ".runtime", "views"));
}

const SUMMARY_FIELDS = Object.freeze({
  spec: Object.freeze([
    { kind: "purpose", property: "purpose" },
    { kind: "scope", property: "scope" },
    { kind: "constraints", property: "constraints" },
    { kind: "openQuestions", property: "openQuestions" },
    { kind: "requirement", property: "requirements", identity: "requirementId" },
    { kind: "task", property: "tasks", identity: "taskId" },
  ]),
  acceptance: Object.freeze([
    { kind: "requirementJudgment", property: "requirements", identity: "requirementId", status: true },
    { kind: "mechanicalBlocker", property: "mechanicalBlockers", identity: "blockerId" },
    { kind: "hardBlocker", property: "hardBlockers", identity: "blockerId" },
    { kind: "deferredFinding", property: "deferredFindings", identity: "findingId" },
    { kind: "remainingRisk", property: "remainingRisks", identity: "riskId" },
  ]),
});

function exactSummaryResponses(fullView, target) {
  const fields = SUMMARY_FIELDS[target];
  return splitArtifactViewSummary(fullView)
    .filter((chunk) => chunk.units.some((unit) => fields.some((field) => field.kind === unit.kind)))
    .map((chunk) => {
      const response = {};
      for (const field of fields) {
        const units = chunk.units.filter((unit) => unit.kind === field.kind);
        if (units.length === 0) continue;
        const excerpt = (unit) => ({ sourceRefs: [unit.id], excerpt: unit.markdown });
        response[field.property] = field.identity == null
          ? excerpt(units[0])
          : units.map((unit) => ({
            [field.identity]: unit.identity,
            ...(field.status ? { status: unit.status } : {}),
            ...excerpt(unit),
          }));
      }
      return JSON.stringify(response);
    });
}

function envelopeNextAction(envelope) {
  return envelope.data.nextAction ?? envelope.data;
}

function actionPrompt(envelope) {
  return envelopeNextAction(envelope).directive.actionPrompt;
}

function viewChoice(prompt, actionId) {
  const choice = prompt.choices.find((entry) => entry.actionId === actionId);
  assert.ok(choice, `missing ${actionId} view choice`);
  return choice;
}

function parsedViewChoice(choice) {
  const match = /^sennel flow get artifact ([a-z][a-z0-9.]*) --mode (summary|full) --expect-binding '([^']+)'(?: --expect-no-issue)?$/.exec(choice.nextAction || "");
  assert.ok(match, `view choice must be one exact guarded artifact command: ${choice.nextAction}`);
  return {
    logicalKey: match[1],
    mode: match[2],
    binding: match[3],
    expectsNoIssue: choice.nextAction.endsWith(" --expect-no-issue"),
  };
}

function invokeViewChoice(root, choice, { binding = null } = {}) {
  const parsed = parsedViewChoice(choice);
  return invokeFlow(root, [
    "get", "artifact", parsed.logicalKey,
    "--mode", parsed.mode,
    "--expect-binding", binding ?? parsed.binding,
    ...(parsed.expectsNoIssue ? ["--expect-no-issue"] : []),
  ]);
}

function approvalBoundaryBinding(boundary) {
  const binding = boundary.envelope.data.dispatch.binding;
  assert.match(binding, /^[A-Za-z0-9_-]+$/);
  assert.equal(parsedViewChoice(viewChoice(
    actionPrompt(boundary.envelope),
    "REVIEW_SPECIFICATION_SUMMARY",
  )).binding, binding);
  return binding;
}

function approveApprovalBoundary(root, boundary) {
  return invokeFlow(root, [
    "run",
    "dispatch",
    "--expect-binding",
    approvalBoundaryBinding(boundary),
    "--expect-no-issue",
    "--approve",
    boundary.envelope.data.dispatch.approvalToken,
  ]);
}

function staleBinding(root, state) {
  const staleAuthority = path.join(root, "stale-artifact-view-authority");
  fs.mkdirSync(staleAuthority, { recursive: true });
  return new FlowTargetBinding({
    runId: state.runId,
    issue: state.issue,
    specId: state.specId,
    authority: {
      mode: "direct",
      mainRoot: staleAuthority,
      executionRoot: staleAuthority,
      featureBranch: null,
      baseBranch: null,
    },
  }).serialize();
}

function assertReacquiredDecision({
  root,
  binding,
  expectedPrompt,
  expectedBoundary,
  approvalToken,
  location,
  snapshot,
}) {
  const nextAction = invokeFlow(root, ["get", "next-action", "--expect-binding", binding]);
  assert.equal(nextAction.status, 0, nextAction.stderr);
  assert.deepEqual(actionPrompt(nextAction.envelope), expectedPrompt);
  const dispatch = invokeFlow(root, ["run", "dispatch", "--expect-binding", binding]);
  assert.equal(dispatch.status, 0, dispatch.stderr);
  assert.equal(dispatch.envelope.data.dispatch.boundary, expectedBoundary);
  assert.deepEqual(actionPrompt(dispatch.envelope), expectedPrompt);
  assert.equal(dispatch.envelope.data.dispatch.approvalToken, approvalToken);
  assert.deepEqual(decisionSnapshot(location), snapshot);
}

function assertReadOnlyDecisionViewLifecycle({
  root,
  manager,
  state,
  location,
  boundary,
  expectedBoundary,
  logicalKey,
  summaryTarget,
  summaryAgent,
}) {
  const prompt = actionPrompt(boundary.envelope);
  const full = viewChoice(prompt, logicalKey === "spec.record"
    ? "REVIEW_SPECIFICATION_FULL"
    : "REVIEW_ACCEPTANCE_FULL");
  const summary = viewChoice(prompt, logicalKey === "spec.record"
    ? "REVIEW_SPECIFICATION_SUMMARY"
    : "REVIEW_ACCEPTANCE_SUMMARY");
  const fullCommand = parsedViewChoice(full);
  const summaryCommand = parsedViewChoice(summary);
  assert.equal(fullCommand.logicalKey, logicalKey);
  assert.equal(summaryCommand.logicalKey, logicalKey);
  assert.equal(fullCommand.binding, summaryCommand.binding);
  const binding = fullCommand.binding;
  assert.equal(boundary.envelope.data.dispatch.binding, binding);
  const approvalToken = boundary.envelope.data.dispatch.approvalToken;
  const before = decisionSnapshot(location);
  const viewsBefore = viewSnapshot(location);
  const callsBefore = summaryAgent.callCount();

  const failed = invokeViewChoice(root, summary, { binding: staleBinding(root, state) });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.envelope.errors[0].code, "ACTIVE_FLOW_MISMATCH");
  assert.deepEqual(decisionSnapshot(location), before);
  assert.deepEqual(viewSnapshot(location), viewsBefore);
  assert.equal(summaryAgent.callCount(), callsBefore);
  assertReacquiredDecision({
    root,
    binding,
    expectedPrompt: prompt,
    expectedBoundary,
    approvalToken,
    location,
    snapshot: before,
  });

  const fullResult = invokeViewChoice(root, full);
  assert.equal(fullResult.status, 0, fullResult.stderr || fullResult.stdout);
  assert.equal(typeof fullResult.envelope.data.markdown, "string");
  const afterFull = decisionSnapshot(location);
  const fullViews = viewSnapshot(location);
  assert.deepEqual(afterFull, before);
  assert.deepEqual(fullViews.map(([name]) => name), [`${logicalKey}.full.md`]);
  assertReacquiredDecision({
    root,
    binding,
    expectedPrompt: prompt,
    expectedBoundary,
    approvalToken,
    location,
    snapshot: afterFull,
  });

  // A correctly targeted summary can fail after the artifact reader has
  // reached the configured AI boundary. That failure must not create a
  // summary cache, mutate the decision, replace its token, or alter the
  // binding required to return to the exact scene.
  const summaryFailure = invokeViewChoice(root, summary);
  assert.notEqual(summaryFailure.status, 0);
  assert.equal(summaryFailure.envelope.errors[0].code, "ARTIFACT_VIEW_SUMMARY_FAILED");
  assert.deepEqual(decisionSnapshot(location), afterFull);
  assert.deepEqual(viewSnapshot(location).map(([name]) => name), [`${logicalKey}.full.md`]);
  assert.equal(summaryAgent.callCount(), callsBefore);
  assertReacquiredDecision({
    root,
    binding,
    expectedPrompt: prompt,
    expectedBoundary,
    approvalToken,
    location,
    snapshot: afterFull,
  });

  const rendered = new ArtifactViewService({ config: { lang: "en" }, root, flowManager: manager }).full({
    logicalKey,
    activeState: manager.loadReadOnly(state.specId),
  });
  summaryAgent.setResponses(exactSummaryResponses(rendered.fullView, summaryTarget));
  const summaryResult = invokeViewChoice(root, summary);
  assert.equal(summaryResult.status, 0, summaryResult.stderr);
  assert.equal(typeof summaryResult.envelope.data.markdown, "string");
  const afterSummary = decisionSnapshot(location);
  assert.deepEqual(afterSummary, afterFull);
  assert.deepEqual(viewSnapshot(location).map(([name]) => name), [
    `${logicalKey}.full.md`,
    `${logicalKey}.summary.md`,
  ]);
  assert.ok(summaryAgent.callCount() > callsBefore);
  assertReacquiredDecision({
    root,
    binding,
    expectedPrompt: prompt,
    expectedBoundary,
    approvalToken,
    location,
    snapshot: afterSummary,
  });
}

function approvalAuthorizationSnapshot(location) {
  const snapshot = decisionSnapshot(location);
  return {
    flowState: snapshot.flowState,
    activities: snapshot.activities,
    metrics: snapshot.metrics,
    approvalReceipts: snapshot.approvalReceipts,
  };
}

function assertApprovalMutationRejected({
  root,
  scenario,
  worker,
  mutate,
  assertMutation = null,
}) {
  const boundary = invoke(scenario);
  assert.equal(boundary.status, 0, boundary.stderr);
  const before = approvalAuthorizationSnapshot(scenario.fixture.location());
  mutate(scenario.fixture.location(), scenario);
  const afterMutation = approvalAuthorizationSnapshot(scenario.fixture.location());
  assert.deepEqual(afterMutation.approvalReceipts, before.approvalReceipts);
  assertMutation?.({ before, afterMutation });

  const resumed = approveApprovalBoundary(root, boundary);

  assert.notEqual(resumed.status, 0);
  assert.equal(resumed.envelope.errors[0].code, "FLOW_DISPATCH_APPROVAL_STALE");
  assert.notEqual(
    resumed.envelope.data.dispatch.approvalToken,
    boundary.envelope.data.dispatch.approvalToken,
    "a mutation requires a distinct fresh approval token",
  );
  assert.deepEqual(approvalAuthorizationSnapshot(scenario.fixture.location()), afterMutation);
  assert.equal(fs.existsSync(worker.count), false);
}

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function spawnedResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      resolve({ status, signal, stdout, stderr, envelope: JSON.parse(stdout) });
    });
  });
}

describe("flow dispatch CLI", () => {
  let root;
  afterEach(() => {
    if (root) removeTmpDir(root);
  });

  it("serializes worker ownership and rejects a concurrent dispatcher", async () => {
    root = createTmpDir("sennel-flow-dispatch-concurrent-");
    const worker = installWorker(root, { holdForRelease: true });
    const scenario = new DispatchFlowScenario(root);
    ensureGitRepository(root);
    const first = spawn(process.execPath, scenario.args(), {
      ...invocationOptions(root),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const firstResultPromise = spawnedResult(first);

    await waitForFile(worker.lock);
    let second;
    let secondFailure = null;
    try {
      second = invoke(scenario);
    } catch (error) {
      secondFailure = error;
    } finally {
      fs.writeFileSync(worker.release, "release\n");
    }
    const firstResult = await firstResultPromise;
    if (secondFailure) throw secondFailure;

    assert.notEqual(second.status, 0);
    assert.equal(second.envelope.errors[0].code, "FLOW_DISPATCH_BUSY");
    assert.notEqual(firstResult.status, 0, firstResult.stderr);
    assert.equal(firstResult.envelope.errors[0].code, "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED");
    assert.equal(fs.readFileSync(worker.count, "utf8"), "2");
    assert.equal(fs.existsSync(worker.overlap), false);
  });

  it("accepts an opaque Version-bound target without separate target fields", () => {
    root = createTmpDir("sennel-flow-dispatch-binding-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root);
    ensureGitRepository(root);
    const result = spawnSync(process.execPath, [
      SENNEL,
      "flow",
      "run",
      "dispatch",
      "--expect-binding",
      scenario.binding(),
    ], invocationOptions(root));
    const envelope = JSON.parse(result.stdout);

    assert.notEqual(result.status, 0);
    assert.equal(envelope.errors[0].code, "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED");
    assert.equal(fs.readFileSync(worker.count, "utf8"), "2");
  });

  it("rejects next-action data that omits or changes the captured binding", () => {
    root = createTmpDir("sennel-flow-dispatch-next-action-binding-");
    const scenario = new DispatchFlowScenario(root);
    const expectation = new FlowTargetExpectation({ expectBinding: scenario.binding() });
    const target = new FlowDispatchTarget({ expectation, binding: expectation.binding });
    const action = { step: "draft", binding: scenario.binding() };

    assert.deepEqual(target.assertNextActionBinding(action), { step: "draft" });
    assert.throws(
      () => target.assertNextActionBinding({ step: "draft" }),
      (error) => error.code === "FLOW_NEXT_ACTION_BINDING_INVALID",
    );
    assert.throws(
      () => target.assertNextActionBinding({ step: "draft", binding: staleBinding(root, scenario.state) }),
      (error) => error.code === "FLOW_NEXT_ACTION_BINDING_INVALID",
    );
  });

  it("returns and reuses one opaque binding across draft-question decisions", () => {
    root = createTmpDir("sennel-flow-dispatch-draft-question-");
    const scenario = draftQuestionScenario(root);
    const first = invokeFlow(root, [
      "run", "dispatch",
      "--expect-run-id", scenario.state.runId,
      "--expect-spec", scenario.state.specId,
    ]);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.envelope.data.dispatch.boundary, "await_user_decision");
    assert.equal(first.envelope.data.dispatch.binding, scenario.binding);
    assert.equal(first.envelope.data.nextAction.directive.kind, "await_draft_question");
    assert.equal(first.envelope.data.nextAction.directive.questionId, "q1");

    const stale = invokeFlow(root, [
      "set", "draft-answer", "q1",
      "--question-revision", String(first.envelope.data.nextAction.directive.questionRevision),
      "--answer", "A stale target must not write this answer.",
      "--why", "This invocation deliberately uses the wrong authority.",
      "--expect-binding", staleBinding(root, scenario.state),
    ]);
    assert.notEqual(stale.status, 0);
    assert.equal(stale.envelope.errors[0].code, "ACTIVE_FLOW_MISMATCH");

    const firstAnswer = invokeFlow(root, [
      "set", "draft-answer", "q1",
      "--question-revision", String(first.envelope.data.nextAction.directive.questionRevision),
      "--answer", "Return the stable public representation selected by the user.",
      "--why", "The explicit user decision is part of the canonical draft.",
      "--expect-binding", first.envelope.data.dispatch.binding,
    ]);
    assert.equal(firstAnswer.status, 0, firstAnswer.stderr);

    const second = invokeFlow(root, [
      "run", "dispatch",
      "--expect-binding", first.envelope.data.dispatch.binding,
    ]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.envelope.data.dispatch.boundary, "await_user_decision");
    assert.equal(second.envelope.data.dispatch.binding, scenario.binding);
    assert.equal(second.envelope.data.nextAction.directive.questionId, "q2");

    const secondAnswer = invokeFlow(root, [
      "set", "draft-answer", "q2",
      "--question-revision", String(second.envelope.data.nextAction.directive.questionRevision),
      "--drop",
      "--dropped-reason", "The project contract already fixes this compatibility boundary.",
      "--expect-binding", second.envelope.data.dispatch.binding,
    ]);
    assert.equal(secondAnswer.status, 0, secondAnswer.stderr);

    const ready = invokeFlow(root, [
      "get", "next-action",
      "--expect-binding", second.envelope.data.dispatch.binding,
    ]);
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.envelope.data.binding, scenario.binding);
    assert.equal(ready.envelope.data.directive.kind, "execute_step");
    assert.equal(ready.envelope.data.step, "draft-refine");
  });

  it("reclaims a lease whose dispatcher owner exited", () => {
    root = createTmpDir("sennel-flow-dispatch-stale-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root);
    const dispatchModule = pathToFileURL(path.resolve("src/flow/lib/run-dispatch.js")).href;
    const invocationModule = pathToFileURL(path.resolve("src/flow/lib/dispatch-invocation.js")).href;
    const targetModule = pathToFileURL(path.resolve("src/lib/flow-target-guard.js")).href;
    const owner = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `import { FlowDispatchLease } from ${JSON.stringify(dispatchModule)};`,
      `import { FlowDispatchSession, FlowDispatchTarget } from ${JSON.stringify(invocationModule)};`,
      `import { FlowTargetExpectation } from ${JSON.stringify(targetModule)};`,
      `const expectation=new FlowTargetExpectation({expectBinding:${JSON.stringify(scenario.binding())}});`,
      "const target=new FlowDispatchTarget({expectation,binding:expectation.binding});",
      "const session=new FlowDispatchSession({id:'exited-dispatcher',target});",
      "new FlowDispatchLease(session).acquire();",
    ].join("\n")], { cwd: root, encoding: "utf8" });
    assert.equal(owner.status, 0, owner.stderr);

    const result = invoke(scenario);

    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.errors[0].code, "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED");
    assert.equal(fs.readFileSync(worker.count, "utf8"), "2");
  });

  it("returns an approval boundary without starting a worker", () => {
    root = createTmpDir("sennel-flow-dispatch-approval-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root, { step: "approval" });

    const result = invoke(scenario);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.envelope.data.dispatch.boundary, "approval_required");
    assert.equal(result.envelope.data.dispatch.binding, scenario.binding());
    assert.match(result.envelope.data.dispatch.approvalToken, /^[a-f0-9]{64}$/);
    assert.equal(result.envelope.data.nextAction.directive.kind, "execute_step");
    assert.equal(result.envelope.data.nextAction.directive.requiresUserAction, true);
    const choices = result.envelope.data.nextAction.directive.actionPrompt.choices;
    assert.deepEqual(
      choices.map((choice) => choice.actionId),
      [
        "APPROVE_SPECIFICATION",
        "REVIEW_SPECIFICATION_SUMMARY",
        "REVIEW_SPECIFICATION_FULL",
        "REQUEST_SPECIFICATION_CHANGES",
        "OTHER_APPROVAL_RESPONSE",
      ],
    );
    assert.deepEqual(
      choices.map((choice) => choice.label),
      [
        "承認する",
        "仕様の要約を確認する",
        "仕様をすべて確認する",
        "修正する",
        "その他",
      ],
    );
    for (const choice of choices.slice(1, 3)) {
      assert.match(choice.nextAction, /--expect-binding '[A-Za-z0-9_-]+'/);
      assert.doesNotMatch(choice.nextAction, /--approve/);
    }
    assert.equal(fs.existsSync(worker.count), false);
  });

  it("claims a pending approval before issuing one active approval token", () => {
    root = createTmpDir("sennel-flow-dispatch-pending-approval-");
    const worker = installWorker(root, { captureInput: true, failAfterCapture: true });
    const scenario = new DispatchFlowScenario(root, { step: "approval", pending: true });
    const location = scenario.fixture.location();
    const before = decisionSnapshot(location);

    const rejectedPreclaimToken = invoke(scenario, ["--approve", "a".repeat(64)]);
    assert.notEqual(rejectedPreclaimToken.status, 0);
    assert.equal(rejectedPreclaimToken.envelope.errors[0].code, "FLOW_DISPATCH_APPROVAL_STALE");
    assert.deepEqual(decisionSnapshot(location), before);

    const boundary = invoke(scenario);

    assert.equal(boundary.status, 0, boundary.stderr);
    assert.equal(boundary.envelope.data.dispatch.boundary, "approval_required");
    assert.equal(boundary.envelope.data.dispatch.dispatchCount, 1);
    assert.match(boundary.envelope.data.dispatch.approvalToken, /^[a-f0-9]{64}$/);
    assert.equal(scenario.manager.canonicalState(scenario.state.specId).current.at(-1), "approval");
    assert.equal(decisionSnapshot(location).approvalReceipts.length, 0);
    assert.equal(fs.existsSync(worker.count), false);
    assert.notDeepEqual(decisionSnapshot(location).flowState, before.flowState);

    const resumed = approveApprovalBoundary(root, boundary);

    assert.notEqual(resumed.status, 0, "the capture worker deliberately fails after approval continuation");
    assert.equal(fs.readFileSync(worker.count, "utf8"), "2");
    assert.deepEqual(
      decisionSnapshot(location).approvalReceipts.map((receipt) => receipt.approvalToken),
      [boundary.envelope.data.dispatch.approvalToken],
    );
    assert.equal(scenario.manager.canonicalState(scenario.state.specId).current.at(-1), "test");
  });

  it("claims a pending auto approval before applying its active route facts", () => {
    root = createTmpDir("sennel-flow-dispatch-pending-auto-approval-");
    const worker = installWorker(root, { captureInput: true, failAfterCapture: true });
    const scenario = new DispatchFlowScenario(root, {
      step: "approval",
      pending: true,
      autoApprove: true,
    });

    const result = invoke(scenario);

    assert.notEqual(result.status, 0, "the capture worker deliberately fails after auto approval continuation");
    assert.equal(fs.readFileSync(worker.count, "utf8"), "2");
    assert.equal(scenario.manager.canonicalState(scenario.state.specId).current.at(-1), "test");
    assert.deepEqual(decisionSnapshot(scenario.fixture.location()).approvalReceipts, []);
  });

  it("recovers an approval invalidated by plan-gate repair before issuing its token", () => {
    root = createTmpDir("sennel-flow-dispatch-invalidated-approval-");
    const worker = installWorker(root);
    const manager = makeFlowManager(root);
    const specId = "001-invalidated-approval";
    const fixture = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-invalidated-approval",
      request: "Recover a plan-gate-invalidated approval through dispatch.",
      execution: { mode: "direct" },
      specRecord: { goal: "Plan-gate recovery fixture", requirements: [] },
    }).create().registerActive().activate("spec-gate");
    const source = {
      issueLogId: "spec-gate-blocking-evidence",
      step: "spec-gate",
      phase: "spec",
      reason: "The spec gate found a blocking requirement omission.",
      trigger: "gate post hook (auto)",
      observations: [{
        kind: "violation",
        failureMode: "guardrail-violation",
        requirementRef: "R-1",
        where: { file: "spec.json", locator: "requirements[0]" },
        observed: "The required behavior is absent from the specification.",
        severity: "blocking",
        refs: ["R-1"],
      }],
      timestamp: "2026-08-13T00:00:00.000Z",
    };
    const gateResult = attachCanonicalCommandResultArtifact({
      result: "fail",
      artifacts: {
        phase: "spec",
        nextAction: { diagnosis: { observations: source.observations } },
      },
    }, {
      logicalKey: "spec.gate",
      payload: {
        result: "fail",
        artifacts: {
          phase: "spec",
          nextAction: { diagnosis: { observations: source.observations } },
        },
      },
    });
    manager.failCurrentAttempt({
      specId,
      failure: {
        category: "semantic",
        code: "GATE_REJECTED",
        message: "The spec gate has blocking evidence.",
        retryable: true,
        retryKind: "semantic",
      },
      commandResult: gateResult,
    });
    manager.appendIssueLog({ specId, entry: source, idempotencyKey: source.issueLogId });
    const repaired = new RunRepairPlanGateCommand().execute({
      root,
      mainRoot: root,
      executionRoot: root,
      specId,
      flowManager: manager,
      flowState: manager.load(specId),
    });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));

    for (const stepId of ["spec", "spec-review", "spec-triage", "spec-repair", "spec-gate"]) {
      fixture.settle(stepId);
    }
    const recovered = manager.canonicalState(specId);
    assert.equal(recovered.current, null);
    assert.equal(recovered.findNode("approval").status, "invalidated");

    const result = invokeCli(root, [
      SENNEL,
      "flow", "run", "dispatch",
      "--expect-run-id", "run-invalidated-approval",
      "--expect-spec", specId,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.envelope.data.dispatch.boundary, "approval_required");
    assert.equal(result.envelope.data.dispatch.dispatchCount, 1);
    assert.match(result.envelope.data.dispatch.approvalToken, /^[a-f0-9]{64}$/);
    assert.equal(manager.canonicalState(specId).current.at(-1), "approval");
    assert.equal(decisionSnapshot(fixture.location()).approvalReceipts.length, 0);
    assert.equal(fs.existsSync(worker.count), false);
  });

  it("keeps approval review views read-only across success, guarded failure, and binding reacquisition", () => {
    root = createTmpDir("sennel-flow-dispatch-approval-view-lifecycle-");
    const summaryAgent = installSummaryAgent(root);
    const scenario = new DispatchFlowScenario(root, { step: "approval" });
    const boundary = invoke(scenario);

    assert.equal(boundary.status, 0, boundary.stderr);
    assert.equal(boundary.envelope.data.dispatch.boundary, "approval_required");
    assertReadOnlyDecisionViewLifecycle({
      root,
      manager: scenario.manager,
      state: scenario.state,
      location: scenario.fixture.location(),
      boundary,
      expectedBoundary: "approval_required",
      logicalKey: "spec.record",
      summaryTarget: "spec",
      summaryAgent,
    });
  });

  it("auto-approves without creating an approval artifact view", () => {
    root = createTmpDir("sennel-flow-dispatch-auto-approval-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root, {
      step: "approval",
      autoApprove: true,
    });

    const result = invoke(scenario);
    const runtime = path.join(scenario.fixture.location().directory, ".runtime");

    assert.notEqual(result.status, 0, "the fixture worker does not complete the approval step");
    assert.equal(fs.existsSync(worker.count), true, "autoApprove continues with the normal worker path");
    assert.equal(fs.existsSync(path.join(runtime, "views")), false);
    assert.equal(fs.existsSync(path.join(runtime, "spec-render")), false);
  });

  it("binds the approved continuation worker to its post-approval handoff contract", () => {
    root = createTmpDir("sennel-flow-dispatch-approved-worker-");
    const worker = installWorker(root, { captureInput: true, failAfterCapture: true });
    const scenario = new DispatchFlowScenario(root, { step: "approval" });
    const boundary = invoke(scenario);

    assert.equal(boundary.status, 0, boundary.stderr);
    assert.equal(boundary.envelope.data.dispatch.boundary, "approval_required");
    const binding = approvalBoundaryBinding(boundary);
    const resumed = approveApprovalBoundary(root, boundary);

    assert.notEqual(resumed.status, 0, "the capture worker deliberately fails after receiving its input");
    assert.equal(fs.existsSync(worker.prompt), true, JSON.stringify(resumed.envelope));
    assert.equal(fs.existsSync(worker.invocation), true);
    const prompt = fs.readFileSync(worker.prompt, "utf8");
    const invocation = JSON.parse(fs.readFileSync(worker.invocation, "utf8"));
    assert.deepEqual(Object.keys(invocation), [
      "version",
      "dispatchInvocationId",
      "actionDigest",
      "requestPath",
      "requestDigest",
      "actionFilePath",
      "actionFileDigest",
      "authorization",
      "targetBinding",
    ]);
    const workerAction = JSON.parse(fs.readFileSync(invocation.actionFilePath, "utf8"));
    const workerRequest = JSON.parse(fs.readFileSync(invocation.requestPath, "utf8"));
    const boundaryAction = boundary.envelope.data.nextAction;
    assert.equal(resumed.envelope.data.nextAction, null, "the deliberately failed worker must not advance the handoff step");
    assert.deepEqual(Object.keys(workerAction), [
      "taskId",
      "step",
      "action",
      "instructions",
      "context",
      "output_schema",
      "requires_approval",
      "maxAttempts",
      "directive",
    ]);
    assert.equal(workerAction.step, "test");
    assert.equal(workerAction.action, "write-tests");
    assert.equal(workerAction.context.workerArtifactHandoff.required, true);
    assert.equal(invocation.actionDigest, workerRequest.actionDigest);
    assert.match(invocation.requestDigest, /^[a-f0-9]{64}$/);
    assert.match(invocation.actionFileDigest, /^[a-f0-9]{64}$/);
    assert.equal(invocation.authorization.actionDigest, invocation.actionDigest);
    assert.equal(invocation.authorization.source, "unapproved");
    assert.equal(invocation.targetBinding, binding);
    assert.equal(Object.hasOwn(invocation.authorization, "approvalToken"), false);
    assert.equal(Object.hasOwn(invocation, "action"), false);
    assert.equal(Object.hasOwn(invocation, "target"), false);
    assert.equal(Object.hasOwn(invocation, "inputs"), false);
    assert.equal(Object.hasOwn(invocation, "payloads"), false);
    assert.doesNotMatch(prompt, /"actionPrompt"/);
    assert.doesNotMatch(JSON.stringify(workerAction), /"actionPrompt"/);
    assert.doesNotMatch(JSON.stringify(invocation), /actionPrompt/);
    assert.doesNotMatch(prompt, /"inputs"|"payloads"|"specTestTopology"|"sealCommand"/);
    assert.notDeepEqual(resumed.envelope.data.nextAction, boundaryAction);
    assert.deepEqual(
      decisionSnapshot(scenario.fixture.location()).approvalReceipts.map((receipt) => receipt.approvalToken),
      [boundary.envelope.data.dispatch.approvalToken],
    );
  });

  it("reuses one exact approval receipt and token after a failed worker retry", () => {
    root = createTmpDir("sennel-flow-dispatch-approval-retry-");
    const worker = installWorker(root, { captureInput: true, failAfterCapture: true });
    const scenario = new DispatchFlowScenario(root, { step: "approval" });
    const boundary = invoke(scenario);

    assert.equal(boundary.status, 0, boundary.stderr);
    const first = approveApprovalBoundary(root, boundary);
    assert.notEqual(first.status, 0, "the fixture worker deliberately fails after the first approved handoff");
    assert.equal(fs.readFileSync(worker.count, "utf8"), "2");
    const firstReceipts = decisionSnapshot(scenario.fixture.location()).approvalReceipts;
    assert.deepEqual(firstReceipts.map((receipt) => receipt.approvalToken), [
      boundary.envelope.data.dispatch.approvalToken,
    ]);

    const retry = invokeFlow(root, [
      "run",
      "dispatch",
      "--expect-binding",
      approvalBoundaryBinding(boundary),
      "--expect-no-issue",
    ]);

    assert.notEqual(retry.status, 0, "the retry reaches the deliberately failing worker without a second approval");
    assert.notEqual(retry.envelope.data?.dispatch?.boundary, "approval_required");
    assert.equal(fs.readFileSync(worker.count, "utf8"), "4");
    const retriedReceipts = decisionSnapshot(scenario.fixture.location()).approvalReceipts;
    assert.deepEqual(retriedReceipts, firstReceipts);
    const exposedRetryToken = retry.envelope.data?.dispatch?.approvalToken;
    assert.ok(
      exposedRetryToken == null || exposedRetryToken === boundary.envelope.data.dispatch.approvalToken,
      "a retry must not offer a replacement approval token",
    );
  });

  it("normalizes only the selected Version control plane and runtime views", () => {
    root = createTmpDir("sennel-flow-dispatch-approval-exact-pathspec-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root, { step: "approval" });
    const boundary = invoke(scenario);

    assert.equal(boundary.status, 0, boundary.stderr);
    const location = scenario.fixture.location();
    const selectedViews = path.join(location.directory, ".runtime", "views");
    fs.mkdirSync(selectedViews, { recursive: true });
    fs.writeFileSync(path.join(selectedViews, "spec.record.full.md"), "selected Version read-only view\n");

    const afterSelectedView = invoke(scenario);
    assert.equal(afterSelectedView.status, 0, afterSelectedView.stderr);
    assert.equal(afterSelectedView.envelope.data.dispatch.boundary, "approval_required");
    assert.equal(
      afterSelectedView.envelope.data.dispatch.approvalToken,
      boundary.envelope.data.dispatch.approvalToken,
      "the selected Version's ephemeral view is excluded from the approval identity",
    );

    const siblingControl = path.join(path.dirname(location.directory), "002", "flow.json");
    fs.mkdirSync(path.dirname(siblingControl), { recursive: true });
    fs.writeFileSync(siblingControl, "sibling Version control plane must remain fingerprinted\n");
    const stale = approveApprovalBoundary(root, boundary);

    assert.notEqual(stale.status, 0);
    assert.equal(stale.envelope.errors[0].code, "FLOW_DISPATCH_APPROVAL_STALE");
    assert.notEqual(
      stale.envelope.data.dispatch.approvalToken,
      boundary.envelope.data.dispatch.approvalToken,
      "a sibling Version control file is outside the exact normalized paths",
    );
    assert.equal(fs.existsSync(worker.count), false);
  });

  it("fails closed when canonical Store validation rejects a corrupt receipt control file", () => {
    root = createTmpDir("sennel-flow-dispatch-approval-corrupt-control-");
    const worker = installWorker(root, { captureInput: true, failAfterCapture: true });
    const scenario = new DispatchFlowScenario(root, { step: "approval" });
    const boundary = invoke(scenario);

    assert.equal(boundary.status, 0, boundary.stderr);
    const first = approveApprovalBoundary(root, boundary);
    assert.notEqual(first.status, 0);
    assert.equal(fs.readFileSync(worker.count, "utf8"), "2");
    const activitiesFile = scenario.fixture.location().activitiesFile;
    const activitiesBefore = fs.readFileSync(activitiesFile, "utf8");
    fs.writeFileSync(scenario.fixture.location().flowStateFile, "{ invalid canonical Flow state\n");

    const corrupt = invokeFlow(root, [
      "run",
      "dispatch",
      "--expect-binding",
      approvalBoundaryBinding(boundary),
      "--expect-no-issue",
    ]);

    assert.notEqual(corrupt.status, 0);
    assert.ok(corrupt.envelope, corrupt.stderr);
    assert.equal(fs.readFileSync(worker.count, "utf8"), "2");
    assert.equal(fs.readFileSync(activitiesFile, "utf8"), activitiesBefore);
  });

  it("rejects a source mutation before recording an approval receipt", () => {
    root = createTmpDir("sennel-flow-dispatch-source-mutation-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root, { step: "approval" });
    assertApprovalMutationRejected({
      root,
      scenario,
      worker,
      mutate() {
        fs.writeFileSync(path.join(root, "unrelated-source-change.js"), "export const changed = true;\n");
      },
    });
  });

  it("rejects an active Version spec mutation before recording an approval receipt", () => {
    root = createTmpDir("sennel-flow-dispatch-spec-mutation-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root, { step: "approval" });
    assertApprovalMutationRejected({
      root,
      scenario,
      worker,
      mutate(location, activeScenario) {
        // Write through the canonical Store so the catalog remains valid;
        // this is an active spec.record change, not a malformed-file recovery
        // path that would mask the approval fingerprint assertion.
        activeScenario.manager.updateSpecApproval({
          specId: activeScenario.state.specId,
          approval: {
            confirmedAt: "2026-01-02T03:04:05.000Z",
            notes: "A canonical spec mutation invalidates the prior approval token.",
          },
        });
        assert.equal(
          JSON.parse(fs.readFileSync(location.specFile, "utf8")).user_approval.notes,
          "A canonical spec mutation invalidates the prior approval token.",
        );
      },
      assertMutation({ before, afterMutation }) {
        assert.notDeepEqual(afterMutation, before, "the Store writes canonical spec and ledger evidence");
      },
    });
  });

  it("rejects an approval token after the canonical next action changes", () => {
    root = createTmpDir("sennel-flow-dispatch-changed-action-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root, { step: "approval" });
    const first = invoke(scenario);
    assert.equal(first.status, 0, first.stderr);

    scenario.manager.updateStepStatus({ stepId: "approval", requestedStatus: "done" }, {
      specId: scenario.state.specId,
    });
    const resumed = invoke(scenario, ["--approve", first.envelope.data.dispatch.approvalToken]);

    assert.notEqual(resumed.status, 0);
    assert.equal(resumed.envelope.errors[0].code, "FLOW_DISPATCH_APPROVAL_STALE");
    assert.notEqual(resumed.envelope.data.nextAction.step, "approval");
    assert.equal(fs.existsSync(worker.count), false);
  });

  it("keeps risk-bearing acceptance decisions tokenless and manual under autoApprove", () => {
    root = createTmpDir("sennel-flow-dispatch-manual-exception-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root, {
      step: "acceptance-decision",
      autoApprove: true,
    });

    const result = invoke(scenario);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.envelope.data.dispatch.boundary, "await_user_decision");
    assert.equal(result.envelope.data.dispatch.binding, scenario.binding());
    assert.equal(result.envelope.data.dispatch.approvalToken, undefined);
    assert.equal(result.envelope.data.nextAction.requires_approval, false);
    assert.deepEqual(
      result.envelope.data.nextAction.directive.actionPrompt.choices.map((choice) => choice.actionId),
      [
        "ACCEPT_RISK_AND_CONTINUE",
        "ABORT_ACCEPTANCE",
        "REVIEW_ACCEPTANCE_SUMMARY",
        "REVIEW_ACCEPTANCE_FULL",
      ],
    );
    assert.deepEqual(
      result.envelope.data.nextAction.directive.actionPrompt.choices.map((choice) => choice.label),
      [
        "リスクを受け入れて続行する",
        "中止する",
        "受入レビューの要約を確認する",
        "受入レビューをすべて確認する",
      ],
    );
    for (const choice of result.envelope.data.nextAction.directive.actionPrompt.choices) {
      assert.match(choice.nextAction, /--expect-binding '[A-Za-z0-9_-]+'/);
      assert.doesNotMatch(choice.nextAction, /--approve/);
    }
    assert.equal(fs.existsSync(worker.count), false);
    assert.equal(
      fs.existsSync(path.join(scenario.fixture.location().directory, ".runtime", "views")),
      false,
    );
  });

  it("keeps acceptance review views tokenless and read-only across success, guarded failure, and binding reacquisition", () => {
    root = createTmpDir("sennel-flow-dispatch-acceptance-view-lifecycle-");
    const summaryAgent = installSummaryAgent(root);
    const scenario = acceptanceDecisionScenario(root);
    const boundary = invokeFlow(root, ["run", "dispatch", "--expect-binding", scenario.binding]);

    assert.equal(boundary.status, 0, boundary.stderr);
    assert.equal(boundary.envelope.data.dispatch.boundary, "await_user_decision");
    assert.equal(boundary.envelope.data.dispatch.approvalToken, undefined);
    assertReadOnlyDecisionViewLifecycle({
      root,
      manager: scenario.manager,
      state: scenario.state,
      location: scenario.location,
      boundary,
      expectedBoundary: "await_user_decision",
      logicalKey: "acceptance.review",
      summaryTarget: "acceptance",
      summaryAgent,
    });
  });

  it("rejects a mismatched target before starting a worker", () => {
    root = createTmpDir("sennel-flow-dispatch-target-mismatch-");
    const worker = installWorker(root);
    const scenario = new DispatchFlowScenario(root);

    ensureGitRepository(root);
    const args = scenario.args();
    args[args.indexOf("--expect-run-id") + 1] = "different-run";
    const spawned = spawnSync(process.execPath, args, invocationOptions(root));
    const result = {
      ...spawned,
      envelope: spawned.stdout.trim() ? JSON.parse(spawned.stdout) : null,
    };

    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.errors[0].code, "ACTIVE_FLOW_MISMATCH");
    assert.equal(fs.existsSync(worker.count), false);
  });
});
