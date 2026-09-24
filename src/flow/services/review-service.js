import { attachedCanonicalCommandResultArtifact } from "../lib/canonical-command-result.js";
import { DraftReviewArtifactDocument, DraftReviewEvidenceSet } from "../lib/draft-review-artifacts.js";
import { draftReviewRouteForStepId } from "../lib/draft-review-routes.js";
import { readProspectiveDraftGateFacts } from "../lib/gate-transition-facts.js";
import { DraftCompletionConnector, DraftExecutionSettlement, DraftReviewExecutionBinding, DraftStepExecutionLifecycle, settleDraftStepResult } from "../definition.js";
import {
  StepResult,
} from "../engine/step-result.js";
import {
  DraftGateEvaluationBinding,
  DraftReviewStepBinding,
} from "../engine/connectors/draft/draft-step-binding.js";
import {
  StepPersistenceFailure,
  findCommittedStepSettlementReceipt,
  recoverStepSettlementReceipt,
} from "../lib/definition-lifecycle-failure.js";
import { StepAdmissionRefusal } from "../lib/step-admission-refusal.js";
import { CurrentFlowStateConflictError } from "../lib/current-flow-state.js";
import {
  DraftGateIssuePublication,
  DraftGatePublicationIntent,
} from "../lib/draft-gate-prospective.js";
import {
  createDraftCompletionSettlementApplication,
} from "../lib/draft-completion-connector.js";

/** Validate a Draft Review observation and settle it in one canonical transaction. */
export class ReviewService {
  #reviewDocument = null;

  #rethrowAdmissionRead(error) {
    if (error instanceof CurrentFlowStateConflictError) {
      throw new StepAdmissionRefusal(error.message, error);
    }
    throw error;
  }

  /** Claim one exact Review provider request, recovering only its durable receipt. */
  static claimExecution({ flowManager, binding, stepResult, settlement, executionBinding, executionClaim }) {
    const input = {
      binding, stepResult, settlement,
      executionLifecycle: DraftStepExecutionLifecycle.checkpoint(executionBinding).claimed(executionClaim),
    };
    try {
      return flowManager.claimDraftStepExecution({
        binding, stepResult, settlement, executionBinding, executionClaim,
      });
    } catch (error) {
      const receipt = recoverStepSettlementReceipt(flowManager, input, error);
      return { state: flowManager.canonicalState(binding.specId), receipt };
    }
  }

  #assertCurrent() {
    try {
      return this.binding.assertCurrent();
    } catch (error) {
      this.#rethrowAdmissionRead(error);
    }
  }

  constructor({
    flowManager,
    binding,
    commandResult = null,
    executionBinding = null,
    publicationResult = null,
  }) {
    if (!flowManager || typeof flowManager.settleDraftStepResult !== "function"
      || typeof flowManager.findStepSettlementReceipt !== "function") {
      throw new TypeError("ReviewService requires canonical Result settlement and receipt readback");
    }
    if (!(binding instanceof DraftReviewStepBinding)) {
      throw new TypeError("ReviewService requires a typed Draft review binding");
    }
    if (binding.flowManager !== flowManager) throw new Error("ReviewService binding belongs to a different FlowManager");
    const route = draftReviewRouteForStepId(binding.stepId);
    if (route === null) throw new Error(`ReviewService has no draft review route for ${binding.stepId}`);
    if (executionBinding !== null && !(executionBinding instanceof DraftReviewExecutionBinding)) {
      throw new TypeError("ReviewService execution requires a typed Draft review binding");
    }
    if ([commandResult, executionBinding, publicationResult].filter((value) => value !== null).length !== 1) {
      throw new TypeError("ReviewService requires exactly one terminal, checkpoint, or publication input");
    }
    if (publicationResult !== null
      && attachedCanonicalCommandResultArtifact(publicationResult)?.logicalKey !== route.reviewLogicalKey) {
      throw new TypeError("ReviewService publication requires its canonical review result");
    }
    this.flowManager = flowManager;
    this.binding = binding;
    this.route = route;
    this.commandResult = commandResult;
    this.executionBinding = executionBinding;
    this.publicationResult = publicationResult;
    Object.freeze(this);
  }

  requiresReviewExecution() {
    this.#assertCurrent();
    return this.executionBinding !== null || this.publicationResult !== null;
  }

  inspectReviewResult(result = this.commandResult) {
    if (result === this.commandResult && this.#reviewDocument !== null) return this.#reviewDocument;
    const state = this.#assertCurrent();
    const artifact = attachedCanonicalCommandResultArtifact(result);
    if (artifact?.logicalKey !== this.route.reviewLogicalKey) {
      throw new StepAdmissionRefusal("draft review command result does not match the bound review route");
    }
    let document;
    try {
      document = DraftReviewArtifactDocument.fromStored(artifact.payload);
    } catch (error) {
      throw new StepAdmissionRefusal(error.message || String(error), error);
    }
    if (JSON.stringify(document.sourceDraftRevision) !== JSON.stringify(this.binding.revision)) {
      throw new StepAdmissionRefusal("draft review command result does not match the bound canonical Draft revision");
    }
    const issues = new DraftReviewEvidenceSet({
      route: this.route,
      state,
      reviewFile: { document: document.toJSON() },
    }).validateReview({ validateBinding: false });
    if (issues.length > 0) throw new StepAdmissionRefusal(issues.join("; "));
    if (result === this.commandResult) this.#reviewDocument = document;
    return document;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.binding.stepId) {
      throw new TypeError("ReviewService requires its bound Step's concrete Result");
    }
    const settlement = settleDraftStepResult(this.binding.stepId, stepResult);
    let draftCompletionApplication = null;
    if (settlement.connector === DraftCompletionConnector) {
      let facts;
      try {
        facts = this.flowManager.readProspectiveDraftCoveragePassFacts({
          binding: this.binding,
          commandResult: this.commandResult,
        });
      } catch (error) {
        this.#rethrowAdmissionRead(error);
      }
      draftCompletionApplication = createDraftCompletionSettlementApplication(facts);
    }
    if (this.executionBinding !== null || this.publicationResult !== null) {
      if (!(settlement instanceof DraftExecutionSettlement)) {
        throw new StepPersistenceFailure(new Error("Draft review pre-execution Step must select an Execution settlement"));
      }
      const input = {
        binding: this.binding,
        stepResult,
        settlement,
        commandResult: this.publicationResult ?? undefined,
        ...(this.executionBinding === null ? {} : {
          executionLifecycle: DraftStepExecutionLifecycle.checkpoint(this.executionBinding),
        }),
      };
      try {
        const committed = this.executionBinding === null
          ? this.flowManager.settleDraftStepResult(input)
          : this.flowManager.checkpointDraftStepExecution({
              binding: this.binding, stepResult, settlement, executionBinding: this.executionBinding,
            });
        return committed.receipt;
      } catch (error) {
        return recoverStepSettlementReceipt(this.flowManager, input, error);
      }
    }
    if (stepResult.error === null && this.#reviewDocument === null) this.inspectReviewResult();
    const input = {
      binding: this.binding,
      stepResult,
      settlement,
      draftCompletionApplication,
      // Terminal routing still supplies the exact already-published bytes so
      // producer-readiness can bind the downstream confirmation to them.
      commandResult: stepResult.error === null ? this.commandResult : undefined,
    };
    try {
      const committed = await this.flowManager.settleDraftStepResult(input);
      return committed.receipt;
    } catch (error) {
      return recoverStepSettlementReceipt(this.flowManager, input, error);
    }
  }
}

