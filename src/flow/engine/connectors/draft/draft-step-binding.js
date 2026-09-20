import { CanonicalDraftReviewSource } from "../../../lib/canonical-review-artifacts.js";
import { CurrentAttemptIdentity } from "../../../lib/current-flow-state.js";
import { GateTransitionFacts } from "../../../lib/gate-transition.js";
import { readCurrentGateTransitionFacts } from "../../../lib/gate-transition-facts.js";
import { draftReviewRouteForRetryPhase } from "../../../lib/draft-review-routes.js";
import { readDraftTransitionFacts } from "../../../lib/draft-transition-facts.js";
import {
  requiresWorkerArtifactHandoff,
} from "../../../lib/flow-artifact-authority.js";
import { WorkerArtifactHandoffRequest } from "../../../lib/worker-artifact-handoff.js";
import { isConditionalDraftWorkerStep } from "../../../lib/draft-conditional-worker.js";

function canonicalState(flowManager, specId) {
  if (!flowManager || typeof flowManager.canonicalState !== "function") {
    throw new TypeError("Draft step binding requires FlowManager canonical state reads");
  }
  const state = flowManager.canonicalState(specId);
  if (state === null) throw new Error("Draft step binding has no canonical Flow state");
  return state;
}

function sameRevision(left, right) {
  return left.runId === right.runId
    && left.specId === right.specId
    && left.sourceStepId === right.sourceStepId
    && left.digest === right.digest
    && left.byteLength === right.byteLength
    && left.finalizedAt === right.finalizedAt;
}

/** Shared immutable target contract for one Draft Step execution. */
export class DraftStepBinding {
  constructor({ flowManager, state, stepId, attempt, allowFailed = false } = {}) {
    if (new.target === DraftStepBinding) throw new TypeError("DraftStepBinding is abstract");
    if (typeof stepId !== "string" || stepId.trim() === "") {
      throw new TypeError("Draft step binding requires a Step id");
    }
    if (typeof state?.runId !== "string" || state.runId === "" || typeof state.specId !== "string" || state.specId === "") {
      throw new TypeError("Draft step binding requires a canonical Flow state");
    }
    this.flowManager = flowManager;
    this.runId = state.runId;
    this.specId = state.specId;
    this.stepId = stepId;
    this.attempt = CurrentAttemptIdentity.from(attempt);
    this.allowFailed = allowFailed;
    if (this.attempt.nodeId !== this.stepId
      || !(this.attempt.matches(state) || (allowFailed && this.attempt.matchesFailed(state)))) {
      throw new Error("Draft step binding requires the exact active Step Attempt");
    }
  }

  assertCurrent() {
    const state = canonicalState(this.flowManager, this.specId);
    if (state.runId !== this.runId || state.specId !== this.specId
      || !(this.attempt.matches(state) || (this.allowFailed && this.attempt.matchesFailed(state)))) {
      throw new Error("Draft step binding is stale for the canonical Step Attempt");
    }
    return state;
  }
}

/** Binds an artifact-worker Draft Step to its canonical handoff and Attempt. */
export class DraftWorkerStepBinding extends DraftStepBinding {
  constructor({ request } = {}) {
    if (!(request instanceof WorkerArtifactHandoffRequest)) {
      throw new TypeError("Draft worker binding requires a WorkerArtifactHandoffRequest");
    }
    if ((request.stepId !== "draft" && !request.stepId.startsWith("draft-"))
      || !requiresWorkerArtifactHandoff(request.stepId)) {
      throw new Error("Draft worker binding requires a Draft worker Step");
    }
    const state = canonicalState(request.flowManager, request.specId);
    super({ flowManager: request.flowManager, state, stepId: request.stepId, attempt: state.attempt });
    this.request = request;
    Object.freeze(this);
  }

  assertCurrent() {
    const state = super.assertCurrent();
    this.request.assertCurrent(this.flowManager.loadReadOnly(this.specId));
    return state;
  }
}

/** Binds pre-execution admission without granting a materialized worker request. */
export class DraftWorkerExecutionStepBinding extends DraftStepBinding {
  constructor({ flowManager, specId, stepId } = {}) {
    if (!isConditionalDraftWorkerStep(stepId)) {
      throw new Error("Draft worker execution admission requires a conditional worker Step");
    }
    const state = canonicalState(flowManager, specId);
    if (state.current?.at(-1) !== stepId || state.attempt?.nodeId !== stepId
      || state.attempt.failure !== null) {
      throw new Error("Draft worker execution admission requires its active Attempt");
    }
    super({ flowManager, state, stepId, attempt: state.attempt });
    Object.freeze(this);
  }
}

