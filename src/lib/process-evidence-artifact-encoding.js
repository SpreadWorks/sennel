import { ReviewWorkUnitOutput } from "../flow/lib/review-work-unit-values.js";
import { ProcessExecutionStopReceipt, ProcessStopArtifactEncoding, ProcessStopArtifactReference } from "./process-execution-values.js";

export const REVIEW_PROCESS_EVIDENCE_KEYS = Object.freeze([
  ...["draft-questions", "draft-coverage", "test", "impl"].map(phase => ReviewWorkUnitOutput.forReview({ phase }).logicalKey),
  ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: "bound-task" }).logicalKey,
]);
export const HASH_BOUND_PROCESS_EVIDENCE_KEYS = Object.freeze([
  "source.handoff.event", "spec.review", "activity.evidence", ...REVIEW_PROCESS_EVIDENCE_KEYS,
]);

/** Protocol-owned receipt fields only. Provider/binding/user data remains opaque. */
export function artifactProcessStopReceipts(logicalKey, value) {
  const direct = logicalKey === "source.handoff.event" ? value.processStopEvidence
    : logicalKey === "spec.review" ? value.processStop
    : logicalKey === "activity.evidence" ? value.review?.processStop
    : REVIEW_PROCESS_EVIDENCE_KEYS.includes(logicalKey) ? value.processStop : null;
  return [direct, ...(REVIEW_PROCESS_EVIDENCE_KEYS.includes(logicalKey)
    ? (value.attempts ?? []).map(entry => entry.artifact?.payload?.processStop) : [])]
    .filter(receipt => receipt !== null && receipt !== undefined);
}

export const PROCESS_EVIDENCE_MIGRATION_KEYS = Object.freeze(["execution.source.manifest", "prompt.execution.progress", "prompt.execution.event",
  ...HASH_BOUND_PROCESS_EVIDENCE_KEYS]);

const PROOF_PREFIX = "artifacts/migration/process-evidence-v6/retained-completions/";

/** One existing current4 leaf proves its exact retained producer serialization.
 * Per-receipt compact storage keeps the original individual artifact byte cap.
 */
export class ProcessStopArtifactProof {
  constructor(receipt) {
    this.encoding = new ProcessStopArtifactEncoding([receipt]);
    this.receipt = this.encoding.receipts[0];
    this.evidenceDigest = this.receipt.evidenceDigest;
    this.relativePath = ProcessStopArtifactProof.pathFor(ProcessStopArtifactProof.referenceDigest(this.receipt));
    Object.freeze(this);
  }
  get bytes() { return Buffer.from(`${JSON.stringify(this.receipt.toJSON())}\n`, "utf8"); }
  /** Lookup binds the immutable physical call identity, independent of JSON key
   * ordering. Complete receipt equality is still required by the proof codec. */
  static referenceDigest(receipt) {
    return new ProcessStopArtifactReference(receipt).digest;
  }
  static pathFor(digest) {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("Stop proof requires a physical call reference digest");
    return `${PROOF_PREFIX}${digest}.json`;
  }
  static isProofPath(relativePath) { return relativePath.startsWith(PROOF_PREFIX); }
  static assertDescriptor(descriptor) {
    if (!this.isProofPath(descriptor.relativePath)) return false;
    const digest = descriptor.relativePath.slice(PROOF_PREFIX.length).replace(/\.json$/, "");
    if (descriptor.relativePath !== this.pathFor(digest) || descriptor.logicalKey !== null
      || descriptor.kind !== "migration-materialization" || descriptor.slot.authority.toString() !== "canonical-flow-artifacts"
      || descriptor.slot.publicationStep !== "system" || descriptor.retention !== "permanent"
      || descriptor.migrationMaterialization !== true) {
      throw new TypeError("Stop proof differs from its permanent migration descriptor");
    }
    return true;
  }
  static fromBytes(bytes, relativePath) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Stop proof requires Buffer bytes");
    const proof = new this(new ProcessExecutionStopReceipt(JSON.parse(bytes.toString("utf8"))));
    if (proof.relativePath !== relativePath) throw new TypeError("Stop proof differs from its physical call reference path");
    return proof;
  }
  static requiredDigests(logicalKey, bytes) {
    if (!HASH_BOUND_PROCESS_EVIDENCE_KEYS.includes(logicalKey)) return [];
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Process evidence artifact requires Buffer bytes");
    return [...new Set(artifactProcessStopReceipts(logicalKey, JSON.parse(bytes.toString("utf8")))
      .filter(receipt => receipt.schemaVersion === 3).map(receipt => this.referenceDigest(receipt)))];
  }
}
