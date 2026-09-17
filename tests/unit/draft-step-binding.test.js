import assert from "node:assert/strict";
import test from "node:test";

import {
  DraftStepBinding,
  DraftWorkerStepBinding,
} from "../../src/flow/engine/connectors/draft/draft-step-binding.js";

test("DraftStepBinding cannot be constructed without a typed domain source", () => {
  assert.throws(() => new DraftStepBinding(), /abstract/);
});

test("DraftWorkerStepBinding requires the existing typed handoff request", () => {
  assert.throws(() => new DraftWorkerStepBinding({ request: {} }), /WorkerArtifactHandoffRequest/);
});
