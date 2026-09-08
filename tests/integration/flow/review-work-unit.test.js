import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  CanonicalReviewWorkUnit,
  CanonicalReviewPromotion,
  canonicalReviewArtifactFilename,
} from "../../../src/flow/lib/canonical-review-artifacts.js";
import { CanonicalReviewInputDescriptor } from "../../../src/flow/lib/review-work-unit-input.js";
import {
  REVIEW_WORK_UNIT_MANIFEST_ENV,
  ReviewWorkUnit,
  ReviewWorkUnitOutput,
  TaskReviewUnsealedWorkUnitSet,
  reconcileCompletedReviewWorkUnits,
} from "../../../src/flow/lib/review-work-unit.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import {
  parseImplReviewOutput,
  parseProposalReviewOutput,
  taskReviewSourceObservationIgnoredDirectories,
  parseSpecReviewOutput,
  parseTestReviewOutput,
  taskReviewRecoveryIgnoredDirectories,
} from "../../../src/flow/lib/run-review.js";
import {
  SourceMutationBaseline,
  SourceMutationManifest,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { parseTestReviewFindings } from "../../../src/flow/commands/review.js";
import {
  TestReviewRepairFinding,
  TestReviewRepairScope,
} from "../../../src/flow/lib/test-review-repair.js";
import {
  CanonicalSpecReview,
  SpecReviewDelta,
} from "../../../src/flow/lib/spec-review-artifacts.js";
import { CanonicalTaskContext } from "../../../src/flow/lib/task-canonical-context.js";

const roots = [];

function root() {
  const value = createTmpDir("review-work-unit-");
  roots.push(value);
  return value;
}

function createWorkUnit(executionRoot, overrides = {}) {
  return new ReviewWorkUnit({
    executionRoot,
    runId: "review-run",
    specId: "001-review-work-unit",
    phase: "draft-questions",
    nodeId: "draft-questions-review",
    attemptId: "attempt-1",
    target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) },
    output: new ReviewWorkUnitOutput({
      logicalKey: "draft.questions.review",
      basename: "draft-review-questions.json",
      mediaType: "application/json",
    }),
    ...overrides,
  });
}

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

