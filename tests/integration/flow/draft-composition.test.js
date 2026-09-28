import assert from "node:assert/strict";
import { test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { draftStepRegistration } from "../../../src/flow/engine/composition/draft.js";
import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { DraftService } from "../../../src/flow/services/draft-service.js";
import { DraftRefineStep } from "../../../src/flow/steps/draft/draft-refine.js";
import { FlowAtStepFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { assertServiceBoundary } from "../../support/structure/service-boundary.js";

test("Draft production registration creates the declared Step with its exact Service", async () => {
  const root = createTmpDir("draft-composition-");
  try {
    const specId = "001-draft-composition";
    const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    new FlowAtStepFixture({
      flowManager, specId, runId: "run-draft-composition",
      request: "Create the registered Draft Step.", targetStep: "draft-refine",
    }).create();
    const binding = new DraftWorkerExecutionStepBinding({ flowManager, specId, stepId: "draft-refine" });
    const prepared = await draftStepRegistration("draft-refine").create({
      flowManager, binding, executionBinding: null,
    });
    assert.ok(prepared.step instanceof DraftRefineStep);
    assert.ok(prepared.dependency(DraftService) instanceof DraftService);
    assert.equal(prepared.dependencies.size, 1);
    assertServiceBoundary(prepared.dependency(DraftService));

    const registration = (prepareDependencies) => new StepRegistration({
      stepId: "draft-refine", StepClass: DraftRefineStep, prepareDependencies,
    });
    await assert.rejects(registration(() => new Map()).create(), /exactly its declared dependencies/);
    await assert.rejects(registration(() => new Map([
      [DraftService, prepared.dependency(DraftService)], [Date, new Date()],
    ])).create(), /exactly its declared dependencies/);
    await assert.rejects(registration(() => new Map([[DraftService, {}]])).create(),
      /instance of Dependency/);
  } finally {
    removeTmpDir(root);
  }
});
