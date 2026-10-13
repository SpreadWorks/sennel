import { currentRuntimePackage } from "../../lib/runtime-package.js";
import { executionValueDigest, FlowExecutionContract } from "./flow-execution-contract.js";

/** The actual captured template/schema bytes, distinct from the input revision.
 * Inline builders are additionally bound by the complete runtime revision.
 */
export class ExecutionProtocolSnapshot {
  constructor({ prompt = null, schema = null } = {}) {
    const files = currentRuntimePackage().files;
    const templates = files.filter(({ key }) => /\/(prompts|locale|skills)\//.test(key));
    const schemas = files.filter(({ key }) => /\/schemas\//.test(key));
    this.promptDigest = executionValueDigest({ templates, prompt });
    this.schemaDigest = executionValueDigest({ schemas, schema });
    Object.freeze(this);
  }
  static forReview({ manifest, skipConfirm }) {
    return new ExecutionProtocolSnapshot({ prompt: { manifest: manifest.toJSON(), request: { skipConfirm } },
      schema: manifest.output.toJSON() });
  }
  bind({ binding, generation, inputRevision, ...options }) {
    return FlowExecutionContract.fromBinding({ binding, generation, inputRevision,
      promptDigest: this.promptDigest, schemaDigest: this.schemaDigest, ...options });
  }
}