describe("ReviewWorkUnit", () => {
  it("derives every review output basename from its one typed descriptor route", () => {
    for (const [phase, taskId, basename] of [
      ["draft-questions", null, "draft-review-questions.json"],
      ["draft-coverage", null, "draft-review-coverage.json"],
      ["spec", null, "review.delta.json"],
      ["test", null, "test-review.json"],
      ["impl", null, "impl-review.json"],
      ["impl", "task-1", "impl-review.json"],
    ]) {
      assert.equal(canonicalReviewArtifactFilename({ phase, taskId }), basename);
    }
  });

  it("builds a child descriptor from persisted spec.review bytes without replacing promotion metadata", () => {
    const executionRoot = root();
    const persistentReview = new CanonicalSpecReview({
      version: 2,
      identity: { specId: "001-persisted-review", revision: 2, digest: "c".repeat(64), byteLength: 1 },
      generation: 1,
      findings: [],
      audit: [],
    });
    const bytes = Buffer.from(`${JSON.stringify(persistentReview.toJSON())}\n`, "utf8");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const persistentDescriptor = {
      mediaType: "application/json",
      relativePath: "revisions/002/review.json",
      hash: digest,
      size: bytes.length,
    };
    const flowManager = {
      readArtifact() { return null; },
      canonicalState() {
        return { attempt: { nodeId: "spec-review", id: "persisted-review-attempt" } };
      },
      readCurrentSpecReviewInput() {
        return {
          revision: 2,
          descriptor: persistentDescriptor,
          bytes,
          review: persistentReview,
          persisted: true,
        };
      },
    };
    const workUnit = new CanonicalReviewWorkUnit({
      flowManager,
      state: { schemaRevision: 3, specId: "001-persisted-review", runId: "persisted-review-run" },
      phase: "spec",
      executionRoot,
      treeSha: "a".repeat(40),
      targetStateDigest: "b".repeat(64),
    });

    const inputDescriptor = workUnit.materializeSpecReview();

    assert.ok(inputDescriptor instanceof CanonicalReviewInputDescriptor);
    assert.deepEqual(inputDescriptor.toJSON(), {
      version: 1,
      logicalKey: "spec.review",
      logicalPath: "review.json",
      sourcePath: inputDescriptor.sourcePath,
      digest,
      byteLength: bytes.length,
    });
    assert.deepEqual(inputDescriptor.readBytes(), bytes);
    assert.equal(workUnit.specReviewSource.revision, 2);
    assert.equal(workUnit.specReviewSource.descriptor, persistentDescriptor);
    assert.equal(workUnit.specReviewSource.review, persistentReview);
    assert.equal(workUnit.specReviewSource.persisted, true);
  });

  it("seals only an execution-checkout work unit and recovers only an exact parent contract", () => {
    const mainRoot = root();
    const executionRoot = path.join(root(), "execution");
    fs.mkdirSync(executionRoot, { recursive: true });
    initGitRepo(mainRoot);
    initGitRepo(executionRoot);
    const writer = createWorkUnit(executionRoot);
    writer.writeInput({
      logicalKey: "draft",
      logicalPath: "draft.json",
      bytes: Buffer.from('{"qa":[]}\n', "utf8"),
      mediaType: "application/json",
      root: true,
    });
    const surface = writer.finalize();
    assert.equal(surface.directory.startsWith(path.join(executionRoot, ".sennel", "review-work-units")), true);
    assert.equal(surface.directory.startsWith(mainRoot), false);
    fs.writeFileSync(surface.outputPath, '{"verdict":"PASS","blockingFindings":[],"advisoryFindings":[]}\n');
    ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }).seal();

    const recovered = createWorkUnit(executionRoot);
    recovered.declareInput({
      logicalKey: "draft",
      logicalPath: "draft.json",
      bytes: Buffer.from('{"qa":[]}\n', "utf8"),
      mediaType: "application/json",
      root: true,
    });
    assert.ok(recovered.recoverSealed());

    const mismatched = createWorkUnit(executionRoot, {
      target: { treeSha: "c".repeat(40), targetStateDigest: "b".repeat(64) },
    });
    mismatched.declareInput({
      logicalKey: "draft",
      logicalPath: "draft.json",
      bytes: Buffer.from('{"qa":[]}\n', "utf8"),
      mediaType: "application/json",
      root: true,
    });
    assert.throws(() => mismatched.recoverSealed(), /parent Attempt contract/);
  });

  it("fails closed for unsealed residue and every tampered worker boundary", () => {
    const executionRoot = root();
    const unsealed = createWorkUnit(executionRoot);
    unsealed.writeInput({ logicalKey: "draft", logicalPath: "draft.json", bytes: "{}\n", root: true });
    const partial = unsealed.finalize();
    assert.equal(unsealed.recoverSealed(), null);
    assert.equal(fs.existsSync(partial.directory), false, "unsealed residue is safely discarded");

    const writer = createWorkUnit(executionRoot, { attemptId: "attempt-tampered" });
    writer.writeInput({ logicalKey: "draft", logicalPath: "draft.json", bytes: "{}\n", root: true });
    const surface = writer.finalize();
    fs.writeFileSync(surface.outputPath, '{"verdict":"PASS","blockingFindings":[],"advisoryFindings":[]}\n');
    ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }).seal();
    fs.writeFileSync(path.join(surface.directory, "seal.json"), '{"version":1}\n');
    assert.throws(
      () => ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }).readSealedOutput(),
      /seal is invalid|seal has invalid fields/,
    );

    const symlink = createWorkUnit(executionRoot, { attemptId: "attempt-symlink" });
    const symlinkSurface = symlink.finalize();
    const outside = path.join(executionRoot, "outside.json");
    fs.writeFileSync(outside, "{}\n");
    fs.symlinkSync(outside, symlinkSurface.outputPath);
    assert.throws(
      () => ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: symlinkSurface.manifestPath }).seal(),
      /regular (file|real)|symbolic/i,
    );

    const directorySymlink = createWorkUnit(executionRoot, { attemptId: "attempt-directory-symlink" });
    const directorySymlinkSurface = directorySymlink.finalize();
    const manifestBytes = fs.readFileSync(directorySymlinkSurface.manifestPath);
    fs.rmSync(directorySymlinkSurface.directory, { recursive: true });
    const outsideDirectory = path.join(executionRoot, "outside-work-unit");
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(path.join(outsideDirectory, "manifest.json"), manifestBytes);
    fs.symlinkSync(outsideDirectory, directorySymlinkSurface.directory);
    assert.throws(
      () => ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: directorySymlinkSurface.manifestPath }),
      /manifest directory must be a real directory/i,
    );

    const oversizedInput = createWorkUnit(executionRoot, { attemptId: "attempt-oversized-input" });
    oversizedInput.writeInput({ logicalKey: "draft", logicalPath: "draft.json", bytes: "{}\n", root: true });
    const oversizedInputSurface = oversizedInput.finalize();
    fs.writeFileSync(path.join(oversizedInputSurface.directory, "draft.json"), Buffer.alloc(1024, "x"));
    fs.writeFileSync(oversizedInputSurface.outputPath, '{"verdict":"PASS"}\n');
    assert.throws(
      () => ReviewWorkUnit.fromEnvironment({
        [REVIEW_WORK_UNIT_MANIFEST_ENV]: oversizedInputSurface.manifestPath,
      }).seal(),
      /review work unit input draft is unavailable or invalid:.*up to 3 bytes/,
    );
  });

  it("exposes an exact unsealed Attempt surface for Task Review recovery before cleanup", () => {
    const executionRoot = root();
    const writer = createWorkUnit(executionRoot, {
      phase: "impl",
      taskId: "task-1",
      nodeId: "task-1-review",
      attemptId: "task-review-interrupted",
      output: ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: "task-1" }),
    });
    writer.writeInput({
      logicalKey: "task.source",
      logicalPath: "task-source.json",
      bytes: Buffer.from('{"fingerprint":"checkpoint"}\n', "utf8"),
      mediaType: "application/json",
    });
    const surface = writer.finalize();
    const recovered = createWorkUnit(executionRoot, {
      phase: "impl",
      taskId: "task-1",
      nodeId: "task-1-review",
      attemptId: "task-review-interrupted",
      output: ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: "task-1" }),
    });
    recovered.declareInput({
      logicalKey: "task.source",
      logicalPath: "task-source.json",
      bytes: Buffer.from('{"fingerprint":"checkpoint"}\n', "utf8"),
      mediaType: "application/json",
    });
    const partial = recovered.recoverUnsealed();
    assert.ok(partial instanceof ReviewWorkUnit);
    assert.equal(partial.manifestDocument.attemptId, "task-review-interrupted");
    assert.equal(fs.existsSync(surface.directory), true, "recovery owns the unsealed evidence until it has made a disposition");
  });

  it("retains unsealed Task Review evidence during dispatcher reconciliation and enumerates a prior Attempt", () => {
    const executionRoot = root();
    const writer = createWorkUnit(executionRoot, {
      phase: "impl",
      taskId: "task-1",
      nodeId: "task-1-review",
      attemptId: "task-review-prior-attempt",
      output: ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: "task-1" }),
    });
    const surface = writer.finalize();
    const flowManager = {
      canonicalState() {
        return {
          runId: "review-run",
          currentNodeId: "task-1-review",
          attempt: { id: "task-review-current-attempt", nodeId: "task-1-review" },
        };
      },
      activityLedger() {
        return [{ nodeId: "task-1-review", attemptId: "task-review-prior-attempt" }];
      },
      artifactCatalog() { return { artifacts: [] }; },
    };
    assert.equal(reconcileCompletedReviewWorkUnits({
      flowManager,
      specId: "001-review-work-unit",
      executionRoot,
    }), 0, "dispatcher preserves task-scoped unsealed evidence");
    assert.equal(fs.existsSync(surface.directory), true);
    const recovered = TaskReviewUnsealedWorkUnitSet.recover({
      executionRoot,
      runId: "review-run",
      specId: "001-review-work-unit",
      taskId: "task-1",
      nodeId: "task-1-review",
      acceptedAttemptIds: new Set(["task-review-current-attempt", "task-review-prior-attempt"]),
    });
    assert.deepEqual(recovered.workUnits.map((unit) => unit.manifestDocument.attemptId), ["task-review-prior-attempt"]);
  });

  it("keeps read-only phase unsealed cleanup behavior during reconciliation", () => {
    const executionRoot = root();
    const surface = createWorkUnit(executionRoot).finalize();
    const flowManager = {
      canonicalState() { return { runId: "review-run", currentNodeId: "draft-questions-review", attempt: null }; },
      activityLedger() { return []; },
      artifactCatalog() { return { artifacts: [] }; },
    };
    assert.equal(reconcileCompletedReviewWorkUnits({
      flowManager,
      specId: "001-review-work-unit",
      executionRoot,
    }), 1);
    assert.equal(fs.existsSync(surface.directory), false);
  });

  it("re-entry baseline ignores only direct-mode parent receipts and detects other canonical spec changes", () => {
    const executionRoot = root();
    initGitRepo(executionRoot);
    fs.mkdirSync(path.join(executionRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(executionRoot, "src", "task.js"), "export const task = true;\n");
    commitAll(executionRoot, "baseline");
    const versionDirectory = path.join(executionRoot, "specs", "001-review-work-unit", "001");
    const reviewDirectory = path.join(executionRoot, ".sennel", "review-work-units", "task-attempt");
    fs.mkdirSync(reviewDirectory, { recursive: true });
    const ignoredDirectories = taskReviewRecoveryIgnoredDirectories(executionRoot, {
      workUnit: { directory: reviewDirectory },
      flowManager: { specLocation: () => ({ directory: versionDirectory }) },
      state: { specId: "001-review-work-unit" },
    });
    const sourceObservationBaseline = SourceMutationBaseline.capture({
      root: executionRoot,
      attempt: { id: "task-review-attempt", nodeId: "task-1-review", sequence: 1 },
      ignoredDirectories: taskReviewSourceObservationIgnoredDirectories(executionRoot, {
        workUnit: { directory: reviewDirectory },
        flowManager: { specLocation: () => ({ directory: versionDirectory }) },
        state: { specId: "001-review-work-unit" },
      }),
    });
    const baseline = SourceMutationBaseline.capture({
      root: executionRoot,
      attempt: { id: "task-review-attempt", nodeId: "task-1-review", sequence: 1 },
      ignoredDirectories,
    });
    fs.mkdirSync(versionDirectory, { recursive: true });
    fs.writeFileSync(path.join(versionDirectory, "flow.json"), "{\"failure\":true}\n");
    fs.writeFileSync(path.join(versionDirectory, "activities.jsonl"), "{\"failure\":true}\n");
    fs.writeFileSync(path.join(versionDirectory, "artifact-catalog.json"), "{\"failure\":true}\n");
    assert.equal(SourceMutationManifest.capture({ baseline: sourceObservationBaseline }).mutations.length, 0);
    assert.equal(SourceMutationManifest.capture({ baseline }).mutations.length, 0);
    fs.writeFileSync(path.join(versionDirectory, "provider-edited-evidence.json"), "{\"changed\":true}\n");
    assert.deepEqual(
      SourceMutationManifest.capture({ baseline: sourceObservationBaseline }).mutations.map((entry) => entry.path),
      ["specs/001-review-work-unit/001/provider-edited-evidence.json"],
    );
    assert.deepEqual(
      SourceMutationManifest.capture({ baseline }).mutations.map((entry) => entry.path),
      ["specs/001-review-work-unit/001/provider-edited-evidence.json"],
    );
    fs.rmSync(path.join(versionDirectory, "provider-edited-evidence.json"));
    fs.writeFileSync(path.join(executionRoot, "src", "outside-task-allow-list.js"), "export const changed = true;\n");
    assert.deepEqual(
      SourceMutationManifest.capture({ baseline }).mutations.map((entry) => entry.path),
      ["src/outside-task-allow-list.js"],
    );
  });

  it("accepts parent-declared inputs larger than the worker output limit", () => {
    const executionRoot = root();
    const writer = createWorkUnit(executionRoot, { attemptId: "large-parent-input" });
    const input = Buffer.alloc((2 * 1024 * 1024) + 1, "x");
    writer.writeInput({ logicalKey: "spec.record", logicalPath: "spec.json", bytes: input, root: true });
    const surface = writer.finalize();
    fs.writeFileSync(surface.outputPath, '{"verdict":"PASS"}\n');
    assert.doesNotThrow(() => ReviewWorkUnit.fromEnvironment({
      [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath,
    }).seal());

    const recovered = createWorkUnit(executionRoot, { attemptId: "large-parent-input" });
    recovered.declareInput({ logicalKey: "spec.record", logicalPath: "spec.json", bytes: input, root: true });
    assert.ok(recovered.recoverSealed());
  });

  it("rejects an oversized worker output", () => {
    const executionRoot = root();
    const writer = createWorkUnit(executionRoot, { attemptId: "large-worker-output" });
    const surface = writer.finalize();
    fs.writeFileSync(surface.outputPath, Buffer.alloc((2 * 1024 * 1024) + 1, "x"));
    assert.throws(
      () => ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }).seal(),
      /review work unit output is unavailable or invalid:.*2097152 bytes/,
    );
  });

  it("reconstructs phase lifecycle results from sealed artifacts equivalently to the subprocess parser", () => {
    const executionRoot = root();
    const taskSource = Object.freeze({
      fingerprint: "d".repeat(64), lineageFingerprints: [], entries: [], noChangeReasons: [],
    });
    const taskContext = new CanonicalTaskContext({
      state: { runId: "review-run", specId: "001-review-work-unit", currentTaskId: "task-1" },
      spec: {
        overview: { goal: "Verify sealed Task review outputs." },
        tasks: [{ id: "task-1", title: "Task review", goal: "Review the Task." }],
        requirements: [{ id: "R1", description: "The review result is durable.", task_ids: ["task-1"] }],
      },
      sourceFingerprint: taskSource.fingerprint,
    });
    const outcomes = ["PASS", "ADVISORY", "REJECTED"];
    const phases = [
      ["draft-questions", null],
      ["draft-coverage", null],
      ["spec", null],
      ["test", null],
      ["impl", null],
      ["impl", "task-1"],
    ];
    for (const [phase, taskId] of phases) {
      for (const verdict of outcomes) {
        const output = canonicalReviewArtifactFilename({ phase, taskId });
        const workUnit = createWorkUnit(executionRoot, {
          phase,
          taskId,
          nodeId: phase === "impl" ? (taskId === null ? "impl-review" : "task-1-review") : `${phase}-review`,
          attemptId: `${phase}-${taskId || "flow"}-${verdict}`,
          output: new ReviewWorkUnitOutput({ logicalKey: `${phase}.review`, basename: output, mediaType: "application/json" }),
        });
        const surface = workUnit.finalize();
        const blockingFindings = verdict === "REJECTED" ? [{ id: "blocked", summary: "Must fix." }] : [];
        const advisoryFindings = verdict === "ADVISORY" ? [{ id: "advice", summary: "Optional." }] : [];
        const specReview = phase === "spec" ? new CanonicalSpecReview({
          version: 2,
          identity: { specId: "001-review-work-unit", revision: 1, digest: "c".repeat(64), byteLength: 1 },
          generation: 0,
          findings: [],
          audit: [],
        }) : null;
        const workerOutput = phase === "spec"
          ? new SpecReviewDelta({
            version: 2,
            stage: "spec-review",
            identity: specReview.identity.toJSON(),
            baseReviewDigest: specReview.digest,
            findings: verdict === "REJECTED" ? [{
              kind: "blocking", findingId: "blocked", title: "Must fix.", target: "R1", body: "Must fix.",
              issue: "A required behavior is not specified.", requiredChange: "Specify it.", whyBlocking: "It cannot be tested.",
            }] : verdict === "ADVISORY" ? [{
              kind: "improvement", findingId: "advice", title: "Optional.", target: "R1", body: "Optional.",
              improvement: "Clarify this behavior.", whyNonBlocking: "Implementation can proceed.",
            }] : [],
            operations: [],
          }).toJSON()
          : { verdict, blockingFindings, advisoryFindings, nonBlockingImprovements: advisoryFindings };
        fs.writeFileSync(surface.outputPath, `${JSON.stringify(workerOutput, null, 2)}\n`);
        ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }).seal();
        const promotion = new CanonicalReviewPromotion({
          workUnit: ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }),
          phase,
          taskId,
          treeSha: "a".repeat(40),
          targetStateDigest: "b".repeat(64),
          ...(specReview === null ? {} : { specReviewSource: { revision: 1, review: specReview } }),
          ...(taskId === null ? {} : {
            taskSource,
            taskContext,
            taskSpecDigest: "c".repeat(64),
            taskReviewCycle: ReviewFindingCycle.fromActivityLedger({ runId: taskSource.runId, activities: [] }),
          }),
        });
        const recovered = promotion.resultFromSealedArtifact();
        const count = verdict === "PASS" ? 0 : 1;
        const response = { ok: true, status: 0 };
        const stderr = phase.startsWith("draft-")
          ? `verdict=${verdict} questions=${count} retryPhase=${phase}`
          : phase === "spec"
            ? `verdict=${verdict} proposalCount=${count}`
            : phase === "test"
              ? `verdict=${verdict} blocking=${verdict === "REJECTED" ? 1 : 0} advisory=${verdict === "ADVISORY" ? 1 : 0}`
              : `verdict=${verdict} blocking=${verdict === "REJECTED" ? 1 : 0} nonBlocking=${verdict === "ADVISORY" ? 1 : 0}${taskId === null ? "" : ` taskId=${taskId}`}`;
        const parsed = phase.startsWith("draft-")
          ? parseProposalReviewOutput(response, "", stderr)
          : phase === "spec"
            ? parseSpecReviewOutput(response, "", stderr)
            : phase === "test"
              ? parseTestReviewOutput(response, "", stderr)
              : parseImplReviewOutput(response, "", stderr);
        parsed.artifacts.phase = phase;
        if (taskId !== null) parsed.artifacts.taskId = taskId;
        assert.equal(Object.hasOwn(recovered, "next"), false, `${phase}/${verdict} recovered route projection`);
        assert.equal(Object.hasOwn(parsed, "next"), false, `${phase}/${verdict} subprocess route projection`);
        assert.equal(recovered.artifacts.verdict, parsed.artifacts.verdict, `${phase}/${verdict} verdict`);
        assert.equal(recovered.artifacts.taskId || null, parsed.artifacts.taskId || null, `${phase}/${verdict} task`);
        if (phase.startsWith("draft-")) assert.equal(recovered.artifacts.issueCount, parsed.artifacts.issueCount);
        if (phase === "spec") assert.equal(recovered.artifacts.proposalCount, parsed.artifacts.proposalCount);
        if (phase === "test") {
          assert.equal(recovered.artifacts.blockingCount, parsed.artifacts.blockingCount);
          assert.equal(recovered.artifacts.advisoryCount, parsed.artifacts.advisoryCount);
        }
        if (phase === "impl") {
          assert.equal(recovered.artifacts.blockingCount, parsed.artifacts.blockingCount);
          assert.equal(recovered.artifacts.nonBlockingCount, parsed.artifacts.nonBlockingCount);
        }
      }
    }
  });

  it("does not promote a tooling-shaped or verdict-less worker artifact", () => {
    const executionRoot = root();
    const workUnit = createWorkUnit(executionRoot, { attemptId: "tooling-failure" });
    const surface = workUnit.finalize();
    fs.writeFileSync(surface.outputPath, '{"toolingOutcome":{"reason":"permission"}}\n');
    ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }).seal();
    const promotion = new CanonicalReviewPromotion({
      workUnit: ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }),
      phase: "draft-questions",
      treeSha: "a".repeat(40),
      targetStateDigest: "b".repeat(64),
    });
    assert.throws(() => promotion.resultFromSealedArtifact(), /verdict is required/);
  });

  it("keeps test-review repair scope in the sealed artifact while canonical evidence remains identity-only", () => {
    const executionRoot = root();
    const workUnit = createWorkUnit(executionRoot, {
      phase: "test",
      nodeId: "test-review",
      attemptId: "test-review-repair-binding",
      output: new ReviewWorkUnitOutput({
        logicalKey: "test.review",
        basename: "test-review.json",
        mediaType: "application/json",
      }),
    });
    const surface = workUnit.finalize();
    const parsed = parseTestReviewFindings(JSON.stringify({
      blockingFindings: [{
        origin: "test-coverage",
        failureKind: "header_without_test_name",
        title: "Header requirement has no test",
        target: "a.test.js:R1",
        issue: "The header declares R1 but there is no matching test name.",
        requiredChange: "Add an R1 test name to a.test.js.",
        whyBlocking: "Coverage evidence is inconsistent.",
        testPaths: ["a.test.js"],
      }, {
        title: "AI found an incomplete behavior",
        target: "GLOBAL",
        createTestPaths: ["new-behavior.test.js"],
        issue: "The test suite omits an observable behavior.",
        requiredChange: "Add the missing behavior assertion.",
        whyBlocking: "The acceptance premise is not executable.",
      }],
      advisoryFindings: [],
    }));
    fs.writeFileSync(surface.outputPath, `${JSON.stringify({
      verdict: "REJECTED",
      blockingFindings: parsed.blocking.map((finding) => finding.toJSON()),
      advisoryFindings: [],
    })}\n`);
    ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }).seal();
    const promotion = new CanonicalReviewPromotion({
      workUnit: ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }),
      phase: "test",
      treeSha: "a".repeat(40),
      targetStateDigest: "b".repeat(64),
    });
    const sealed = promotion.sealedArtifact();
    assert.deepEqual(sealed.artifact.blockingFindings.map((finding) => finding.target), ["a.test.js:R1", "GLOBAL"]);
    assert.deepEqual(sealed.artifact.blockingFindings[0].testPaths, ["a.test.js"]);
    const resolved = new TestReviewRepairScope({
      finding: new TestReviewRepairFinding(sealed.artifact.blockingFindings[0]),
      testPaths: ["a.test.js"],
    });
    assert.deepEqual(resolved.allowedTestPaths, ["a.test.js"]);
    assert.deepEqual(sealed.artifact.blockingFindings[1].createTestPaths, ["new-behavior.test.js"]);
    const create = new TestReviewRepairScope({
      finding: new TestReviewRepairFinding(sealed.artifact.blockingFindings[1]),
      testPaths: ["a.test.js"],
    });
    assert.equal(create.operation, "create");
    assert.deepEqual(create.allowedTestPaths, ["new-behavior.test.js"]);
    assert.deepEqual(sealed.artifact.blockingFindings.map((finding) => finding.requiredChange), [
      "Add an R1 test name to a.test.js.",
      "Add the missing behavior assertion.",
    ]);
    const evidenceFindings = sealed.evidence.toJSON().blockingFindings;
    for (const [index, evidenceFinding] of evidenceFindings.entries()) {
      assert.equal(Object.hasOwn(evidenceFinding, "target"), false);
      assert.equal(Object.hasOwn(evidenceFinding, "requiredChange"), false);
      assert.equal(evidenceFinding.findingId, sealed.artifact.blockingFindings[index].findingId);
      assert.equal(evidenceFinding.fingerprint, sealed.artifact.blockingFindings[index].fingerprint);
    }
  });
});
