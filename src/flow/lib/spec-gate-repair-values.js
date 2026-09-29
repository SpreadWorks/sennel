import { createHash } from "node:crypto";
import { SpecJsonValidator } from "../../lib/spec-json-validator.js";

/** Read-only evidence. Its identity never grants a Spec edit target. */
export class SpecGateRepairSource {
  constructor({ id, origin, revision, content }) {
    if (typeof id !== "string" || !id || typeof origin !== "string" || !origin
      || typeof revision !== "string" || !revision || typeof content !== "string") {
      throw new TypeError("Repair source requires an identity, origin, revision and text");
    }
    this.id = `evidence:${id}`;
    this.origin = origin;
    this.revision = revision;
    this.content = content;
    this.digest = createHash("sha256").update(JSON.stringify(this.toJSON())).digest("hex");
    Object.freeze(this);
  }
  toJSON() { return { origin: this.origin, revision: this.revision, content: this.content }; }
}

/** One version-bound, permission-limited parent input for Gate repair. */
export class SpecGateRepairInput {
  constructor({ repair, spec, baseRevision, specByteLength, context, sourceDescriptor, review, attempt,
    observationIdentities, validator }) {
    if (!(validator instanceof SpecJsonValidator)) throw new TypeError("Gate repair input requires its canonical Spec validator");
    this.repair = repair;
    this.spec = Object.freeze(structuredClone(spec));
    this.baseRevision = baseRevision;
    this.specByteLength = specByteLength;
    this.context = context;
    this.sourceDescriptor = Object.freeze(structuredClone(sourceDescriptor));
    this.review = review;
    this.attempt = Object.freeze({ id: attempt.id, sequence: attempt.sequence });
    this.observationIdentities = Object.freeze(observationIdentities.map((identity) => Object.freeze(identity)));
    this.validator = validator;
    Object.freeze(this);
  }
}
