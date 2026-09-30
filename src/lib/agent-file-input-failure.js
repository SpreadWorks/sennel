/** A caller-owned file input could not be captured or no longer matches its reference. */
export class AgentFileInputFailure extends Error {
  constructor(message, { cause, reference = null } = {}) {
    super(message, { cause });
    this.name = "AgentFileInputFailure";
    this.code = "AGENT_FILE_INPUT_FAILURE";
    this.data = Object.freeze({ failureMode: "local_input_failure",
      inputDigest: reference?.digest ?? null, inputByteLength: reference?.byteLength ?? null });
  }
}
