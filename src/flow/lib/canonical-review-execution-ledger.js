import { isDeepStrictEqual } from "node:util";
import { DraftStepSettlementReceipt } from "../definition.js";
import { FlowActivity } from "./current-flow-state.js";

/** Exact durable Review execution claims shared by semantic accounting readers. */
export class CanonicalReviewExecutionLedger {
  #claims = new Map();

  constructor(activities) {
    this.activities = Object.freeze(activities.map(activity => FlowActivity.canonical(activity)));
    for (const activity of this.activities) {
      if (activity.result?.draftSettlementReceipt?.executionLifecycle?.phase !== "claimed") continue;
      const key = this.#key(activity);
      const prior = this.#claims.get(key) ?? [];
      prior.push(activity);
      this.#claims.set(key, prior);
    }
    Object.freeze(this);
  }

  #key(activity) {
    return JSON.stringify([activity.nodeId, activity.attemptId, activity.sequence]);
  }

  assertTerminal({ activity, binding, result, settlement, target }) {
    const receipt = DraftStepSettlementReceipt.assertStored(
      activity.result.draftSettlementReceipt.toJSON(), { binding, result, settlement });
    const lifecycle = receipt.executionLifecycle;
    const claim = (this.#claims.get(this.#key(activity)) ?? []).findLast(prior =>
      prior.confirmationOrder < activity.confirmationOrder
      && isDeepStrictEqual(prior.result.draftSettlementReceipt.executionLifecycle.toJSON().binding, lifecycle?.binding));
    if (lifecycle?.phase !== "terminal" || lifecycle.binding.kind !== "review"
      || claim === undefined
      || !isDeepStrictEqual(lifecycle.claim, claim.result.draftSettlementReceipt.executionLifecycle.toJSON().claim)
      || !isDeepStrictEqual(lifecycle.binding.target, target)) {
      throw new Error("Canonical Review completion lacks its exact execution claim, target and terminal receipt");
    }
    return receipt;
  }
}
