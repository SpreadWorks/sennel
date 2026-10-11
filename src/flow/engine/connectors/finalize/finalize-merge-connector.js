import { ImplPhaseConnector } from "../impl/impl-target-connectors.js";

/** Expose the canonical merge Attempt selected by the commit Result. */
export class FinalizeMergeConnector extends ImplPhaseConnector {
  static activateTarget = true;
}
