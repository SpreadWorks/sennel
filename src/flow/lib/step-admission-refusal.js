/** A system-boundary observation rejected before the Step selects a Result. */
export class StepAdmissionRefusal extends Error {
  constructor(message, cause = null) {
    super(message, cause === null ? undefined : { cause });
    this.name = "StepAdmissionRefusal";
  }
}

export function isStepAdmissionRefusal(error) {
  return error instanceof StepAdmissionRefusal
    || error?.data?.failureKind === "step-admission"
    || error?.isAdmissionRejection === true;
}
