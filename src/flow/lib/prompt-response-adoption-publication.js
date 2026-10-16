import { CanonicalPromptResponseAdoption, CanonicalPromptResponseContributionSelection, PromptResponseAdoptionAdmissionValue } from "./prompt-response-adoption.js";
import { assertPromptResponseSelectionFromView } from "./canonical-prompt-execution.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";

/** Reuses the canonical Prompt reader inside the existing publication lock. */
export class PromptResponseAdoptionPublicationAdmission extends PromptResponseAdoptionAdmissionValue {
  constructor(writes, activity, publicationWrites) {
    super();
    this.adoptions = Object.freeze(writes.map((write) => CanonicalPromptResponseAdoption.fromJSON(JSON.parse(write.bytes))));
    this.activity = activity;
    this.publicationWrites = publicationWrites;
    Object.freeze(this);
  }
  assert(view) {
    for (const adoption of this.adoptions) {
      assertPromptResponseSelectionFromView(view, adoption.selection);
      adoption.assertPublication(view, this.activity);
      assertPublicationPayload(adoption, view, this.publicationWrites);
    }
  }
}

function assertPublicationPayload(adoption, view, writes = null) {
  const selection = adoption.selection;
  if (!(selection instanceof CanonicalPromptResponseContributionSelection)) return;
  if (writes !== null) {
    const publications = writes.filter((write) => (write.logicalKey ?? write.artifact?.logicalKey) === selection.publicationLogicalKey);
    if (publications.length !== 1) throw new TypeError("Prompt contributions require their actual publication in the same transaction");
    selection.assertPublishedArtifact(publications[0].bytes);
  } else {
    const descriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === selection.publicationLogicalKey);
    if (descriptor === undefined) throw new TypeError("Prompt contribution publication artifact is missing");
    selection.assertPublishedArtifact(view.readCatalogedArtifact(descriptor));
  }
}

export class CapturedPromptResponseAdoption {
  constructor({ adoption, descriptor, activity }) {
    Object.assign(this, { adoption, descriptor, activity, acceptedAt: activity.result?.confirmedAt ?? activity.timing?.finishedAt ?? null });
    Object.freeze(this);
  }
}

/** Historical capture validates retained evidence without live/current execution checks. */
export function capturePromptResponseAdoptionsFromView(view) {
  return Object.freeze(view.catalog.artifacts.filter((entry) => entry.logicalKey === "execution.response.adoption").map((descriptor) => {
    const adoption = CanonicalPromptResponseAdoption.fromJSON(JSON.parse(view.readCatalogedArtifact(descriptor)));
    if (descriptor.relativePath !== FLOW_ARTIFACT_CONTRACTS.resolve("execution.response.adoption", { adoptionId: adoption.id }).relativePath) {
      throw new TypeError("Prompt response adoption path differs from its identity");
    }
    const activity = view.activities.find((entry) => entry.id === descriptor.activityId);
    if (activity === undefined) throw new TypeError("Prompt response adoption publication Activity is missing");
    assertPromptResponseSelectionFromView(view, adoption.selection);
    adoption.assertPublication(view, activity);
    assertPublicationPayload(adoption, view);
    return new CapturedPromptResponseAdoption({ adoption, descriptor, activity });
  }));
}
