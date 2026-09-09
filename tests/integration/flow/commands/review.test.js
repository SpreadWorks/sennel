import { describe, it, afterEach, mock } from "node:test";
import os from "os";
import fs from "fs";
import assert from "node:assert/strict";
import path, { join } from "path";
import { execFileSync } from "child_process";
import { createTmpDir, removeTmpDir } from "../../../support/builders/tmp-dir.js";
import {
  CanonicalFlowFixture,
  makeFlowManager,
  setupFlowConfig,
} from "../../../support/infrastructure/flow-setup.js";
import { FLOW_STEPS } from "../../../../src/lib/flow-helpers.js";
import { FlowManager } from "../../../../src/lib/flow-manager.js";
import { emptySpecStub } from "../../../../src/lib/spec-json.js";
import { CanonicalFlowCreateRequest } from "../../../../src/flow/lib/canonical-flow-manager-store.js";
import { CurrentFlowSpecRecord } from "../../../../src/flow/lib/current-flow-state.js";
import { flattenSteps } from "../../../../src/flow/lib/step-tree.js";
import { container } from "../../../../src/lib/container.js";
import { attachCanonicalCommandResultArtifact } from "../../../../src/flow/lib/canonical-command-result.js";
import { CanonicalReviewWorkUnit } from "../../../../src/flow/lib/canonical-review-artifacts.js";
import { CanonicalSourceRequirementAuthority } from "../../../../src/flow/lib/canonical-file-map.js";
import { CanonicalSpecTestTopology } from "../../../../src/flow/lib/canonical-worker-artifacts.js";
import { CanonicalSpecReview } from "../../../../src/flow/lib/spec-review-artifacts.js";
import {
  REVIEW_WORK_UNIT_MANIFEST_ENV,
  ReviewWorkUnit,
  ReviewWorkUnitOutput,
} from "../../../../src/flow/lib/review-work-unit.js";
import { ReviewFindingCycle } from "../../../../src/flow/lib/finding-disposition-policy.js";
import { Agent } from "../../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../../src/lib/provider.js";
import { adaptJsonSchemaForProvider } from "../../../../src/lib/provider-schema.js";
import { Logger } from "../../../../src/lib/log.js";
import { AgentAuthenticationFailure } from "../../../../src/lib/agent-failure.js";
import { FLOW_COMMANDS } from "../../../../src/flow/registry.js";
import {
  createMemoryWorkUnitCheckpointStore,
  WorkUnitToolingFailure,
} from "../../../../src/flow/lib/work-unit.js";
import { ImplReviewProposal } from "../../../../src/flow/lib/impl-review-proposal.js";
import {
  canonicalReviewArtifactFindings,
  reviewArtifactFindingLists,
  runCmdWithRetry,
} from "../../../../src/flow/lib/run-review.js";
import { ReviewFailure } from "../../../../src/flow/lib/review-failure.js";
import {
  ReviewProtocolAttempt,
  ReviewProtocolFailure,
} from "../../../../src/flow/lib/review-protocol.js";
import {
  artifactPhaseMatchesReviewTarget,
  buildReviewHandoffFindings,
  ReviewConvergenceState,
  ReviewDisposition,
  ReviewEvidence,
  ReviewEvidenceReference,
} from "../../../../src/flow/lib/review-convergence.js";
import FlowReviewCommand, {
  parseProposals,
  buildDraftReviewPrompt,
  buildDraftReviewAuthorityText,
  buildSpecSummaryMarkdown,
  buildSpecReviewPrompt,
  buildDraftSystemPrompt,
  formatSpecReviewDelta,
  formatSpecReviewMd,
  parseSpecReviewFindings,
  parseImplReviewFindings,
  filterImplReviewFindingsByScope,
  formatImplReviewMd,
  formatImplReviewJson,
  buildImplReviewPrompt,
  createReviewExcludeMatcher,
  collectTestFiles,
  filterProposalsByScope,
  collectTouchedFiles,
  applyTestFixes,
  formatTestReviewMd,
  buildTestReviewPrompt,
  buildGapAnalysisPrompt,
  buildTestFixPrompt,
  parseTestReviewFindings,
  TEST_REVIEW_PROMPT_CHAR_LIMIT,
  assertTestReviewPromptWithinLimit,
  runTestReviewWithDependencies,
  runLoopReviewWithDependencies,
  canonicalLoopReviewCheckpointStore,
  resolveMergeBase,
  resolveReviewTarget,
  loopProposalsToImplReviewJson,
  buildDraftReviewArtifact,
  writeReviewAttemptHistory,
  classifyReviewCommandError,
  loadPreviousImplReviewMemory,
  priorImplReviewFingerprintCounts,
  canonicalTaskReviewFileMap,
  runImplReviewAgentWithDependencies,
  TASK_REVIEW_PROMPT_CHAR_LIMIT,
} from "../../../../src/flow/commands/review.js";

function assertAllMatch(text, patterns) {
  for (const pattern of patterns) assert.match(text, pattern);
}

function assertAllDoesNotMatch(text, patterns) {
  for (const pattern of patterns) assert.doesNotMatch(text, pattern);
}

const CATALOGED_REVIEW_FINGERPRINT = "c".repeat(64);

function reviewFindingCycle(flowManager, flow) {
  return ReviewFindingCycle.fromActivityLedger({
    runId: flow.runId,
    activities: flowManager.activityLedger(flow.specId),
  });
}

function catalogedImplReviewPayload({ cycle, title = "Cataloged repeated finding" } = {}) {
  return {
    version: 1,
    phase: "impl",
    generatedAt: "2026-08-14T00:00:00.000Z",
    verdict: "REJECTED",
    summary: { blocking: 1, nonBlocking: 0, total: 1 },
    blockingFindings: [{
      findingKey: "cataloged-repeated-finding",
      title,
      failureMode: "missing-implementation",
      file: "src/example.js",
      requirementId: "R-1",
      issue: "The required behavior is absent.",
      suggestion: "Implement the required behavior.",
      disposition: "must-fix",
      rationale: "R-1 makes this behavior mandatory.",
      findingId: CATALOGED_REVIEW_FINGERPRINT,
      fingerprint: CATALOGED_REVIEW_FINGERPRINT,
      repeatCount: 1,
    }],
    nonBlockingImprovements: [],
    excluded: { missingFile: 0, outOfScope: 0 },
    runId: cycle.runId,
    planRewindAt: cycle.planRewindAt,
  };
}

function publishCanonicalImplReview(flowManager, flow, payload) {
  flowManager.publishCurrentAttemptResult({
    specId: flow.specId,
    commandResult: attachCanonicalCommandResultArtifact({ result: "ok" }, {
      logicalKey: "impl.review",
      payload,
    }),
  });
}

describe("review command error classification", () => {
  it("does not classify a local schema error as a provider failure from a stack line number", () => {
    const error = new Error("spec.json failed schema validation: overview.modules[0].text is required");
    error.stack = `${error.message}\n    at runReview (src/flow/commands/review.js:4295:3)`;

    assert.equal(classifyReviewCommandError(error, "spec"), null);
  });

  it("distinguishes unavailable source observation from an observed source effect", () => {
    const attempt = new ReviewProtocolAttempt({ number: 1, cacheMode: "default" });
    const unavailable = classifyReviewCommandError(new ReviewProtocolFailure({
      kind: "observation_unavailable",
      attempt,
      maxAttempts: 2,
      cause: new Error("snapshot unavailable"),
    }), "impl");
    const effect = classifyReviewCommandError(new ReviewProtocolFailure({
      kind: "effect_observed",
      attempt,
      maxAttempts: 2,
      cause: new Error("provider changed source"),
    }), "impl");

    assert.equal(unavailable.failureCode, "TASK_REVIEW_SOURCE_OBSERVATION_UNAVAILABLE");
    assert.match(unavailable.reason, /could not verify whether the provider changed source/);
    assert.equal(effect.failureCode, "TASK_REVIEW_SOURCE_EFFECT_OBSERVED");
    assert.match(effect.reason, /observed source effects/);
  });
});

describe("canonical impl review catalog history", () => {
  let historyRoot = null;

  afterEach(() => {
    if (historyRoot) removeTmpDir(historyRoot);
    historyRoot = null;
  });

  it("counts same-cycle retries from cataloged attempts and excludes them after typed draft reopen", () => {
    historyRoot = createTmpDir("canonical-impl-review-history-");
    const flowManager = makeFlowManager(historyRoot);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "001-cataloged-review-history",
      runId: "run-cataloged-review-history",
      execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
      specRecord: {
        goal: "Keep implementation review history canonical.",
        requirements: [{ id: "R-1", desc: "Review finding history remains durable." }],
      },
    }).create().registerActive().activate("impl-review");

    let flow = fixture.state();
    let cycle = reviewFindingCycle(flowManager, flow);
    publishCanonicalImplReview(flowManager, flow, catalogedImplReviewPayload({ cycle }));

    flowManager.failCurrentAttempt({
      specId: flow.specId,
      failure: {
        category: "tooling",
        code: "REVIEW_WORKER_RETRY",
        message: "Retry the review worker.",
        retryable: true,
        retryKind: "tooling",
      },
    });
    flowManager.retryCurrentAttempt({ specId: flow.specId });
    flow = fixture.state();
    cycle = reviewFindingCycle(flowManager, flow);
    publishCanonicalImplReview(flowManager, flow, catalogedImplReviewPayload({ cycle }));

    assert.equal(
      flowManager.activityLedger(flow.specId).some((activity) => activity.transition.operation === "retry_attempt"),
      true,
    );
    assert.equal(
      priorImplReviewFingerprintCounts({ flowManager, flow, cycle }).get(CATALOGED_REVIEW_FINGERPRINT),
      2,
      "two cataloged impl.review attempts in the same cycle count as two occurrences",
    );
    assert.equal(
      loadPreviousImplReviewMemory({ flowManager, flow }).previousBlockingFindings[0].title,
      "Cataloged repeated finding",
    );

    const transientWorkUnit = path.join(
      fixture.location().directory,
      ".runtime",
      "review-work-units",
      "impl-review",
      "transient-attempt",
    );
    fs.mkdirSync(transientWorkUnit, { recursive: true });
    fs.writeFileSync(path.join(transientWorkUnit, "checkpoint.json"), "{}\n");
    fs.rmSync(transientWorkUnit, { recursive: true, force: true });
    assert.equal(fs.existsSync(transientWorkUnit), false);
    assert.equal(
      priorImplReviewFingerprintCounts({ flowManager, flow, cycle }).get(CATALOGED_REVIEW_FINGERPRINT),
      2,
      "removing a transient work unit cannot erase cataloged review history",
    );

    flowManager.reopenDraft({ specId: flow.specId, route: "spec-correction" });
    fixture.activate("impl-review");
    flow = fixture.state();
    cycle = reviewFindingCycle(flowManager, flow);
    assert.notEqual(cycle.planRewindAt, null);
    assert.equal(
      flowManager.activityLedger(flow.specId).some((activity) => (
        activity.transition.operation === "reopen_draft_spec_correction"
      )),
      true,
    );
    assert.equal(
      priorImplReviewFingerprintCounts({ flowManager, flow, cycle }).get(CATALOGED_REVIEW_FINGERPRINT) || 0,
      0,
      "a reopened draft begins a new finding cycle",
    );
    assert.equal(fs.existsSync(path.join(fixture.location().directory, "review-history")), false);
  });
});

