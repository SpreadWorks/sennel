import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { PromptRequestLimit, PromptReferenceElement } from "../../src/lib/prompt-batching.js";
import { SpecGateRepairSource } from "../../src/flow/lib/spec-gate-repair-values.js";
import { SpecGateRepairBundle } from "../../src/flow/lib/spec-gate-repair-bundle.js";

const revision = `sha256:${"a".repeat(64)}`;
const rule = { id: "planned-check", title: "Planned checks", body: "State a check and its passing condition. Exception: a justified non-testable item needs no executable check." };
const target = (id = "R1", field = "desc") => ({ entity: "requirement", id, field });
function finding(id, targets = [target()]) {
  return { identity: { sourceArtifact: "gate/result.json", sourceStep: "spec-gate", sourceFindingId: id, fingerprint: id.charCodeAt(0).toString(16).padEnd(64, "0") },
    requirementRef: rule.id, observed: `Missing planned passing condition ${id}`, targets,
    allowedTargets: targets.map((entry) => ({ target: entry, operationKinds: ["edit-text-field"] })) };
}
function spec() {
  return { goal: "A small planned change", background: "UNRELATED_BACKGROUND",
    scope: { in: [], out: [] }, constraints: [], design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [{ text: "Keep planned checks separate from executed evidence." }] },
    requirements: [
      { id: "R1", desc: "Check one", task_ids: ["T1"], testable: true, preimplementation_test_expectation: "fail" },
      { id: "R2", desc: "Check two", task_ids: ["T2"], testable: true, preimplementation_test_expectation: "fail" },
    ],
    tasks: [{ id: "T1", title: "One", goal: "Implement one" }, { id: "T2", title: "Two", goal: "UNRELATED_TASK" }],
    acceptance_criteria: [], clarifications: [], alternatives_considered: [], open_questions: [], keywords: [], implementationTargets: [] };
}
function context(findings, document = spec()) {
  return new SpecGateRepairContext({ spec: document, baseRevision: revision, findings,
    guardrails: [rule], acknowledgedRationale: "Justification alone does not grant an exception." });
}

test("existing decisions are read-only evidence in every repair unit and cannot become edit locations", () => {
  const source = new SpecGateRepairSource({ id: "issue", origin: "issue.md", revision: "approved-request",
    content: "The confirmed request includes shared consumers in regression coverage." });
  const ctx = new SpecGateRepairContext({ spec: spec(), baseRevision: revision,
    findings: [finding("F1"), finding("F2", [target("R2")])], guardrails: [rule], sources: [source] });
  for (const unit of ctx.units()) {
    const range = ctx.select(unit.id).ranges.find((entry) => entry.id === source.id);
    assert.equal(range.writable, false);
    assert.equal(range.target, null);
    assert.equal(range.value.content, source.content);
    assert.equal(range.value.revision, source.revision);
    assert.equal(range.digest, source.digest);
  }
  const unresolved = { ...finding("F3", []), where: { file: "spec.json", locator: "unlocated decision" } };
  const location = new SpecGateRepairContext({ spec: spec(), baseRevision: revision,
    findings: [unresolved], guardrails: [rule], sources: [source] });
  assert.throws(() => location.resolveLocations({ baseRevision: revision,
    locations: [{ identity: unresolved.identity, rangeIds: [source.id] }] }), /not a Spec finding location/);
  const resolved = location.resolveLocations({ baseRevision: revision,
    locations: [{ identity: unresolved.identity, rangeIds: ["requirements[R1].desc"] }] });
  assert.equal(resolved.evidenceDigest, location.evidenceDigest);
  assert(resolved.select(resolved.units()[0].id).ranges.some((entry) => entry.id === source.id));
});

test("repair evidence binds merged rule content and regular expression semantics across location resolution", () => {
  const unresolved = { ...finding("F1", []), where: { locator: "an unresolved target" } };
  const withRule = (body, lint) => new SpecGateRepairContext({
    spec: spec(), baseRevision: revision, findings: [unresolved], sources: [],
    guardrails: [{ ...rule, body, meta: { lint } }],
  });
  const original = withRule(rule.body, /planned/i);
  const changedBody = withRule("Require the precise planned check.", /planned/i);
  const changedLint = withRule(rule.body, /planned/);
  assert.notEqual(original.evidenceDigest, changedBody.evidenceDigest);
  assert.notEqual(original.evidenceDigest, changedLint.evidenceDigest);
  const resolved = original.resolveLocations({ baseRevision: revision,
    locations: [{ identity: unresolved.identity, rangeIds: ["requirements[R1].desc"] }] });
  assert.equal(resolved.evidenceDigest, original.evidenceDigest);
});

