import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import {
  AnsweredQuestion,
  AwaitingUserAnswer,
  CandidateQuestion,
  DiscardedQuestion,
  DraftQuestionLedger,
  ResolvedByExistingInformation,
} from "../../../src/flow/lib/draft-question-ledger.js";
import { DraftLifecycle, nextDraftQaId } from "../../../src/flow/lib/draft-lifecycle.js";
import { DraftQuestionFact, DraftTransitionFacts } from "../../../src/flow/lib/draft-transition-facts.js";
import SetDraftAnswerCommand from "../../../src/flow/lib/set-draft-answer.js";
import GetQaCountCommand from "../../../src/flow/lib/get-qa-count.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { createDraftRefineResult, DraftRefineStep } from "../../../src/flow/steps/draft/draft-refine.js";
import { DraftQuestionResolutionIdentity } from "../../../src/flow/lib/draft-question-resume-receipt.js";
import { DraftRefineConnector } from "../../../src/flow/engine/connectors/draft/draft-refine-connector.js";
import { DraftService } from "../../../src/flow/services/draft-service.js";
import { CanonicalDraftReviewSource } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { DraftRefineAwaitingAnswerResult } from "../../../src/flow/engine/step-result.js";
import { DraftStepSettlementReceiptValue, settleDraftStepResult } from "../../../src/flow/definition.js";

const DIGEST = "a".repeat(64);
const base = { category: "user-visible-behavior", provenance: { producer: "fixture" }, evidenceDigest: DIGEST };
function ledger(questions) { return new DraftQuestionLedger({ revision: 0, publication: "fixture-publication", evidenceDigest: DIGEST, questions }); }
function draft(questionLedger) {
  return {
    devType: "feature", goal: "Exercise typed questions.",
    analysis: { problem: "A decision is required.", proposedApproach: "Persist the ledger.", validation: "Read it again." },
    decisionMap: { knownFacts: [], decisionPoints: [], resolvedByProjectRules: [], requiresUserJudgment: [], deferredToSpec: [] },
    questionLedger: questionLedger.toJSON(),
  };
}