/** The exact pending question for a refine Attempt awaiting the user. */
export class DraftRefineAwaitBinding extends DraftStepBinding {
  constructor({ flowManager, specId } = {}) {
    const state = canonicalState(flowManager, specId);
    if (state.current?.at(-1) !== "draft-refine" || state.attempt?.nodeId !== "draft-refine"
      || state.autoApprove === true) {
      throw new Error("Draft refine await binding requires its active manual Attempt");
    }
    const facts = readDraftTransitionFacts({ flowManager, flowState: flowManager.loadReadOnly(specId) });
    if (facts?.nextQuestion === null || facts?.nextQuestion === undefined) {
      throw new Error("Draft refine has no question awaiting a user answer");
    }
    super({ flowManager, state, stepId: "draft-refine", attempt: state.attempt });
    this.questionId = facts.nextQuestion.id;
    this.questionRevision = facts.nextQuestion.revision;
    Object.freeze(this);
  }

  assertCurrent() {
    const state = super.assertCurrent();
    const facts = readDraftTransitionFacts({ flowManager: this.flowManager, flowState: this.flowManager.loadReadOnly(this.specId) });
    if (facts?.nextQuestion?.id !== this.questionId
      || facts.nextQuestion.revision !== this.questionRevision) {
      throw new Error("Draft refine awaiting question revision is stale");
    }
    return state;
  }
}

/** Binds a Draft review to the selected canonical Draft revision and Attempt. */
export class DraftReviewStepBinding extends DraftStepBinding {
  constructor({ source } = {}) {
    if (!(source instanceof CanonicalDraftReviewSource)) {
      throw new TypeError("Draft review binding requires a CanonicalDraftReviewSource");
    }
    const state = canonicalState(source.flowManager, source.state.specId);
    const route = draftReviewRouteForRetryPhase(source.phase);
    if (route === null || state.attempt?.nodeId !== route.reviewStepId) {
      throw new Error("Draft review binding requires its routed active review Attempt");
    }
    super({ flowManager: source.flowManager, state, stepId: route.reviewStepId, attempt: state.attempt });
    this.source = source;
    this.phase = source.phase;
    this.revision = Object.freeze({ ...source.revision() });
    Object.freeze(this);
  }

  assertCurrent() {
    const state = super.assertCurrent();
    const source = new CanonicalDraftReviewSource({
      flowManager: this.flowManager,
      state,
      phase: this.phase,
    });
    if (!sameRevision(this.revision, source.revision())) {
      throw new Error("Draft review binding is stale for the canonical Draft revision");
    }
    return state;
  }
}

/** Binds the active Draft Gate Attempt before evaluation produces a result. */
export class DraftGateEvaluationBinding extends DraftStepBinding {
  constructor({ flowManager, specId } = {}) {
    const state = canonicalState(flowManager, specId);
    if (state.current?.at(-1) !== "draft-gate" || state.attempt?.nodeId !== "draft-gate"
      || state.attempt.failure !== null) {
      throw new Error("Draft Gate evaluation requires its active Attempt");
    }
    super({ flowManager, state, stepId: "draft-gate", attempt: state.attempt });
    Object.freeze(this);
  }
}

/** Binds a Draft Gate result to the exact gate Attempt and catalog publication. */
export class DraftGateStepBinding extends DraftStepBinding {
  constructor({ flowManager, facts } = {}) {
    if (!(facts instanceof GateTransitionFacts)) {
      throw new TypeError("Draft Gate binding requires GateTransitionFacts");
    }
    if (facts.phase !== "draft" || facts.target.stepId !== "draft-gate") {
      throw new Error("Draft Gate binding requires draft-gate facts");
    }
    const state = canonicalState(flowManager, facts.target.specId);
    const attempt = new CurrentAttemptIdentity({
      id: facts.target.attempt.id,
      nodeId: facts.target.stepId,
      sequence: facts.target.attempt.sequence,
    });
    if (!facts.currentAttempt.matches(facts.target.attempt)
      || !facts.catalogPublication.attempt.matches(facts.target.attempt)) {
      throw new Error("Draft Gate binding facts must share one exact Attempt");
    }
    super({ flowManager, state, stepId: facts.target.stepId, attempt, allowFailed: true });
    this.facts = facts;
    Object.freeze(this);
  }

  assertCurrent() {
    const state = super.assertCurrent();
    const facts = readCurrentGateTransitionFacts({
      flowManager: this.flowManager,
      flowState: state,
      phase: this.facts.phase,
    });
    if (facts === null
      || !facts.currentAttempt.matches(this.facts.currentAttempt)
      || facts.catalogPublication.fingerprint !== this.facts.catalogPublication.fingerprint
      || facts.catalogPublication.producerActivityId !== this.facts.catalogPublication.producerActivityId) {
      throw new Error("Draft Gate binding is stale for the canonical Gate publication");
    }
    return state;
  }
}
