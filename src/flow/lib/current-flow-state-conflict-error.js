/** A canonical state conflict value, independent of Store implementation. */
export class CurrentFlowStateConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "CurrentFlowStateConflictError";
    this.code = "CURRENT_FLOW_STATE_CONFLICT";
  }
}
