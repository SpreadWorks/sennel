import { draftWorkerStepRegistration } from "../../../src/flow/engine/composition/draft.js";
import { DraftService } from "../../../src/flow/services/draft-service.js";

/** Build the production Draft Service from the registered Step's observed input. */
export async function prepareDraftService(input) {
  const stepId = input.request?.stepId ?? input.binding?.stepId;
  const registration = draftWorkerStepRegistration(stepId);
  if (registration === null) throw new Error(`no Draft worker registration for ${stepId}`);
  const prepared = await registration.create(input);
  return prepared.dependency(DraftService);
}
