import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ExternalBlockedOutcome, StepAttempt } from "../../../src/flow/lib/step-outcome.js";
import { SingleUserActionDirective } from "../../../src/flow/lib/next-action-directive.js";
import { coreCommandRegistry } from "../../../src/lib/command-registry.js";
import { Envelope } from "../../../src/lib/flow-envelope.js";
import {
  assertFlowStopGuidanceAdapters,
  deriveFlowStopGuidanceInventory,
} from "../../support/infrastructure/flow-stop-guidance-inventory.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const INVENTORY_PATH = path.join(ROOT, "docs/design/flow-stop-guidance/routes.json");

function leafPaths(definition, prefix = [], output = []) {
  const parts = [...prefix, definition.name];
  if (definition.command) output.push(parts.join(" "));
  else for (const child of definition.subcommands.values()) leafPaths(child, parts, output);
  return output;
}

test("Flow stop guidance inventory exhausts registered routes, codes, and output adapters", () => {
  const current = deriveFlowStopGuidanceInventory();
  const recorded = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));
  const registeredLeaves = leafPaths(coreCommandRegistry.find(["flow"]));
  assert.deepEqual(current.routes.map((route) => route.path), registeredLeaves.sort((left, right) => left.localeCompare(right)),
    "inventory derivation must account for every production Flow registry leaf");
  assert.ok(current.routes.some((route) => route.path === "flow query" && route.adapter === "query-wire"),
    "independent flow query route must be inventoried");
  assert.ok(current.routes.some((route) => route.path === "flow prepare" && route.adapter === "dispatcher-envelope"));
  assert.ok(current.routes.some((route) => route.path === "flow resume" && route.adapter === "dispatcher-envelope"));
  assertFlowStopGuidanceAdapters(current);
  const selected = new SingleUserActionDirective({ actionId: "REQUEST_FLOW_DIAGNOSTIC_REPAIR",
    instruction: "Give the recorded diagnostic code to the maintainer.",
    reason: "The selected Flow action requires external repair." });
  const stepAttempt = new StepAttempt({ runId: "inventory-run", stepId: "review", attempt: 1,
    outcome: new ExternalBlockedOutcome({ reason: "A durable step is blocked.",
      resumeInstruction: "Wait for the selected diagnostic repair." }) });
  const envelope = Envelope.fail("run", "dispatch", "FLOW_DISPATCH_BLOCKED", "The dispatcher stopped.", {
    dispatch: { boundary: "blocked" },
    nextAction: { directive: selected.toJSON() },
    stepAttempt: stepAttempt.toJSON(),
  }).attachStopGuidance();
  assert.deepEqual(envelope.data.directive.toJSON(), selected.toJSON(),
    "nested nextAction.directive is the selected authority, even when dispatch.boundary is blocked");
  assert.equal(envelope.guidance.directive, envelope.data.directive,
    "guidance and the envelope share exactly one directive authority");
  assert.deepEqual(envelope.data.stepAttempt, stepAttempt.toJSON(),
    "durable StepAttempt evidence remains available without becoming a second routing authority");
  assert.equal(envelope.guidance.nextAction.kind, "external_work",
    "presentation describes the nested selected action rather than inferring recovery from boundary metadata");
  assert.deepEqual(recorded, current,
    `Flow stop guidance inventory is stale. Current source-derived inventory:\n${JSON.stringify(current, null, 2)}`);
});