test("repair selection includes linked task and decisions but excludes unrelated body", () => {
  const ctx = context([finding("F1")]);
  const selection = ctx.select(ctx.units()[0].id).toJSON();
  assert.equal(selection.baseRevision, revision);
  assert.deepEqual(selection.guardrails, [rule]);
  assert.deepEqual(selection.unit.findings[0].identity, finding("F1").identity);
  assert(selection.ranges.some((range) => range.id === "tasks[T1].goal" && range.writable === false));
  assert(selection.ranges.some((range) => range.id === "requirements[R1].desc" && range.writable === true));
  assert(selection.ranges.some((range) => range.id === "overview.decisions[0]"));
  assert(!JSON.stringify(selection).includes("UNRELATED_BACKGROUND"));
  assert(!JSON.stringify(selection).includes("UNRELATED_TASK"));
});

test("shared locations and one finding spanning locations form a single atomic repair unit", () => {
  const ctx = context([finding("F1"), finding("F2", [target(), target("R2")]), finding("F3", [target("R2")])]);
  assert.equal(ctx.units().length, 1);
  assert.equal(ctx.units()[0].findings.length, 3);
  assert.deepEqual(ctx.units()[0].rangeIds, ["requirements[R1].desc", "requirements[R2].desc"]);
  const batch = ctx.referencePlan().batches;
  assert.equal(batch.length, 1);
  assert.equal(batch[0].elements.length, 1);
  assert.equal(batch[0].elements[0].id, ctx.units()[0].id);
});

test("independent units share a bounded call and preserve order-independent identities", () => {
  const a = finding("F1"); const b = finding("F2", [target("R2")]);
  const first = context([a, b]); const second = context([b, a]);
  assert.equal(first.units().length, 2);
  assert.deepEqual(first.units().map((unit) => unit.id), second.units().map((unit) => unit.id));
  assert.equal(first.referencePlan().batches.length, 1);
  assert.equal(first.referencePlan().batches[0].elements.length, 2);
});

test("free text is unresolved until a version-bound canonical location response is validated", () => {
  const source = { ...finding("F1", []), where: { file: "spec.json", locator: "the first requirement" } };
  const ctx = context([source]);
  assert.equal(ctx.unresolvedFindings().length, 1);
  assert.throws(() => ctx.units(), /unresolved/);
  const response = { baseRevision: revision, locations: [{ identity: source.identity, rangeIds: ["requirements[R1].desc"] }] };
  const resolved = ctx.resolveLocations(response);
  assert.equal(resolved.unresolvedFindings().length, 0);
  assert.equal(resolved.select(resolved.units()[0].id).ranges.find((range) => range.id === "requirements[R1].desc").writable, false);
  assert.throws(() => ctx.resolveLocations({ ...response, baseRevision: `sha256:${"b".repeat(64)}` }), /Stale/);
  assert.throws(() => ctx.resolveLocations({ ...response, locations: [] }), /omitted/);
  assert.throws(() => ctx.resolveLocations({ ...response, locations: [{ ...response.locations[0], rangeIds: ["requirements[R99].desc"] }] }), /foreign/);
  assert.throws(() => ctx.resolveLocations({ ...response, locations: [response.locations[0], response.locations[0]] }), /duplicate/);
});

test("ordinal Gate locations resolve to the frozen entity range without granting edit authority", () => {
  const findings = ["requirements[R2].desc", "$.requirements[1].desc", "requirements[1].desc",
    "$.requirements[9].desc", "$.requirements[1].missing", "the second requirement"].map((locator, index) => ({
    ...finding(`F${index + 1}`, []), where: { locator },
  }));
  const ctx = context(findings);
  assert.deepEqual(ctx.unresolvedFindings().map((entry) => entry.where.locator), [
    "$.requirements[9].desc", "$.requirements[1].missing", "the second requirement",
  ]);
  const ranges = ctx.tableOfContents();
  const canonical = ranges.find((entry) => entry.id === "requirements[R2].desc");
  assert(canonical);
  const resolved = findings.slice(0, 3).map((entry) => {
    const selected = context([entry]);
    return selected.select(selected.units()[0].id).toJSON();
  });
  for (const selection of resolved) {
    assert.deepEqual(selection.unit.rangeIds, [canonical.id]);
    assert.equal(selection.ranges.find((range) => range.id === canonical.id).writable, false);
  }
});

