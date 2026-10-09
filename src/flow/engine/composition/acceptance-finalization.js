import { ImplStepBinding } from "../connectors/impl/impl-step-binding.js";
import { FinalRegressionInput } from "../../services/final-regression-input.js";
import { ReportInput } from "../../services/report-input.js";
import { AcceptanceSettlementWriter } from "../../services/acceptance-settlement-writer.js";
import { FinalRegressionResultEvidence } from "../../steps/acceptance/final-regression-result-evidence.js";
import { ReportResultEvidence } from "../../steps/acceptance/report-values.js";
import { NonGateTargetBinding, NonGateRetryMetrics, NonGateCatalogPublication } from "../../lib/non-gate-transition.js";
import { FlowOutboxIdentity } from "../../lib/flow-outbox-identity.js";
import { TestChainTransitionSnapshot } from "../../lib/test-chain-transition-facts.js";
import { CanonicalCommandAttemptArtifactHistory } from "../../lib/canonical-command-result.js";
import { finalRegressionFactsFromSnapshot, captureFinalRegressionChangedSnapshotDigest } from "../../lib/final-regression-transition-facts.js";
import { StepAdmissionRefusal } from "../../lib/step-admission-refusal.js";
import { finalRegressionResult } from "../../steps/acceptance/final-regression.js";

/** Project current source admission without changing the saved process meaning. */
export function projectFinalRegressionSourceResult(evidence, admission) {
  return finalRegressionResult(new FinalRegressionInput({ evidence: evidence.withSourceAdmission(admission) }));
}

export class AcceptanceFinalizationPreparation {
  constructor({ binding, observed, commandResult = null, acceptancePublication = null }) {
    if (!(binding instanceof ImplStepBinding) || (!(observed instanceof FinalRegressionInput) && !(observed instanceof ReportInput)) || observed.stepId !== binding.stepId) throw new TypeError("Finalization preparation requires acquired typed input");
    Object.assign(this, { binding, observed, commandResult, acceptancePublication });
    Object.freeze(this);
  }
}
function identity(state) {
  return new NonGateTargetBinding({ runId: state.runId, specId: state.specId, stepId: state.current.at(-1), attempt: state.attempt });
}
function bindingFor(input, stepId) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  return input.binding ?? new ImplStepBinding({ flowManager, specId: input.state?.specId ?? input.ctx?.flowState?.specId,
    stepId, allowFailed: input.commandResult?.failedRecorded === true });
}
export function prepareFinalRegressionExecution({ flowManager, state, binding = null }) {
  const selected = binding ?? new ImplStepBinding({ flowManager, specId: state.specId, stepId: "final-regression", allowFailed: true });
  return new AcceptanceFinalizationPreparation({ binding: selected, observed: new FinalRegressionInput({
    evidence: new FinalRegressionResultEvidence({ identity: identity(state), retry: new NonGateRetryMetrics({
      used: state.attempt.consumption.semantic, maximum: state.definition.contractFor("final-regression", state.root).semanticRetryLimit }) }) }) });
}
export function prepareReportExecution({ flowManager, state, binding = null }) {
  const selected = binding ?? new ImplStepBinding({ flowManager, specId: state.specId, stepId: "report", allowFailed: true });
  return new AcceptanceFinalizationPreparation({ binding: selected, observed: new ReportInput({
    evidence: new ReportResultEvidence({ identity: identity(state), delivery: "pending" }) }) });
}
export function prepareFinalRegressionPublication(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const binding = bindingFor(input, "final-regression");
  const publication = flowManager.prepareAcceptanceCommandPublication({ binding, commandResult: input.commandResult,
    acceptedFailure: input.commandResult.failedRecorded === true });
  const snapshot = new TestChainTransitionSnapshot(publication.settlementAttempt === null ? publication : { ...publication,
    state: { ...publication.state, attempt: publication.settlementAttempt } });
  const descriptor = snapshot.catalog.find((entry) => entry.logicalKey === "final.regression");
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "final.regression", bytes: publication.readCatalogedArtifact(descriptor) });
  const facts = finalRegressionFactsFromSnapshot({ snapshot,
    current: { artifact: history.current.payload, descriptor, relativePath: descriptor.relativePath },
    changedFileSnapshotDigest: () => captureFinalRegressionChangedSnapshotDigest({
      root: flowManager.executionRoot(), relativeSpecFile: flowManager.specLocation(binding.specId).relativeSpecFile }) });
  if (!facts.stepFacts.changedFileSnapshot.current) throw new StepAdmissionRefusal("Final regression source changed before publication");
  return new AcceptanceFinalizationPreparation({ binding: publication.resultBinding ?? binding, observed: new FinalRegressionInput({ evidence: FinalRegressionResultEvidence.fromTransitionFacts(facts) }),
    commandResult: input.commandResult, acceptancePublication: publication });
}
export function prepareReportPublication(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const binding = bindingFor(input, "report");
  const publication = flowManager.prepareAcceptanceCommandPublication({ binding, commandResult: input.commandResult });
  const snapshot = new TestChainTransitionSnapshot(publication);
  const descriptor = snapshot.catalog.find((entry) => entry.logicalKey === "report");
  const report = JSON.parse(publication.readCatalogedArtifact(descriptor).toString("utf8"));
  const activity = snapshot.activities.find((entry) => entry.id === descriptor.activityId);
  const reportPublication = new NonGateCatalogPublication({ runId: snapshot.runId, specId: snapshot.specId,
    stepId: "report", attemptId: activity.attemptId, sequence: activity.sequence,
    producerActivityId: activity.id, artifactId: descriptor.relativePath, fingerprint: descriptor.hash });
  const delivery = report.data.delivery;
  const evidence = new ReportResultEvidence({ identity: identity(snapshot.state), publication: reportPublication,
    delivery: delivery.status, outboxIdentity: new FlowOutboxIdentity({
      runId: snapshot.runId, stepId: "report", operation: "report", idempotencyKey: delivery.idempotencyKey ?? null }) });
  return new AcceptanceFinalizationPreparation({ binding, observed: new ReportInput({ evidence }), commandResult: input.commandResult,
    acceptancePublication: publication });
}
export function prepareFinalRegressionServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const acquired = input.preparation ?? (input.observed ? input : input.commandResult
    ? prepareFinalRegressionPublication({ ...input, flowManager })
    : prepareFinalRegressionExecution({ flowManager, state: input.state ?? flowManager.canonicalState(input.binding?.specId ?? input.ctx?.flowState?.specId) }));
  return [new FinalRegressionInput(acquired.observed), new AcceptanceSettlementWriter({ flowManager, ...acquired })];
}
export function prepareReportServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const acquired = input.preparation ?? (input.observed ? input : input.commandResult
    ? prepareReportPublication({ ...input, flowManager })
    : prepareReportExecution({ flowManager, state: input.state ?? flowManager.canonicalState(input.binding?.specId ?? input.ctx?.flowState?.specId) }));
  return [new ReportInput(acquired.observed), new AcceptanceSettlementWriter({ flowManager, ...acquired })];
}
