import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCurrentFlowDefinition,
  initializeRequirementTestLifecycle,
  RequirementTestLifecycleDecision,
} from "../../../src/flow/definition.js";
import {
  CurrentAttempt,
  CurrentFlowState,
} from "../../../src/flow/lib/current-flow-state.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
} from "../../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
} from "../../../src/flow/lib/requirement-test-lifecycle.js";
import { SpecRevisionIdentity } from "../../../src/flow/lib/spec-revision-identity.js";

const STARTED_AT = "2026-09-13T00:00:00.000Z";
const CONFIRMED_AT = "2026-09-13T00:01:00.000Z";

function result(summary) {
  return { outcome: "passed", summary, confirmedAt: CONFIRMED_AT, artifactRefs: [] };
}

function attemptFor(state, nodeId, id) {
  const node = state.findNode(nodeId);
  const path = state.definition.pathFor(state.root, nodeId);
  const contract = state.definition.contractFor(nodeId, state.root);
  return new CurrentAttempt({
    id,
    nodeId,
    sequence: node.attemptSequence + 1,
    startedAt: STARTED_AT,
    consumption: { semantic: 0, tooling: 0 },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: [{ operation: "execute", resources: [...contract.resourceContract.required] }],
  });
}

function settleUntil(state, targetId) {
  while (state.nextAction()?.nodeId !== targetId) {
    const next = state.nextAction();
    if (next === null) throw new Error(`missing target ${targetId}`);
    const active = state.startAttempt({ path: next.path, attempt: attemptFor(state, next.nodeId, `before-${next.nodeId}`) });
    state = active.confirmCurrentAttempt({ result: result(`completed ${next.nodeId}`) });
  }
  return state;
}

function revision() {
  return new SpecRevisionIdentity({
    specId: "requirement-test-state",
    revision: 1,
    digest: "a".repeat(64),
    byteLength: 100,
  });
}

function spec(requirements) {
  return {
    goal: "Exercise the Requirement test lifecycle.",
    scope: { in: [], out: [] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    background: "",
    requirements: requirements.map((requirement) => ({
      desc: `${requirement.id} behavior`,
      task_ids: ["T1"],
      ...requirement,
    })),
    acceptance_criteria: [],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
    tasks: [{ id: "T1", title: "Implement", goal: "Implement", origin: "plan", added_round: 0, status: "pending" }],
  };
}

function candidate(requirementId, sourceRevision = revision()) {
  const bundle = new RequirementTestBundleRevision({
    requirementId,
    specRevision: sourceRevision,
    revision: 1,
    paths: [`tests/${requirementId.toLowerCase()}.test.js`],
    lineage: new RequirementTestBundleLineage({
      requirementId,
      specRevision: sourceRevision,
      bundleRevision: 1,
      predecessorRevision: null,
      sourceAttempt: { id: `source-${requirementId}`, sequence: 1 },
      sourceFindingFingerprints: [],
    }),
  });
  return new RequirementTestCandidateBundle({
    bundle,
    sources: [RequirementTestCandidateSource.fromBytes({
      testPath: bundle.paths[0],
      bytes: Buffer.from(`// spec: ${requirementId}\n`),
    })],
  });
}

function activeApproval() {
  let state = CurrentFlowState.create({ definition: buildCurrentFlowDefinition() });
  state = settleUntil(state, "approval");
  const next = state.nextAction();
  return state.startAttempt({ path: next.path, attempt: attemptFor(state, "approval", "approval") });
}

describe("Requirement test fixed-leaf state connector", () => {
  it("keeps the generate Attempt active while Definition stages a non-final Requirement", () => {
    let state = activeApproval();
    const initialization = initializeRequirementTestLifecycle({
      specRevision: revision(),
      spec: spec([
        { id: "R1", testable: true, preimplementation_test_expectation: "fail" },
        { id: "R2", testable: true, preimplementation_test_expectation: "pass" },
      ]),
    });
    state = state.initializeRequirementTestLifecycle({
      result: result("approved"),
      decision: initialization.effect,
      targetAttempt: attemptFor(state, "test-generate", "shared-generate"),
    });
    const sourceAttempt = state.attempt;
    state = state.completeRequirementTestLifecycle({
      result: result("R1 staged"),
      decision: new RequirementTestLifecycleDecision({
        disposition: "advance", target: "test-generate", nextStatus: "candidate_saved",
        requirementId: "R1", nextRequirementId: "R2", candidateBundle: candidate("R1"),
      }),
      targetAttempt: sourceAttempt,
    });
    assert.equal(state.current.at(-1), "test-generate");
    assert.equal(state.attempt.id, "shared-generate");
    assert.equal(state.attempt.sequence, sourceAttempt.sequence);
  });

  it("claims the first R and atomically loops the fixed leaves for the next R", () => {
    const sourceRevision = revision();
    const initialization = initializeRequirementTestLifecycle({
      specRevision: sourceRevision,
      spec: spec([
          { id: "R1", testable: true, preimplementation_test_expectation: "fail" },
          { id: "R2", testable: true, preimplementation_test_expectation: "pass" },
        ]),
    });
    let state = activeApproval();
    state = state.initializeRequirementTestLifecycle({
      result: result("approved"),
      decision: initialization.effect,
      targetAttempt: attemptFor(state, "test-generate", "r1-generate"),
    });
    assert.equal(state.current.at(-1), "test-generate");

    const generated = candidate("R1", sourceRevision);
    state = state.completeRequirementTestLifecycle({
      result: result("candidate saved"),
      decision: new RequirementTestLifecycleDecision({
        disposition: "advance", target: "test-review", nextStatus: "candidate_saved",
        requirementId: "R1", candidateBundle: generated,
      }),
      targetAttempt: attemptFor(state, "test-review", "r1-review"),
    });
    state = state.completeRequirementTestLifecycle({
      result: result("review passed"),
      decision: new RequirementTestLifecycleDecision({
        disposition: "advance", target: "test-gate", nextStatus: "reviewed",
        requirementId: "R1", repairRequired: false,
      }),
      targetAttempt: attemptFor(state, "test-gate", "r1-gate"),
    });
    assert.equal(state.findNode("test-repair").status, "skipped");
    state = state.completeRequirementTestLifecycle({
      result: result("R1 promoted"),
      decision: new RequirementTestLifecycleDecision({
        disposition: "promote", target: "test-generate", nextStatus: "promoted",
        requirementId: "R1", nextRequirementId: "R2",
      }),
      targetAttempt: attemptFor(state, "test-generate", "r2-generate"),
    });

    assert.equal(state.current.at(-1), "test-generate");
    assert.equal(state.findNode("test-generate").attemptSequence, 2);
    assert.equal(state.findNode("test-review").status, "invalidated");
    assert.equal(state.findNode("implement").status, "invalidated");
    assert.doesNotThrow(() => new CurrentFlowState(state.toJSON(), { definition: state.definition }));
  });

  it("skips all four fixed leaves and claims implementation when no Requirement is testable", () => {
    const initialization = initializeRequirementTestLifecycle({
      specRevision: revision(),
      spec: spec([{ id: "R1", testable: false }]),
    });
    let state = activeApproval();
    state = state.initializeRequirementTestLifecycle({
      result: result("approved without tests"),
      decision: initialization.effect,
      targetAttempt: attemptFor(state, "implement", "implement-no-tests"),
    });
    assert.equal(state.current.at(-1), "implement");
    for (const stepId of ["test-generate", "test-review", "test-repair", "test-gate"]) {
      assert.equal(state.findNode(stepId).status, "skipped");
    }
  });
});
