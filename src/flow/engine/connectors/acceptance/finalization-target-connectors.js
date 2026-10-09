import { StepConnector } from "../../step-connector.js";
export class FinalRegressionReportConnector extends StepConnector {
  connect({ flowManager, specId, targetStepId }) {
    const state = flowManager.canonicalState(specId);
    if ((state.current?.at(-1) ?? state.nextAction()?.nodeId) !== targetStepId) throw new Error("Finalization connection does not expose its saved target");
    return state;
  }
}
export class ReportFinalizeCommitConnector extends FinalRegressionReportConnector {}
