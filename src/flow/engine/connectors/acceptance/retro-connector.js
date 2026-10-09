import { ImplPhaseConnector } from "../impl/impl-target-connectors.js";

/** Apply the saved aggregate handoff or selected stale-evidence rewind. */
export class RetroConnector extends ImplPhaseConnector { static activateTarget = true; }