test("exclusive typed states round-trip while ledger order and identity remain stable", () => {
  const value = ledger([
    new CandidateQuestion({ id: "q1", question: "Candidate?", revision: 0, ...base }),
    new ResolvedByExistingInformation({ id: "q2", question: "Resolved?", revision: 0, resolution: "The request answers it.", ...base }),
    new AwaitingUserAnswer({ id: "q3", question: "Awaiting?", revision: 1, ...base }),
    new AnsweredQuestion({ id: "q4", question: "Answered?", revision: 1, answer: "The user chose this public behavior.", why: "It meets the stated goal.", considered: "The incompatible private behavior was rejected.", ...base }),
    new DiscardedQuestion({ id: "q5", question: "Discarded?", revision: 1, reason: "This belongs to spec writing.", ...base }),
  ]);
  const restored = DraftQuestionLedger.from(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(restored.questions.map((question) => question.id), ["q1", "q2", "q3", "q4", "q5"]);
  assert.throws(() => ledger([value.questions[0], value.questions[0]]), /duplicate id/);
  assert.throws(() => new CandidateQuestion({ id: "q01", question: "Leading zero?", revision: 0, ...base }), /q<N>/);
  assert.throws(() => new CandidateQuestion({ id: "q9007199254740992", question: "Oversized?", revision: 0, ...base }), /safe/);
  assert.throws(() => new DraftLifecycle({ ...draft(value), qa: [] }), /schema changed/);
});

test("canonical question ids reject exhausted next sequence", () => {
  const max = new CandidateQuestion({ id: `q${Number.MAX_SAFE_INTEGER}`, question: "Maximum sequence?", revision: 0, ...base });
  assert.throws(() => nextDraftQaId(draft(ledger([max]))), /exhausted/);
});

test("DraftRefineStep result factory selects candidate and awaiting work", () => {
  const value = ledger([new CandidateQuestion({ id: "q1", question: "Choose behavior?", revision: 2, ...base })]);
  const facts = new DraftTransitionFacts({ ledger: value, candidateQuestion: new DraftQuestionFact(value.nextCandidate()) });
  assert.equal(createDraftRefineResult({ facts, autoApprove: false }).kind, "draft-refine-worker-required");
  const sealedFacts = new DraftTransitionFacts({
    ledger: value,
    origin: "sealed-worker-output",
    candidateQuestion: new DraftQuestionFact(value.nextCandidate()),
  });
  assert.equal(createDraftRefineResult({ facts: sealedFacts, autoApprove: false }).kind,
    "draft-refine-awaiting-answer");
  assert.equal(createDraftRefineResult({ facts: sealedFacts, autoApprove: true }).kind,
    "draft-refine-worker-required");
  const promoted = value.transitionCandidate("q1", 2);
  const waiting = promoted.nextAwaiting();
  const waitFacts = new DraftTransitionFacts({ ledger: promoted, nextQuestion: new DraftQuestionFact(waiting) });
  assert.equal(createDraftRefineResult({ facts: waitFacts, autoApprove: false }).kind, "draft-refine-awaiting-answer");
  assert.equal(createDraftRefineResult({ facts: waitFacts, autoApprove: true }).kind, "draft-refine-worker-required");
});

test("Draft answer and discard identities normalize exact replay inputs", () => {
  const answer = DraftQuestionResolutionIdentity.answer({
    answer: "  Use the selected public behavior. ",
    why: " The user selected it. ",
  });
  assert.deepEqual(answer.toJSON(), {
    kind: "answer",
    answer: "Use the selected public behavior.",
    why: "The user selected it.",
    considered: "",
  });
  assert.equal(answer.equals(DraftQuestionResolutionIdentity.answer({
    answer: "Use the selected public behavior.", why: "The user selected it.",
  })), true);
  assert.deepEqual(DraftQuestionResolutionIdentity.discard(" Out of scope. ").toJSON(), {
    kind: "discard", reason: "Out of scope.",
  });
});

test("qa-count counts only AnsweredQuestion and treats a missing draft as zero", () => {
  const value = ledger([
    new CandidateQuestion({ id: "q1", question: "Candidate?", revision: 0, ...base }),
    new AwaitingUserAnswer({ id: "q2", question: "Awaiting?", revision: 0, ...base }),
    new ResolvedByExistingInformation({ id: "q3", question: "Resolved?", revision: 0, resolution: "Source decides it.", ...base }),
    new AnsweredQuestion({ id: "q4", question: "Answered?", revision: 0, answer: "The user selected this public behavior.", why: "It meets the request.", considered: "The incompatible alternative was rejected.", ...base }),
    new DiscardedQuestion({ id: "q5", question: "Discarded?", revision: 0, reason: "Spec owns it.", ...base }),
  ]);
  const bytes = Buffer.from(JSON.stringify(draft(value)));
  const command = new GetQaCountCommand();
  assert.deepEqual(command.execute({ flowState: { specId: "spec-1" }, flowManager: { readArtifact: () => ({ bytes }) } }), { count: 1 });
  assert.deepEqual(command.execute({ flowState: { specId: "spec-1" }, flowManager: { readArtifact: () => null } }), { count: 0 });
});

test("DraftRefineStep alone selects wait, execution, or completion from typed facts", () => {
  const decision = (questions, autoApprove = false, workerStatus = "pending") => {
    const value = ledger(questions);
    const next = value.nextAwaiting();
    return createDraftRefineResult({
      autoApprove,
      facts: new DraftTransitionFacts({ ledger: value, workerStatus, ...(next && { nextQuestion: new DraftQuestionFact(next) }), ...(value.nextCandidate() && { candidateQuestion: new DraftQuestionFact(value.nextCandidate()) }) }),
    }).kind;
  };
  assert.equal(decision([]), "draft-refine-completed");
  assert.equal(decision([], false, "in_progress"), "draft-refine-completed");
  assert.equal(decision([new CandidateQuestion({ id: "q1", question: "Candidate?", revision: 0, ...base })]), "draft-refine-worker-required");
  assert.equal(decision([new ResolvedByExistingInformation({ id: "q1", question: "Resolved?", revision: 0, resolution: "Source decides it.", ...base })]), "draft-refine-completed");
  assert.equal(decision([new AnsweredQuestion({ id: "q1", question: "Answered?", revision: 0, answer: "The user chose this behavior.", why: "It meets the request.", considered: "The incompatible alternative was rejected.", ...base })]), "draft-refine-completed");
  assert.equal(decision([new DiscardedQuestion({ id: "q1", question: "Discarded?", revision: 0, reason: "Spec owns it.", ...base })]), "draft-refine-completed");
  assert.equal(decision([new AwaitingUserAnswer({ id: "q1", question: "Awaiting?", revision: 0, ...base })]), "draft-refine-awaiting-answer");
  assert.equal(decision([new AwaitingUserAnswer({ id: "q1", question: "Awaiting?", revision: 0, ...base })], true), "draft-refine-worker-required");
});

test("DraftRefineStep commits a fact-read failure without re-reading transition facts", async () => {
  const root = createTmpDir("draft-refine-error-result-");
  try {
    const specId = "001-draft-refine-error-result";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "draft-refine-error-result",
      request: "Persist a Draft refinement error result.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    flow.activate("draft");
    manager.publishArtifacts({
      specId,
      nodeId: "draft",
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(draft(ledger([])), null, 2)}\n`, "utf8"),
      }],
    });
    flow.settle("draft").activate("draft-refine");
    const binding = await new DraftRefineConnector({ flowManager: manager, specId }).connect();
    let readAttempts = 0;
    manager.readArtifact = () => {
      readAttempts += 1;
      throw new Error("transition facts unavailable");
    };
    const service = new DraftService({
      flowManager: manager,
      binding,
    });

    const result = await new DraftRefineStep(service).execute();

    assert.equal(result.kind, "draft-refine-error");
    assert.equal(readAttempts, 1);
    const canonical = manager.canonicalState(specId);
    assert.equal(canonical.attempt.failure.category, "step-result-error");
    assert.equal(manager.activityLedger(specId).at(-1).result.stepResult.kind, "draft-refine-error");
    assert.equal(manager.activityLedger(specId).at(-1).result.draftSettlementReceipt.settlementKind, "failure");
  } finally {
    removeTmpDir(root);
  }
});

test("answer and resume receipt commit atomically, replay exactly, and re-enter the same Attempt", async () => {
  const root = createTmpDir("draft-question-resume-");
  try {
    const specId = "001-draft-question-resume";
    let crashAfterResumeAppend = false;
    const manager = new FlowManager({
      root,
      mainRoot: root,
      inWorktree: false,
      specId,
      versionStoreFaultInjector({ phase }) {
        if (crashAfterResumeAppend && phase === "activity-appended") {
          throw new Error("crash after Draft resume Activity append");
        }
      },
    });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "draft-question-resume",
      request: "Answer one persisted Draft question.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    const source = draft(ledger([
      new AwaitingUserAnswer({ id: "q1", question: "Choose behavior?", revision: 2, ...base }),
    ]));
    flow.activate("draft");
    manager.publishArtifacts({
      specId,
      nodeId: "draft",
      artifactWrites: [{
        logicalKey: "draft", mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8"),
      }],
    });
    flow.settle("draft").activate("draft-refine");
    const attempt = manager.canonicalState(specId).attempt;
    const binding = await new DraftRefineConnector({ flowManager: manager, specId }).connect();
    assert.equal((await new DraftRefineStep(new DraftService({ flowManager: manager, binding })).execute()).kind,
      "draft-refine-awaiting-answer");
    const beforeAnswer = manager.activityLedger(specId).length;
    const command = new SetDraftAnswerCommand();
    const input = {
      flowManager: manager,
      flowState: manager.loadReadOnly(specId),
      questionId: "q1",
      questionRevision: 2,
      answer: " Use the selected public behavior. ",
      why: " The user selected it. ",
    };

    const awaitingDraft = manager.readArtifact({
      specId, logicalKey: "draft", consumerNodeId: "draft-refine",
    });
    for (const staleIdentity of [
      { questionId: "q2", questionRevision: 2 },
      { questionId: "q1", questionRevision: 1 },
    ]) {
      const rejected = command.execute({ ...input, ...staleIdentity });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.errors[0].code, "DRAFT_ANSWER_NOT_SELECTED");
      const unchanged = manager.readArtifact({
        specId, logicalKey: "draft", consumerNodeId: "draft-refine",
      });
      assert.equal(unchanged.descriptor.hash, awaitingDraft.descriptor.hash);
      assert.equal(manager.activityLedger(specId).length, beforeAnswer);
    }

    const selectedResolution = DraftQuestionResolutionIdentity.answer({
      answer: "Use the selected public behavior.",
      why: "The user selected it.",
    });
    const awaitingLifecycle = new DraftLifecycle(JSON.parse(awaitingDraft.bytes.toString("utf8")));
    const selectedOutput = awaitingLifecycle.withQuestionLedger(
      awaitingLifecycle.questionLedger.answer("q1", 2, {
        answer: selectedResolution.answer,
        why: selectedResolution.why,
        considered: selectedResolution.considered,
      }),
    );
    const selectedOutputBytes = Buffer.from(`${JSON.stringify(selectedOutput, null, 2)}\n`, "utf8");
    const awaitReceipt = manager.draftRefineStepState({ binding }).awaitReceiptFor({
      questionId: "q1",
      questionRevision: 2,
    });
    assert.equal(awaitReceipt instanceof DraftStepSettlementReceiptValue, true);
    assert.throws(() => manager.recordDraftQuestionResume({
      binding,
      awaitReceipt: awaitReceipt.toJSON(),
      questionId: "q1",
      questionRevision: 2,
      resolution: selectedResolution,
      source: awaitingDraft,
      outputBytes: selectedOutputBytes,
    }), /does not match its persisted Await receipt/);
    assert.throws(() => manager.recordDraftQuestionResume({
      binding: {
        runId: binding.runId,
        specId: binding.specId,
        stepId: binding.stepId,
        attempt: { ...binding.attempt, id: "stale-draft-refine-attempt" },
      },
      awaitReceipt,
      questionId: "q1",
      questionRevision: 2,
      resolution: selectedResolution,
      source: awaitingDraft,
      outputBytes: selectedOutputBytes,
    }), /Attempt changed|binding is stale|binding is invalid|stale/i);
    assert.throws(() => manager.recordDraftQuestionResume({
      binding,
      awaitReceipt,
      questionId: "q1",
      questionRevision: 2,
      resolution: selectedResolution,
      source: {
        ...awaitingDraft,
        descriptor: { ...awaitingDraft.descriptor, hash: "b".repeat(64) },
      },
      outputBytes: selectedOutputBytes,
    }), /does not match its persisted Await receipt/);
    assert.equal(manager.activityLedger(specId).length, beforeAnswer);
    assert.equal(manager.readArtifact({
      specId, logicalKey: "draft", consumerNodeId: "draft-refine",
    }).descriptor.hash, awaitingDraft.descriptor.hash);

    crashAfterResumeAppend = true;
    const interrupted = command.execute(input);
    crashAfterResumeAppend = false;
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.errors[0].code, "DRAFT_ANSWER_STALE_PUBLICATION");
    assert.equal(manager.readArtifact({
      specId, logicalKey: "draft", consumerNodeId: "draft-refine",
    }).descriptor.hash, awaitingDraft.descriptor.hash);
    assert.equal(manager.activityLedger(specId).length, beforeAnswer);

    const first = command.execute(input);
    const activity = manager.activityLedger(specId).at(-1);
    const persisted = new DraftLifecycle(JSON.parse(manager.readArtifact({
      specId, logicalKey: "draft", consumerNodeId: "draft-refine",
    }).bytes.toString("utf8")));
    assert.equal(first.replayed, false);
    assert.equal(first.resumeReceiptId, activity.transition.draftResumeReceipt.id);
    assert.equal(activity.transition.operation, "publish_artifacts");
    assert.equal(activity.transition.draftResumeReceipt.awaitReceiptId,
      manager.activityLedger(specId).at(-2).result.draftSettlementReceipt.id);
    assert.equal(persisted.questionLedger.questions[0] instanceof AnsweredQuestion, true);
    assert.equal(persisted.questionLedger.questions[0].considered, "");
    assert.equal(manager.activityLedger(specId).length, beforeAnswer + 1);

    const answeredDigest = manager.readArtifact({
      specId, logicalKey: "draft", consumerNodeId: "draft-refine",
    }).descriptor.hash;
    const conflictingReplay = command.execute({
      ...input,
      flowState: manager.loadReadOnly(specId),
      answer: "Use a different public behavior.",
    });
    assert.equal(conflictingReplay.ok, false);
    assert.equal(conflictingReplay.errors[0].code, "DRAFT_ANSWER_NOT_SELECTED");
    assert.equal(manager.activityLedger(specId).length, beforeAnswer + 1);
    assert.equal(manager.readArtifact({
      specId, logicalKey: "draft", consumerNodeId: "draft-refine",
    }).descriptor.hash, answeredDigest);

    const replayCanonical = manager.canonicalState(specId);
    assert.equal(manager.findDraftQuestionResumeReceipt({
      binding: {
        runId: replayCanonical.runId,
        specId: replayCanonical.specId,
        stepId: "draft-refine",
        attempt: replayCanonical.attempt,
      },
      questionId: "q1",
      questionRevision: 2,
      resolution: DraftQuestionResolutionIdentity.answer({
        answer: "Use the selected public behavior.", why: "The user selected it.",
      }),
    })?.id, first.resumeReceiptId);
    const replay = command.execute({ ...input, flowState: manager.loadReadOnly(specId) });
    assert.equal(replay.replayed, true, JSON.stringify(replay));
    assert.equal(replay.resumeReceiptId, first.resumeReceiptId);
    assert.equal(manager.activityLedger(specId).length, beforeAnswer + 1);

    const stale = command.execute({ ...input, flowState: manager.loadReadOnly(specId), questionRevision: 1 });
    assert.equal(stale.ok, false);
    assert.equal(stale.errors[0].code, "DRAFT_ANSWER_NOT_SELECTED");
    assert.equal(manager.activityLedger(specId).length, beforeAnswer + 1);

    assert.throws(
      () => new CanonicalDraftReviewSource({
        flowManager: manager,
        state: manager.loadReadOnly(specId),
        phase: "draft-coverage",
      }),
      /no authorized draft-coverage producer Activity/,
    );

    const resumedBinding = await new DraftRefineConnector({ flowManager: manager, specId }).connect();
    assert.equal((await new DraftRefineStep(new DraftService({ flowManager: manager, binding: resumedBinding })).execute()).kind,
      "draft-refine-completed");
    const canonical = manager.canonicalState(specId);
    assert.equal(attempt.id, canonical.findNode("draft-refine").result.draftSettlementReceipt.binding.attemptId);
    assert.equal(canonical.nextAction().nodeId, "draft-coverage-review");
    const coverageSource = new CanonicalDraftReviewSource({
      flowManager: manager,
      state: manager.loadReadOnly(specId),
      phase: "draft-coverage",
    });
    assert.equal(coverageSource.sourceNodeId, "draft-refine");
    assert.equal(manager.activityLedger(specId).slice(beforeAnswer)
      .some((entry) => entry.result?.stepResult?.kind === "draft-refine-worker-required"), false);
  } finally {
    removeTmpDir(root);
  }
});

test("promotion records sealed and promoted draft identities in its canonical Activity", async () => {
  const root = createTmpDir("draft-question-promotion-");
  try {
    const specId = "001-draft-question-promotion";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "draft-question-promotion",
      request: "Exercise canonical draft question promotion.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    const sourceDraft = draft(ledger([
      new CandidateQuestion({ id: "q1", question: "Choose behavior?", revision: 2, ...base }),
      new AnsweredQuestion({ id: "q2", question: "Keep current behavior?", revision: 3, answer: "The current public behavior remains unchanged.", why: "The request requires compatibility.", considered: "Changing the representation was rejected.", ...base }),
    ]));
    const sourceBytes = Buffer.from(`${JSON.stringify(sourceDraft, null, 2)}\n`, "utf8");
    flow.activate("draft");
    manager.publishArtifacts({
      specId,
      nodeId: "draft",
      artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }],
    });
    flow.settle("draft").activate("draft-refine");
    const source = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
    const handoffDigest = "b".repeat(64);
    const handoffRequestDigest = "c".repeat(64);
    const sourcePayloadDigest = crypto.createHash("sha256").update(sourceBytes).digest("hex");
    const binding = await new DraftRefineConnector({ flowManager: manager, specId }).connect();
    const stepResult = new DraftRefineAwaitingAnswerResult();
    const settlement = settleDraftStepResult(stepResult.stepId, stepResult);
    manager.promoteDraftQuestionAndKeepRefineActive({
      specId,
      questionId: "q1",
      questionRevision: 2,
      digest: source.descriptor.hash,
      byteLength: source.descriptor.size,
      sourceBytes,
      sourcePayloadDigest,
      handoffDigest,
      handoffRequestDigest,
      stepResult,
      settlement,
      binding,
    });

    const promoted = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
    const promotedDigest = crypto.createHash("sha256").update(promoted.bytes).digest("hex");
    const persisted = new DraftLifecycle(JSON.parse(promoted.bytes.toString("utf8")));
    const activity = manager.activityLedger(specId).at(-1);

    assert.equal(manager.canonicalState(specId).current.at(-1), "draft-refine");
    assert.equal(persisted.questionLedger.questions[0] instanceof AwaitingUserAnswer, true);
    assert.equal(persisted.questionLedger.questions[0].revision, 3);
    assert.equal(persisted.questionLedger.questions[1] instanceof AnsweredQuestion, true);
    assert.equal(activity.result.draftSettlementReceipt.settlementKind, "await");
    assert.deepEqual(activity.references.artifacts, [
      { id: handoffDigest, label: "draft-refine handoff" },
      { id: handoffRequestDigest, label: "draft-refine handoff request" },
      { id: sourcePayloadDigest, label: "draft-refine sealed draft payload" },
      { id: promotedDigest, label: "draft question q1@2 promoted artifact" },
    ]);
  } finally {
    removeTmpDir(root);
  }
});

test("canonical promotion rejects stale catalog or question identity without side effects", async () => {
  const root = createTmpDir("draft-question-promotion-stale-");
  try {
    const specId = "001-draft-question-promotion-stale";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "draft-question-promotion-stale",
      request: "Reject stale canonical promotion identities.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    const sourceBytes = Buffer.from(`${JSON.stringify(draft(ledger([
      new CandidateQuestion({ id: "q1", question: "Choose behavior?", revision: 2, ...base }),
    ])), null, 2)}\n`, "utf8");
    flow.activate("draft");
    manager.publishArtifacts({
      specId,
      nodeId: "draft",
      artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }],
    });
    flow.settle("draft").activate("draft-refine");
    const source = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
    const sourcePayloadDigest = crypto.createHash("sha256").update(sourceBytes).digest("hex");
    const binding = await new DraftRefineConnector({ flowManager: manager, specId }).connect();
    const stepResult = new DraftRefineAwaitingAnswerResult();
    const settlement = settleDraftStepResult(stepResult.stepId, stepResult);

    for (const { name, digest, byteLength, questionRevision } of [
      { name: "digest", digest: "d".repeat(64), byteLength: source.descriptor.size, questionRevision: 2 },
      { name: "byte length", digest: source.descriptor.hash, byteLength: source.descriptor.size + 1, questionRevision: 2 },
      { name: "question revision", digest: source.descriptor.hash, byteLength: source.descriptor.size, questionRevision: 3 },
    ]) {
      const before = {
        bytes: Buffer.from(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" }).bytes),
        catalog: manager.artifactCatalog(specId).toJSON(),
        activities: manager.activityLedger(specId).length,
        state: manager.canonicalState(specId).toJSON(),
      };
      assert.throws(() => manager.promoteDraftQuestionAndKeepRefineActive({
        specId,
        questionId: "q1",
        questionRevision,
        digest,
        byteLength,
        sourceBytes,
        sourcePayloadDigest,
        handoffDigest: "e".repeat(64),
        handoffRequestDigest: "f".repeat(64),
        stepResult,
        settlement,
        binding,
      }), undefined, name);
      assert.deepEqual(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" }).bytes, before.bytes, name);
      assert.deepEqual(manager.artifactCatalog(specId).toJSON(), before.catalog, name);
      assert.equal(manager.activityLedger(specId).length, before.activities, name);
      assert.deepEqual(manager.canonicalState(specId).toJSON(), before.state, name);
    }
  } finally {
    removeTmpDir(root);
  }
});
