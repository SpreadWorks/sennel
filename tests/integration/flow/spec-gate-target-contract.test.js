import assert from "node:assert/strict";
import { test } from "node:test";
import { Observation } from "../../../src/flow/lib/observation.js";
import { buildGuardrailArticleEvalPrompt, parseGuardrailArticleEvaluation } from "../../../src/flow/lib/run-gate.js";
import { SpecGateTargetSelection } from "../../../src/flow/lib/spec-gate-targets.js";
import { specRepairTargetEntries } from "../../../src/flow/lib/spec-repair-operations.js";
import { adaptJsonSchemaForProvider } from "../../../src/lib/provider-schema.js";
import { PlanGateRepairObservation } from "../../../src/flow/lib/plan-gate-repair.js";

const specRevision = `sha256:${"a".repeat(64)}`;
const requirement = { entity: "requirement", id: "R10", field: "desc" };
const task = { entity: "task", id: "T1", field: "goal" };
const missingOptional = { entity: "task", id: "T1", field: "acceptance" };
const collection = { collection: "constraints" };
const firstConstraint = { collection: "constraints", position: 0 };
const secondConstraint = { collection: "constraints", position: 1 };
const document = { document: "spec" };
const permission = (target, ...operationKinds) => ({ target, operationKinds });

function spec() {
  return {
    goal: "Define a reliable CLI", background: "The current gate reports unclear requirements.",
    requirements: [{ id: "R10", desc: "Check representative input dimensions.", task_ids: ["T1"] }],
    tasks: [{ id: "T1", title: "Cover the CLI", goal: "Test the command." }],
    constraints: ["Keep the test deterministic.", "Keep errors actionable."],
  };
}

function response(targets, allowedTargets, where = { file: "spec.json", locator: "requirements.R10.desc" }) {
  return JSON.stringify({ observations: [{ failureMode: "guardrail-violation",
    requirementRef: "unambiguous-requirements", where,
    observed: "The selected dimensions are undefined.", targets, allowedTargets }] });
}

function parse(raw, canonicalSpec = spec()) {
  return parseGuardrailArticleEvaluation(raw, ["unambiguous-requirements"],
    { spec: canonicalSpec, specRevision });
}

// Evaluate the ordinary JSON Schema constraints used by the provider-facing
// response. This catches an object enum that becomes impossible when the Codex
// adapter closes an object with no declared properties.
function schemaAccepts(schema, value) {
  if (schema.anyOf && !schema.anyOf.some((branch) => schemaAccepts(branch, value))) return false;
  if (Object.hasOwn(schema, "const") && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (schema.enum && !schema.enum.some((choice) => JSON.stringify(choice) === JSON.stringify(value))) return false;
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !allowedTypes.includes(type)
    && !(type === "number" && Number.isInteger(value) && allowedTypes.includes("integer"))) return false;
  if (type === "object") {
    const properties = schema.properties ?? {};
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    return Object.entries(value).every(([key, item]) => !properties[key] || schemaAccepts(properties[key], item));
  }
  if (type === "array") {
    if (schema.minItems != null && value.length < schema.minItems) return false;
    return value.every((item) => !schema.items || schemaAccepts(schema.items, item));
  }
  return true;
}

