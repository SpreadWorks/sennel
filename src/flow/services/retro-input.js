import { RetroResultEvidence } from "../lib/retro-values.js";
export class RetroInput {
  constructor({ evidence }) {
    if (!(evidence instanceof RetroResultEvidence)) throw new TypeError("Retro input requires acquired aggregate evidence");
    this.evidence = evidence;
    this.stepId = "retro";
    Object.freeze(this);
  }
}
