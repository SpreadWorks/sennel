import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertRetainedArtifactProofDescriptor } from "./process-evidence-artifact-encoding.js";
import { assertWorkerArtifactStoredValue } from "../flow/lib/worker-artifact-input-format.js";
import {
  CanonicalSourceHandoffCheckpoint,
  SourceMutationBaseline,
  SourceWorkerCanonicalObservationAdvance,
} from "../flow/lib/worker-artifact-handoff.js";

const retainedEncodingToken = Symbol("retained source checkpoint encoding");
const PROOF_PREFIX = "artifacts/migration/process-evidence-v6/retained-source-checkpoints-v3/";

/** A representation supplied only by explicit, retained-artifact migration. */
export class SourceCheckpointArtifactEncoding {
  encode() { throw new TypeError("source checkpoint encoding must implement encode"); }
}

class RetainedSourceCheckpointEncoding extends SourceCheckpointArtifactEncoding {
  #previous;
  #current;
  constructor(token, previous, current) {
    super();
    if (token !== retainedEncodingToken) throw new TypeError("retained source encoding requires its migration proof");
    this.#previous = JSON.stringify(previous);
    this.#current = current.unsignedJSON();
    Object.freeze(this);
  }
  encode(current) {
    if (!isDeepStrictEqual(current, this.#current)) throw new TypeError("retained source checkpoint differs from its compact proof");
    const { digest: _digest, ...unsigned } = JSON.parse(this.#previous);
    return unsigned;
  }
}

/** Keep the original immutable checkpoint and its domain digest unchanged.
 * The explicit migration adds only the current compact value that proves its
 * exact interpretation. Ordinary version-3 reads never accept version 2.
 */
export class SourceCheckpointArtifactProof {
  #previous;
  #current;
  #observation;
  #encoding;
  constructor(sourceBytes, { root, canonicalLocation }) {
    if (!Buffer.isBuffer(sourceBytes)) throw new TypeError("source checkpoint proof requires captured bytes");
    const previous = JSON.parse(sourceBytes.toString("utf8"));
    const keys = ["version", "identity", "baseline", "canonicalObservation", "rollbackBlobDigest", "allowedCanonicalPaths", "producer", "digest"];
    if (previous?.version !== 2 || !isDeepStrictEqual(Object.keys(previous).sort(), keys.sort())) {
      throw new TypeError("source checkpoint migration requires the exact previous version-2 document");
    }
    const observation = SourceWorkerCanonicalObservationAdvance.fromStored(previous.canonicalObservation, { canonicalLocation });
    this.#current = new CanonicalSourceHandoffCheckpoint({
      identity: previous.identity,
      baseline: SourceMutationBaseline.fromStored(previous.baseline, { root }),
      canonicalObservation: observation,
      rollbackBlobDigest: previous.rollbackBlobDigest,
      allowedCanonicalPaths: previous.allowedCanonicalPaths,
      producer: previous.producer,
    });
    assertWorkerArtifactStoredValue(previous, {
      ...this.#current.unsignedJSON(), version: 2,
      canonicalObservation: observation.storedJSON(), digest: previous.digest,
    }, "previous source handoff checkpoint");
    this.#previous = JSON.stringify(previous);
    this.#observation = SourceWorkerCanonicalObservationAdvance.fromCheckpoint(
      this.#current.canonicalObservation.checkpointJSON(), { canonicalLocation });
    this.#encoding = new RetainedSourceCheckpointEncoding(retainedEncodingToken, previous, this.#current);
    this.sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    this.relativePath = SourceCheckpointArtifactProof.pathFor(this.sourceHash);
    // The existing checkpoint constructor authenticates the old domain digest
    // using the retained encoding; no second digest implementation is needed.
    this.checkpoint();
    Object.freeze(this);
  }
  checkpoint() {
    const previous = JSON.parse(this.#previous);
    return new CanonicalSourceHandoffCheckpoint({
      identity: this.#current.identity,
      baseline: this.#current.baseline,
      canonicalObservation: this.#observation,
      rollbackBlobDigest: this.#current.rollbackBlobDigest,
      allowedCanonicalPaths: this.#current.allowedCanonicalPaths,
      producer: this.#current.producer,
      artifactEncoding: this.#encoding,
      digest: previous.digest,
    });
  }
  get identity() { return this.#current.identity; }
  toJSON() {
    return { version: 1, sourceHash: this.sourceHash, checkpoint: this.#current.toJSON() };
  }
  get bytes() { return Buffer.from(JSON.stringify(this.toJSON(), null, 2) + "\n", "utf8"); }
  static pathFor(sourceHash) {
    if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new TypeError("source checkpoint proof requires its original byte digest");
    return PROOF_PREFIX + sourceHash + ".json";
  }
  static assertDescriptor(descriptor) {
    assertRetainedArtifactProofDescriptor(descriptor,
      this.pathFor(descriptor.relativePath.slice(PROOF_PREFIX.length).replace(/\.json$/, "")));
  }
  static fromBytes(bytes, sourceBytes, options) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("source checkpoint proof requires Buffer bytes");
    const proof = new this(sourceBytes, options);
    if (!isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), proof.toJSON())) {
      throw new TypeError("source checkpoint proof differs from its exact original artifact");
    }
    return proof;
  }
}
