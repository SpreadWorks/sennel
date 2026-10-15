import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLifecyclePlan, RunLifecycleHook } from "../../src/flow/definition.js";

for (const strategy of ["skip", "squash", "pr"]) {
  test(`finalize-merge ${strategy} failure keeps canonical audit and commits Git metadata only for squash recovery`, () => {
    const plan = resolveLifecyclePlan({ event: "finalize:onError", command: "finalize-merge", mergeStrategy: strategy });
    assert.ok(plan.actions.every((action) => action instanceof RunLifecycleHook));
    assert.deepEqual(plan.actions.map((action) => action.handler), [
      "assertFinalizeMergeMetadataMutationSafe",
      "finalizeOnError",
      ...(strategy === "squash" ? ["commitFinalizeMergeConflictMetadata"] : []),
    ]);
  });
}