test("additional context is canonical and read-only without minting edit authority", () => {
  const ctx = context([finding("F1")]);
  const unit = ctx.units()[0];
  const selected = ctx.select(unit.id, { additionalRangeIds: ["background"] }).toJSON();
  assert(selected.ranges.some((range) => range.id === "background" && range.value === "UNRELATED_BACKGROUND" && !range.writable));
  assert.throws(() => ctx.select(unit.id, { additionalRangeIds: ["background", "background"] }), /duplicated/);
  assert.throws(() => ctx.select(unit.id, { additionalRangeIds: ["unknown"] }), /foreign/);
});

test("explicit coupled permissions select every authorized field as one writable unit", () => {
  const item = finding("F1");
  item.allowedTargets.push({ target: target("R1", "testable"), operationKinds: ["replace-entity-field"] });
  const ctx = context([item, finding("F2", [target("R1", "testable")])]);
  assert.equal(ctx.units().length, 1);
  const selection = ctx.select(ctx.units()[0].id).toJSON();
  assert(selection.ranges.some((range) => range.id === "requirements[R1].testable" && range.writable));
});

test("collection anchors disclose omitted content and missing fields disclose actual absence", () => {
  const document = spec();
  document.constraints = ["Do not remove this constraint"];
  const ctx = context([finding("F1", [{ collection: "constraints" }])], document);
  const ranges = ctx.select(ctx.units()[0].id).toJSON().ranges;
  const anchor = ranges.find((range) => range.id === "constraints");
  assert.equal(anchor.collectionAnchor, true);
  assert.equal(anchor.digest, null);
  assert.deepEqual(anchor.value, { itemCount: 1, contentOmitted: true });
  assert(ctx.tableOfContents().some((range) => range.id === "requirements[R1].priority" && range.exists === false));
});

test("whole-document findings select canonical context while preserving explicit field permissions", () => {
  const source = finding("F1");
  source.targets = [{ document: "spec" }];
  const ctx = context([source]);
  assert.equal(ctx.unresolvedFindings().length, 0);
  const selected = ctx.select(ctx.units()[0].id).toJSON();
  assert.deepEqual(selected.unit.rangeIds, ctx.tableOfContents().map(({ id }) => id).sort());
  assert.deepEqual(selected.ranges.filter(({ writable }) => writable).map(({ target }) => target), [target()]);
  assert.equal(selected.ranges.find(({ id }) => id === "background").value, "UNRELATED_BACKGROUND");
  assert.equal(selected.ranges.find(({ id }) => id === "tasks[T2].goal").writable, false);
});

test("immutable file references pack complete oversized atomic units without body fragments", () => {
  const document = spec();
  document.requirements[0].desc = "日本語の完全な確認条件。".repeat(9000);
  const ctx = context([finding("F1")], document);
  const selection = ctx.select(ctx.units()[0].id).toJSON();
  const plan = ctx.referencePlan({ limit: new PromptRequestLimit({ maxCharacters: 10000 }) });
  assert.equal(plan.batches.length, 1);
  const [element] = plan.batches[0].payloadElements;
  assert(element instanceof PromptReferenceElement);
  assert.equal(element.id, selection.unit.id);
  assert.equal(element.byteLength, Buffer.byteLength(JSON.stringify(selection), "utf8"));
  assert.equal(element.coverageEntries()[0].status, "reference");
  assert(!plan.batches[0].request.userPrompt.includes(document.requirements[0].desc));
  assert.equal(ctx.select(element.id).ranges.find((range) => range.writable).value, document.requirements[0].desc);
});

