import { flattenSteps } from "./step-tree.js";
import { advisorySummary } from "./nonblocking.js";

const TERMINAL_STEP_STATUSES = new Set(["done", "skipped"]);

export class FlowCompletion {
  constructor(state) {
    if (!state || typeof state !== "object") throw new Error("flow completion requires state");
    this.state = state;
    const leaves = flattenSteps(state.steps || []);
    this.total = leaves.length;
    this.done = leaves.filter((step) => TERMINAL_STEP_STATUSES.has(step.status)).length;
    if (this.total > 0 && this.done === this.total) {
      this.completionMode = "normal";
      this.mergeDisposition = state.mergeStrategy || state.state?.mergeStrategy || null;
      this.success = true;
      this.terminal = true;
    } else {
      this.completionMode = null;
      this.mergeDisposition = null;
      this.success = null;
      this.terminal = false;
    }
    this.assurance = advisorySummary(state).length > 0 ? "advisory" : "strict";
    Object.freeze(this);
  }

  get complete() {
    return this.terminal && this.success === true;
  }

  get active() {
    return !this.terminal;
  }

  toJSON() {
    const advisory = advisorySummary(this.state || {});
    return {
      terminal: this.terminal,
      success: this.success,
      completionMode: this.completionMode,
      mergeDisposition: this.mergeDisposition,
      assurance: this.assurance,
      ...(advisory.length > 0 && { advisorySummary: advisory }),
    };
  }
}