test("Spec Gate prompt offers canonical repair locations and R10 response survives Observation JSON readback", () => {
  const canonicalSpec = spec();
  const built = buildGuardrailArticleEvalPrompt(JSON.stringify(canonicalSpec), [
    { id: "unambiguous-requirements", title: "Clear requirements", body: "State the selected dimensions." },
  ], "spec", null, [], { specTargetScope: { spec: canonicalSpec, specRevision } }).build();
  const fields = built.jsonSchema.properties.observations.items;
  const inventory = specRepairTargetEntries(canonicalSpec).map((entry) => entry.target.toJSON());
  assert(fields.required.includes("targets"));
  assert(fields.required.includes("allowedTargets"));
  assert.match(built.fmtFallback, /allowedTargets/);

  const providerSchema = adaptJsonSchemaForProvider("codex", built.jsonSchema);
  for (const target of [document, requirement, task, missingOptional, collection, firstConstraint, secondConstraint]) {
    const operationKinds = target === document ? [permission(requirement, "edit-text-field")]
      : [permission(target, target === missingOptional ? "add-entity-field"
        : target === collection ? "add-array-element"
          : target === firstConstraint || target === secondConstraint ? "replace-array-element" : "edit-text-field")];
    assert(schemaAccepts(providerSchema, JSON.parse(response([target], operationKinds))),
      `Codex schema must represent ${JSON.stringify(target)}`);
  }
  for (const [target, operationKind] of [
    [requirement, "add-entity-field"],
    [missingOptional, "edit-text-field"],
    [collection, "edit-text-field"],
    [firstConstraint, "add-array-element"],
  ]) {
    assert(!schemaAccepts(providerSchema, JSON.parse(response([target], [permission(target, operationKind)]))),
      `Codex schema must exclude ${operationKind} for ${JSON.stringify(target)}`);
  }
  assert(inventory.some((target) => JSON.stringify(target) === JSON.stringify(requirement)));

  const [parsed] = parse(response([requirement], [permission(requirement, "edit-text-field")]), canonicalSpec);
  assert.deepEqual(parsed.targets, [requirement]);
  assert.deepEqual(parsed.allowedTargets, [permission(requirement, "edit-text-field")]);
  assert.equal(parsed.specRevision, specRevision);
  assert.deepEqual(Observation.fromJSON(JSON.parse(JSON.stringify(parsed))).toJSON(), parsed);
});

test("Spec Gate accepts distinct locations, missing optional fields, and collection additions with explicit operations", () => {
  const targets = [requirement, task, missingOptional, collection, firstConstraint, secondConstraint];
  const allowedTargets = [
    permission(requirement, "edit-text-field"),
    permission(task, "replace-entity-field"),
    permission(missingOptional, "add-entity-field"),
    permission(collection, "add-array-element"),
    permission(firstConstraint, "replace-array-element"),
    permission(secondConstraint, "replace-array-element"),
  ];
  const [parsed] = parse(response(targets, allowedTargets));
  assert.deepEqual(parsed.targets, targets);
  assert.deepEqual(parsed.allowedTargets, allowedTargets);
  assert.deepEqual(Observation.fromJSON(JSON.parse(JSON.stringify(parsed))).toJSON(), parsed);
});

test("whole-document location carries context while only explicit allowedTargets grant edit authority", () => {
  const [parsed] = parse(response([document], [permission(requirement, "edit-text-field")],
    { file: "spec.json", locator: null }));
  assert.deepEqual(parsed.targets, [document]);
  assert.deepEqual(parsed.allowedTargets, [permission(requirement, "edit-text-field")]);
  assert.deepEqual(Observation.fromJSON(JSON.parse(JSON.stringify(parsed))).toJSON(), parsed);
  assert.throws(() => parse(response([document], [])), /allowedTargets/);
  assert.throws(() => parse(response([document], [permission({ entity: "spec", field: "unknown" }, "replace-field")])),
    /replaceable spec field/);
});

