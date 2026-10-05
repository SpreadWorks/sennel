/**
 * Mechanical authority for the spec-test-coverage guardrail.
 *
 * The spec phase defines behavior but does not own downstream test-file or
 * runtime evidence. Header coverage remains enforced by the test lifecycle,
 * while execution evidence remains enforced by integration. The semantic
 * gate must not turn those later responsibilities into an early blocker.
 */

export const SPEC_TEST_COVERAGE_GUARDRAIL_ID = "spec-test-coverage";

export class SpecTestCoverageDecision {
  constructor({ phase, guardrail }) {
    if (phase !== "spec") throw new Error("spec test coverage decision requires spec phase");
    if (guardrail?.id !== SPEC_TEST_COVERAGE_GUARDRAIL_ID) {
      throw new Error(`spec test coverage requires ${SPEC_TEST_COVERAGE_GUARDRAIL_ID} guardrail`);
    }

    this.guardrailId = guardrail.id;
    this.title = guardrail.title || guardrail.id;
    this.category = guardrail.meta?.category || "testing";
    Object.freeze(this);
  }

  toGateEvaluation() {
    return {
      guardrail_id: this.guardrailId,
      result: "pass",
      reason: "spec phase does not own downstream test-file or runtime evidence",
      category: this.category,
      title: this.title,
      authority: "mechanical",
    };
  }
}