describe("normal no-diff canonical review", () => {
  let noDiffRoot = null;
  let previousReviewOutputDirectory;
  let previousReviewSpecSource;
  let previousReviewFileMapSource;
  let previousReviewWorkUnitManifest;
  let reviewEnvironmentCaptured = false;

  afterEach(() => {
    container.reset();
    if (previousReviewOutputDirectory === undefined) delete process.env.SENNEL_REVIEW_OUTPUT_DIR;
    else process.env.SENNEL_REVIEW_OUTPUT_DIR = previousReviewOutputDirectory;
    if (previousReviewSpecSource === undefined) delete process.env.SENNEL_REVIEW_SPEC_SOURCE;
    else process.env.SENNEL_REVIEW_SPEC_SOURCE = previousReviewSpecSource;
    if (previousReviewFileMapSource === undefined) delete process.env.SENNEL_REVIEW_FILE_MAP_SOURCE;
    else process.env.SENNEL_REVIEW_FILE_MAP_SOURCE = previousReviewFileMapSource;
    if (previousReviewWorkUnitManifest === undefined) delete process.env[REVIEW_WORK_UNIT_MANIFEST_ENV];
    else process.env[REVIEW_WORK_UNIT_MANIFEST_ENV] = previousReviewWorkUnitManifest;
    previousReviewOutputDirectory = undefined;
    previousReviewSpecSource = undefined;
    previousReviewFileMapSource = undefined;
    previousReviewWorkUnitManifest = undefined;
    reviewEnvironmentCaptured = false;
    if (noDiffRoot) removeTmpDir(noDiffRoot);
    noDiffRoot = null;
  });

  function bindReviewWorkUnit(fixture, flowManager) {
    const workUnit = new CanonicalReviewWorkUnit({
      flowManager,
      state: fixture.state(),
      phase: "impl",
      executionRoot: noDiffRoot,
      treeSha: "a".repeat(40),
      targetStateDigest: "b".repeat(64),
    });
    workUnit.prepare();
    const specSource = workUnit.materializeSpecRecord();
    const fileMapSource = workUnit.materializeFileMap();
    const surface = workUnit.finalize();
    const outputDirectory = surface.directory;
    if (!reviewEnvironmentCaptured) {
      previousReviewOutputDirectory = process.env.SENNEL_REVIEW_OUTPUT_DIR;
      previousReviewSpecSource = process.env.SENNEL_REVIEW_SPEC_SOURCE;
      previousReviewFileMapSource = process.env.SENNEL_REVIEW_FILE_MAP_SOURCE;
      previousReviewWorkUnitManifest = process.env[REVIEW_WORK_UNIT_MANIFEST_ENV];
      reviewEnvironmentCaptured = true;
    }
    process.env.SENNEL_REVIEW_OUTPUT_DIR = outputDirectory;
    process.env.SENNEL_REVIEW_SPEC_SOURCE = JSON.stringify(specSource);
    if (fileMapSource === null) delete process.env.SENNEL_REVIEW_FILE_MAP_SOURCE;
    else process.env.SENNEL_REVIEW_FILE_MAP_SOURCE = JSON.stringify(fileMapSource);
    process.env[REVIEW_WORK_UNIT_MANIFEST_ENV] = surface.manifestPath;
    return { outputDirectory, specSource, fileMapSource, executionWorkDir: noDiffRoot };
  }

  it("passes without a diff on a first Attempt and a typed retry after transient cleanup", async () => {
    noDiffRoot = createTmpDir("canonical-no-diff-review-");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: noDiffRoot, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "review@example.test"], { cwd: noDiffRoot, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Review Fixture"], { cwd: noDiffRoot, stdio: "pipe" });

    const flowManager = makeFlowManager(noDiffRoot);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "001-no-diff-review",
      runId: "run-no-diff-review",
      execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
      specRecord: {
        goal: "Exercise a normal no-diff review.",
        requirements: [{ id: "R-1", desc: "The retry lifecycle remains canonical." }],
      },
    }).create().registerActive().activate("impl-review");
    execFileSync("git", ["add", "--all"], { cwd: noDiffRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "canonical review fixture"], { cwd: noDiffRoot, stdio: "pipe" });

    const { outputDirectory } = bindReviewWorkUnit(fixture, flowManager);
    container.reset();
    container.register("root", noDiffRoot);
    container.register("mainRoot", noDiffRoot);
    container.register("flowManager", flowManager);
    container.register("config", { flow: { review: {} } });

    const command = new FlowReviewCommand();
    await command.execute({ _rawArgs: [] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputDirectory, "impl-review.json"), "utf8")).verdict, "PASS");
    assert.equal(
      flowManager.readProducerArtifact({
        specId: fixture.specId,
        nodeId: "impl-review",
        logicalKey: "impl.review",
        optional: true,
      }),
      null,
      "a first normal no-diff review has no prior catalog artifact",
    );

    let flow = fixture.state();
    let cycle = reviewFindingCycle(flowManager, flow);
    publishCanonicalImplReview(flowManager, flow, catalogedImplReviewPayload({ cycle }));
    flowManager.failCurrentAttempt({
      specId: flow.specId,
      failure: {
        category: "semantic",
        code: "REVIEW_REJECTED",
        message: "The first canonical review Attempt has a retryable finding.",
        retryable: true,
        retryKind: "semantic",
      },
    });
    flowManager.retryCurrentAttempt({ specId: flow.specId });
    flow = fixture.state();
    cycle = reviewFindingCycle(flowManager, flow);
    assert.equal(flowManager.canonicalState(flow.specId).attempt.sequence, 2);
    assert.equal(
      priorImplReviewFingerprintCounts({ flowManager, flow, cycle }).get(CATALOGED_REVIEW_FINGERPRINT),
      1,
      "the replacement Attempt reads prior canonical history without a transient checkpoint",
    );
    fs.rmSync(outputDirectory, { recursive: true, force: true });

    const { outputDirectory: retryOutputDirectory } = bindReviewWorkUnit(fixture, flowManager);
    await command.execute({ _rawArgs: [] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(retryOutputDirectory, "impl-review.json"), "utf8")).verdict, "PASS");
    assert.equal(fs.existsSync(path.join(fixture.location().directory, "review-history")), false);
  });

  it("uses the cataloged file.map as the unchanged implementation-review prompt authority", async () => {
    noDiffRoot = createTmpDir("canonical-file-map-review-");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: noDiffRoot, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "review@example.test"], { cwd: noDiffRoot, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Review Fixture"], { cwd: noDiffRoot, stdio: "pipe" });
    fs.mkdirSync(path.join(noDiffRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(noDiffRoot, "src", "mapped.js"), "export const value = 1;\n");
    execFileSync("git", ["add", "--all"], { cwd: noDiffRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "review baseline"], { cwd: noDiffRoot, stdio: "pipe" });

    const flowManager = makeFlowManager(noDiffRoot);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "001-file-map-review",
      runId: "run-file-map-review",
      execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
      specRecord: {
        goal: "Consume the canonical file map during review.",
        requirements: [{ id: "R-1", desc: "Review the mapped implementation file." }],
      },
    }).create().registerActive().activate("implement");
    flowManager.updateFileMap({
      specId: fixture.specId,
      requirementId: "R-1",
      paths: ["src/mapped.js"],
    });
    fixture.settle("implement").activate("impl-review");
    fs.writeFileSync(path.join(noDiffRoot, "src", "mapped.js"), "export const value = 2;\n");

    const { outputDirectory, fileMapSource, executionWorkDir } = bindReviewWorkUnit(fixture, flowManager);
    assert.ok(fileMapSource);
    let capturedPrompt = "";
    let capturedExecutionWorkDir = null;
    let capturedWaitForProcessTree = null;
    container.reset();
    container.register("root", noDiffRoot);
    container.register("mainRoot", noDiffRoot);
    container.register("flowManager", flowManager);
    container.register("config", { flow: { review: {} } });
    container.register("agent", {
      resolve: () => ({ provider: "fixture" }),
      call: async (userPrompt, options) => {
        capturedPrompt = `${options.systemPrompt || ""}\n${userPrompt}`;
        capturedExecutionWorkDir = options.executionWorkDir;
        capturedWaitForProcessTree = options.waitForProcessTree;
        return JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] });
      },
    });

    await new FlowReviewCommand().execute({ _rawArgs: [] });

    assert.match(capturedPrompt, /## Requirement-File Mapping/);
    assert.match(capturedPrompt, /"R-1": \[/);
    assert.match(capturedPrompt, /"src\/mapped\.js"/);
    assert.equal(capturedExecutionWorkDir, executionWorkDir);
    assert.equal(capturedExecutionWorkDir, noDiffRoot);
    assert.equal(fs.existsSync(path.join(outputDirectory, "checkout")), false);
    assert.equal(capturedWaitForProcessTree, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputDirectory, "impl-review.json"), "utf8")).verdict, "PASS");
    assert.equal(fs.existsSync(path.join(fixture.location().directory, "file-map.json")), false);
  });

  it("fails closed before agent execution when changed implementation has no cataloged file.map", async () => {
    noDiffRoot = createTmpDir("canonical-missing-file-map-review-");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: noDiffRoot, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "review@example.test"], { cwd: noDiffRoot, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Review Fixture"], { cwd: noDiffRoot, stdio: "pipe" });
    fs.writeFileSync(path.join(noDiffRoot, "changed.js"), "export const changed = 1;\n");
    execFileSync("git", ["add", "--all"], { cwd: noDiffRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "review baseline"], { cwd: noDiffRoot, stdio: "pipe" });

    const flowManager = makeFlowManager(noDiffRoot);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "001-missing-file-map-review",
      runId: "run-missing-file-map-review",
      execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
      specRecord: { requirements: [{ id: "R-1", desc: "Require a durable file map." }] },
    }).create().registerActive();
    // Model an older completion without the optional file.map publication.
    // The review command must still fail closed before the provider sees
    // changed source when its catalog authority is unavailable.
    const reviewIndex = fixture.leaves().findIndex((step) => step.id === "impl-review");
    for (const step of fixture.leaves().slice(0, reviewIndex)) {
      if (step.id !== "implement") {
        fixture.settle(step.id);
        continue;
      }
      fixture.activate("implement", { settlePredecessors: false });
      flowManager._store.runtime.confirmAttempt({
        specId: fixture.specId,
        activityId: "historical-artifactless-implement-confirmation",
        status: "done",
        result: {
          outcome: "passed",
          summary: "historical artifactless implementation completion",
          confirmedAt: "2026-08-20T00:00:00.000Z",
          artifactRefs: [],
        },
      });
    }
    fixture.activate("impl-review", { settlePredecessors: false });
    fs.writeFileSync(path.join(noDiffRoot, "changed.js"), "export const changed = 2;\n");
    bindReviewWorkUnit(fixture, flowManager);
    let agentCalls = 0;
    container.reset();
    container.register("root", noDiffRoot);
    container.register("mainRoot", noDiffRoot);
    container.register("flowManager", flowManager);
    container.register("config", { flow: { review: {} } });
    container.register("agent", {
      resolve: () => ({ provider: "fixture" }),
      call: async () => { agentCalls += 1; return "{}"; },
    });

    await assert.rejects(
      () => new FlowReviewCommand().execute({ _rawArgs: [] }),
      /SENNEL_REVIEW_FILE_MAP_SOURCE is required/,
    );
    assert.equal(agentCalls, 0);
  });
});

describe("canonical review target artifact filtering", () => {
  let targetRoot = null;

  afterEach(() => {
    if (targetRoot) removeTmpDir(targetRoot);
    targetRoot = null;
  });

  it("retains Store-published tests.source while excluding other Version artifacts", async () => {
    targetRoot = createTmpDir("canonical-review-target-");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: targetRoot, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "review@example.test"], { cwd: targetRoot, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Review Fixture"], { cwd: targetRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "review target baseline"], { cwd: targetRoot, stdio: "pipe" });

    const flowManager = makeFlowManager(targetRoot);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "001-review-target",
      runId: "run-review-target",
      execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
      specRecord: { goal: "Preserve canonical test source review input.", requirements: [] },
    }).create().registerActive().activate("test");
    flowManager.publishArtifacts({
      specId: fixture.specId,
      nodeId: "test",
      artifactWrites: [{
        logicalKey: "tests.source",
        parameters: { testPath: "preserved.test.js" },
        mediaType: "text/javascript",
        bytes: Buffer.from("export const preserved = 1;\n", "utf8"),
      }],
    });
    fixture.settle("test").activate("impl-review");
    const location = fixture.location();
    const canonicalTestPath = path.join(location.directory, "artifacts", "tests", "preserved.test.js");
    const flow = fixture.state();
    const relativeTestPath = path.relative(targetRoot, canonicalTestPath).split(path.sep).join("/");
    const storeManagedPaths = [
      location.relativeFlowStateFile,
      location.relativeActivitiesFile,
      location.relativeCatalogFile,
      location.relativeSpecFile,
    ];
    const mergeBase = resolveMergeBase(targetRoot, "main");
    const spec = JSON.parse(flowManager.readArtifact({
      specId: fixture.specId,
      logicalKey: "spec.record",
      consumerNodeId: "impl-review",
    }).bytes.toString("utf8"));
    const untrackedTarget = await resolveReviewTarget(targetRoot, flow, mergeBase, spec);

    assert.equal(untrackedTarget.untrackedFiles.has(relativeTestPath), true);
    for (const relativePath of storeManagedPaths) {
      assert.equal(
        untrackedTarget.untrackedFiles.has(relativePath),
        false,
        `Store-owned Version artifact must not become review input: ${relativePath}`,
      );
    }

    execFileSync("git", ["add", "--", relativeTestPath], { cwd: targetRoot, stdio: "pipe" });
    const stagedTarget = await resolveReviewTarget(targetRoot, flow, mergeBase, spec);
    assert.match(stagedTarget.diff, new RegExp(relativeTestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(stagedTarget.touchedFiles.has(relativeTestPath), true);
    for (const relativePath of storeManagedPaths) {
      assert.equal(stagedTarget.touchedFiles.has(relativePath), false);
      assert.equal(stagedTarget.untrackedFiles.has(relativePath), false);
    }
  });
});

describe("canonical review finding disposition", () => {
  it("keeps the agent-facing evidence reference on the typed Flow or Task catalog path", () => {
    const evidenceFor = (taskId) => new ReviewEvidence({
      phase: "impl",
      taskId,
      treeSha: "1".repeat(40),
      provenance: {
        provider: "fixture-provider",
        invocationId: taskId === null ? "flow-handoff-evidence" : "task-handoff-evidence",
        capturedAt: "2026-08-14T00:00:00.000Z",
      },
      disposition: new ReviewDisposition({
        value: "ADVISORY",
        blockingFindings: [],
        advisoryFindings: [{
          findingId: taskId === null ? "flow-handoff-finding" : "task-handoff-finding",
          summary: "The reviewer recorded an advisory finding.",
          fingerprint: taskId === null ? "a".repeat(64) : "b".repeat(64),
          evidenceRefs: ["review.json#finding"],
          disposition: "informational",
        }],
      }),
    });
    const flowEvidence = evidenceFor(null);
    const taskEvidence = evidenceFor("T-1");

    assert.equal(
      buildReviewHandoffFindings(flowEvidence)[0].canonicalEvidenceRef,
      `steps/impl/review/evidence/${flowEvidence.identity.evidenceDigest}.json`,
    );
    assert.equal(
      buildReviewHandoffFindings(taskEvidence)[0].canonicalEvidenceRef,
      `steps/impl/T-1/review/evidence/${taskEvidence.identity.evidenceDigest}.json`,
    );
  });

  it("preserves an informational disposition for acceptance handoff", () => {
    const canonical = canonicalReviewArtifactFindings({
      blockingFindings: [],
      nonBlockingImprovements: [{
        findingId: "informational-finding",
        fingerprint: "a".repeat(64),
        title: "Optional cleanup",
        disposition: "informational",
      }],
    }, "impl", "impl-review.json");

    assert.equal(canonical.advisoryFindings[0].disposition, "informational");
    const evidence = new ReviewEvidence({
      phase: "impl",
      taskId: null,
      treeSha: "1".repeat(40),
      provenance: {
        provider: "fixture-provider",
        invocationId: "typed-informational-finding",
        capturedAt: "2026-07-24T00:00:00.000Z",
      },
      disposition: new ReviewDisposition({ value: "ADVISORY", ...canonical }),
    });
    assert.equal(evidence.disposition.advisoryFindings[0].disposition, "informational");
  });
});

function resolveAgent(cfg, commandId) {
  const registry = new ProviderRegistry(cfg.agent?.providers || {});
  const agent = new Agent({
    config: cfg,
    paths: { root: process.cwd(), agentWorkDir: "/tmp" },
    registry,
    logger: new Logger({ logDir: os.tmpdir(), enabled: false }),
  });
  const resolved = agent.resolve(commandId);
  return resolved ? resolved.profile : null;
}

