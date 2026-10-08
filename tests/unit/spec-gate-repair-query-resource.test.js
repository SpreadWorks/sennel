import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as values from "../../src/flow/lib/spec-gate-repair-values.js";
import * as prompt from "../../src/lib/prompt-batching.js";
import { MAX_WORKER_ARTIFACT_INPUT_BYTES, workerArtifactStableStringify } from "../../src/flow/lib/worker-artifact-input-format.js";
import { cursorQueryResourceInput, overflowQueryResourceInput, observeQueryResources } from "../support/builders/spec-gate-repair-query-resource.js";

const { SpecGateRepairSource, SpecGateRepairSourceQuery, SpecGateRepairSourceQueryResult, SpecGateRepairSourceTextIndex } = values;
const bytes = (value) => Buffer.byteLength(workerArtifactStableStringify(value));
const sign = (value) => {
  const { id, nextCursor, ...body } = value;
  const signed = `source-query:${createHash("sha256").update(workerArtifactStableStringify(body)).digest("hex")}`;
  return SpecGateRepairSourceQueryResult.fromJSON({ ...body, id: signed, nextCursor: body.complete ? null : signed });
};

test("sixteen valid cursor pages authenticate their complete history with one source index per query", () => {
  const input = cursorQueryResourceInput();
  const source = new SpecGateRepairSource(input.source);
  const previous = [];
  let cursor = null;
  assert.equal(source.byteLength, 131213);
  for (let page = 0; page < input.pages; page += 1) {
    const observed = observeQueryResources(values, prompt, source.id,
      () => source.query(new SpecGateRepairSourceQuery({ ...input.query, cursor }), input.binding, previous));
    if (observed.error) throw observed.error;
    assert.equal(observed.counts.indexInstances, 1, `page ${page + 1} must share its source index across receipt validation`);
    const result = observed.result;
    assert.deepEqual(result.matches.map((match) => [match.byteStart, match.byteEnd]), [[page * 7, page * 7 + 6]]);
    assert.deepEqual(result.searchedInterval, { characterStart: page === 0 ? 0 : (page - 1) * 7 + 1,
      characterEnd: page * 7 + 1, byteStart: page === 0 ? 0 : (page - 1) * 7 + 1, byteEnd: page * 7 + 1 });
    assert.equal(result.sourceRevision, input.source.revision);
    assert.equal(result.complete, false);
    assert.equal(result.ranges[0].value.content, "needle\n");
    const restored = SpecGateRepairSourceQueryResult.fromJSON(JSON.parse(workerArtifactStableStringify(result.toJSON())));
    assert.deepEqual(restored.toJSON(), result.toJSON());
    previous.push(restored); cursor = restored.nextCursor;
  }
});

test("oversized enumeration refuses the first over-limit candidate before retaining its range or match", () => {
  const input = overflowQueryResourceInput();
  const source = new SpecGateRepairSource(input.source);
  const observed = observeQueryResources(values, prompt, source.id,
    () => source.query(new SpecGateRepairSourceQuery(input.query), input.binding));
  assert.equal(source.byteLength, 40000);
  assert.equal(observed.error?.code, "FLOW_SPEC_GATE_REPAIR_INPUT_TOO_LARGE");
  assert.equal(observed.error.data.maximumBytes, 2 * 1024 * 1024);
  assert(observed.error.data.actualBytes > MAX_WORKER_ARTIFACT_INPUT_BYTES);
  assert.equal(observed.counts.retainedMatches, observed.counts.examinedWindows - 1);
  assert.equal(observed.counts.retainedRanges, observed.counts.examinedWindows - 1);
  assert(observed.counts.examinedWindows < 20000, "refusal must stop enumeration instead of building every match");
  // Independently serialize the rejected next candidate from the last fitting
  // public receipt. This verifies metadata, arrays, references and body accounting.
  const count = observed.counts.retainedMatches;
  const prefix = source.query(new SpecGateRepairSourceQuery({ ...input.query, maxMatches: count }), input.binding).toJSON();
  prefix.query.maxMatches = input.query.maxMatches;
  const element = new prompt.RangedTextPromptElement({ id: source.id, sourceRevision: source.revision, sequence: 0, text: source.content });
  const range = new values.SpecGateRepairSourceRange({ source, element: element.createRange({ start: count * 2, end: count * 2 + 2 }) });
  prefix.ranges.push({ id: range.id, digest: range.digest, value: range.value });
  prefix.matches.push({ byteStart: count * 2, byteEnd: count * 2 + 1, rangeId: range.id });
  prefix.searchedInterval.characterEnd = prefix.searchedInterval.byteEnd = count * 2 + 1;
  assert.equal(observed.error.data.actualBytes, bytes(prefix));
});

