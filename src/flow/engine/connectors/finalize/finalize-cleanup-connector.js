import { ImplPhaseConnector } from "../impl/impl-target-connectors.js";

/** Expose the canonical cleanup Attempt selected by the sync Result. */
export class FinalizeCleanupConnector extends ImplPhaseConnector {
  static activateTarget = true;
}
