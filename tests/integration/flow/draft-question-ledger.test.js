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
import { PromoteDraftQuestionAndKeepRefineActive, resolveDraftQuestionPromotion, resolveDraftQuestionResolution, resolveDraftTransition, resolveLifecyclePlan } from "../../../src/flow/definition.js";
import SetDraftAnswerCommand from "../../../src/flow/lib/set-draft-answer.js";
import GetQaCountCommand from "../../../src/flow/lib/get-qa-count.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

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

test("Definition applies candidate promotion while only candidate or auto-approved awaiting work executes", () => {
  const value = ledger([new CandidateQuestion({ id: "q1", question: "Choose behavior?", revision: 2, ...base })]);
  const facts = new DraftTransitionFacts({ ledger: value, candidateQuestion: new DraftQuestionFact(value.nextCandidate()) });
  assert.equal(resolveDraftTransition({ stepId: "draft-refine", flowState: { autoApprove: false }, facts }).operation, "execute-worker");
  const promoted = resolveDraftQuestionPromotion({ facts }).apply(value);
  const waiting = promoted.nextAwaiting();
  const waitFacts = new DraftTransitionFacts({ ledger: promoted, nextQuestion: new DraftQuestionFact(waiting) });
  assert.equal(resolveDraftTransition({ stepId: "draft-refine", flowState: { autoApprove: false }, facts: waitFacts }).operation, "await-user-answer");
  assert.equal(resolveDraftTransition({ stepId: "draft-refine", flowState: { autoApprove: true }, facts: waitFacts }).operation, "execute-worker");
});

test("Definition exclusively selects matching answer and discard ledger actions", () => {
  const value = ledger([new AwaitingUserAnswer({ id: "q1", question: "Choose behavior?", revision: 2, ...base })]);
  const facts = DraftTransitionFacts.fromDraft(new DraftLifecycle(draft(value)));
  const answer = resolveDraftQuestionResolution({
    intent: "answer", questionId: "q1", questionRevision: 2, facts, flowState: { autoApprove: false },
    answer: "Use the selected public behavior.", why: "The user selected it after reviewing the alternatives.",
  });
  assert.ok(answer);
  assert.equal(answer.apply(value).questions[0] instanceof AnsweredQuestion, true);
  assert.equal(resolveDraftQuestionResolution({ intent: "discard", questionId: "q1", questionRevision: 1, facts, flowState: { autoApprove: false }, reason: "Stale." }), null);
  assert.equal(resolveDraftQuestionResolution({ intent: "discard", questionId: "q1", questionRevision: 2, facts, flowState: { autoApprove: true }, reason: "Auto." }), null);
});

