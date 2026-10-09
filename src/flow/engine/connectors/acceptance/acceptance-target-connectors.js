import { ImplPhaseConnector } from "../impl/impl-target-connectors.js";
/** Only Definition-selected target handoffs carry connectors. */
export class AcceptanceRepairConnector extends ImplPhaseConnector { static activateTarget = true; }
export class AcceptanceDecisionConnector extends ImplPhaseConnector { static activateTarget = true; }
export class AcceptanceFinalRegressionConnector extends ImplPhaseConnector { static activateTarget = true; }
