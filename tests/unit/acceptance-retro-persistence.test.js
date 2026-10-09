import assert from "node:assert/strict";
import { test } from "node:test";
import { RetroStep } from "../../src/flow/steps/acceptance/retro.js";
import { RetroAggregatedResult } from "../../src/flow/engine/step-result.js";
import { RetroService } from "../../src/flow/services/retro-service.js";
import { RetroInput } from "../../src/flow/services/retro-input.js";
import { AcceptanceSettlementWriter } from "../../src/flow/services/acceptance-settlement-writer.js";
import { RetroResultEvidence } from "../../src/flow/lib/retro-values.js";
import { NonGateTargetBinding } from "../../src/flow/lib/non-gate-transition.js";

function deferredRetroService(receipt) {
  const input = new RetroInput({ evidence: new RetroResultEvidence({
    identity: new NonGateTargetBinding({ runId: "run", specId: "spec", stepId: "retro",
      attempt: { id: "retro-1", sequence: 1 } }),
    fingerprint: "a".repeat(64),
  }) });
  class DeferredRetroService extends RetroService {
    persisted = null;
    persistStepResult(result) { this.persisted = result; return receipt; }
  }
  return new DeferredRetroService(input, new AcceptanceSettlementWriter({}));
}

test("Retro returns its adopted Result only after durable acknowledgement", async () => {
  let release;
  const receipt = new Promise((resolve) => { release = resolve; });
  const service = deferredRetroService(receipt);
  let settled = false;
  const execution = new RetroStep(service).execute().then((result) => { settled = true; return result; });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(service.persisted instanceof RetroAggregatedResult);
  assert.equal(settled, false);
  release({ id: "durable-retro" });
  assert.equal(await execution, service.persisted);
  assert.equal(settled, true);
});

test("Retro preserves the original persistence rejection", async () => {
  let reject;
  const receipt = new Promise((_resolve, fail) => { reject = fail; });
  const service = deferredRetroService(receipt);
  const execution = new RetroStep(service).execute();
  const failure = new Error("canonical storage unavailable");
  reject(failure);
  await assert.rejects(execution, (error) => error === failure);
  assert.ok(service.persisted instanceof RetroAggregatedResult);
});