const FLOW_CMD = join(process.cwd(), "src/sennel.js");
const FLOW_CMD_ARGS_PREFIX = ["flow"];

function draftReviewRevision(sourceStepId = "draft") {
  return {
    version: 1,
    runId: "run-draft-review-artifact",
    specId: "draft-review-artifact",
    sourceStepId,
    digest: "a".repeat(64),
    byteLength: 128,
    finalizedAt: "2026-08-04T00:00:00.000Z",
  };
}

class DraftRepairTargetCheckpoint {
  constructor() {
    this.disposition = "ADVISORY";
    this.blockingFindings = Object.freeze([]);
    this.advisoryFindings = Object.freeze([]);
    this.repairTargets = Object.freeze([Object.freeze({
      title: "Redundant requirement confirmation",
      target: "q1",
      rationale: "Answer q1 from the authoritative request instead of asking again",
      evidence: "The request already states the public behavior asked by q1",
    })]);
    Object.freeze(this);
  }

  toProposal() {
    const [target] = this.repairTargets;
    return {
      title: target.title,
      file: null,
      body: [
        `**QA:** ${target.target}`,
        `**Issue:** ${target.evidence}`,
        `**Suggestion:** ${target.rationale}`,
        "**Classification:** repair_target",
      ].join("\n"),
    };
  }

  toRecordingArtifact(producedArtifact) {
    return {
      ...producedArtifact.toJSON(),
      disposition: this.disposition,
    };
  }
}

function recordCanonicalDraftEvidence({
  artifact,
  phase,
  artifactName,
  invocationId,
}) {
  const canonical = canonicalReviewArtifactFindings(artifact, phase, artifactName);
  const disposition = new ReviewDisposition({
    value: artifact.verdict,
    ...canonical,
  });
  const evidence = new ReviewEvidence({
    phase,
    taskId: null,
    treeSha: "1".repeat(40),
    provenance: {
      provider: "issue-454-fixture",
      invocationId,
      capturedAt: "2026-07-24T00:00:00.000Z",
    },
    disposition,
  });
  const convergence = new ReviewConvergenceState({
    phase,
    taskId: null,
    treeSha: evidence.treeSha,
    semanticAttempts: 0,
    semanticMaxAttempts: 4,
    toolingAttempts: 0,
    toolingMaxAttempts: 1,
    evidence: new ReviewEvidenceReference({
      evidenceId: evidence.identity.evidenceDigest,
      disposition,
    }),
    finalizedEvidenceAvailable: true,
    handoffFindings: buildReviewHandoffFindings(evidence),
    blocker: null,
    toolingOutcome: null,
  });
  return { canonical, convergence, disposition, evidence };
}

describe("draft repair target canonical classification", () => {
  const repairTarget = Object.freeze({
    title: "Redundant requirement confirmation",
    target: "q1",
    rationale: "Answer q1 from the authoritative request instead of asking again",
    evidence: "The request already states the public behavior asked by q1",
    classification: "repair_target",
  });

  for (const phase of ["draft-questions", "draft-coverage"]) {
    it(`records ${phase} repairTargets-only as completed advisory evidence`, () => {
      const artifact = {
        verdict: "ADVISORY",
        blockingFindings: [],
        advisoryFindings: [],
        repairTargets: [repairTarget],
      };
      const result = reviewArtifactFindingLists(artifact, phase);
      const recorded = recordCanonicalDraftEvidence({
        artifact,
        phase,
        artifactName: phase === "draft-coverage"
          ? "draft-review-coverage.json"
          : "draft-review-questions.json",
        invocationId: `${phase}-result-recording`,
      });

      assert.deepEqual(result.blocking, []);
      assert.deepEqual(result.advisory, [repairTarget]);
      assert.equal(recorded.disposition.value, "ADVISORY");
      assert.equal(recorded.disposition.advisoryFindings.length, 1);
      assert.equal(recorded.convergence.finalizedEvidenceAvailable, true);
      assert.equal(recorded.convergence.evidence.evidenceId, recorded.evidence.identity.evidenceDigest);
    });
  }

  it("preserves advisory findings and repair targets without creating blocking findings", () => {
    const advisoryFinding = {
      title: "Optional wording improvement",
      classification: "advisory",
    };
    const result = reviewArtifactFindingLists({
      blockingFindings: [],
      advisoryFindings: [advisoryFinding],
      repairTargets: [repairTarget],
    }, "draft-questions");

    assert.deepEqual(result.blocking, []);
    assert.deepEqual(result.advisory, [advisoryFinding, repairTarget]);
  });

  it("keeps an empty draft review empty for PASS", () => {
    const result = reviewArtifactFindingLists({
      blockingFindings: [],
      advisoryFindings: [],
      repairTargets: [],
    }, "draft-questions");

    assert.deepEqual(result, { blocking: [], advisory: [] });
  });

  it("does not reclassify blocking findings", () => {
    const blockingFinding = {
      title: "Missing required decision",
      classification: "blocking",
    };
    const result = reviewArtifactFindingLists({
      blockingFindings: [blockingFinding],
      advisoryFindings: [],
      repairTargets: [repairTarget],
    }, "draft-coverage");

    assert.deepEqual(result.blocking, [blockingFinding]);
    assert.deepEqual(result.advisory, [repairTarget]);
  });

  it("records multiple repair targets with unique fallback IDs and rejects true duplicates", () => {
    const secondRepairTarget = {
      ...repairTarget,
      title: "Question contains an embedded rationale",
      target: "q2",
      evidence: "q2 contains answer text",
    };
    const canonical = canonicalReviewArtifactFindings({
      blockingFindings: [],
      advisoryFindings: [],
      repairTargets: [repairTarget, secondRepairTarget],
    }, "draft-questions", "draft-review-questions.json");

    assert.deepEqual(
      canonical.advisoryFindings.map((finding) => finding.findingId),
      ["draft-questions-advisory-001", "draft-questions-advisory-002"],
    );
    assert.equal(new ReviewDisposition({
      value: "ADVISORY",
      ...canonical,
    }).advisoryFindings.length, 2);

    const duplicateCanonical = canonicalReviewArtifactFindings({
      blockingFindings: [],
      advisoryFindings: [],
      repairTargets: [repairTarget, repairTarget],
    }, "draft-questions", "draft-review-questions.json");
    assert.throws(
      () => new ReviewDisposition({
        value: "ADVISORY",
        ...duplicateCanonical,
      }),
      /duplicate fingerprint/,
    );
  });

  it("normalizes colliding provider identities for distinct findings", () => {
    const duplicateIdentity = "a".repeat(64);
    const canonical = canonicalReviewArtifactFindings({
      verdict: "REJECTED",
      blockingFindings: [
        {
          title: "Missing stale scenario evidence coverage",
          issue: "Scenario evidence at the rewind boundary is not covered.",
          findingId: duplicateIdentity,
          fingerprint: duplicateIdentity,
        },
        {
          title: "Missing stale test execution evidence coverage",
          issue: "Test execution evidence at the rewind boundary is not covered.",
          findingId: duplicateIdentity,
          fingerprint: duplicateIdentity,
        },
      ],
    }, "test", "test-review.json");

    assert.deepEqual(
      canonical.blockingFindings.map((finding) => finding.findingId),
      [duplicateIdentity, "test-blocking-002"],
    );
    assert.notEqual(
      canonical.blockingFindings[0].fingerprint,
      canonical.blockingFindings[1].fingerprint,
    );
    assert.equal(new ReviewDisposition({
      value: "REJECTED",
      ...canonical,
    }).blockingFindings.length, 2);
    assert.notEqual(canonical.blockingFindings[0].findingId, canonical.blockingFindings[1].findingId);
    assert.notEqual(canonical.blockingFindings[0].fingerprint, canonical.blockingFindings[1].fingerprint);
  });
});

describe("FLOW_STEPS includes impl-review", () => {
  it("has impl-review between implement and finalize-commit", () => {
    const implIdx = FLOW_STEPS.indexOf("implement");
    const reviewIdx = FLOW_STEPS.indexOf("impl-review");
    const finalIdx = FLOW_STEPS.indexOf("finalize-commit");
    assert.ok(reviewIdx > 0, "impl-review step exists");
    assert.ok(reviewIdx > implIdx, "impl-review comes after implement");
    assert.ok(finalIdx > 0, "finalize-commit step exists");
    assert.ok(reviewIdx < finalIdx, "impl-review comes before finalize-commit");
  });
});

describe("draft repair target checkpoint replay", () => {
  it("accepts the public draft artifact phase for its internal retry phase", () => {
    assert.equal(artifactPhaseMatchesReviewTarget("draft-questions-review", "draft-questions"), true);
    assert.equal(artifactPhaseMatchesReviewTarget("draft-coverage-review", "draft-coverage"), true);
    assert.equal(artifactPhaseMatchesReviewTarget("draft-questions-review", "draft-coverage"), false);
  });

  it("records the exact R8 ADVISORY fixture once and advances through the production triage hook without review AI", async () => {
    const tmp = createTmpDir("draft-repair-target-checkpoint-");
    const specDir = path.join(tmp, "specs/demo");
    fs.mkdirSync(specDir, { recursive: true });
    const checkpoint = new DraftRepairTargetCheckpoint();
    const agentCall = mock.method(Agent.prototype, "call", () => {
      throw new Error("review AI must not run while replaying finalized checkpoint evidence");
    });
    const flowManager = new FlowManager({ root: tmp, mainRoot: tmp, inWorktree: false });
    const created = flowManager.createFresh(new CanonicalFlowCreateRequest({
      specId: "demo",
      runId: "draft-checkpoint-run",
      request: "Replay canonical draft review evidence.",
      execution: { mode: "direct" },
      policy: { autoApprove: false, nonblocking: null },
      flowId: "draft-checkpoint-flow",
      flowVersionId: "draft-checkpoint-v1",
      specRecord: new CurrentFlowSpecRecord({ ...emptySpecStub(), tasks: [] }, { specId: "demo" }),
    }));
    flowManager.addActiveFlow(created.specId, "direct");
    const reviewIndex = flattenSteps(flowManager.load(created.specId).steps)
      .findIndex((step) => step.id === "draft-questions-review");
    for (const step of flattenSteps(flowManager.load(created.specId).steps).slice(0, reviewIndex)) {
      flowManager.updateStepStatus({ stepId: step.id, requestedStatus: "done" });
    }
    flowManager.updateStepStatus({ stepId: "draft-questions-review", requestedStatus: "in_progress" });

    try {
      assert.equal(checkpoint.disposition, "ADVISORY");
      assert.deepEqual(checkpoint.blockingFindings, []);
      assert.deepEqual(checkpoint.advisoryFindings, []);
      assert.deepEqual(checkpoint.repairTargets, [{
        title: "Redundant requirement confirmation",
        target: "q1",
        rationale: "Answer q1 from the authoritative request instead of asking again",
        evidence: "The request already states the public behavior asked by q1",
      }]);

      const producedArtifact = buildDraftReviewArtifact({
        raw: "FINALIZED_CHECKPOINT_EVIDENCE",
        draftPath: "draft.json",
        draftRevision: draftReviewRevision(),
        proposals: [checkpoint.toProposal()],
        stage: {
          artifactPhase: "draft-questions-review",
          retryPhase: "draft-questions",
          findingClassification: "repair_target",
        },
      });
      assert.equal(producedArtifact.verdict, checkpoint.disposition);
      assert.equal(producedArtifact.phase, "draft-questions");
      assert.deepEqual(producedArtifact.blockingFindings, []);
      assert.deepEqual(producedArtifact.advisoryFindings, []);
      assert.equal(producedArtifact.repairTargets.length, 1);

      const written = writeReviewAttemptHistory({
        specDir,
        phase: "draft-questions",
        latestBasename: "draft-review-questions.json",
        artifact: checkpoint.toRecordingArtifact(producedArtifact),
        attemptNumber: 1,
      });
      const recordedArtifact = JSON.parse(fs.readFileSync(written.latestPath, "utf8"));
      const historyArtifact = JSON.parse(fs.readFileSync(written.historyJsonPath, "utf8"));
      const recorded = recordCanonicalDraftEvidence({
        artifact: recordedArtifact,
        phase: "draft-questions",
        artifactName: "draft-review-questions.json",
        invocationId: "checkpoint-result-recording",
      });

      assert.equal(recordedArtifact.verdict, checkpoint.disposition);
      assert.equal(recordedArtifact.disposition, "ADVISORY");
      assert.equal(historyArtifact.findings.length, 1);
      assert.equal(recorded.disposition.value, "ADVISORY");
      assert.equal(recorded.disposition.advisoryFindings.length, 1);
      assert.equal(recorded.convergence.finalizedEvidenceAvailable, true);
      assert.deepEqual(historyArtifact.findings[0], {
        id: "draft-questions-001-non-blocking-001",
        findingId: "draft-questions-001-non-blocking-001",
        phase: "draft-questions",
        sourceArtifact: "draft-review-questions.json",
        attempt: 1,
        severity: "non-blocking",
        title: "Redundant requirement confirmation",
        body: "Answer q1 from the authoritative request instead of asking again",
        category: "repair_target",
        target: "q1",
        evidence: "The request already states the public behavior asked by q1",
        rationale: "Answer q1 from the authoritative request instead of asking again",
      });
      assert.deepEqual(
        historyArtifact.findings[0].target,
        recordedArtifact.repairTargets[0].target,
      );
      assert.deepEqual(
        historyArtifact.findings[0].evidence,
        recordedArtifact.repairTargets[0].evidence,
      );

      await FLOW_COMMANDS.run.review.post({
        phase: "draft",
        root: tmp,
        executionRoot: tmp,
        flowState: flowManager.load(created.specId),
        flowManager,
      }, {
        artifacts: {
          phase: "draft",
          verdict: recordedArtifact.verdict,
          issueCount: historyArtifact.findings.length,
          retryPhase: historyArtifact.phase,
        },
      });

      assert.equal(agentCall.mock.callCount(), 0);
      const steps = flattenSteps(flowManager.load(created.specId).steps);
      assert.equal(steps.find((step) => step.id === "draft-questions-review").status, "done");
      assert.equal(steps.find((step) => step.id === "draft-questions-triage").status, "pending");
      assert.equal(steps.find((step) => step.id === "draft-questions-repair").status, "pending");
      assert.deepEqual(
        fs.readdirSync(path.join(specDir, "review-history")),
        ["draft-questions-attempt-001.json"],
      );
    } finally {
      agentCall.mock.restore();
      removeTmpDir(tmp);
    }
  });
});

