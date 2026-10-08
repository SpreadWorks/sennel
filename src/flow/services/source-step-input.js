import { SourceStepFacts } from "../lib/source-effect-values.js";

/** Acquired source values only; authority remains in the save dependency. */
export class SourceStepInput {
  constructor(facts) {
    if (!(facts instanceof SourceStepFacts)) throw new TypeError("Source input requires typed facts");
    this.facts = facts;
    Object.freeze(this);
  }
}
