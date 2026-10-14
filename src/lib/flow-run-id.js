import { IdentityValue } from "./flow-identity-value.js";

export class FlowRunId extends IdentityValue {
  constructor(value) { super(value, "runId"); }
  static from(value) { return value instanceof FlowRunId ? value : new FlowRunId(value); }
}
