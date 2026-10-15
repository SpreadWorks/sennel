import { Envelope } from "./flow-envelope.js";
import { publicFlowErrorCode, publicFlowErrorMessage } from "./flow-stop-guidance.js";

/** Pre-dispatch failures use the same typed stop boundary as command results. */
export function flowCliFailure(error, { code = null, type = "run", key = "initialize", t = null } = {}) {
  const envelope = Envelope.fail(type, key,
    publicFlowErrorCode(code ?? error?.code, "FLOW_INITIALIZATION_FAILED"),
    publicFlowErrorMessage(error, "Flow command could not be completed."));
  envelope.attachStopGuidance({ error, operation: `flow ${type} ${key}`, t });
  return envelope;
}
