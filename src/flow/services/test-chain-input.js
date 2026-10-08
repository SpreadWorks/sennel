import { TestChainResultEvidence } from "../lib/test-chain-values.js";

export class TestChainInput {
  constructor({ evidence }) {
    if (!(evidence instanceof TestChainResultEvidence)) throw new TypeError("Test chain input requires acquired canonical evidence");
    this.evidence = evidence;
    this.stepId = evidence.stepId;
    Object.freeze(this);
  }
}
