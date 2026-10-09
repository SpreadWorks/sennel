import { NonGateTargetBinding, NonGateCatalogPublication } from "../../lib/non-gate-transition.js";
import { FlowOutboxIdentity } from "../../lib/flow-outbox-identity.js";

/** A generated document and its delivery confirmation, acquired before saving. */
export class ReportResultEvidence {
  constructor({ identity, publication = null, delivery = "not_required", outboxIdentity = null }) {
    if (!(identity instanceof NonGateTargetBinding) || identity.stepId !== "report"
      || publication !== null && !(publication instanceof NonGateCatalogPublication)
      || !["pending", "done", "not_required"].includes(delivery)
      || outboxIdentity !== null && !(outboxIdentity instanceof FlowOutboxIdentity)) throw new TypeError("Report requires typed publication and delivery evidence");
    if (publication !== null && (outboxIdentity === null || outboxIdentity.runId !== identity.runId
      || outboxIdentity.stepId !== "report" || outboxIdentity.operation !== "report")) throw new TypeError("Report delivery requires its exact outbox identity");
    if (publication !== null && (!publication.attempt.matches(identity.attempt)
      || publication.stepId !== identity.stepId || publication.runId !== identity.runId || publication.specId !== identity.specId)) {
      throw new TypeError("Report publication belongs to another Attempt");
    }
    if (publication === null && delivery !== "pending") throw new TypeError("A generated report requires its acquired publication");
    this.identity = identity;
    this.publication = publication;
    this.delivery = delivery;
    this.outboxIdentity = outboxIdentity;
    Object.freeze(this);
  }
  get stepId() { return "report"; }
  get resultKind() { return this.delivery === "pending" ? "report-delivery-required" : "report-generated"; }
  assertResultKind(kind) { if (kind !== this.resultKind) throw new TypeError("Report Result contradicts its delivery evidence"); }
  toJSON() { return { identity: this.identity.toJSON(), publication: this.publication?.toJSON() ?? null,
    delivery: this.delivery, outboxIdentity: this.outboxIdentity?.toJSON() ?? null }; }
  static fromJSON(value) { return new ReportResultEvidence({ identity: new NonGateTargetBinding(value.identity),
    publication: value.publication === null ? null : new NonGateCatalogPublication(value.publication), delivery: value.delivery,
    outboxIdentity: value.outboxIdentity === null ? null : FlowOutboxIdentity.fromStored(value.outboxIdentity) }); }
}
