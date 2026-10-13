import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordedRepairChange, FLOW_QUERY_REPAIR_CHANGE_SCHEMA } from "../../src/flow/query-repair-change.js";
import { SpecRepairIdEntityFieldReplace, SpecRepairTextFieldEdit, SpecRepairTextEdit,
  SpecRepairArrayDelete, SpecGateRepairIdEntityFieldDelete } from "../../src/flow/lib/spec-repair-operations.js";
import { validateSchema } from "../../src/lib/schema-validate.js";
import { FLOW_QUERY_RESPONSE_SCHEMA } from "../../src/flow/query-contract.js";

const fields = { findingIds: ["F-private"], target: { entity: "task", id: "T-1", field: "acceptance" },
  expectedDigest: "a".repeat(64), reason: "Adopt the saved correction." };
function replace(replacement) {
  return new SpecRepairIdEntityFieldReplace({ ...fields, kind: "replace-entity-field", replacement }, 0);
}
function edit() {
  // Offsets address A and B in the immutable UTF-8 text あAいB.
  const first = Buffer.byteLength("あ");
  const second = Buffer.byteLength("あAい");
  return new SpecRepairTextFieldEdit({ ...fields, kind: "edit-text-field", edits: [
    { startByte: first, endByte: first + 1, replacement: "仕様" },
    { startByte: second, endByte: second + 1, replacement: "" },
  ] }, 0);
}

test("recorded repair replacement preserves exact string, structured JSON and explicit null values", () => {
  for (const replacement of ["A concrete saved replacement.",
    { requirements: [{ title: "確認", enabled: false }], alternatives: [null, 4] }, null]) {
    const operation = replace(replacement);
    const change = new RecordedRepairChange(operation);
    assert.equal(Object.isFrozen(change), true);
    assert.deepEqual(change.toJSON(), { replacement, edits: null });
    assert.deepEqual(validateSchema(change.toJSON(), FLOW_QUERY_REPAIR_CHANGE_SCHEMA), []);
  }
});

test("recorded UTF-8 edits preserve existing typed byte intervals, replacements and order", () => {
  const operation = edit();
  assert.equal(operation.edits.every((value) => value instanceof SpecRepairTextEdit), true);
  const recorded = new RecordedRepairChange(operation).toJSON();
  assert.deepEqual(recorded, { replacement: null, edits: [
    { startByte: 3, endByte: 4, replacement: "仕様" },
    { startByte: 7, endByte: 8, replacement: "" },
  ] });
  assert.deepEqual(recorded.edits, operation.edits.map((value) => value.toJSON()));
  assert.deepEqual(validateSchema(recorded, FLOW_QUERY_REPAIR_CHANGE_SCHEMA), []);
});

test("recorded deletion leaves replacement and edits absent as explicit nulls", () => {
  const operations = [
    new SpecRepairArrayDelete({ ...fields, kind: "delete-array-element", target: { collection: "constraints", position: 0 } }, 0),
    new SpecGateRepairIdEntityFieldDelete({ ...fields, kind: "delete-entity-field",
      target: { entity: "task", id: "T-1", field: "implementation_notes" } }, 0),
  ];
  for (const operation of operations) {
    const recorded = new RecordedRepairChange(operation).toJSON();
    assert.deepEqual(recorded, { replacement: null, edits: null });
    assert.deepEqual(validateSchema(recorded, FLOW_QUERY_REPAIR_CHANGE_SCHEMA), []);
  }
});

test("recorded change excludes operation authority and rejects non-nominal input", () => {
  const operation = replace("The exact saved content.");
  const recorded = new RecordedRepairChange(operation).toJSON();
  assert.deepEqual(Object.keys(recorded).sort(), ["edits", "replacement"]);
  for (const field of ["expectedDigest", "findingIds", "target", "kind", "reason", "workerOutput"]) {
    assert.equal(Object.hasOwn(recorded, field), false);
  }
  for (const value of [operation.toJSON(), null, undefined, { replacementRequired: true, toJSON: () => recorded }]) {
    assert.throws(() => new RecordedRepairChange(value), TypeError);
  }
});

test("returned repair JSON is isolated from the value and its original typed operation", () => {
  const original = { rows: [{ text: "Original saved content." }] };
  const operation = replace(original);
  const change = new RecordedRepairChange(operation);
  original.rows[0].text = "Changed input object.";
  const first = change.toJSON();
  first.replacement.rows[0].text = "Changed returned object.";
  first.edits = [];
  assert.deepEqual(change.toJSON(), { replacement: { rows: [{ text: "Original saved content." }] }, edits: null });
  assert.equal(operation.toJSON().replacement.rows[0].text, "Original saved content.");
  const textOperation = edit();
  const textChange = new RecordedRepairChange(textOperation);
  textChange.toJSON().edits[0].replacement = "Changed edit.";
  assert.equal(textChange.toJSON().edits[0].replacement, "仕様");
  assert.equal(textOperation.edits[0].replacement, "仕様");
});

test("repair change Schema admits JSON content and excludes extra fields or conflicting edit forms", () => {
  assert.deepEqual(validateSchema(null, FLOW_QUERY_REPAIR_CHANGE_SCHEMA), []);
  for (const replacement of ["", 0, false, [], { data: { arbitrary: true } }, null]) {
    assert.deepEqual(validateSchema({ replacement, edits: null }, FLOW_QUERY_REPAIR_CHANGE_SCHEMA), []);
  }
  for (const invalid of [
    {}, { replacement: "value" }, { replacement: "value", edits: null, expectedDigest: "a".repeat(64) },
    { replacement: null, edits: [] }, { replacement: null, edits: "private worker output" },
    { replacement: "a second whole-field value", edits: [{ startByte: 0, endByte: 1, replacement: "text" }] },
    { replacement: null, edits: [{ startByte: -1, endByte: 1, replacement: "text" }] },
    { replacement: null, edits: [{ startByte: 0, endByte: 0.5, replacement: "text" }] },
    { replacement: null, edits: [{ startByte: 0, endByte: 1, replacement: null }] },
    { replacement: null, edits: [{ startByte: 0, replacement: "text" }] },
    { replacement: null, edits: [{ startByte: 0, endByte: 1, replacement: "text", workerOutput: {} }] },
  ]) assert.ok(validateSchema(invalid, FLOW_QUERY_REPAIR_CHANGE_SCHEMA).length > 0);
});

test("the shipped response contract uses the same closed change Schema for ordinary and lifecycle repairs", () => {
  const fragments = [];
  const visit = (value) => {
    if (value === null || typeof value !== "object") return;
    if (value.type === "object" && value.properties?.operationKind && value.properties?.adoptedReason
      && value.properties?.discardedReason && value.properties?.target && value.properties?.findingIds) {
      fragments.push(value.properties.change);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(FLOW_QUERY_RESPONSE_SCHEMA);
  assert.equal(fragments.length, 4);
  for (const fragment of fragments) assert.deepEqual(fragment, FLOW_QUERY_REPAIR_CHANGE_SCHEMA);
});