test("draft-refine confirmation selects an exclusive typed promotion lifecycle action", () => {
  const value = ledger([new CandidateQuestion({ id: "q1", question: "Choose behavior?", revision: 2, ...base })]);
  const facts = new DraftTransitionFacts({ ledger: value, candidateQuestion: new DraftQuestionFact(value.nextCandidate()) });
  const plan = resolveLifecyclePlan({ event: "draft-refine:confirm", currentStepId: "draft-refine", flowState: { autoApprove: false }, draftTransitionFacts: facts, draftCatalogBaseline: { digest: DIGEST, byteLength: 12 } });
  assert.equal(plan.actions.length, 1);
  assert.ok(plan.actions[0] instanceof PromoteDraftQuestionAndKeepRefineActive);
  assert.equal(resolveLifecyclePlan({ event: "draft-refine:confirm", currentStepId: "draft-refine", flowState: { autoApprove: true }, draftTransitionFacts: facts, draftCatalogBaseline: { digest: DIGEST, byteLength: 12 } }).actions.some((action) => action instanceof PromoteDraftQuestionAndKeepRefineActive), false);
  const mixed = new DraftTransitionFacts({
    ledger: value,
    candidateQuestion: new DraftQuestionFact(value.nextCandidate()),
    nextQuestion: new DraftQuestionFact(new AwaitingUserAnswer({ id: "q2", question: "Already awaiting?", revision: 0, ...base })),
  });
  assert.equal(resolveLifecyclePlan({ event: "draft-refine:confirm", currentStepId: "draft-refine", flowState: { autoApprove: false }, draftTransitionFacts: mixed, draftCatalogBaseline: { digest: DIGEST, byteLength: 12 } }).actions.some((action) => action instanceof PromoteDraftQuestionAndKeepRefineActive), false);
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

test("Definition waits, executes, skips, or completes draft-refine from its canonical ledger", () => {
  const decision = (questions, autoApprove = false, workerStatus = "pending") => {
    const value = ledger(questions);
    const next = value.nextAwaiting();
    return resolveDraftTransition({
      stepId: "draft-refine", flowState: { autoApprove },
      facts: new DraftTransitionFacts({ ledger: value, workerStatus, ...(next && { nextQuestion: new DraftQuestionFact(next) }), ...(value.nextCandidate() && { candidateQuestion: new DraftQuestionFact(value.nextCandidate()) }) }),
    }).operation;
  };
  assert.equal(decision([]), "skip-worker");
  assert.equal(decision([], false, "in_progress"), "complete-worker");
  assert.equal(decision([new CandidateQuestion({ id: "q1", question: "Candidate?", revision: 0, ...base })]), "execute-worker");
  assert.equal(decision([new ResolvedByExistingInformation({ id: "q1", question: "Resolved?", revision: 0, resolution: "Source decides it.", ...base })]), "skip-worker");
  assert.equal(decision([new AnsweredQuestion({ id: "q1", question: "Answered?", revision: 0, answer: "The user chose this behavior.", why: "It meets the request.", considered: "The incompatible alternative was rejected.", ...base })]), "skip-worker");
  assert.equal(decision([new DiscardedQuestion({ id: "q1", question: "Discarded?", revision: 0, reason: "Spec owns it.", ...base })]), "skip-worker");
  assert.equal(decision([new AwaitingUserAnswer({ id: "q1", question: "Awaiting?", revision: 0, ...base })]), "await-user-answer");
  assert.equal(decision([new AwaitingUserAnswer({ id: "q1", question: "Awaiting?", revision: 0, ...base })], true), "execute-worker");
});

test("answer rejects a stale conditional publication without writing", () => {
  const value = ledger([new AwaitingUserAnswer({ id: "q1", question: "Choose behavior?", revision: 0, ...base })]);
  assert.throws(() => value.answer("q1", 1, { answer: "Use the selected behavior.", why: "The user selected it." }), /revision/);
  const bytes = Buffer.from(JSON.stringify(draft(value)));
  let writes = 0;
  const manager = {
    loadReadOnly: () => ({ specId: "spec-1", currentNodeId: "draft-refine", autoApprove: false }),
    readArtifact: () => ({ relativePath: "draft.json", descriptor: { hash: "b".repeat(64), size: bytes.length }, bytes }),
    publishArtifacts: ({ artifactBaselines }) => {
      assert.deepEqual(artifactBaselines, [{ logicalKey: "draft", digest: "b".repeat(64), byteLength: bytes.length }]);
      throw new Error("canonical artifact changed before conditional publication");
    },
  };
  const result = new SetDraftAnswerCommand().execute({ flowManager: manager, flowState: { specId: "spec-1" }, questionId: "q1", questionRevision: 0, answer: "Use the selected behavior.", why: "The user selected it.", considered: "The incompatible alternative was rejected." });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "DRAFT_ANSWER_STALE_PUBLICATION");
  assert.equal(writes, 0);
});

test("set draft-answer accepts an omitted optional considered value", () => {
  const value = ledger([
    new AwaitingUserAnswer({ id: "q1", question: "Choose behavior?", revision: 0, ...base }),
    new AwaitingUserAnswer({ id: "q2", question: "Choose another behavior?", revision: 0, ...base }),
  ]);
  const bytes = Buffer.from(JSON.stringify(draft(value)));
  let published = null;
  const manager = {
    loadReadOnly: () => ({ specId: "spec-1", currentNodeId: "draft-refine", autoApprove: false }),
    readArtifact: () => ({ relativePath: "draft.json", descriptor: { hash: "b".repeat(64), size: bytes.length }, bytes }),
    publishArtifacts: ({ artifactWrites }) => { published = artifactWrites[0].bytes; },
  };

  const result = new SetDraftAnswerCommand().execute({
    flowManager: manager,
    flowState: { specId: "spec-1" },
    questionId: "q1",
    questionRevision: 0,
    answer: "Use the selected public behavior for the command.",
    why: "The user selected this behavior after reviewing the alternatives.",
  });

  assert.equal(result.status, "answered");
  assert.equal(new DraftLifecycle(JSON.parse(published.toString("utf8"))).questionLedger.questions[0].considered, "");
});

test("promotion records sealed and promoted draft identities in its canonical Activity", () => {
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
    });

    const promoted = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
    const promotedDigest = crypto.createHash("sha256").update(promoted.bytes).digest("hex");
    const persisted = new DraftLifecycle(JSON.parse(promoted.bytes.toString("utf8")));
    const activity = manager.activityLedger(specId).at(-1);

    assert.equal(manager.canonicalState(specId).current.at(-1), "draft-refine");
    assert.equal(persisted.questionLedger.questions[0] instanceof AwaitingUserAnswer, true);
    assert.equal(persisted.questionLedger.questions[0].revision, 3);
    assert.equal(persisted.questionLedger.questions[1] instanceof AnsweredQuestion, true);
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

test("canonical promotion rejects stale catalog or question identity without side effects", () => {
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