/** Validate a prospective Draft Gate observation without publishing it. */
export class GateService {
  #facts = null;

  constructor({ flowManager, binding, commandResult, issuePublication = null }) {
    if (!flowManager || typeof flowManager.settleDraftStepResult !== "function"
      || typeof flowManager.findStepSettlementReceipt !== "function") {
      throw new TypeError("GateService requires canonical Result settlement and receipt readback");
    }
    if (!(binding instanceof DraftGateEvaluationBinding)) {
      throw new TypeError("GateService requires a typed Draft Gate evaluation binding");
    }
    if (binding.flowManager !== flowManager) throw new Error("GateService binding belongs to a different FlowManager");
    if (attachedCanonicalCommandResultArtifact(commandResult)?.logicalKey !== "draft.gate") {
      throw new Error("GateService requires the evaluated Draft Gate result");
    }
    if (issuePublication !== null && (
      !(issuePublication instanceof DraftGateIssuePublication) || !issuePublication.matches(binding)
    )) {
      throw new Error("GateService received an invalid Draft Gate issue publication");
    }
    this.flowManager = flowManager;
    this.binding = binding;
    this.commandResult = commandResult;
    this.issuePublication = issuePublication;
    Object.freeze(this);
  }

  #readGateFacts() {
    if (this.#facts !== null) return this.#facts;
    this.#facts = readProspectiveDraftGateFacts({
      flowManager: this.flowManager,
      binding: this.binding,
      commandResult: this.commandResult,
    });
    return this.#facts;
  }

  /** Complete system-boundary admission before the Step classifies its observed facts. */
  assertGateResultAdmission() {
    this.#readGateFacts();
  }

  inspectGateFacts() {
    return this.#readGateFacts();
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.binding.stepId) {
      throw new TypeError("GateService requires its bound Step's concrete Result");
    }
    const settlement = settleDraftStepResult(this.binding.stepId, stepResult);
    if (stepResult.error === null && this.#facts === null) {
      throw new Error("Draft Gate Result requires the facts observed by its Step");
    }
    const gatePublication = stepResult.error === null
      ? new DraftGatePublicationIntent({ facts: this.#facts, issue: this.issuePublication })
      : null;
    const input = {
      binding: this.binding,
      stepResult,
      settlement,
      commandResult: this.commandResult,
      gatePublication,
    };
    try {
      const committed = await this.flowManager.settleDraftStepResult(input);
      return committed.receipt;
    } catch (error) {
      const replay = findCommittedStepSettlementReceipt(this.flowManager, input);
      if (replay !== null) return replay;
      throw new StepPersistenceFailure(error);
    }
  }
}
