import { attachedCanonicalCommandResultArtifact } from "../lib/canonical-command-result.js";
import { DraftReviewArtifactDocument, DraftReviewEvidenceSet } from "../lib/draft-review-artifacts.js";
import { draftReviewRouteForStepId } from "../lib/draft-review-routes.js";
import { readProspectiveDraftGateFacts } from "../lib/gate-transition-facts.js";
import { DraftCompletionConnector, DraftExecutionSettlement, settleDraftStepResult } from "../definition.js";
import {
  StepResult,
} from "../engine/step-result.js";
import {
  DraftGateEvaluationBinding,
  DraftReviewStepBinding,
} from "../engine/connectors/draft/draft-step-binding.js";
import { DraftStepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import {
  DraftGateIssuePublication,
  DraftGatePublicationIntent,
} from "../lib/draft-gate-prospective.js";
import {
  createDraftCompletionSettlementApplication,
} from "../lib/draft-completion-connector.js";

function committedReceipt(flowManager, input) {
  try {
    return flowManager.findDraftStepSettlementReceipt(input);
  } catch {
    return null;
  }
}

/** Validate a Draft Review observation and settle it in one canonical transaction. */
export class ReviewService {
  #reviewDocument = null;

  constructor({
    flowManager,
    binding,
    commandResult = null,
    executionCheckpointer = null,
  }) {
    if (!flowManager || typeof flowManager.settleDraftStepResult !== "function"
      || typeof flowManager.findDraftStepSettlementReceipt !== "function") {
      throw new TypeError("ReviewService requires canonical Result settlement and receipt readback");
    }
    if (!(binding instanceof DraftReviewStepBinding)) {
      throw new TypeError("ReviewService requires a typed Draft review binding");
    }
    if (binding.flowManager !== flowManager) throw new Error("ReviewService binding belongs to a different FlowManager");
    const route = draftReviewRouteForStepId(binding.stepId);
    if (route === null) throw new Error(`ReviewService has no draft review route for ${binding.stepId}`);
    this.flowManager = flowManager;
    this.binding = binding;
    this.route = route;
    this.commandResult = commandResult;
    if (executionCheckpointer !== null && typeof executionCheckpointer !== "function") {
      throw new TypeError("ReviewService execution checkpointer must be a function");
    }
    this.executionCheckpointer = executionCheckpointer;
    Object.freeze(this);
  }

  requiresReviewExecution() {
    this.binding.assertCurrent();
    return this.executionCheckpointer !== null;
  }

  inspectReviewResult(result = this.commandResult) {
    if (result === this.commandResult && this.#reviewDocument !== null) return this.#reviewDocument;
    const state = this.binding.assertCurrent();
    const artifact = attachedCanonicalCommandResultArtifact(result);
    if (artifact?.logicalKey !== this.route.reviewLogicalKey) {
      throw new Error("draft review command result does not match the bound review route");
    }
    const document = DraftReviewArtifactDocument.fromStored(artifact.payload);
    if (JSON.stringify(document.sourceDraftRevision) !== JSON.stringify(this.binding.revision)) {
      throw new Error("draft review command result does not match the bound canonical Draft revision");
    }
    const issues = new DraftReviewEvidenceSet({
      route: this.route,
      state,
      reviewFile: { document: document.toJSON() },
    }).validateReview({ validateBinding: false });
    if (issues.length > 0) throw new Error(issues.join("; "));
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
      const facts = this.flowManager.readProspectiveDraftCoveragePassFacts({
        binding: this.binding,
        commandResult: this.commandResult,
      });
      draftCompletionApplication = createDraftCompletionSettlementApplication(facts);
    }
    if (this.executionCheckpointer !== null) {
      if (!(settlement instanceof DraftExecutionSettlement)) {
        throw new DraftStepPersistenceFailure(new Error("Draft review pre-execution Step must select an Execution settlement"));
      }
      const input = {
        binding: this.binding,
        stepResult,
        settlement,
        commandResult: this.commandResult,
      };
      try {
        const committed = await this.executionCheckpointer(stepResult, settlement, this.binding);
        return committed.receipt;
      } catch (error) {
        const replay = committedReceipt(this.flowManager, input);
        if (replay !== null) return replay;
        throw error instanceof DraftStepPersistenceFailure ? error : new DraftStepPersistenceFailure(error);
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
      const replay = committedReceipt(this.flowManager, input);
      if (replay !== null) return replay;
      throw new DraftStepPersistenceFailure(error);
    }
  }
}

/** Validate a prospective Draft Gate observation without publishing it. */
export class GateService {
  #facts = null;

  constructor({ flowManager, binding, commandResult, issuePublication = null }) {
    if (!flowManager || typeof flowManager.settleDraftStepResult !== "function"
      || typeof flowManager.findDraftStepSettlementReceipt !== "function") {
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

  inspectGateFacts() {
    if (this.#facts !== null) return this.#facts;
    this.#facts = readProspectiveDraftGateFacts({
      flowManager: this.flowManager,
      binding: this.binding,
      commandResult: this.commandResult,
    });
    return this.#facts;
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
      const replay = committedReceipt(this.flowManager, input);
      if (replay !== null) return replay;
      throw new DraftStepPersistenceFailure(error);
    }
  }
}
