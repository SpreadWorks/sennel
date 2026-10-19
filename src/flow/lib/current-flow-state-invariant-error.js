export class CurrentFlowStateInvariantError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CurrentFlowStateInvariantError";
    this.code = "CURRENT_FLOW_STATE_INVARIANT_INVALID";
  }
}