test("Spec Gate rejects absent, unknown, duplicate, and impossible target selections at response boundary", () => {
  const baseline = permission(requirement, "edit-text-field");
  const invalid = [
    [response([], [baseline]), /targets/],
    [response([requirement], []), /allowedTargets/],
    [JSON.stringify({ observations: [{ failureMode: "guardrail-violation",
      requirementRef: "unambiguous-requirements", where: { file: "spec.json", locator: "requirements.R10.desc" },
      observed: "The selected dimensions are undefined." }] }), /targets/],
    [response([{ entity: "requirement", id: "R11", field: "desc" }], [baseline]), /absent|ambiguous/],
    [response([{ entity: "requirement", id: "R10", field: "unknown" }], [baseline]), /invalid/],
    [response([{ ...requirement, extra: true }], [baseline]), /unknown|invalid/],
    [response([requirement, requirement], [baseline]), /duplicate/],
    [response([document, requirement], [baseline]), /ambiguous|document/],
    [response([requirement], [baseline, baseline]), /duplicate/],
    [response([requirement], [permission(task, "edit-text-field")]), /among its targets/],
    [response([requirement], [permission(requirement, "add-array-element")]), /incompatible|unauthorized/],
    [response([requirement], [permission(requirement, "delete-entity-field")]), /incompatible/],
    [response([missingOptional], [permission(missingOptional, "edit-text-field")]), /impossible/],
    [response([missingOptional], [permission(missingOptional, "replace-entity-field")]), /impossible/],
    [response([missingOptional], [permission(missingOptional, "delete-entity-field")]), /impossible/],
  ];
  for (const [raw, expected] of invalid) assert.throws(() => parse(raw), expected);
});

test("Spec Gate accepts only structured AI fields and requires a concrete observations array", () => {
  assert.throws(() => parse(JSON.stringify({ observations: null })), /observations/);
  assert.throws(() => parse(JSON.stringify({ observations: [], evaluations: [] })), /only.*observations|unknown/);
  const wrongMode = JSON.parse(response([requirement], [permission(requirement, "edit-text-field")]));
  wrongMode.observations[0].failureMode = "spec-impl-mismatch";
  assert.throws(() => parse(JSON.stringify(wrongMode)), /failureMode|guardrail-violation/);
  const wrongFile = JSON.parse(response([requirement], [permission(requirement, "edit-text-field")]));
  wrongFile.observations[0].where.file = "other.json";
  assert.throws(() => parse(JSON.stringify(wrongFile)), /spec\.json|where\.file/);
  const aiRevision = JSON.parse(response([requirement], [permission(requirement, "edit-text-field")]));
  aiRevision.observations[0].specRevision = specRevision;
  assert.throws(() => parse(JSON.stringify(aiRevision)), /unknown property/);
});

test("Spec recurrence fingerprint follows typed targets and permissions, not display locator or revision", () => {
  const selected = [requirement, task];
  const permitted = [permission(requirement, "edit-text-field"), permission(task, "edit-text-field")];
  const observation = (targets, allowedTargets, locator, revision = specRevision) => {
    const [parsed] = parse(response(targets, allowedTargets,
      { file: "spec.json", locator }));
    return new PlanGateRepairObservation({ ...parsed, phase: "spec", scope: "flow", specRevision: revision });
  };
  const original = observation(selected, permitted, "requirements.R10.desc");
  const reordered = observation([...selected].reverse(), [...permitted].reverse(), "a display-only location");
  const changedTarget = observation([requirement], [permitted[0]], "requirements.R10.desc");
  const revised = observation(selected, permitted, "requirements.R10.desc", `sha256:${"b".repeat(64)}`);
  assert.equal(reordered.fingerprint.toString(), original.fingerprint.toString());
  assert.notEqual(changedTarget.fingerprint.toString(), original.fingerprint.toString());
  assert.equal(revised.fingerprint.toString(), original.fingerprint.toString());
  assert.equal(new PlanGateRepairObservation({ ...JSON.parse(JSON.stringify(revised.toJSON())),
    phase: "spec", scope: "flow" }).specRevision,
    revised.specRevision);
});

test("duplicate Spec IDs make a location ambiguous and a missing canonical revision cannot authorize it", () => {
  const duplicate = spec();
  duplicate.requirements.push({ id: "R10", desc: "A second R10." });
  assert.throws(() => parse(response([requirement], [permission(requirement, "edit-text-field")]), duplicate),
    /ambiguous/);
  assert.throws(() => new SpecGateTargetSelection({ targets: [requirement],
    allowedTargets: [permission(requirement, "edit-text-field")], spec: spec(), specRevision: "sha256:stale" }),
  /canonical revision/);
});