test("file packing measures exact UTF-8 JSON and actual metadata independently of reference instructions", () => {
  const document = spec();
  document.requirements = Array.from({ length: 10 }, (_, index) => ({
    id: `R${index + 1}`, desc: `Whole \"漢🧭\"\nunit ${index}`, task_ids: [], testable: false,
  }));
  document.tasks = [];
  const findings = document.requirements.map((requirement, index) => finding(`F${index}`, [target(requirement.id)]));
  let ctx = context(findings, document);
  const selectedUnit = ctx.units().find((unit) => unit.rangeIds.includes("requirements[R1].desc"));
  const single = ctx.referencePlan({ unitIds: [selectedUnit.id] });
  const initialBytes = Buffer.byteLength(JSON.stringify(ctx.referenceDocument(single.batches[0])));
  document.requirements[0].desc += "a".repeat(2 * 1024 * 1024 - initialBytes);
  ctx = context(findings, document);
  const plan = ctx.referencePlan({ limit: new PromptRequestLimit({ maxCharacters: 10000 }) });
  assert.ok(plan.batches.length > 1);
  const documents = plan.batches.map((batch) => ctx.referenceDocument(batch));
  const sizes = documents.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
  assert.equal(Math.max(...sizes), 2 * 1024 * 1024);
  const selections = documents.flatMap((entry) => SpecGateRepairBundle.fromJSON(entry.bundle).selections());
  assert.equal(selections.length, 10);
  assert.ok(plan.batches.every((batch) => batch.footprint.total <= 10000));
  for (const selection of selections) {
    assert.deepEqual(selection, ctx.select(selection.unit.id).toJSON());
  }
  document.requirements[0].desc += "a";
  assert.throws(() => context(findings, document).referencePlan(),
    { code: "FLOW_SPEC_GATE_REPAIR_INPUT_TOO_LARGE" });
});

test("additional context participates in complete file packing without granting edit permission", () => {
  const document = spec();
  document.background = "漢\"\n🧭".repeat(160000);
  const ctx = context([finding("F1"), finding("F2", [target("R2")])], document);
  const additionalRanges = Object.fromEntries(ctx.units().map((unit) => [unit.id, ["background"]]));
  assert.equal(ctx.referencePlan().batches.length, 1);
  const plan = ctx.referencePlan({ additionalRanges });
  // One shared full range permits both units in the same immutable input file.
  assert.equal(plan.batches.length, 1);
  for (const batch of plan.batches) {
    const input = ctx.referenceDocument(batch);
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 2 * 1024 * 1024);
    const selections = SpecGateRepairBundle.fromJSON(input.bundle).selections();
    assert.equal(selections.length, 2);
    for (const selection of selections) {
      const range = selection.ranges.find((entry) => entry.id === "background");
      assert.equal(range.value, document.background);
      assert.equal(range.writable, false);
    }
    assert.equal(input.bundle.ranges.filter((entry) => entry.id === "background").length, 1);
  }
});

test("missing canonical rule and forged finding identity fail before a repair request", () => {
  assert.throws(() => new SpecGateRepairContext({ spec: spec(), baseRevision: revision, findings: [finding("F1")], guardrails: [] }), /guardrail body/);
  assert.throws(() => context([{ ...finding("F1"), identity: { ...finding("F1").identity, fingerprint: "wrong" } }]), /fingerprint/);
});

test("large location indexes have exact bounded coverage before resolving a finding", () => {
  const document = spec();
  document.requirements.push(...Array.from({ length: 60 }, (_, index) => ({
    id: `R${index + 3}`, desc: "Unrelated text", task_ids: ["T2"], testable: true,
    preimplementation_test_expectation: "fail",
  })));
  const source = { ...finding("F1", []), where: { locator: "the first requirement" } };
  const ctx = context([source], document);
  const plan = ctx.locationPlan({ limit: new PromptRequestLimit({ maxCharacters: 8000 }) });
  assert(plan.batches.length > 1);
  const searched = plan.batches.flatMap((batch) => batch.payloadElements.map((entry) => JSON.parse(entry.toPromptText()).id));
  assert.deepEqual(searched.sort(), ctx.tableOfContents().map((entry) => entry.id).sort());
  assert(plan.batches.every((batch) => batch.footprint.total <= 8000));
  const responses = plan.batches.map((batch) => ({ batchDigest: batch.digest, baseRevision: revision,
    locations: [{ identity: source.identity, rangeIds: batch.payloadElements.some((entry) =>
      JSON.parse(entry.toPromptText()).id === "requirements[R1].desc") ? ["requirements[R1].desc"] : [] }] }));
  assert.equal(ctx.resolveLocationBatches({ plan, responses }).unresolvedFindings().length, 0);
  assert.throws(() => ctx.resolveLocationBatches({ plan, responses: responses.slice(1) }), /every planned batch/);
  assert.throws(() => ctx.resolveLocationBatches({ plan, responses: responses.map((response, index) => index ? response : {
    ...response, locations: [{ identity: source.identity, rangeIds: [searched.at(-1)] }],
  }) }), /unsearched/);
  const unresolved = ctx.resolveLocationBatches({ plan, responses: responses.map((response) => ({ ...response,
    locations: [{ identity: source.identity, rangeIds: [] }] })) });
  assert.equal(unresolved.unresolvedFindings().length, 1);
});
