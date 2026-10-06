import { ApprovalResultEvidence, RequirementTestResultPublication } from "../engine/step-result.js";
import { CanonicalSpecApproval } from "../lib/canonical-spec-approval.js";
import { RequirementTestPlan } from "../lib/requirement-test-lifecycle.js";

/** Acquired approval and initial plan evidence for the existing approval boundary. */
export class ApprovalInput {
  constructor({ evidence, approval = null, plan = null, specRecordPublication = null, error = null } = {}) {
    if (!(evidence instanceof ApprovalResultEvidence)
      || (approval !== null && !(approval instanceof CanonicalSpecApproval))
      || (plan !== null && !(plan instanceof RequirementTestPlan))
      || (specRecordPublication !== null && !(specRecordPublication instanceof RequirementTestResultPublication))
      || (error !== null && !(error instanceof Error))) throw new TypeError("Approval input requires typed source, approval and plan values");
    if (plan !== null && (!plan.specRevision.equals(evidence.specRevision)
      || evidence.testsRequired !== (plan.workItems.length > 0))) throw new TypeError("Approval source and initial plan do not match");
    this.stepId = "approval";
    this.evidence = evidence;
    this.approval = approval;
    this.plan = plan;
    this.specRecordPublication = specRecordPublication;
    this.error = error;
    Object.freeze(this);
  }
}
