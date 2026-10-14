import assert from "node:assert/strict";
import { STEP_RESULT_REGISTRY, STEP_RESULT_TYPE, StepResult, rehydrateStepResult } from "../../../src/flow/engine/step-result.js";

/** Expected semantic contracts from the board's frozen leaf designs.
 * These values inspect the single production registry; they never register or
 * implement a Result, select a route or provide substitute production output.
 */
export class ImplPhaseResultContract {
  constructor(stepId, className, kind, type, sourceBoard) {
    if ([stepId, className, kind, sourceBoard].some((value) => typeof value !== "string" || !value)
      || !Object.values(STEP_RESULT_TYPE).includes(type)) throw new TypeError("invalid implementation Result contract");
    Object.assign(this, { stepId, className, kind, type, sourceBoard });
    Object.freeze(this);
  }

  registration() {
    const entries = STEP_RESULT_REGISTRY.filter((entry) => entry.kind === this.kind);
    assert.equal(entries.length, 1,
      `IMPL_PHASE_RESULT_CONTRACT_MISSING: ${this.stepId} requires exactly one ${this.kind} in STEP_RESULT_REGISTRY (board ${this.sourceBoard})`);
    const entry = entries[0];
    assert.equal(entry.stepId, this.stepId);
    assert.equal(entry.type, this.type);
    assert.equal(entry.ResultClass.name, this.className);
    assert.ok(StepResult.prototype.isPrototypeOf(entry.ResultClass.prototype));
    return entry;
  }

  assertResult(result) {
    const entry = this.registration();
    assert.ok(result instanceof StepResult, "readback must expose a concrete StepResult");
    assert.equal(result.constructor, entry.ResultClass);
    assert.equal(result.stepId, this.stepId);
    assert.equal(result.kind, this.kind);
    assert.equal(result.type, this.type);
    const stored = result.toJSON();
    const restored = rehydrateStepResult(this.stepId, stored);
    assert.equal(restored.constructor, entry.ResultClass);
    assert.deepEqual(restored.toJSON(), stored);
    for (const field of ["target", "effects", "connector", "ctx", "manager", "payload"]) {
      assert.equal(Object.hasOwn(stored, field), false, `Result must not store ${field}`);
    }
    const anotherType = this.type === "completed" ? "loop-required" : "completed";
    assert.throws(() => rehydrateStepResult(this.stepId, { ...stored, type: anotherType }), TypeError);
    assert.throws(() => rehydrateStepResult(this.stepId, { ...stored, kind: "unknown-implementation-result" }), TypeError);
    return restored;
  }
}
