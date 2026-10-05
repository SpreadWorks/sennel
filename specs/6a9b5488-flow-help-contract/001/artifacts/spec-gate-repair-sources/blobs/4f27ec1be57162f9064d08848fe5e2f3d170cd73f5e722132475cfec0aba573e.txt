import { SourceMutationBaseline, SourceMutationManifest } from "./worker-artifact-handoff.js";

/** Revalidate the observed checkout inside the canonical publication lock. */
export class SourceMutationPublicationAdmission {
  constructor({ baseline, manifest, producerAdmission }) {
    if (!(baseline instanceof SourceMutationBaseline) || !(manifest instanceof SourceMutationManifest)) {
      throw new Error("source publication requires its parent-captured baseline and manifest");
    }
    this.baseline = baseline;
    this.manifest = manifest;
    this.producerAdmission = producerAdmission;
    Object.freeze(this);
  }

  assert(view) {
    view.state.assertAttemptConfirmable();
    this.producerAdmission?.assert(view);
    this.manifest.assertMatchesCurrent(this.baseline);
  }
}
