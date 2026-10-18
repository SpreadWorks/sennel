import { readFlowReviewAccounting } from "./flow-review-accounting.js";
import { ImplReviewDeferredResult } from "../engine/step-result.js";
import { readFlowFindingsSnapshot, FlowFindingsArtifact } from "./flow-findings.js";
import { canonicalSourceFindings, FlowFindingSourceIdentity } from "./flow-finding-source.js";

/** A completed semantic-limit handoff with every exact source finding retained. */
export class FlowReviewSemanticHandoff {
  #identities;
  constructor({ completion, findings }) {
    const result = completion.activity.result.stepResult;
    if (!(result instanceof ImplReviewDeferredResult) || !(findings instanceof FlowFindingsArtifact)) {
      throw new TypeError("Flow Review handoff requires its completed deferral and cataloged findings");
    }
    result.deferral.assertEvidence(completion.evidence);
    this.sourceArtifact = completion.sourceArtifact;
    const selected = new Set(result.deferral.fingerprints);
    const sources = canonicalSourceFindings({ artifact: completion.payload,
      sourceStep: "impl-review", sourceArtifact: this.sourceArtifact })
      .filter(source => selected.has(source.identity.fingerprint));
    this.#identities = new Map();
    for (const source of sources) {
      const retained = findings.entries.filter(entry => entry.sourceIdentity().equals(source.identity)
        && entry.runId === completion.evidence.identity.runId
        && (entry.planRewindAt ?? null) === (completion.payload.planRewindAt ?? null));
      if (retained.length !== 1 || !retained[0].retryExhausted
        || retained[0].attempts !== result.deferral.attempts
        || retained[0].round !== result.deferral.attempts) {
        throw new Error("Flow Review deferral lost its exact exhausted source finding");
      }
      this.#identities.set(source.identity.toString(), source.identity);
    }
    if (this.#identities.size !== selected.size) {
      throw new Error("Flow Review handoff differs from its selected semantic findings");
    }
    this.identities = Object.freeze([...this.#identities.values()]);
    Object.freeze(this);
  }

  includes(identity) {
    if (!(identity instanceof FlowFindingSourceIdentity)) throw new TypeError("Flow Review handoff requires a complete source identity");
    return this.#identities.has(identity.toString());
  }
}

/** Read the actual terminal Review and its current retained findings through their owners. */
export function readFlowReviewSemanticHandoff({ flowManager, state, consumerNodeId }) {
  const accounting = readFlowReviewAccounting({ flowManager, state });
  const completion = accounting.completed.at(-1) ?? null;
  if (!(completion?.activity.result.stepResult instanceof ImplReviewDeferredResult)) return null;
  if (completion.activity.sequence !== accounting.currentAttemptSequence) {
    throw new Error("Flow Review handoff no longer owns the current canonical Review source");
  }
  const findings = readFlowFindingsSnapshot({ flowManager,
    flowState: state, nodeId: consumerNodeId }).artifact;
  return new FlowReviewSemanticHandoff({ completion, findings });
}