test("a shared escaped Unicode window is charged once and exact-limit complete output remains accepted", () => {
  const source = new SpecGateRepairSource({ id: "source:漢\"\\", origin: "漢\"\\.js", revision: "capture\"\\", required: false,
    content: "X😀\t\"\\X\r\n" });
  const query = new SpecGateRepairSourceQuery({ origin: source.origin, literal: "X", beforeLines: 0, afterLines: 0, maxMatches: 2, cursor: null });
  const binding = { unitId: "u", baseRevision: `sha256:${"a".repeat(64)}` };
  const small = source.query(query, binding);
  const padding = "u".repeat(MAX_WORKER_ARTIFACT_INPUT_BYTES - bytes(small.toJSON()) + 1);
  const observed = observeQueryResources(values, prompt, source.id, () => source.query(query, { ...binding, unitId: padding }));
  if (observed.error) throw observed.error;
  assert.equal(bytes(observed.result.toJSON()), MAX_WORKER_ARTIFACT_INPUT_BYTES);
  assert.equal(observed.result.matches.length, 2);
  assert.equal(observed.result.ranges.length, 1);
  assert.equal(observed.counts.constructedRanges, 1, "the shared window must be reused for both matches");
  assert.equal(observed.result.ranges[0].value.content, source.content);
  assert.throws(() => source.query(query, { ...binding, unitId: padding + "u" }), (error) =>
    error.code === "FLOW_SPEC_GATE_REPAIR_INPUT_TOO_LARGE" && error.data.actualBytes === MAX_WORKER_ARTIFACT_INPUT_BYTES + 1);
});

test("re-signed altered ancestor receipts cannot authenticate their derived cursor chain", () => {
  const input = cursorQueryResourceInput();
  const source = new SpecGateRepairSource(input.source);
  const first = source.query(new SpecGateRepairSourceQuery(input.query), input.binding);
  const second = source.query(new SpecGateRepairSourceQuery({ ...input.query, cursor: first.id }), input.binding, [first]);
  const altered = first.toJSON();
  altered.searchedInterval.characterEnd = altered.searchedInterval.byteEnd = 2;
  const forgedFirst = sign(altered);
  const descendant = second.toJSON(); descendant.query.cursor = forgedFirst.id;
  const forgedSecond = sign(descendant);
  assert.throws(() => source.query(new SpecGateRepairSourceQuery({ ...input.query, cursor: forgedSecond.id }), input.binding,
    [forgedFirst, forgedSecond]), /cursor receipt/);
  assert.throws(() => source.query(new SpecGateRepairSourceQuery({ ...input.query, cursor: second.id }), input.binding, [second]), /cursor/);
});

test("compact offsets retain exact UTF-8 boundaries and the captured source revision", () => {
  const source = new SpecGateRepairSource({ id: "source:unicode", origin: "unicode", revision: "capture", required: false,
    content: "\ufeffA😀漢\r\n尾" });
  const index = new SpecGateRepairSourceTextIndex(source);
  for (const position of [0, 1, 2, 4, 5, 6, 7, 8]) {
    assert.equal(index.byteOffset(position), Buffer.byteLength(source.content.slice(0, position)));
  }
  for (const position of [3, -1, 9, 0.5, Infinity]) assert.throws(() => index.byteOffset(position), /Unicode boundaries/);
  assert.throws(() => index.assertSource(new SpecGateRepairSource({ ...source.descriptor(), id: "source:unicode", content: source.content,
    revision: "foreign" })), /different captured source/);
});

test("zero-hit output still rejects oversized escaped metadata with the unchanged typed limit", () => {
  const source = new SpecGateRepairSource({ id: "source:empty", origin: "empty", revision: "capture", required: false, content: "" });
  const query = new SpecGateRepairSourceQuery({ origin: source.origin, literal: "X", beforeLines: 0, afterLines: 0, maxMatches: 1, cursor: null });
  assert.throws(() => source.query(query, { unitId: "\n".repeat(MAX_WORKER_ARTIFACT_INPUT_BYTES), baseRevision: `sha256:${"a".repeat(64)}` }),
    (error) => error.code === "FLOW_SPEC_GATE_REPAIR_INPUT_TOO_LARGE" && error.data.maximumBytes === MAX_WORKER_ARTIFACT_INPUT_BYTES);
});