describe("draft review artifact phases", () => {
  const proposal = {
    title: "Clarify the acceptance condition",
    file: null,
    body: "The draft needs one explicit acceptance condition.",
  };

  for (const { retryPhase, artifactPhase } of [
    { retryPhase: "draft-questions", artifactPhase: "draft-questions-review" },
    { retryPhase: "draft-coverage", artifactPhase: "draft-coverage-review" },
  ]) {
    it(`persists ${retryPhase} for ${artifactPhase}`, () => {
      const stage = { retryPhase, artifactPhase, findingClassification: "advisory" };
      const pass = buildDraftReviewArtifact({
        raw: "NO_PROPOSALS",
        draftPath: "draft.json",
        draftRevision: draftReviewRevision(retryPhase === "draft-coverage" ? "draft-refine" : "draft"),
        proposals: [],
        stage,
      });
      const advisory = buildDraftReviewArtifact({
        raw: "A review finding was recorded.",
        draftPath: "draft.json",
        draftRevision: draftReviewRevision(retryPhase === "draft-coverage" ? "draft-refine" : "draft"),
        proposals: [proposal],
        stage,
      });

      assert.equal(pass.phase, retryPhase);
      assert.equal(pass.version, 2);
      assert.deepEqual(pass.sourceDraftRevision, draftReviewRevision(
        retryPhase === "draft-coverage" ? "draft-refine" : "draft",
      ));
      assert.equal(advisory.phase, retryPhase);
      assert.equal(advisory.verdict, "ADVISORY");
    });
  }

  it("rejects draft review artifact construction without a finalized revision", () => {
    assert.throws(
      () => buildDraftReviewArtifact({
        raw: "NO_PROPOSALS",
        draftPath: "draft.json",
        proposals: [],
        stage: {
          retryPhase: "draft-questions",
          artifactPhase: "draft-questions-review",
          findingClassification: "advisory",
        },
      }),
      /draft artifact revision version must be 1/,
    );
  });

  it("does not invent coverage findings when the review reports none", () => {
    const artifact = buildDraftReviewArtifact({
      raw: "NO_PROPOSALS",
      draftPath: "draft.json",
      draftRevision: draftReviewRevision("draft-refine"),
      proposals: [],
      stage: {
        retryPhase: "draft-coverage",
        artifactPhase: "draft-coverage-review",
        findingClassification: "blocking",
      },
    });

    assert.equal(artifact.verdict, "PASS");
    assert.deepEqual(artifact.repairTargets, []);
  });
});

describe("flow run routes review action", () => {
  it("shows review in flow run help output", () => {
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "run", "--help"], { encoding: "utf8" });
    assert.match(result, /review/);
  });
});

describe("flow run review CLI", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("errors when no active flow", () => {
    tmp = createTmpDir();
    try {
      execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "run", "review"], {
        encoding: "utf8",
        env: { ...process.env, SENNEL_WORK_ROOT: tmp },
      });
      assert.fail("should exit non-zero");
    } catch (err) {
      const out = `${err.stdout || ""}${err.stderr || ""}`;
      assert.match(out, /no active flow/i);
    }
  });
});

describe("canonical test review work-unit inputs", () => {
  let targetRoot = null;

  afterEach(() => {
    if (targetRoot) removeTmpDir(targetRoot);
    targetRoot = null;
  });

  it("materializes cataloged test sources only below the work-unit input directory", () => {
    targetRoot = createTmpDir("canonical-test-review-input-");
    const flowManager = makeFlowManager(targetRoot);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "001-test-review-input",
      runId: "run-test-review-input",
      specRecord: { goal: "Materialize test sources inside one review work unit.", requirements: [] },
    }).create().registerActive().activate("test");
    flowManager.publishArtifacts({
      specId: fixture.specId,
      nodeId: "test",
      artifactWrites: [{
        logicalKey: "tests.source",
        parameters: { testPath: "r1.test.js" },
        mediaType: "text/javascript",
        bytes: Buffer.from("export const reviewInput = true;\n", "utf8"),
      }],
    });
    fixture.settle("test").settle("scenario-validity").activate("test-review", { settlePredecessors: false });

    const workUnit = new CanonicalReviewWorkUnit({
      flowManager,
      state: fixture.state(),
      phase: "test",
      executionRoot: targetRoot,
      treeSha: "a".repeat(40),
      targetStateDigest: "b".repeat(64),
    });
    const prepared = workUnit.prepare();
    const sources = workUnit.materializeTestSources(prepared.directory);

    assert.equal(sources.directory, path.join(prepared.directory, "inputs"));
    assert.equal(
      fs.readFileSync(path.join(prepared.directory, "inputs", "tests", "r1.test.js"), "utf8"),
      "export const reviewInput = true;\n",
    );
    assert.equal(fs.existsSync(path.join(prepared.directory, "tests", "r1.test.js")), false);
    assert.deepEqual(sources.topology.toJSON(), {
      canonicalTestRoot: path.relative(
        targetRoot,
        path.join(fixture.location().directory, "artifacts", "tests"),
      ).split(path.sep).join("/"),
      staticRelativeImportBase: "each canonical test file",
    });
  });
});

describe("flow run review --phase test CLI", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("passes --phase test through to review command", () => {
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "run", "review", "--help"], { encoding: "utf8" });
    const removedLogOption = `--log-${"file"}`;
    assert.match(result, /--phase/);
    assert.match(result, /--agent-work-dir/);
    assert.ok(!result.includes(removedLogOption));
  });

  it("errors when no active flow with --phase test", () => {
    tmp = createTmpDir();
    try {
      execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "run", "review", "--phase", "test"], {
        encoding: "utf8",
        env: { ...process.env, SENNEL_WORK_ROOT: tmp },
      });
      assert.fail("should exit non-zero");
    } catch (err) {
      const out = `${err.stdout || ""}${err.stderr || ""}`;
      assert.match(out, /no active flow/i);
    }
  });

  it("fails closed when a direct child review omits its canonical work-unit environment", () => {
    tmp = createTmpDir();
    setupFlowConfig(tmp, "en");
    const flowManager = new FlowManager({ root: tmp, mainRoot: tmp, inWorktree: false });
    const created = flowManager.createFresh(new CanonicalFlowCreateRequest({
      specId: "001-direct-review-child",
      runId: "direct-review-child-run",
      request: "Require the parent-created review work unit.",
      execution: { mode: "direct" },
      policy: { autoApprove: false, nonblocking: null },
      flowId: "direct-review-child-flow",
      flowVersionId: "direct-review-child-v1",
      specRecord: new CurrentFlowSpecRecord({ ...emptySpecStub(), tasks: [] }, { specId: "001-direct-review-child" }),
    }));
    flowManager.addActiveFlow(created.specId, "direct");
    const environment = { ...process.env };
    for (const variable of [
      "SENNEL_REVIEW_OUTPUT_DIR",
      "SENNEL_REVIEW_TEST_SOURCE_DIR",
      "SENNEL_REVIEW_TEST_ARTIFACT_REVISION",
      "SENNEL_REVIEW_TEST_TOPOLOGY",
      "SENNEL_REVIEW_TASK_SPEC_SOURCE",
      "SENNEL_REVIEW_DRAFT_SOURCE",
      "SENNEL_REVIEW_SPEC_SOURCE",
      "SENNEL_REVIEW_SPEC_REVIEW_SOURCE",
      "SENNEL_REVIEW_FILE_MAP_SOURCE",
    ]) delete environment[variable];

    assert.throws(
      () => execFileSync("node", [join(process.cwd(), "src/flow/commands/review.js"), "--phase", "test"], {
        encoding: "utf8",
        env: { ...environment, SENNEL_WORK_ROOT: tmp },
      }),
      (error) => {
        const output = `${error.stdout || ""}${error.stderr || ""}`;
        return /SENNEL_REVIEW_OUTPUT_DIR is required for a canonical review work unit/.test(output);
      },
    );
  });

  it("rejects a partial spec.review descriptor before the child invokes an agent or seals output", () => {
    tmp = createTmpDir();
    setupFlowConfig(tmp, "en");
    const flowManager = new FlowManager({ root: tmp, mainRoot: tmp, inWorktree: false });
    const created = flowManager.createFresh(new CanonicalFlowCreateRequest({
      specId: "001-direct-spec-review-child",
      runId: "direct-spec-review-child-run",
      request: "Reject incomplete child spec-review input descriptors.",
      execution: { mode: "direct" },
      policy: { autoApprove: false, nonblocking: null },
      flowId: "direct-spec-review-child-flow",
      flowVersionId: "direct-spec-review-child-v1",
      specRecord: new CurrentFlowSpecRecord({ ...emptySpecStub(), tasks: [] }, { specId: "001-direct-spec-review-child" }),
    }));
    flowManager.addActiveFlow(created.specId, "direct");

    const workUnit = new ReviewWorkUnit({
      executionRoot: tmp,
      runId: created.runId,
      specId: created.specId,
      phase: "spec",
      nodeId: "spec-review",
      attemptId: "direct-spec-review-child-attempt",
      target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) },
      output: ReviewWorkUnitOutput.forReview({ phase: "spec" }),
    });
    const spec = workUnit.writeInput({
      logicalKey: "spec.record",
      logicalPath: "spec.json",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(emptySpecStub()), "utf8"),
    });
    const review = workUnit.writeInput({
      logicalKey: "spec.review",
      logicalPath: "review.json",
      mediaType: "application/json",
      bytes: Buffer.from("{}", "utf8"),
    });
    const surface = workUnit.finalize();
    const environment = { ...process.env };
    for (const variable of [
      "SENNEL_REVIEW_TEST_SOURCE_DIR",
      "SENNEL_REVIEW_TEST_ARTIFACT_REVISION",
      "SENNEL_REVIEW_TEST_TOPOLOGY",
      "SENNEL_REVIEW_TASK_SPEC_SOURCE",
      "SENNEL_REVIEW_DRAFT_SOURCE",
      "SENNEL_REVIEW_FILE_MAP_SOURCE",
    ]) delete environment[variable];

    assert.throws(
      () => execFileSync("node", [join(process.cwd(), "src/flow/commands/review.js"), "--phase", "spec"], {
        encoding: "utf8",
        env: {
          ...environment,
          SENNEL_WORK_ROOT: tmp,
          SENNEL_REVIEW_OUTPUT_DIR: surface.directory,
          [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath,
          SENNEL_REVIEW_SPEC_SOURCE: JSON.stringify({
            version: 1,
            logicalKey: "spec.record",
            logicalPath: "spec.json",
            sourcePath: spec.sourcePath,
            digest: spec.digest,
            byteLength: spec.byteLength,
          }),
          SENNEL_REVIEW_SPEC_REVIEW_SOURCE: JSON.stringify({
            logicalPath: "review.json",
            sourcePath: review.sourcePath,
          }),
        },
      }),
      (error) => /canonical review input descriptor has invalid fields/.test(`${error.stdout || ""}${error.stderr || ""}`),
    );
    assert.equal(fs.existsSync(path.join(surface.directory, "review.delta.json")), false);
    assert.equal(fs.existsSync(path.join(surface.directory, "seal.json")), false);
  });
});

