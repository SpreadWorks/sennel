import { isDeepStrictEqual } from "node:util";
import { FlowExecutionContract, FlowExecutionContractRefusal } from "./flow-execution-contract.js";

/** The Store authenticates unchanged input content before saving this exact rebind. */
export class ArtifactWorkerInputContinuation {
  constructor({ sourceContract, targetContract, contentDigest }) {
    if (!(sourceContract instanceof FlowExecutionContract) || !(targetContract instanceof FlowExecutionContract)
      || typeof contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(contentDigest)) {
      throw new TypeError("Worker input continuation requires typed contracts and its verified content digest");
    }
    const { generation: sourceGeneration, runtimeRevision: sourceRuntime, inputRevision: sourceRevision, ...sourcePolicy } = sourceContract.toJSON();
    const { generation: targetGeneration, runtimeRevision: targetRuntime, inputRevision: targetRevision, ...targetPolicy } = targetContract.toJSON();
    if (targetGeneration !== sourceGeneration + 1 || !isDeepStrictEqual(sourcePolicy, targetPolicy)) {
      throw new FlowExecutionContractRefusal("Worker input continuation changed its episode, authority or execution policy");
    }
    Object.assign(this, { sourceContract, targetContract, contentDigest });
    Object.freeze(this);
  }
  assertContracts(sourceContract, targetContract) {
    this.sourceContract.assertMatches(sourceContract);
    this.targetContract.assertMatches(targetContract);
    return this;
  }
  toJSON() { return { sourceContract: this.sourceContract.toJSON(), targetContract: this.targetContract.toJSON(), contentDigest: this.contentDigest }; }
  static fromJSON(value) {
    const restored = new ArtifactWorkerInputContinuation({ sourceContract: FlowExecutionContract.fromJSON(value.sourceContract),
      targetContract: FlowExecutionContract.fromJSON(value.targetContract), contentDigest: value.contentDigest });
    if (!isDeepStrictEqual(restored.toJSON(), value)) throw new FlowExecutionContractRefusal("Saved worker input continuation has unknown fields");
    return restored;
  }
}
