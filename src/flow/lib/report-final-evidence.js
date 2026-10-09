import { FinalRegressionResultEvidence } from "../steps/acceptance/final-regression-result-evidence.js";
import { ReportBindingError } from "./report-binding.js";
import { validateFinalRegressionEvidence, validateFinalRegressionResult } from "./test-artifacts.js";
import { RepairArtifactRegistry } from "./repair-state-identity.js";
import { captureFinalRegressionChangedSnapshotDigest } from "./final-regression-transition-facts.js";

/** Validate acquired regression bytes against the current implementation. */
export function assertReportFinalRegressionEvidence({ root, relativeSpecFile, artifact, acceptedEvidence = null }) {
  if (artifact.completed !== true && (!(acceptedEvidence instanceof FinalRegressionResultEvidence)
    || acceptedEvidence.acceptedDecision === null || acceptedEvidence.resultKind !== "final-regression-failure-accepted"
    || artifact.result !== "fail")) throw new ReportBindingError("REPORT_BINDING_INVALID", "Final regression is not completed");
  assertCurrentFinalRegressionEvidence({ root, relativeSpecFile, artifact });
}

/** Validate the original process evidence without changing its completion status. */
export function assertCurrentFinalRegressionEvidence({ root, relativeSpecFile, artifact: value }) {
  const artifact = validateFinalRegressionResult(value);
  if (artifact.result === "skipped") {
    if (artifact.changedFileSnapshotDigest !== captureFinalRegressionChangedSnapshotDigest({ root,
      relativeSpecFile })) {
      throw new ReportBindingError("REPORT_BINDING_STALE", "Final regression implementation source changed");
    }
    return;
  }
  const observed = validateFinalRegressionEvidence({ root, artifact, requireCurrentRepository: true, repositoryBindingOptions: {
    pathspecExcludes: new RepairArtifactRegistry(relativeSpecFile).gitPathspecExcludes(),
  } });
  if (!observed.ok) throw new ReportBindingError("REPORT_BINDING_STALE", `Final regression source binding is stale: ${observed.reason}`);
}