describe("test-review spec-local file scope", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  function write(file, content) {
    const full = join(tmp, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it("collects only spec-local test files and excludes project-level tests", () => {
    tmp = createTmpDir();
    const specDir = "specs/demo";
    write("tests/project.test.js", "project root test");
    write(`${specDir}/spec.md`, "spec markdown");
    write(`${specDir}/tests/.raw/test-execution.log`, "raw execution log");
    write(`${specDir}/tests/helper.js`, "helper module");
    write(`${specDir}/tests/local.test.txt`, "text file");
    write(`${specDir}/tests/local.md`, "markdown file");
    write(`${specDir}/tests/project.test.js`, "spec local shadow");
    write(`${specDir}/tests/local.test.ts`, "spec local ts test");
    write(`${specDir}/tests/local.spec.mjs`, "spec local mjs");
    write(`${specDir}/tests/nested/local.spec.ts`, "nested spec local ts");

    const files = collectTestFiles(tmp, specDir);

    assert.deepEqual(
      files.map((f) => f.source).sort(),
      [
        `${specDir}/tests/local.spec.mjs`,
        `${specDir}/tests/local.test.ts`,
        `${specDir}/tests/nested/local.spec.ts`,
        `${specDir}/tests/project.test.js`,
      ].sort(),
    );
    assert.ok(files.every((f) => f.source.startsWith(`${specDir}/tests/`)));
    assert.ok(files.some((f) => f.content === "spec local shadow"));
    assert.ok(!files.some((f) => f.content === "project root test"));
    assert.ok(!files.some((f) => f.content === "spec markdown"));
    assert.ok(!files.some((f) => f.content === "raw execution log"));
    assert.ok(!files.some((f) => f.content === "helper module"));
    assert.ok(!files.some((f) => f.content === "text file"));
    assert.ok(!files.some((f) => f.content === "markdown file"));
  });

  it("renders materialized tests at their canonical artifact paths without leaking the work unit", () => {
    tmp = createTmpDir();
    const physicalTestRoot = join(tmp, ".sennel/review-work-units/test-review/attempt/inputs/tests");
    write(".sennel/review-work-units/test-review/attempt/inputs/tests/example.test.js", [
      "import support from '../../../../../tests/support/example.js';",
      "test('R1: uses support', () => support());",
    ].join("\n"));
    write(".sennel/review-work-units/test-review/attempt/inputs/tests/nested/example.spec.js", [
      "import support from '../../../../../../tests/support/example.js';",
      "test('R1: nested support', () => support());",
    ].join("\n"));
    const topology = CanonicalSpecTestTopology.fromJSON(new CanonicalSpecTestTopology({
      repositoryRoot: tmp,
      canonicalTestRoot: join(tmp, "specs/demo/001/artifacts/tests"),
    }).toJSON(), { repositoryRoot: tmp });

    const files = collectTestFiles(tmp, "specs/demo/001", {
      sourceDirectory: physicalTestRoot,
      sourceTopology: topology,
    });
    const coverageArtifact = {
      toPromptSummary() {
        return {
          requirements: [{ id: "R1", status: "covered", files: ["tests/example.test.js"] }],
          files: [{ file: "tests/example.test.js", headerIds: ["R1"], testNameIds: ["R1"] }],
        };
      },
    };
    const prompt = buildTestReviewPrompt("- R1: Resolve repository support.", coverageArtifact, files);
    const combined = `${prompt.systemPrompt}\n${prompt.userPrompt}`;

    assert.match(combined, /### specs\/demo\/001\/artifacts\/tests\/example\.test\.js/);
    assert.match(combined, /### specs\/demo\/001\/artifacts\/tests\/nested\/example\.spec\.js/);
    assert.doesNotMatch(combined, /specs\/demo\/001\/tests\/example\.test\.js/);
    assert.doesNotMatch(combined, new RegExp(physicalTestRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(combined, /"file": "tests\/example\.test\.js"/);
    assert.equal(
      path.resolve(tmp, path.dirname(files.find((file) => file.name === "example.test.js").source), "../../../../../tests/support/example.js"),
      join(tmp, "tests/support/example.js"),
    );
  });

  it("keeps test design in systemPrompt for gap-analysis and fix prompts", () => {
    const testDesign = "TC-1: review-test input contract";
    const testFiles = [{
      source: "specs/demo/tests/review.test.js",
      content: "test('R1: collects local files', () => {});",
    }];
    const gapPrompt = buildGapAnalysisPrompt(testDesign, testFiles);
    const fixPrompt = buildTestFixPrompt(testDesign, "GAP-1", testFiles);

    for (const prompt of [gapPrompt, fixPrompt]) {
      assert.match(prompt.systemPrompt, /## Test Design/);
      assert.match(prompt.systemPrompt, /TC-1: review-test input contract/);
      assert.doesNotMatch(prompt.userPrompt, /## Test Design/);
      assert.doesNotMatch(prompt.userPrompt, /TC-1: review-test input contract/);
    }
  });

  it("enforces the test-review prompt limit before calling the agent", async () => {
    assert.equal(TEST_REVIEW_PROMPT_CHAR_LIMIT, 1_000_000);
    const overLimitPrompt = {
      systemPrompt: "x".repeat(TEST_REVIEW_PROMPT_CHAR_LIMIT),
      userPrompt: "y",
      fmtFallback: "",
    };
    let agentCalled = false;

    assert.throws(
      () => assertTestReviewPromptWithinLimit(overLimitPrompt, "test review"),
      /TEST_REVIEW_PROMPT_TOO_LARGE/,
    );
    await assert.rejects(
      () => runTestReviewWithDependencies({
        buildReviewPrompt: () => overLimitPrompt,
        callAgent: async () => {
          agentCalled = true;
          return "{}";
        },
      }),
      /TEST_REVIEW_PROMPT_TOO_LARGE/,
    );
    assert.equal(agentCalled, false);
  });

  it("applies test fixes only under the current spec-local tests directory", () => {
    tmp = createTmpDir();
    const specDir = "specs/demo";
    const allowed = [
      `### FILE: ${specDir}/tests/generated.test.js`,
      "```",
      "import assert from \"node:assert/strict\";",
      "```",
    ].join("\n");

    assert.deepEqual(applyTestFixes(allowed, tmp, specDir), [
      `${specDir}/tests/generated.test.js`,
    ]);
    assert.equal(
      fs.readFileSync(join(tmp, specDir, "tests/generated.test.js"), "utf8"),
      "import assert from \"node:assert/strict\";\n",
    );

    const outside = [
      "### FILE: tests/project.test.js",
      "```",
      "should not be written",
      "```",
    ].join("\n");
    assert.throws(
      () => applyTestFixes(outside, tmp, specDir),
      /outside specs\/demo\/tests/,
    );
    assert.equal(fs.existsSync(join(tmp, "tests/project.test.js")), false);
  });

  it("formats blocking and advisory findings without undefined placeholders", () => {
    const md = formatTestReviewMd({
      verdict: "ADVISORY",
      coverageArtifact: "specs/demo/test-coverage.json",
      toolingOutcome: null,
      blockingFindings: [],
      advisoryFindings: [{
        title: "Boundary case",
        target: "R1",
        improvement: "Add a boundary assertion when implementation details are known.",
        whyNonBlocking: "Existing tests cover the acceptance behavior.",
      }],
    });

    assert.match(md, /## Verdict: ADVISORY/);
    assert.match(md, /Boundary case/);
    assert.doesNotMatch(md, /undefined/);
  });

  it("asks for one-shot JSON blocking findings separately from advisory findings", () => {
    const coverageArtifact = {
      toPromptSummary() {
        return {
          requirements: [{ id: "R1", status: "covered", files: ["tests/example.test.js"] }],
          files: [{ file: "tests/example.test.js", headerIds: ["R1"], testNameIds: ["R1"] }],
        };
      },
    };
    const prompt = buildTestReviewPrompt(
      "- R1 [must]: Do x",
      coverageArtifact,
      [{ source: "specs/demo/tests/example.test.js", content: "// spec: R1\ntest('R1: does x', () => {});" }],
    );
    const combined = `${prompt.systemPrompt || ""}\n${prompt.userPrompt || ""}`;

    assert.ok(prompt.jsonSchema, "test review should provide a JSON schema to Agent");
    assert.match(prompt.fmtFallback, /Return only a JSON object/);
    assert.match(combined, /one-shot static test reviewer/);
    assert.match(combined, /blockingFindings\[\]/);
    assert.match(combined, /advisoryFindings\[\]/);
    assert.match(combined, /origin/);
    assert.match(combined, /failureKind/);
    assert.match(combined, /Use null for origin or failureKind/);
    assert.match(combined, /Do not fail for advisory findings/);
    assert.match(combined, /does not auto-fix tests/i);
    assert.match(combined, /Requirement-to-Test Coverage Artifact/);
    assert.match(combined, /invents a module path, export, function, constant, method, or artifact shape/);

    const itemSchema = prompt.jsonSchema.properties.blockingFindings.items;
    assert.deepEqual([...itemSchema.required].sort(), [
      "failureKind", "issue", "origin", "requiredChange", "target", "title", "whyBlocking",
    ]);
    assert.deepEqual(itemSchema.properties.origin.type, ["string", "null"]);
    assert.deepEqual(itemSchema.properties.failureKind.type, ["string", "null"]);
    assert.equal(itemSchema.properties.testPaths.minItems, 1);
    assert.equal(itemSchema.properties.createTestPaths.minItems, 1);
  });

  it("parses JSON test review findings and rejects markdown gap output", () => {
    const parsed = parseTestReviewFindings(JSON.stringify({
      blockingFindings: [{
        title: "Missing coverage",
        target: "R2",
        issue: "R2 has no test.",
        requiredChange: "Add a spec-local test for R2.",
        whyBlocking: "Implementation would proceed without acceptance coverage.",
      }],
      advisoryFindings: [{
        title: "Extra boundary",
        target: "R1",
        improvement: "Add one more boundary case.",
        whyNonBlocking: "Current coverage is adequate for implementation.",
      }],
    }));

    assert.equal(parsed.blocking.length, 1);
    assert.equal(parsed.advisory.length, 1);
    assert.throws(() => parseTestReviewFindings("### GAP-1\nMissing"), /test review output failed schema validation|Unexpected token|JSON/i);
  });

  it("retains declared canonical test path capabilities in parsed blocking findings", () => {
    const parsed = parseTestReviewFindings(JSON.stringify({
      blockingFindings: [{
        title: "Shared test behavior", target: "tests/flow-query-api.test.js — R1 test",
        testPaths: ["flow-query-api.test.js", "nested/api.spec.js"],
        issue: "Two related assertions require one coherent repair.",
        requiredChange: "Repair both assertions together.", whyBlocking: "The acceptance behavior is incomplete.",
        origin: null, failureKind: null,
      }],
      advisoryFindings: [],
    }));
    assert.deepEqual(parsed.blocking[0].toJSON().testPaths, ["flow-query-api.test.js", "nested/api.spec.js"]);
  });

  it("accepts missing top-level test review findings arrays and rejects malformed items", () => {
    const empty = parseTestReviewFindings(JSON.stringify({}));
    assert.equal(empty.blocking.length, 0);
    assert.equal(empty.advisory.length, 0);

    const blockingOnly = parseTestReviewFindings(JSON.stringify({
      blockingFindings: [{
        title: "Missing coverage",
        target: "R2",
        issue: "R2 has no test.",
        requiredChange: "Add a spec-local test for R2.",
        whyBlocking: "Implementation would proceed without acceptance coverage.",
      }],
    }));
    assert.equal(blockingOnly.blocking.length, 1);
    assert.equal(blockingOnly.advisory.length, 0);

    const advisoryOnly = parseTestReviewFindings(JSON.stringify({
      advisoryFindings: [{
        title: "Extra boundary",
        target: "R1",
        improvement: "Add one more boundary case.",
        whyNonBlocking: "Current coverage is adequate for implementation.",
      }],
    }));
    assert.equal(advisoryOnly.blocking.length, 0);
    assert.equal(advisoryOnly.advisory.length, 1);

    assert.throws(
      () => parseTestReviewFindings(JSON.stringify({ blockingFindings: "none", advisoryFindings: [] })),
      /test review output failed schema validation/,
    );
    assert.throws(
      () => parseTestReviewFindings(JSON.stringify({
        blockingFindings: [{ title: "Missing required fields" }],
        advisoryFindings: [],
      })),
      /test review output failed schema validation/,
    );
  });
});

describe("resolveAgent for flow.review", () => {
  it("resolves flow.review.draft independently from flow.review.final via profiles", () => {
    const cfg = {
      agent: {
        default: "claude",
        providers: {
          claude: { command: "claude", args: ["-p", "{{PROMPT}}"] },
          "claude/opus": { command: "claude", args: ["-p", "{{PROMPT}}", "--model", "opus"] },
          codex: { command: "codex", args: ["exec", "{{PROMPT}}"] },
        },
        useProfile: "review",
        profiles: {
          review: {
            "flow.review.draft": "codex",
            "flow.review.final": "claude/opus",
          },
        },
      },
    };
    const draft = resolveAgent(cfg, "flow.review.draft");
    assert.equal(draft.command, "codex");

    const final = resolveAgent(cfg, "flow.review.final");
    assert.equal(final.command, "claude");
    assert.ok(final.args.includes("opus"));
  });

  it("falls back to flow.review prefix when specific phase not configured via profiles", () => {
    const cfg = {
      agent: {
        default: "claude",
        providers: {
          claude: { command: "claude", args: ["-p", "{{PROMPT}}"] },
          codex: { command: "codex", args: ["exec", "{{PROMPT}}"] },
        },
        useProfile: "review",
        profiles: {
          review: { "flow.review": "codex" },
        },
      },
    };
    // flow.review.draft matches "flow.review" prefix
    const draft = resolveAgent(cfg, "flow.review.draft");
    assert.equal(draft.command, "codex");
  });

  it("falls back to default agent when no flow.review configured", () => {
    const cfg = {
      agent: {
        default: "claude",
        providers: {
          claude: { command: "claude", args: ["-p", "{{PROMPT}}"] },
        },
      },
    };
    const draft = resolveAgent(cfg, "flow.review.draft");
    assert.equal(draft.command, "claude");
  });
});

describe("parseProposals extracts file from **File:** marker (spec 201 R-P1/R-P3)", () => {
  it("returns file=<path> when body contains '**File:** `path`'", () => {
    const text = [
      "### 1. Title A",
      "**File:** `src/foo.js`",
      "**Issue:** something",
      "",
      "### 2. Title B",
      "**File:** src/bar.js",
      "**Issue:** another",
    ].join("\n");
    const proposals = parseProposals(text);
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0].file, "src/foo.js");
    assert.equal(proposals[1].file, "src/bar.js");
  });

  it("returns file=null when body has no **File:** marker", () => {
    const text = "### 1. No file\n**Issue:** nothing to point at\n";
    const proposals = parseProposals(text);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].file, null);
  });

  it("rejects Markdown and provider preambles at the loop review boundary", async () => {
    const rawResponse = [
      "I’ll inspect the touched test file first.The path is unavailable under the agent work directory.### 1. Extract the Active Spec Path",
      "**File:** `tests/unit/flow/retry-recovery-convergence.test.js`",
      "**Requirement:** R1",
      "**Issue:** The test repeats the same spec path.",
      "**Suggestion:** Extract and reuse a local specPath constant.",
    ].join("\n");
    const requirementIds = new Set(["R1"]);
    const result = await runLoopReviewWithDependencies({
      groups: [{
        files: ["tests/unit/flow/retry-recovery-convergence.test.js"],
        representative: "tests/unit/flow/retry-recovery-convergence.test.js",
        diff: "+ test",
      }],
      buildChunkInput: () => "review input",
      reviewChunk: async () => rawResponse,
      crossCheck: async () => JSON.stringify({ proposals: [] }),
      requirementIds,
    });

    assert.equal(result.failureKind, "parser_failure");
    assert.equal(result.proposals.length, 0);
    assert.ok(result.toolingOutcome);
  });

  it("blocks the same terminal WorkUnit without another call and executes changed input", async () => {
    const checkpointStore = createMemoryWorkUnitCheckpointStore();
    const groups = [{
      files: ["src/example.js"],
      representative: "src/example.js",
      diff: "+ changed",
    }];
    let input = "same input";
    let calls = 0;
    let failAuthentication = true;
    const run = () => runLoopReviewWithDependencies({
      groups,
      buildChunkInput: () => input,
      reviewChunk: async () => {
        calls += 1;
        if (failAuthentication) {
          throw new AgentAuthenticationFailure({ message: "HTTP 401 Unauthorized" })
            .recordAttempts(1, 3);
        }
        return JSON.stringify({ proposals: [] });
      },
      crossCheck: async () => JSON.stringify({ proposals: [] }),
      checkpointStore,
    });

    await assert.rejects(run(), AgentAuthenticationFailure);
    failAuthentication = false;
    await assert.rejects(
      run(),
      (error) => (
        error instanceof WorkUnitToolingFailure
        && error.failureCode === "AGENT_AUTHENTICATION_FAILED"
        && error.retryable === false
      ),
    );
    assert.equal(calls, 1);

    input = "changed input";
    const changed = await run();
    assert.equal(calls, 2);
    assert.equal(changed.reviewCallCount, 1);
  });
});

describe("canonical impl loop work-unit checkpoints", () => {
  let checkpointRoot = null;

  afterEach(() => {
    if (checkpointRoot) removeTmpDir(checkpointRoot);
    checkpointRoot = null;
  });

  it("keeps retry checkpoints in the parent work unit and recreates them after transient cleanup", async () => {
    checkpointRoot = createTmpDir("canonical-loop-review-checkpoint-");
    const versionDirectory = path.join(checkpointRoot, "specs", "001-loop-checkpoint", "001");
    const outputDirectory = path.join(
      versionDirectory,
      ".runtime",
      "review-work-units",
      "impl-review",
      "attempt-loop-checkpoint",
    );
    const environmentKey = "SENNEL_REVIEW_OUTPUT_DIR";
    const previousOutputDirectory = process.env[environmentKey];
    process.env[environmentKey] = outputDirectory;
    try {
      const checkpointStore = canonicalLoopReviewCheckpointStore();
      const checkpointDirectory = checkpointStore.checkpointDir();
      let calls = 0;
      const run = () => runLoopReviewWithDependencies({
        groups: [{
          files: ["src/example.js"],
          representative: "src/example.js",
          diff: "+ canonical loop review",
        }],
        buildChunkInput: () => "canonical loop input",
        reviewChunk: async () => {
          calls += 1;
          return JSON.stringify({ proposals: [] });
        },
        crossCheck: async () => JSON.stringify({ proposals: [] }),
        checkpointStore,
        requirementIds: new Set(["R-1"]),
      });

      const first = await run();
      assert.equal(first.reviewCallCount, 1);
      assert.equal(calls, 1);
      assert.equal(checkpointDirectory, path.join(outputDirectory, "review-history", "work-units", "impl-review"));
      assert.equal(fs.readdirSync(checkpointDirectory).length, 1);
      assert.equal(fs.existsSync(path.join(versionDirectory, "review-history")), false);

      fs.rmSync(checkpointDirectory, { recursive: true, force: true });
      const retried = await run();
      assert.equal(retried.reviewCallCount, 1);
      assert.equal(calls, 2);
      assert.equal(fs.readdirSync(checkpointDirectory).length, 1);
      assert.equal(fs.existsSync(path.join(versionDirectory, "review-history")), false);
    } finally {
      if (previousOutputDirectory === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = previousOutputDirectory;
    }
  });
});

describe("buildDraftSystemPrompt enforces scope (spec 201 R-P2)", () => {
  it("includes an instruction restricting proposals to the diff target files", () => {
    const prompt = buildDraftSystemPrompt();
    assert.match(
      prompt,
      /diff|touched|changed/i,
      "prompt must mention diff/touched/changed scope constraint",
    );
    assert.match(
      prompt,
      /only|do not propose|out of scope|outside/i,
      "prompt must explicitly restrict suggestions",
    );
  });
});

describe("spec review classification helpers", () => {
  it("builds a review summary with acceptance, decisions, tasks, and unresolved items", () => {
    const longTail = "x".repeat(900);
    const summary = buildSpecSummaryMarkdown({
      goal: "Improve spec-review input.",
      background: "Existing review lacks some spec fields.",
      scope: { in: ["`src/flow/commands/review.js`"], out: ["No CLI flag changes"] },
      constraints: ["Keep prompt size bounded."],
      design_principles: ["Pass only blocking-review-relevant fields."],
      overview: {
        modules: [{ text: "Review command" }],
        data_flow: [{ text: "spec.json -> review summary -> reviewer" }],
        decisions: [{
          text: "Use structured review memory.",
          evidence: `This evidence should be present but truncated. ${longTail}`,
          consideredAlternatives: "Pass full spec.md to review.",
        }],
      },
      requirements: [{
        id: "R1",
        priority: "must",
        testable: false,
        desc: "Review should see acceptance criteria.",
      }],
      acceptance_criteria: ["spec-review sees acceptance criteria"],
      clarifications: [{ q: "Should review see prior answers?", a: "Yes, through bounded fields." }],
      alternatives_considered: [{ option: "Full spec.md input", reason: "Too much token growth." }],
      open_questions: ["Confirm whether live-provider behavior is in scope."],
      tasks: [{
        id: "T-1",
        title: "Enrich spec review summary",
        status: "pending",
        goal: "Expose task-level acceptance and test strategy.",
        acceptance: ["summary includes task acceptance"],
        test_strategy: `Unit test summary field projection. ${longTail}`,
      }],
    });

    assert.match(summary, /# Acceptance Criteria/);
    assert.match(summary, /spec-review sees acceptance criteria/);
    assert.match(summary, /# Clarifications/);
    assert.match(summary, /Q: Should review see prior answers\?/);
    assert.match(summary, /# Alternatives Considered/);
    assert.match(summary, /Option: Full spec\.md input/);
    assert.match(summary, /# Open Questions/);
    assert.match(summary, /Confirm whether live-provider behavior is in scope/);
    assert.match(summary, /## Decisions/);
    assert.match(summary, /evidence: This evidence should be present but truncated/);
    assert.match(summary, /testable=false/);
    assert.match(summary, /# Tasks/);
    assert.match(summary, /T-1: Enrich spec review summary/);
    assert.match(summary, /acceptance: summary includes task acceptance/);
    assert.match(summary, /test_strategy: Unit test summary field projection/);
    assert.doesNotMatch(summary, new RegExp(`x{800}`));
  });

  it("asks for JSON blocking findings separately from non-blocking improvements", () => {
    const prompt = buildSpecReviewPrompt("# Requirements\n- R1 [must]: Do x", []);
    const combined = `${prompt.systemPrompt || ""}\n${prompt.userPrompt || ""}`;

    assert.ok(prompt.jsonSchema, "spec review should provide a JSON schema to Agent");
    assert.match(prompt.fmtFallback, /Return only a JSON object/);
    assert.match(prompt.fmtFallback, /Always include both top-level arrays/);
    assert.match(combined, /Always include both top-level arrays/);
    assert.match(combined, /blockingFindings\[\]/);
    assert.match(combined, /nonBlockingImprovements\[\]/);
    assert.match(combined, /Do not fail the review for non-blocking improvements/);
    assert.match(combined, /Treat a concern as blocking only when/);
    assert.match(combined, /contradicts verified existing codebase behavior/);
    assert.match(combined, /no implementation target or integration point/);
    assert.match(combined, /no observable acceptance\/test basis/);
    assert.match(combined, /required error path, data path, or compatibility path/);
    assert.match(combined, /Two spec fields conflict/);
    assert.match(combined, /wording could be clearer/);
    assert.match(combined, /whyBlocking must name the concrete implementation, testing, safety, or compatibility failure/);
    assert.match(combined, /Gate-owned checks are not blocking findings/);
    assert.match(combined, /JSON schema, required\/empty fields, unresolved markers, tasks missing\/empty\/depth structure, and guardrail compliance/);
    assert.match(combined, /without codebase context, leave it to gate/);
    assert.match(combined, /This review is diagnostic/);
    assert.match(combined, /smallest spec-level correction/);
    assert.match(combined, /If a concern is gate-owned, omit it entirely/);
    assert.match(combined, /omits an impact on existing behavior/);
    assert.match(combined, /target/);
    assert.doesNotMatch(combined, /\*\*File:\*\* `<path>`/);
  });

  it("injects immutable canonical review memory into the next prompt", () => {
    const previousReview = new CanonicalSpecReview({
      version: 2,
      identity: { specId: "001-review", revision: 1, digest: "a".repeat(64), byteLength: 1 },
      generation: 1,
      findings: [{
        kind: "improvement",
        findingId: "spec-review-improvement-1",
        title: "Mention nearby helper",
        target: "src/lib/example.js",
        body: "Mention this helper as related context.",
        improvement: "Mention this helper as related context.",
        whyNonBlocking: "Implementation can proceed without it.",
      }],
      audit: [],
    });
    const prompt = buildSpecReviewPrompt("# Requirements\n- R1 [must]: Do x", [], {
      toPromptMemory() {
        return previousReview.toJSON();
      },
    });

    assert.match(prompt.userPrompt, /## Previous Spec Review Memory/);
    assert.match(prompt.userPrompt, /Mention nearby helper/);
    assert.match(prompt.systemPrompt, /do not repeat acknowledged non-blocking improvements/i);
  });

  it("parses JSON findings and ignores response text outside the object", () => {
    const parsed = parseSpecReviewFindings([
      "preamble that should be ignored",
      JSON.stringify({
        blockingFindings: [{
          title: "Missing acceptance condition",
          target: "R1",
          issue: "R1 has no observable pass/fail behavior.",
          requiredChange: "Add an acceptance condition.",
          whyBlocking: "Tests cannot be designed.",
        }],
        nonBlockingImprovements: [{
          title: "Mention nearby helper",
          target: "src/lib/example.js",
          improvement: "Mention this helper as related context.",
          whyNonBlocking: "Implementation can proceed without it.",
        }],
      }),
      "trailing text that should be ignored",
    ].join("\n"));

    assert.equal(parsed.blocking.length, 1);
    assert.equal(parsed.blocking[0].title, "Missing acceptance condition");
    assert.equal(parsed.blocking[0].target, "R1");
    assert.equal(parsed.improvements.length, 1);
    assert.equal(parsed.improvements[0].title, "Mention nearby helper");
    assert.equal(parsed.improvements[0].target, "src/lib/example.js");
  });

  it("treats omitted spec review finding arrays as empty arrays", () => {
    const empty = parseSpecReviewFindings("{}");
    assert.equal(empty.blocking.length, 0);
    assert.equal(empty.improvements.length, 0);

    const blockingOnly = parseSpecReviewFindings(JSON.stringify({ blockingFindings: [] }));
    assert.equal(blockingOnly.blocking.length, 0);
    assert.equal(blockingOnly.improvements.length, 0);

    const improvementsOnly = parseSpecReviewFindings(JSON.stringify({ nonBlockingImprovements: [] }));
    assert.equal(improvementsOnly.blocking.length, 0);
    assert.equal(improvementsOnly.improvements.length, 0);
  });

  it("terminalizes schema-invalid parsed spec review output without correction retry", () => {
    assert.throws(
      () => parseSpecReviewFindings(
        JSON.stringify({ blockingFindings: "not-array", nonBlockingImprovements: [] }),
      ),
      /spec review output failed schema validation.*blockingFindings/,
    );
  });

  it("rejects markdown proposal output instead of treating it as blocking", () => {
    assert.throws(() => parseSpecReviewFindings([
      "### 1. Legacy proposal",
      "**File:** `src/example.js`",
      "**Issue:** Something is missing.",
      "**Suggestion:** Add it.",
    ].join("\n")), /spec review output failed schema validation|Unexpected token|JSON/i);
  });

  it("renders verdict, blocking findings, and non-blocking improvements separately", () => {
    const md = formatSpecReviewMd({
      verdict: "ADVISORY",
      blocking: [],
      improvements: [{ title: "Helpful detail", body: "**Target:** GLOBAL" }],
    });

    assert.match(md, /## Verdict: ADVISORY/);
    assert.match(md, /## Blocking Findings/);
    assert.match(md, /No blocking findings/);
    assert.match(md, /## Non-blocking Improvements/);
    assert.match(md, /Helpful detail/);
  });

  it("renders a full-input-bound review.delta.json with stable findings", () => {
    const review = new CanonicalSpecReview({
      version: 2,
      identity: { specId: "001-review", revision: 1, digest: "a".repeat(64), byteLength: 1 },
      generation: 0,
      findings: [],
      audit: [],
    });
    const json = formatSpecReviewDelta({
      review,
      blocking: [{
        title: "Missing acceptance condition",
        body: [
          "**Target:** R1",
          "**Issue:** R1 has no observable pass/fail behavior.",
          "**Required change:** Add an acceptance condition.",
          "**Why blocking:** Tests cannot be designed.",
        ].join("\n"),
      }],
      improvements: [{
        title: "Mention nearby helper",
        body: [
          "**Target:** src/lib/example.js",
          "**Improvement:** Mention this helper as related context.",
          "**Why non-blocking:** Implementation can proceed without it.",
        ].join("\n"),
      }],
    });

    assert.equal(json.version, 2);
    assert.equal(json.stage, "spec-review");
    assert.deepEqual(json.identity, review.identity.toJSON());
    assert.equal(json.baseReviewDigest, review.digest);
    assert.equal(json.findings.length, 2);
    assert.equal(json.findings[0].target, "R1");
    assert.equal(json.findings[1].target, "src/lib/example.js");
    assert.deepEqual(json.operations, []);
  });
});

describe("buildDraftReviewPrompt stage-specific QA projection", () => {
  const draftJson = {
    decisionMap: {
      knownFacts: ["The CLI currently has a draft review stage"],
      decisionPoints: ["Decide whether draft coverage is blocking"],
      resolvedByProjectRules: ["Use existing flow step lifecycle"],
      requiresUserJudgment: ["Confirm the user-visible behavior"],
      deferredToSpec: [{ boundary: "Helper placement", relevance: "Preserves reviewed behavior", owner: "spec" }],
    },
    questionLedger: { revision: 0, publication: "fixture", evidenceDigest: "a".repeat(64), questions: [
      {
        id: "q1",
        state: "CandidateQuestion",
        category: "impact-scope",
        question: "Which CLI behavior is in scope?",
        revision: 0, provenance: { producer: "fixture" }, evidenceDigest: "a".repeat(64),
      },
      {
        id: "q2",
        state: "AnsweredQuestion",
        category: "acceptance-criteria",
        question: "Which acceptance criteria apply?",
        answer: "Keep this for coverage review",
        evidenceDigest: "b".repeat(64),
        why: "coverage rationale",
        considered: "coverage alternative",
        revision: 0, provenance: { producer: "fixture" },
      },
      {
        id: "q3",
        state: "CandidateQuestion",
        category: "risk-migration-policy",
        question: "Should this approved question be hidden from coverage?",
        revision: 0, provenance: { producer: "fixture" }, evidenceDigest: "c".repeat(64),
      },
    ] },
  };

  it("omits answer fields from draft-questions-review input", () => {
    const prompt = buildDraftReviewPrompt(draftJson, "request", [], { key: "questions" });
    const leakedAnswerFieldPatterns = [
      /Do not leak this answer/,
      /Do not leak this evidence/,
      /Do not leak this rationale/,
      /Do not leak this considered field/,
    ];
    const coverageOnlyPatterns = [
      /Which acceptance criteria apply\?/,
      /Category coverage across/,
      /Missing first-pass questions/,
      /NEW for missing/,
    ];

    assert.match(prompt, /Which CLI behavior is in scope\?/);
    assert.doesNotMatch(prompt, /\*\*Answer:\*\*/);
    assertAllDoesNotMatch(prompt, leakedAnswerFieldPatterns);
    assertAllDoesNotMatch(prompt, coverageOnlyPatterns);
    assert.match(prompt, /one-shot finite check of the persisted user-decision list/);
    assert.match(prompt, /This is not a question generation task/);
    assert.match(prompt, /An empty question ledger is valid/);
    assert.match(prompt, /redundant confirmation/);
    assert.match(prompt, /Do not identify missing first-pass questions/);
    assert.match(prompt, /Do not propose NEW QA entries/);
    assert.match(prompt, /total: 3/);
    assert.match(prompt, /answered: 1/);
    assert.match(prompt, /## Decision Map/);
    assert.match(prompt, /The CLI currently has a draft review stage/);
  });

  it("limits draft-coverage-review input to answered and dropped QA", () => {
    const prompt = buildDraftReviewPrompt(draftJson, "request", [], { key: "coverage" });
    const renderedQaFieldPatterns = [
      /\*\*Answer:\*\* Keep this for coverage review/,
      /\*\*Evidence digest:\*\* b{64}/,
      /\*\*Why:\*\* coverage rationale/,
      /\*\*Considered:\*\* coverage alternative/,
    ];
    const omittedQuestionStagePatterns = [
      /Which CLI behavior is in scope\?/,
      /Should this approved question be hidden from coverage\?/,
      /Ambiguous user answers must be converted/,
      /unsupported answers/,
      /Propose only NEW follow-up questions/,
    ];

    assertAllMatch(prompt, renderedQaFieldPatterns);
    assertAllDoesNotMatch(prompt, omittedQuestionStagePatterns);
    assert.match(prompt, /one-shot final check/);
    assert.match(prompt, /at most 3 highest-impact blocking gaps/);
    assert.match(prompt, /append ledger entries/);
    assert.match(prompt, /If no blocking user decision is required/);
    assert.match(prompt, /candidates: 2/);
    assert.match(prompt, /answered: 1/);
    assert.match(prompt, /## Decision Map/);
    assert.match(prompt, /Decide whether draft coverage is blocking/);
    assert.match(prompt, /Confirm the user-visible behavior/);

  });

  it("renders empty considered as (none) in coverage review", () => {
    const prompt = buildDraftReviewPrompt({
      ...draftJson,
      questionLedger: { ...draftJson.questionLedger, questions: [{ ...draftJson.questionLedger.questions[1], considered: "" }] },
    }, "request", [], { key: "coverage" });

    assert.match(prompt, /\*\*Considered:\*\* \(none\)/);
  });
});

describe("draft review input authority", () => {
  it("uses the immutable Issue snapshot body instead of only its number", () => {
    const calls = [];
    const flowManager = {
      readArtifact(input) {
        calls.push(input);
        return { bytes: Buffer.from("The Issue already fixes the public response shape.\n", "utf8") };
      },
    };
    const text = buildDraftReviewAuthorityText({
      specId: "demo",
      issue: 517,
      request: "Short request",
    }, {
      artifactPhase: "draft-questions-review",
    }, flowManager);

    assert.equal(text, "Issue #517\nThe Issue already fixes the public response shape.");
    assert.deepEqual(calls, [{
      specId: "demo",
      logicalKey: "issue.snapshot",
      consumerNodeId: "draft-questions-review",
    }]);
  });

  it("uses the canonical request when no Issue is linked", () => {
    const text = buildDraftReviewAuthorityText({
      specId: "demo",
      issue: null,
      request: "Direct request body",
    }, {
      artifactPhase: "draft-questions-review",
    }, {
      readArtifact() { throw new Error("must not read an Issue snapshot"); },
    });
    assert.equal(text, "Direct request body");
  });
});

describe("filterProposalsByScope (spec 201 R-P1/R-P3)", () => {
  it("keeps proposals whose file is in the touched set", () => {
    const proposals = [
      { title: "A", body: "", file: "src/foo.js" },
      { title: "B", body: "", file: "src/bar.js" },
    ];
    const touched = new Set(["src/foo.js", "src/bar.js"]);
    const { kept, excluded } = filterProposalsByScope(proposals, touched);
    assert.equal(kept.length, 2);
    assert.equal(excluded.outOfScope, 0);
    assert.equal(excluded.missingFile, 0);
  });

  it("removes proposals whose file is not in the touched set (R-P1)", () => {
    const proposals = [
      { title: "InScope", body: "", file: "src/foo.js" },
      { title: "OutOfScope", body: "", file: "src/flow/lib/run-draft-task.js" },
    ];
    const touched = new Set(["src/foo.js"]);
    const { kept, excluded } = filterProposalsByScope(proposals, touched);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].title, "InScope");
    assert.equal(excluded.outOfScope, 1);
  });

  it("removes proposals with no file (R-P3) and reports missingFile count", () => {
    const proposals = [
      { title: "WithFile", body: "", file: "src/foo.js" },
      { title: "NoFile", body: "", file: null },
    ];
    const touched = new Set(["src/foo.js"]);
    const { kept, excluded } = filterProposalsByScope(proposals, touched);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].title, "WithFile");
    assert.equal(excluded.missingFile, 1);
  });
});

describe("impl review structured artifact helpers", () => {
  it("requires a typed disposition and rationale for every impl review finding", () => {
    const typedFinding = {
      findingKey: "missing-artifact",
      title: "Missing artifact",
      failureMode: "missing_acceptance_requirement",
      file: null,
      requirementId: "R4",
      issue: "impl-review.json is not written.",
      suggestion: "Write impl-review.json.",
      disposition: "must-fix",
      rationale: "R4 requires a machine-readable artifact.",
    };
    const parse = (entry) => parseImplReviewFindings(JSON.stringify({
      blockingFindings: [entry],
      nonBlockingImprovements: [],
    }), { requirementIds: new Set(["R4"]) });

    const parsed = parse(typedFinding);
    assert.equal(parsed.blockingFindings[0].disposition, "must-fix");

    for (const missingField of ["findingKey", "disposition", "rationale"]) {
      const invalid = { ...typedFinding };
      delete invalid[missingField];
      assert.throws(
        () => parse(invalid),
        new RegExp(`${missingField}.*(required|non-empty)`, "i"),
      );
    }
  });

  it("rejects a partial Task Review recurrence pair after schema validation", () => {
    assert.throws(
      () => parseImplReviewFindings(JSON.stringify({
        blockingFindings: [{
          findingKey: "partial-recurrence",
          title: "Partial recurrence evidence",
          failureMode: "missing_acceptance_requirement",
          file: null,
          requirementId: "R4",
          issue: "The response supplied only one side of the recurrence evidence.",
          suggestion: "Supply both recurrence values or neither.",
          disposition: "must-fix",
          rationale: "Task recurrence evidence must be exact and paired.",
          priorRepairInsufficiency: null,
          repairStrategy: "Use a distinct repair path.",
        }],
        nonBlockingImprovements: [],
      }), { requirementIds: new Set(["R4"]) }),
      /must match exactly one schema in oneOf/,
    );
  });

  it("parses JSON findings and rejects legacy proposal markdown", () => {
    const parsed = parseImplReviewFindings(JSON.stringify({
      blockingFindings: [{
        findingKey: "missing-artifact",
        title: "Missing artifact",
        failureMode: "missing_acceptance_requirement",
        file: null,
        requirementId: "R4",
        issue: "impl-review.json is not written.",
        suggestion: "Write impl-review.json.",
        disposition: "must-fix",
        rationale: "The spec requires a machine-readable artifact.",
      }],
      nonBlockingImprovements: [{
        findingKey: "optional-naming",
        title: "Optional naming",
        failureMode: "naming",
        file: "src/flow/commands/review.js",
        requirementId: "R4",
        issue: "A local variable name could be clearer.",
        suggestion: "Rename it.",
        disposition: "informational",
        rationale: "Readability-only.",
      }],
    }), { requirementIds: new Set(["R4"]) });

    assert.equal(parsed.blockingFindings.length, 1);
    assert.equal(parsed.nonBlockingImprovements.length, 1);
    assert.throws(
      () => parseImplReviewFindings("### 1. Legacy proposal\n**File:** src/example.js", { requirementIds: new Set(["R4"]) }),
      /impl review output failed schema validation|Unexpected token|JSON/i,
    );
  });

  it("filters both blocking and non-blocking findings by touched scope", () => {
    const parsed = parseImplReviewFindings(JSON.stringify({
      blockingFindings: [
        {
          findingKey: "keep-missing-requirement",
          title: "Keep missing requirement",
          failureMode: "missing_acceptance_requirement",
          file: null,
          requirementId: "R4",
          issue: "Missing artifact.",
          suggestion: "Write it.",
          disposition: "must-fix",
          rationale: "Requirement blocker.",
        },
        {
          findingKey: "drop-outside",
          title: "Drop outside",
          failureMode: "spec_behavior_contradiction",
          file: "src/outside.js",
          requirementId: "R4",
          issue: "Outside diff.",
          suggestion: "Drop it.",
          disposition: "must-fix",
          rationale: "Out of scope.",
        },
      ],
      nonBlockingImprovements: [
        {
          findingKey: "keep-advisory",
          title: "Keep advisory",
          failureMode: "refactor",
          file: "src/flow/commands/review.js",
          requirementId: "R4",
          issue: "Optional touched-file issue.",
          suggestion: "Optional fix.",
          disposition: "informational",
          rationale: "Non-blocking.",
        },
        {
          findingKey: "drop-missing-file",
          title: "Drop missing file",
          failureMode: "refactor",
          file: "",
          requirementId: "R4",
          issue: "No file.",
          suggestion: "Drop it.",
          disposition: "informational",
          rationale: "Missing file.",
        },
      ],
    }), { requirementIds: new Set(["R4"]) });
    const filtered = filterImplReviewFindingsByScope({
      parsed,
      touchedFiles: new Set(["src/flow/commands/review.js"]),
      requirementIds: new Set(["R4"]),
    });

    assert.deepEqual(filtered.excluded, { missingFile: 1, outOfScope: 1 });
    assert.deepEqual(filtered.blockingFindings.map((item) => item.title), ["Keep missing requirement"]);
    assert.deepEqual(filtered.nonBlockingImprovements.map((item) => item.title), ["Keep advisory"]);
  });

  it("renders review.md and impl-review.json with advisory verdicts", () => {
    const input = {
      blockingFindings: [],
      nonBlockingImprovements: [{
        findingKey: "optional-cleanup",
        title: "Optional cleanup",
        failureMode: "refactor",
        file: "src/flow/lib/run-review.js",
        requirementId: "R4",
        issue: "A branch could be clearer.",
        suggestion: "Rename the branch.",
        disposition: "informational",
        rationale: "Readability-only.",
      }],
      excluded: { missingFile: 0, outOfScope: 0 },
    };
    const json = JSON.parse(formatImplReviewJson(input));
    const md = formatImplReviewMd(input);

    assert.equal(json.verdict, "ADVISORY");
    assert.deepEqual(json.summary, { blocking: 0, nonBlocking: 1, total: 1 });
    assert.match(json.nonBlockingImprovements[0].findingId, /^[a-f0-9]{64}$/);
    assert.match(md, /## Non-blocking Improvements/);
    assert.match(md, /Optional cleanup/);
  });

  it("builds prompts with the blocking and non-blocking policy", () => {
    const prompt = buildImplReviewPrompt({
      requirementFileMap: { R1: ["src/flow/commands/review.js"] },
      requirementIds: new Set(["R1"]),
      diff: "diff",
      touchedFiles: ["src/flow/commands/review.js"],
    });
    const combined = `${prompt.systemPrompt}\n${prompt.userPrompt}`;

    assert.match(combined, /blockingFindings\[\]/);
    assert.match(combined, /nonBlockingImprovements\[\]/);
    assert.match(combined, /missing_acceptance_requirement/);
    assert.match(combined, /spec_behavior_contradiction/);
    assert.match(combined, /security_or_data_integrity_bug/);
    assert.match(combined, /touched file/);
    assert.match(combined, /replacement action/);
    assert.match(combined, /requirementId is always required/);
    assert.match(combined, /findingKey/);
  });

  it("labels Task Review input as current source without a diff or test log", () => {
    const prompt = buildImplReviewPrompt({
      requirementFileMap: { R1: ["src/task.js"] },
      requirementIds: new Set(["R1"]),
      diff: "export const task = true;",
      touchedFiles: ["src/task.js"],
      taskSpec: { relPath: "tasks/T-1.md", content: "Implement the current Task." },
      taskContext: {
        task: { id: "T-1", goal: "Implement the current Task." },
        requirements: [{ id: "R1", desc: "Provide the Task behavior." }],
      },
      taskReviewAttempt: 1,
    });

    assert.match(prompt.userPrompt, /## Current Task Source/);
    assert.match(prompt.userPrompt, /export const task = true;/);
    assert.doesNotMatch(prompt.userPrompt, /## Diff/);
    assert.doesNotMatch(prompt.userPrompt, /testlog|test log/i);
  });

  it("maps every canonical Task source path to every current Task Requirement", () => {
    const fileMap = canonicalTaskReviewFileMap({
      context: {
        requirements: [
          { id: "R1", desc: "Provide the shared behavior." },
          { id: "R2", desc: "Preserve the shared behavior." },
        ],
      },
      source: {
        entries: [
          { path: "src/shared.js", status: "present", content: "shared" },
          { path: "src/secondary.js", status: "present", content: "secondary" },
        ],
      },
    });

    assert.deepEqual(fileMap, {
      R1: ["src/shared.js", "src/secondary.js"],
      R2: ["src/shared.js", "src/secondary.js"],
    });
    const requirementSourceScope = CanonicalSourceRequirementAuthority
      .fromTaskRequirements([{ id: "R1" }, { id: "R2" }])
      .bindSourceScope(["src/shared.js", "src/secondary.js"]);
    const prompt = buildImplReviewPrompt({
      requirementFileMap: fileMap,
      requirementSourceScope,
      requirementIds: new Set(["R1", "R2"]),
      diff: "shared source",
      touchedFiles: ["src/shared.js", "src/secondary.js"],
      taskSpec: { relPath: "tasks/T-1.md", content: "Review both Requirements." },
      taskContext: { task: { id: "T-1" }, requirements: [{ id: "R1" }, { id: "R2" }] },
      taskReviewAttempt: 1,
    });
    assert.equal(prompt.userPrompt.match(/src\/shared\.js/g)?.length, 2);
    assert.equal(prompt.userPrompt.match(/src\/secondary\.js/g)?.length, 2);
    assert.match(prompt.userPrompt, /relation: all-to-all/);
    assert.throws(
      () => canonicalTaskReviewFileMap({
        context: { requirements: [{ id: "R1" }, { id: "R1" }] },
        source: { entries: [{ path: "src/shared.js" }] },
      }),
      /must not duplicate Requirement ids|ids must be unique/,
    );
  });

  it("rejects an oversized Task Review prompt before resolving or calling the agent", async () => {
    let calls = 0;
    await assert.rejects(
      () => runImplReviewAgentWithDependencies({
        prompt: { systemPrompt: "review", userPrompt: "x".repeat(TASK_REVIEW_PROMPT_CHAR_LIMIT) },
        taskReview: true,
        callAgent: async () => { calls += 1; return "unreachable"; },
      }),
      /TASK_REVIEW_PROMPT_TOO_LARGE/,
    );
    assert.equal(calls, 0);
  });

  it("requires no-change Task Review to validate its declared reason against mapped requirements", () => {
    const prompt = buildImplReviewPrompt({
      requirementFileMap: { R1: [] },
      requirementIds: new Set(["R1"]),
      diff: "",
      touchedFiles: [],
      taskSpec: { relPath: "tasks/T-1.md", content: "Implement the current Task." },
      taskContext: {
        task: { id: "T-1", goal: "Implement the current Task." },
        requirements: [{ id: "R1", desc: "Provide the Task behavior." }],
      },
      taskReviewAttempt: 1,
      taskNoChangeReasons: ["The requested implementation is already present."],
    });

    assert.match(prompt.userPrompt, /## Declared No-Change Reasons/);
    assert.match(prompt.userPrompt, /The requested implementation is already present\./);
    assert.match(prompt.userPrompt, /canonical Task context, mapped Requirements, stated reasons, and the empty current Task source/);
    assert.match(prompt.userPrompt, /must-fix missing_acceptance_requirement blocker with file=null and the mapped requirementId/);
    assert.match(prompt.userPrompt, /Do not use another failure mode or a file-backed finding/);
  });

  it("uses a strict-compatible JSON schema for optional impl review fields", () => {
    const prompt = buildImplReviewPrompt({ requirementIds: new Set(["R1"]) });
    const itemSchema = prompt.jsonSchema.properties.blockingFindings.items;
    const propertyKeys = Object.keys(itemSchema.properties).sort();

    assert.deepEqual([...itemSchema.required].sort(), propertyKeys);
    assert.deepEqual(itemSchema.properties.file.type, ["string", "null"]);
    assert.deepEqual(itemSchema.properties.requirementId.type, ["string", "null"]);
    assert.deepEqual(itemSchema.properties.requirementId.enum, ["R1", null]);
    assert.deepEqual(itemSchema.properties.disposition.enum, ["must-fix", "deferred", "informational"]);
    assert.equal(itemSchema.oneOf.length, 2);
    assert.equal(itemSchema.oneOf[0].properties.priorRepairInsufficiency.type, "null");
    assert.equal(itemSchema.oneOf[0].properties.repairStrategy.type, "null");
    assert.equal(itemSchema.oneOf[1].properties.priorRepairInsufficiency.minLength, 1);
    assert.equal(itemSchema.oneOf[1].properties.repairStrategy.minLength, 1);
    const codexSchema = adaptJsonSchemaForProvider("codex", prompt.jsonSchema);
    const codexItemSchema = codexSchema.properties.blockingFindings.items;
    assert.equal(codexItemSchema.oneOf, undefined);
    assert.equal(codexItemSchema.anyOf.length, 2);
  });

  it("assigns a stable findingKey to loop review proposals", () => {
    const proposal = new ImplReviewProposal({
      title: "Extract shared branch",
      file: "src/example.js",
      issue: "The branch is duplicated.",
      suggestion: "Extract the duplicated branch.",
      requirementId: "R1",
    }, { requirementIds: new Set(["R1"]) });
    const first = parseImplReviewFindings(
      loopProposalsToImplReviewJson([proposal], new Set(["R1"])),
      { requirementIds: new Set(["R1"]) },
    );
    const second = parseImplReviewFindings(
      loopProposalsToImplReviewJson([proposal], new Set(["R1"])),
      { requirementIds: new Set(["R1"]) },
    );

    assert.match(first.nonBlockingImprovements[0].findingKey, /^loop-[a-f0-9]{20}$/);
    assert.equal(
      first.nonBlockingImprovements[0].findingKey,
      second.nonBlockingImprovements[0].findingKey,
    );
  });

});

function initTestRepo(tmp, baseFiles) {
  execFileSync("git", ["-C", tmp, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", tmp, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", tmp, "config", "user.name", "t"]);
  for (const [name, content] of Object.entries(baseFiles)) {
    fs.writeFileSync(join(tmp, name), content);
  }
  execFileSync("git", ["-C", tmp, "add", "."]);
  execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "base"]);
}

describe("collectTouchedFiles (spec 201 R-P4)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("returns the set of files changed in committed diff vs baseRef", () => {
    tmp = createTmpDir();
    initTestRepo(tmp, { "a.js": "a\n", "b.js": "b\n" });
    const baseSha = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", tmp, "checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(join(tmp, "a.js"), "a modified\n");
    execFileSync("git", ["-C", tmp, "add", "a.js"]);
    execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "change a"]);

    const touched = collectTouchedFiles(tmp, baseSha);
    assert.ok(touched instanceof Set, "returns a Set");
    assert.ok(touched.has("a.js"), "includes changed file");
    assert.ok(!touched.has("b.js"), "excludes unchanged file");
  });

  it("includes staged-but-uncommitted changes", () => {
    tmp = createTmpDir();
    initTestRepo(tmp, { "a.js": "a\n" });
    const baseSha = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    fs.writeFileSync(join(tmp, "c.js"), "c\n");
    execFileSync("git", ["-C", tmp, "add", "c.js"]);

    const touched = collectTouchedFiles(tmp, baseSha);
    assert.ok(touched.has("c.js"), "includes staged file");
  });
});

function createDivergedHistoryFixture(tmp) {
  initTestRepo(tmp, { "a.js": "a\n", "upstream.js": "u\n" });

  execFileSync("git", ["-C", tmp, "checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(join(tmp, "a.js"), "a modified on feature\n");
  execFileSync("git", ["-C", tmp, "add", "a.js"]);
  execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "feature change"]);

  execFileSync("git", ["-C", tmp, "checkout", "-q", "main"]);
  fs.writeFileSync(join(tmp, "upstream.js"), "u modified on main\n");
  execFileSync("git", ["-C", tmp, "add", "upstream.js"]);
  execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "upstream-only commit"]);

  execFileSync("git", ["-C", tmp, "checkout", "-q", "feature"]);

  return {
    featureFile: "a.js",
    upstreamFile: "upstream.js",
    mergeBase: resolveMergeBase(tmp, "main"),
  };
}

describe("collectTouchedFiles with merge-base starting point (spec 223)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("excludes upstream-only commits when baseBranch has advanced beyond the merge-base", () => {
    tmp = createTmpDir();
    const { featureFile, upstreamFile, mergeBase } = createDivergedHistoryFixture(tmp);

    const touched = collectTouchedFiles(tmp, mergeBase);
    assert.ok(touched.has(featureFile), "includes branch-local change");
    assert.ok(
      !touched.has(upstreamFile),
      "excludes upstream-only change (baseBranch advanced beyond merge-base)",
    );
  });

  it("old behavior (baseBranch tip) would include upstream-only commits — confirms bug would re-appear without merge-base", () => {
    tmp = createTmpDir();
    const { upstreamFile, mergeBase } = createDivergedHistoryFixture(tmp);

    // Passing baseBranch tip ref (= main) reproduces the bug: touched includes upstream.js
    const touchedFromTip = collectTouchedFiles(tmp, "main");
    assert.ok(
      touchedFromTip.has(upstreamFile),
      "sanity: baseBranch tip includes upstream-only file (this is the bug spec 223 fixes at the caller layer)",
    );

    // Passing merge-base excludes it
    const touchedFromMergeBase = collectTouchedFiles(tmp, mergeBase);
    assert.ok(!touchedFromMergeBase.has(upstreamFile));
  });
});

describe("resolveMergeBase (spec 223)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("returns the SHA of the common ancestor between HEAD and baseBranch", () => {
    tmp = createTmpDir();
    initTestRepo(tmp, { "a.js": "a\n" });
    const baseCommit = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    execFileSync("git", ["-C", tmp, "checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(join(tmp, "a.js"), "a modified\n");
    execFileSync("git", ["-C", tmp, "add", "a.js"]);
    execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "feature change"]);

    const mergeBase = resolveMergeBase(tmp, "main");
    assert.equal(mergeBase, baseCommit);
  });

  it("throws a non-silent error when no common ancestor exists (orphan branch)", () => {
    tmp = createTmpDir();
    initTestRepo(tmp, { "a.js": "a\n" });

    // Create an orphan branch with no shared history
    execFileSync("git", ["-C", tmp, "checkout", "--orphan", "orphan"]);
    execFileSync("git", ["-C", tmp, "rm", "-rf", "-q", "."]);
    fs.writeFileSync(join(tmp, "o.js"), "o\n");
    execFileSync("git", ["-C", tmp, "add", "o.js"]);
    execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "orphan root"]);

    assert.throws(
      () => resolveMergeBase(tmp, "main"),
      (err) => /merge-base/.test(err.message),
      "must throw an error that mentions merge-base",
    );
  });

  it("throws when the base branch does not exist", () => {
    tmp = createTmpDir();
    initTestRepo(tmp, { "a.js": "a\n" });

    assert.throws(
      () => resolveMergeBase(tmp, "nonexistent-branch"),
      (err) => /merge-base/.test(err.message),
    );
  });
});

