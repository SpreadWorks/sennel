/**
 * Base class for preparing and connecting Flow steps.
 * @abstract
 */
export class StepConnector {
  constructor() {
    if (new.target === StepConnector) {
      throw new TypeError("StepConnector is abstract");
    }
  }

  /** Subclasses implement the preparation and handoff between steps. */
  /** @abstract */
  async connect() {
    throw new Error("StepConnector.connect() must be implemented by subclass");
  }
}
