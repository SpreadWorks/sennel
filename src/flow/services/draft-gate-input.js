import { DraftGateIssuePublication } from "../lib/draft-gate-prospective.js";
import { DraftGateProspectiveFacts } from "../lib/draft-gate-prospective.js";

/** Prospective Draft Gate facts observed outside its Service. */
export class DraftGateInput {
  constructor({ facts, issuePublication = null }) {
    if (!(facts instanceof DraftGateProspectiveFacts)
      || issuePublication !== null && !(issuePublication instanceof DraftGateIssuePublication)) {
      throw new TypeError("Draft Gate input requires prospective facts and typed issue evidence");
    }
    this.facts = facts;
    this.issuePublication = issuePublication;
    this.stepId = "draft-gate";
    Object.freeze(this);
  }
}