describe("resolveAgent for flow.review.test", () => {
  it("resolves flow.review.test when explicitly configured via profiles", () => {
    const cfg = {
      agent: {
        default: "claude",
        providers: {
          claude: { command: "claude", args: ["-p", "{{PROMPT}}"] },
          codex: { command: "codex", args: ["exec", "{{PROMPT}}"] },
        },
        useProfile: "review",
        profiles: {
          review: {
            "flow.review.test": "codex",
            "flow.review.draft": "claude",
          },
        },
      },
    };
    const testAgent = resolveAgent(cfg, "flow.review.test");
    assert.equal(testAgent.command, "codex");
  });

  it("falls back to flow.review prefix when flow.review.test not in profile", () => {
    const cfg = {
      agent: {
        default: "claude",
        providers: {
          claude: { command: "claude", args: ["-p", "{{PROMPT}}"] },
          codex: { command: "codex", args: ["exec", "{{PROMPT}}"] },
        },
        useProfile: "review",
        profiles: {
          review: { "flow.review": "codex" },
        },
      },
    };
    // flow.review.test matches "flow.review" prefix
    const testAgent = resolveAgent(cfg, "flow.review.test");
    assert.equal(testAgent.command, "codex");
  });

  it("falls back to agent.default when no flow.review configured", () => {
    const cfg = {
      agent: {
        default: "claude",
        providers: {
          claude: { command: "claude", args: ["-p", "{{PROMPT}}"] },
        },
      },
    };
    const testAgent = resolveAgent(cfg, "flow.review.test");
    assert.equal(testAgent.command, "claude");
  });
});

describe("Task Review outer subprocess retry boundary", () => {
  it("does not add a second child execution for a schema marker when Task protocol owns retries", async () => {
    const failure = ReviewFailure.schemaFailure({
      phase: "impl",
      targetReview: "Task Review",
      validationError: "recurrence explanation and repair strategy must be supplied together",
    });
    let calls = 0;
    const result = await runCmdWithRetry(() => {
      calls += 1;
      return { ok: false, status: 1, stdout: "", stderr: failure.toMarkerLine(), signal: null, killed: false };
    }, {
      phase: "impl",
      retryCount: 0,
      retryDelayMs: 0,
      retrySchema: false,
    });
    assert.equal(calls, 1);
    assert.equal(ReviewFailure.fromSubprocessResult({ phase: "impl", result }).classification, "schema_failure");
  });
});
