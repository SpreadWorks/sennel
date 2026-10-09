import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { StepResult, stepResultDigest } from "../../../src/flow/engine/step-result.js";
import { TaskStepIdentity } from "../../../src/flow/lib/task-step-identity.js";
import { TaskNode } from "../../../src/flow/lib/current-flow-state.js";
import { RequirementTestArtifactStore } from "../../../src/flow/lib/requirement-test-store.js";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { SeedWorkRoot } from "../../support/builders/seed-work-root.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function node(value, id) {
  if (value.id === id) return value;
  return value.steps?.map((child) => node(child, id)).find(Boolean);
}

test("completed Approval reads its genuine immutable reviewed basis after runtime Spec metadata advances", async (t) => {
  const scenario = AcceptancePhaseScenario.create(t);
  await scenario.advanceTo("approval");
  const original = scenario.manager.readCurrentSpecReview({ specId: scenario.specId, consumerNodeId: "approval" });
  await scenario.approve();
  const state = scenario.state();
  const tasks = state.findNode(state.definition.dynamicTaskContainerId).steps.filter((candidate) => candidate instanceof TaskNode);
  assert.ok(tasks.length > 0, "actual Approval must admit its canonical Task before metadata production");
  const implementation = new TaskStepIdentity({ taskId: tasks[0].id, role: "impl" }).nodeId;
  await scenario.advanceTo(implementation);
  await scenario.executeCurrent();
  scenario.reload();
  assert.equal(scenario.state().findNode(implementation).status, "done");
  const identity = new RequirementTestArtifactStore({ flowManager: scenario.manager, state: scenario.state() })
    .readPlan("acceptance-review").artifact.plan.specRevision;
  assert.ok(identity.equals(original.review.identity));
  const currentSpec = scenario.artifact("spec.record");
  assert.notEqual(currentSpec.descriptor.hash, identity.digest, "real approval/Task implementation metadata creates later immutable root revisions");
  const before = scenario.snapshot();
  const approved = scenario.manager.readCurrentSpecReview({ specId: scenario.specId, consumerNodeId: "approval" });
  assert.ok(approved);
  assert.ok(approved.review.identity.equals(identity));
  assert.equal(approved.descriptor.hash, original.descriptor.hash);
  const snapshot = scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "spec.snapshot",
    parameters: { revision: identity.revision.toString() }, consumerNodeId: "approval" });
  assert.equal(digest(snapshot.bytes), identity.digest);
  assert.equal(snapshot.bytes.length, identity.byteLength);
  assert.equal(scenario.manager.readCurrentSpecReview({ specId: scenario.specId, consumerNodeId: "spec-review" }), null,
    "ordinary readers cannot treat the approved historical basis as a review of later metadata bytes");
  assert.deepEqual(scenario.snapshot(), before, "retained approved-basis reads have no state, Activity or catalog effects");

  for (const kind of ["missing genuine receipt", "foreign approval Flow", "stale immutable snapshot", "foreign review owner"]) {
    await t.test(kind, () => {
      const clone = new SeedWorkRoot(scenario.root, { prefix: "sennel-approved-review-refusal-" });
      t.after(() => clone.cleanup());
      const manager = new FlowManager({ root: clone.root, mainRoot: clone.root, inWorktree: false, specId: scenario.specId });
      const location = manager.specLocation(scenario.specId);
      const flowFile = location.artifact("flow.state");
      const catalogFile = location.catalogFile;
      const catalog = JSON.parse(fs.readFileSync(catalogFile));
      const replaceArtifact = (relativePath, bytes) => {
        fs.writeFileSync(path.join(location.directory, relativePath), bytes);
        const descriptor = catalog.artifacts.find((entry) => entry.relativePath === relativePath);
        assert.ok(descriptor);
        descriptor.hash = digest(bytes); descriptor.size = bytes.length;
      };
      if (kind === "missing genuine receipt" || kind === "foreign approval Flow") {
        const state = JSON.parse(fs.readFileSync(flowFile));
        const activities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n").map(JSON.parse);
        const source = node(state, "approval");
        const receiptId = source.result.draftSettlementReceipt.id;
        const owner = activities.find((entry) => entry.result?.draftSettlementReceipt?.id === receiptId);
        assert.ok(owner);
        for (const result of [source.result, owner.result]) {
          if (kind === "missing genuine receipt") {
            delete result.stepResult; delete result.draftSettlementReceipt;
          } else {
            result.stepResult.evidence.runId = "foreign-approval-run";
            const receipt = result.draftSettlementReceipt;
            receipt.binding.runId = "foreign-approval-run";
            receipt.resultDigest = stepResultDigest(StepResult.fromStored("approval", result.stepResult));
            const { id, ...content } = receipt;
            receipt.id = digest(JSON.stringify(content));
          }
        }
        replaceArtifact("flow.json", jsonBytes(state));
        replaceArtifact("activities.jsonl", Buffer.from(`${activities.map((entry) => JSON.stringify(entry)).join("\n")}\n`));
      } else if (kind === "stale immutable snapshot") {
        const document = JSON.parse(snapshot.bytes);
        document.requirements[0].desc += " changed after its actual Approval";
        replaceArtifact(snapshot.descriptor.relativePath, jsonBytes(document));
      } else {
        const descriptor = catalog.artifacts.find((entry) => entry.relativePath === approved.descriptor.relativePath);
        descriptor.activityId = "foreign-review-publication";
      }
      const serializedCatalog = new FlowArtifactCatalog(catalog).toJSON();
      const verifiedCatalog = FlowArtifactCatalog.fromSerialized(serializedCatalog);
      for (const descriptor of verifiedCatalog.artifacts) {
        descriptor.verifyBytes(fs.readFileSync(location.resolve(descriptor.relativePath)));
      }
      fs.writeFileSync(catalogFile, jsonBytes(serializedCatalog));
      const captured = [flowFile, location.activitiesFile, catalogFile].map((file) => fs.readFileSync(file));
      const expected = {
        "missing genuine receipt": /completed Approval review requires its genuine confirmed Result and receipt/,
        "foreign approval Flow": {
          name: "CurrentFlowStateConflictError",
          message: /^Activity journal cannot reproduce flow state: Draft settlement receipt binding is stale$/,
        },
        "stale immutable snapshot": /canonical Spec review does not match its revision snapshot/,
        "foreign review owner": {
          name: "Error",
          message: /^cataloged artifact references a missing Activity: foreign-review-publication$/,
        },
      }[kind];
      assert.throws(() => manager.readCurrentSpecReview({ specId: scenario.specId, consumerNodeId: "approval" }), expected);
      [flowFile, location.activitiesFile, catalogFile].forEach((file, index) =>
        assert.deepEqual(fs.readFileSync(file), captured[index], `${kind} readback refusal cannot mutate canonical evidence`));
    });
  }
});
