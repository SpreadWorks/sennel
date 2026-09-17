import { StepConnector } from "../../step-connector.js";

/** Connects the initial request to the first Draft step. */
export class DraftEntryConnector extends StepConnector {
  async connect() {
    throw new Error("DraftEntryConnector.connect() is not implemented");
  }
}
