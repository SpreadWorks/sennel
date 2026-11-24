import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { countReviewAttempts, settleImplStepResult, settleAcceptanceStepResult, DraftStepSettlementReceipt } from "../definition.js";
import { FlowActivity } from "./current-flow-state.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { ReviewFindingCycle } from "./finding-disposition-policy.js";
import { ImplReviewResultEvidence } from "./impl-review-values.js";
import { deepFreeze } from "./review-observation-values.js";
import { CanonicalReviewExecutionLedger } from "./canonical-review-execution-ledger.js";

/** One completed semantic observation, authenticated by its publication. */
class FlowReviewCompletion {
  constructor({ activity, evidence, payload, sourceArtifact }) {
    if (!(activity instanceof FlowActivity) || !(evidence instanceof ImplReviewResultEvidence)
      || evidence.review === null) throw new TypeError("Flow Review completion requires its canonical semantic Result");
    this.activity = activity;
    this.evidence = evidence;
    this.payload = deepFreeze(structuredClone(payload));
    this.sourceArtifact = sourceArtifact;
    this.phase = "impl";
    this.counter = "reviewRetry";
    this.taskId = null;
    this.reset = evidence.review.disposition.value !== "REJECTED";
    this.delta = this.reset ? 0 : 1;
    Object.freeze(this);
  }
}

/** Completed Review Results are the budget authority; display metrics are not. */
export class FlowReviewAccounting {
  constructor({ state, activities, descriptor = null, bytes = null }) {
    const executions = new CanonicalReviewExecutionLedger(activities);
    const ledger = executions.activities;
    const cycle = ReviewFindingCycle.fromActivityLedger({ runId: state.runId, activities: ledger });
    const repair = ledger.findLast(activity => activity.transition.operation === "repair_acceptance_review");
    if (repair !== undefined) {
      const result = repair.result.stepResult;
      DraftStepSettlementReceipt.assertStored(repair.result.draftSettlementReceipt.toJSON(), {
        binding: { runId: state.runId, specId: state.specId, stepId: "acceptance-review",
          attempt: { id: repair.attemptId, sequence: repair.sequence } }, result,
        settlement: settleAcceptanceStepResult("acceptance-review", result) });
    }
    this.startConfirmationOrder = Math.max(cycle.reopenConfirmationOrder ?? 0, repair?.confirmationOrder ?? 0);
    const candidates = ledger.filter((entry) => entry.nodeId === "impl-review"
      && entry.result?.stepResult?.evidence instanceof ImplReviewResultEvidence
      && entry.result.stepResult.evidence.review !== null
      && entry.result.stepResult.evidence.publication?.producerActivityId === entry.id
      && entry.result.draftSettlementReceipt?.executionLifecycle?.phase === "terminal");
    if ((descriptor === null) !== (bytes === null)) throw new TypeError("Flow Review history needs its complete catalog observation");
    if (descriptor === null && candidates.length > 0) throw new Error("Flow Review completed Results lost their canonical artifact");
    const completed = [];
    if (descriptor !== null) {
      if (descriptor.logicalKey !== "impl.review"
        || createHash("sha256").update(bytes).digest("hex") !== descriptor.hash) {
        throw new Error("Flow Review history differs from its catalog");
      }
      const envelopes = FLOW_ARTIFACT_CONTRACTS.require("impl.review").contentContract.parse(bytes);
      const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "impl.review", bytes });
      this.currentAttemptSequence = history.current.attempt;
      const publication = ledger.find(activity => activity.id === descriptor.activityId);
      if (publication?.nodeId !== "impl-review" || publication.sequence !== history.current.attempt) {
        throw new Error("Flow Review history is not bound to its current catalog producer");
      }
      for (const entry of history.attempts) {
        const terminals = candidates.filter((activity) => activity.sequence === entry.attempt);
        if (terminals.length === 0 && entry.payload.canonicalEvidence == null) continue;
        if (terminals.length !== 1) throw new Error("Flow Review history lacks its one terminal producer");
        const activity = terminals[0];
        const result = activity.result.stepResult;
        const evidence = result.evidence;
        const settlement = settleImplStepResult("impl-review", result);
        const receipt = executions.assertTerminal({ activity, target: entry.payload.canonicalTarget,
          binding: { runId: state.runId, specId: state.specId, stepId: "impl-review",
            attempt: { id: activity.attemptId, sequence: activity.sequence } }, result, settlement });
        const lifecycle = receipt.executionLifecycle;
        const prefixHash = createHash("sha256").update(envelopes.prefixThrough(entry.attempt).toBytes()).digest("hex");
        const publication = evidence.publication;
        if (evidence.identity.runId !== state.runId || evidence.identity.specId !== state.specId
          || evidence.identity.attempt.id !== activity.attemptId || evidence.identity.attempt.sequence !== entry.attempt
          || publication.producerActivityId !== activity.id || publication.fingerprint !== prefixHash
          || publication.artifactId !== descriptor.relativePath
          || !isDeepStrictEqual(entry.payload.canonicalEvidence ?? null, evidence.review?.toJSON() ?? null)
          || !isDeepStrictEqual(entry.payload.canonicalTarget, evidence.manifest.target.toJSON())
          || entry.payload.workerOutput?.digest !== evidence.seal?.output.digest
          || entry.payload.workerOutput?.byteLength !== evidence.seal?.output.byteLength
          || lifecycle.binding.manifestDigest !== evidence.manifest.digest
          || lifecycle.binding.inputDigest !== evidence.manifest.inputDigest) {
          throw new Error("Flow Review count lacks its exact Result, source, seal and execution receipt");
        }
        if (entry.attempt === history.current.attempt && descriptor.activityId !== activity.id) {
          throw new Error("Flow Review current history has a different catalog producer");
        }
        if (evidence.review !== null && cycle.includesActivity(activity)
          && activity.confirmationOrder > this.startConfirmationOrder) {
          if (!cycle.matchesArtifact(entry.payload)) throw new Error("Flow Review completion has a different finding cycle");
          completed.push(new FlowReviewCompletion({ activity, evidence, payload: entry.payload,
            sourceArtifact: descriptor.relativePath }));
        }
      }
      if (candidates.some((activity) => history.atAttempt(activity.sequence) === null)) {
        throw new Error("Flow Review terminal producer is absent from its retained history");
      }
    }
    this.completed = Object.freeze(completed);
    this.attemptCount = countReviewAttempts(completed, "impl");
    Object.freeze(this);
  }
}

/** Read before Step preparation; no filesystem capability enters the Service. */
export function readFlowReviewAccounting({ flowManager, state }) {
  return flowManager.readCanonicalTransitionView({ specId: state.specId, read(view) {
    const descriptor = view.catalog.artifacts.find(entry => entry.logicalKey === "impl.review") ?? null;
    return new FlowReviewAccounting({ state: view.state, activities: view.activities, descriptor,
      bytes: descriptor === null ? null : view.readCatalogedArtifact(descriptor) });
  } });
}
