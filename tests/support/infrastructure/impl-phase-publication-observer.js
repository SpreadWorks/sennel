import { SourcePublicationCaptureFile } from "./source-publication-capture.js";
import assert from "node:assert/strict";

// FlowManager initializes the production composition graph before its shared
// Result/Definition/Store types are inspected. Do not enter via an adapter.
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowManagerStore } from "../../../src/flow/lib/canonical-flow-manager-store.js";
import { StepResult, stepResultDigest } from "../../../src/flow/engine/step-result.js";
import { StepSettlement } from "../../../src/flow/definition.js";
import { CurrentFlowState, FlowActivity } from "../../../src/flow/lib/current-flow-state.js";
import { futurePhaseManifests } from "../structure/phase-manifest.js";
import { StructureLeaf } from "../structure/production-registrations.js";

const defaultLeaves = futurePhaseManifests.find((manifest) => manifest.id === "03").leaves;
const saveOperation = /^(?:commit|settle|save|confirm|complete|record|checkpoint|claim|approve|publish)/;

/** Preserve ordinary publication data, shared aliases and exact Buffer bytes.
 * Nominal values retain their real types/private invariants and are not rebuilt
 * from JSON. Accessors are preserved without being invoked by the snapshot.
 */
function snapshot(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Buffer.isBuffer(value)) {
    const copy = Buffer.from(value);
    seen.set(value, copy);
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  const copy = Array.isArray(value) ? [] : Object.create(prototype);
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (Object.hasOwn(descriptor, "value")) descriptor.value = snapshot(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  if (Array.isArray(value)) Object.defineProperty(copy, "length", Object.getOwnPropertyDescriptor(value, "length"));
  return copy;
}

/** An audit of an actual typed save call, including one that loses its response.
 * It is never a producer, a publication candidate or a replacement receipt.
 */
class PublicationObservation {
  #input;
  #producer;
  #beforeState;
  #priorActivities;

  constructor(producer, operation, input, captured = null) {
    this.#input = snapshot(input);
    this.#producer = producer instanceof FlowManager ? producer._store : producer;
    this.operation = operation;
    const { binding, stepResult } = input;
    this.#beforeState = captured?.beforeState ?? producer.canonicalState(input.specId ?? binding.specId);
    assert.ok(this.#beforeState instanceof CurrentFlowState,
      "publication observation requires the actual pre-save canonical state");
    this.#priorActivities = captured?.priorActivities ?? Object.freeze(producer.activityLedger(input.specId ?? binding.specId)
      .map((entry) => new FlowActivity(entry)));
    this.runId = binding.runId;
    this.specId = binding.specId;
    this.stepId = stepResult.stepId;
    this.attemptId = binding.attempt.id;
    this.sequence = binding.attempt.sequence;
    this.kind = stepResult.kind;
    this.resultDigest = stepResultDigest(stepResult);
    Object.freeze(this);
  }

  captureSource(file) {
    file.write({ operation: this.operation, input: this.#input,
      beforeState: this.#beforeState, priorActivities: this.#priorActivities });
  }

  matches(activity, result) {
    const binding = activity.result?.draftSettlementReceipt?.binding;
    return this.runId === binding?.runId && this.specId === binding.specId
      && this.stepId === result.stepId && this.kind === result.kind
      && this.attemptId === activity.attemptId && this.sequence === activity.sequence
      && this.attemptId === binding.attemptId && this.sequence === binding.attemptSequence
      && this.resultDigest === stepResultDigest(result);
  }

  authenticate(manager, activity, result, settlement) {
    assert.notEqual(manager._store, this.#producer,
      "IMPL_PHASE_PUBLICATION_RELOAD_REQUIRED: authentication must use a fresh manager/Store");
    const input = snapshot(this.#input);
    assert.equal(stepResultDigest(input.stepResult), this.resultDigest,
      "IMPL_PHASE_PUBLICATION_CAPTURE_CHANGED: the original typed Result was mutated after saving");
    assert.equal(input.settlement.constructor, settlement.constructor);
    assert.deepEqual(input.settlement.toJSON(), settlement.toJSON());
    assert.equal(input.settlement.connector, settlement.connector);
    assert.equal(this.resultDigest, stepResultDigest(result));
    assert.equal(this.#beforeState.confirmationOrder + 1, activity.confirmationOrder,
      "IMPL_PHASE_PUBLICATION_PREDECESSOR_MISMATCH: exact owning Activity must follow the observed pre-save state");
    assert.equal(this.#priorActivities.length, this.#beforeState.confirmationOrder);
    // This is the existing read-only replay authenticator. The captured original
    // publication intent is never passed to a save, transition or recovery API.
    const receipt = manager.findStepSettlementReceipt(input);
    if (receipt === null) return null;
    // Replay this one genuine Activity against its genuine observed predecessor.
    // This pure audit never changes the fresh manager or uses a second builder.
    const typedActivity = new FlowActivity(activity);
    const afterState = typedActivity.transition.apply(this.#beforeState, typedActivity,
      { priorActivities: this.#priorActivities }).withConfirmationOrder(activity.confirmationOrder);
    assert.equal(afterState.runId, this.runId);
    assert.equal(afterState.specId, this.specId);
    return new PublicationAuthentication(receipt, afterState, typedActivity);
  }
}

/** Authentic readback plus the exact one-Activity canonical transition audit. */
export class PublicationAuthentication {
  constructor(receipt, afterState, activity) {
    if (typeof receipt?.id !== "string" || !(afterState instanceof CurrentFlowState)
      || !(activity instanceof FlowActivity)) throw new TypeError("publication authentication requires a receipt and typed canonical replay");
    Object.assign(this, { receipt, afterState, activity });
    Object.freeze(this);
  }
}

/** Observe original public save arguments without replacing their behavior.
 * Missing typed save capture is a contract failure: a legacy status/publication
 * or a self-authenticated receipt cannot substitute for the shared save/read API.
 */
export class ImplPhasePublicationObserver {
  #observations = [];
  #captureErrors = [];
  #mocks = [];
  #stepIds;
  #sourceCapture;

  constructor(t, { leaves = defaultLeaves, sourceCapture = null } = {}) {
    if (!Array.isArray(leaves) || !leaves.length || leaves.some((leaf) => !(leaf instanceof StructureLeaf))) {
      throw new TypeError("publication observation requires an existing fixed StructureLeaf scope");
    }
    this.#stepIds = new Set(leaves.map((leaf) => leaf.stepId));
    this.#sourceCapture = sourceCapture === null ? null : new SourcePublicationCaptureFile(sourceCapture);
    t.after(() => this.restore());
    for (const Type of [FlowManager, CanonicalFlowManagerStore]) {
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(Type.prototype))) {
        if (!saveOperation.test(name) || typeof descriptor.value !== "function") continue;
        const original = descriptor.value;
        const observer = this;
        this.#mocks.push(t.mock.method(Type.prototype, name, function (...args) {
          try { observer.#capture(this, `${Type.name}.${name}`, args); }
          catch (error) {
            if (observer.#sourceCapture !== null) throw error;
            observer.#captureErrors.push({ operation: `${Type.name}.${name}`, error });
          }
          // Preserve the receiver, argument identities, return/Promise identity,
          // and thrown error. Recording precedes the call, including postcommit
          // response loss; no finally/readback or async continuation is injected.
          return original.apply(this, args);
        }));
      }
    }
  }

  #capture(producer, operation, args) {
    for (const input of args) {
      if (!(input?.stepResult instanceof StepResult) || !this.#stepIds.has(input.stepResult.stepId)
        || !(input.settlement instanceof StepSettlement) || input.binding?.attempt === undefined) continue;
      const observation = new PublicationObservation(producer, operation, input);
      this.#observations.push(observation);
      if (this.#sourceCapture !== null && operation === "FlowManager.commitSpecStepResult" && input.effect != null) {
        observation.captureSource(this.#sourceCapture);
      }
    }
  }

  importSourceCapture({ filePath, nonce, processId, executionRoot }) {
    const captured = new SourcePublicationCaptureFile({ filePath, nonce }).read({ processId, executionRoot });
    this.#observations.push(new PublicationObservation(captured.producer, captured.operation,
      captured.input, captured));
    return captured.digest;
  }

  authenticate(manager, activity, result, settlement) {
    assert.ok(manager instanceof FlowManager);
    assert.ok(result instanceof StepResult && settlement instanceof StepSettlement);
    const saved = activity.result?.draftSettlementReceipt;
    assert.ok(saved, "IMPL_PHASE_PUBLICATION_RECEIPT_MISSING: owning Activity must retain its receipt");
    const observed = this.#observations.filter((entry) => entry.matches(activity, result));
    assert.ok(observed.length > 0,
      `IMPL_PHASE_PUBLICATION_CAPTURE_MISSING: ${activity.nodeId}/${activity.attemptId}/${activity.sequence}/${result.kind} requires its original typed save inputs`
      + this.#captureErrors.map(({ operation, error }) => `; ${operation}: ${error.name}: ${error.message}`).join(""));
    const failures = [];
    // A facade may forward less complete arguments than the actual Store save.
    // Authenticate each actual call using its own complete captured intent.
    for (const entry of [...observed].reverse()) {
      try {
        const verified = entry.authenticate(manager, activity, result, settlement);
        if (verified === null) { failures.push(`${entry.operation}: no exact receipt`); continue; }
        const { receipt } = verified;
        assert.equal(receipt.id, saved.id);
        assert.equal(receipt.publicationDigest, saved.publicationDigest);
        assert.deepEqual(receipt.binding, saved.binding);
        return Object.freeze(verified);
      } catch (error) { failures.push(`${entry.operation}: ${error.name}: ${error.message}`); }
    }
    assert.fail(`IMPL_PHASE_PUBLICATION_AUTHENTICATION_FAILED: ${activity.nodeId}/${result.kind}: ${failures.join("; ")}`);
  }

  restore() {
    for (const mocked of this.#mocks.splice(0).reverse()) mocked.mock.restore();
  }
}
