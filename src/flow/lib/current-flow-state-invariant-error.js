export class CurrentFlowStateInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "CurrentFlowStateInvariantError";
    this.code = "CURRENT_FLOW_STATE_INVARIANT_INVALID";
  }
}
