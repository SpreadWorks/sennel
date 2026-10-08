import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairSource, SpecGateRepairSourceQuery, SpecGateRepairSourceQueryResult,
  SpecGateRepairSourceRange, SpecGateRepairSourceTextIndex, SpecGateRepairSourceSnapshots,
  SpecGateRepairSourceSnapshotManifest } from "../../src/flow/lib/spec-gate-repair-values.js";
import { RangedTextPromptElement } from "../../src/lib/prompt-batching.js";
import { MAX_WORKER_ARTIFACT_INPUT_BYTES, workerArtifactStableStringify } from "../../src/flow/lib/worker-artifact-input-format.js";

const revision = `sha256:${"a".repeat(64)}`;
const binding = { unitId: "repair-unit", baseRevision: revision };
const source = (content, changes = {}) => new SpecGateRepairSource({ id: "source:owner", origin: "src/owner.js",
  content, revision: "captured", required: false, ...changes });
const query = (changes = {}) => new SpecGateRepairSourceQuery({ origin: "src/owner.js", literal: "aa",
  beforeLines: 0, afterLines: 0, maxMatches: 1, cursor: null, ...changes });
const restore = (value) => JSON.parse(workerArtifactStableStringify(value.toJSON()));

test("saved Unicode snapshot query receipts preserve overlapping matches and authenticate continuation", () => {
  const captured = source("前\n😀 aaaa\nlast\n");
  const blobs = new Map([[captured.digest, Buffer.from(captured.content)]]);
  const manifest = SpecGateRepairSourceSnapshotManifest.fromSnapshots(new SpecGateRepairSourceSnapshots([captured]));
  const first = captured.query(query(), binding);
  assert.deepEqual(first.matches.map(({ byteStart, byteEnd }) => [byteStart, byteEnd]), [[9, 11]]);
  assert.equal(first.ranges[0].value.content, "😀 aaaa\n");
  assert.equal(first.searchedInterval.byteEnd, 10);
  assert.equal(first.nextCursor, first.id);
  const reloaded = SpecGateRepairSourceSnapshotManifest.fromJSON(restore(manifest)).restore((digest) => blobs.get(digest)).sources()[0];
  const receipt = SpecGateRepairSourceQueryResult.fromJSON(restore(first));
  const second = reloaded.query(query({ cursor: receipt.nextCursor }), binding, [receipt]);
  const third = reloaded.query(query({ cursor: second.nextCursor }), binding, [receipt, second]);
  assert.deepEqual(second.matches.map(({ byteStart, byteEnd }) => [byteStart, byteEnd]), [[10, 12]]);
  assert.deepEqual(third.matches.map(({ byteStart, byteEnd }) => [byteStart, byteEnd]), [[11, 13]]);
  assert.equal(first.ranges[0].id, third.ranges[0].id);
  assert.equal(third.complete, true);
  assert.equal(third.nextCursor, null);
  assert.equal(third.searchedInterval.byteEnd, captured.byteLength);
  assert.deepEqual(restore(receipt), restore(first));
  assert.deepEqual(captured.descriptor(), reloaded.descriptor());
});

test("snapshot cursors bind exact source, selected unit, revision and query parameters", () => {
  const captured = source("aaaa\n");
  const receipt = captured.query(query(), binding);
  for (const change of [{ literal: "a" }, { maxMatches: 2 }, { beforeLines: 1 }, { afterLines: 1 },
    { cursor: `source-query:${"f".repeat(64)}` }]) {
    assert.throws(() => captured.query(query({ cursor: receipt.id, ...change }), binding, [receipt]), /cursor/);
  }
  for (const change of [{ unitId: "other" }, { baseRevision: `sha256:${"b".repeat(64)}` }]) {
    assert.throws(() => captured.query(query({ cursor: receipt.id }), { ...binding, ...change }, [receipt]), /cursor/);
  }
  for (const changed of [source("aaaa changed\n"), source("aaaa\n", { revision: "changed" }),
    source("aaaa\n", { id: "source:other" })]) {
    assert.throws(() => changed.query(query({ cursor: receipt.id }), binding, [receipt]), /stale|cursor/);
  }
  const complete = captured.query(query({ literal: "missing" }), binding);
  assert.deepEqual(complete.matches, []);
  assert.equal(complete.complete, true);
  assert.throws(() => captured.query(query({ literal: "missing", cursor: complete.id }), binding, [complete]), /cursor/);
  assert.throws(() => SpecGateRepairSourceQueryResult.fromJSON({ ...restore(receipt), sourceDigest: "f".repeat(64) }), /identity/);
});

test("range coverage counts the union of prior and requested bytes and binds exact source revision", () => {
  const captured = source("0123456789");
  const element = new RangedTextPromptElement({ id: captured.id, sourceRevision: captured.revision, sequence: 0, text: captured.content });
  const index = new SpecGateRepairSourceTextIndex(captured);
  const range = (start, end) => new SpecGateRepairSourceRange({ source: captured, element: element.createRange({ start, end }), index }).value;
  const prior = [range(0, 6), range(3, 8)];
  assert.equal(SpecGateRepairSourceRange.uncoveredRangeBytes([range(7, 10), range(8, 10)], prior), 2);
  assert.equal(SpecGateRepairSourceRange.uncoveredRangeBytes([range(0, 10)], [{ ...range(0, 10), revision: "other" }]), 10);
  assert.throws(() => new SpecGateRepairSourceRange({ source: source("changed"), element, index }), /different captured source/);
});

test("snapshot queries reject malformed selectors and cannot read unavailable captured evidence", () => {
  for (const change of [{ literal: "" }, { literal: "\ud800" }, { literal: "\udc00" }, { beforeLines: -1 },
    { afterLines: 0.5 }, { maxMatches: 0 }, { maxMatches: Infinity }, { cursor: 0 }, { extra: true }]) {
    assert.throws(() => query(change), /query/);
  }
  assert.throws(() => source("", { availability: "missing" }).query(query(), binding), (error) =>
    error.code === "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE");
  const result = source("X ".repeat(1000)).query(query({ literal: "X", maxMatches: 1000 }), binding);
  assert.equal(result.matches.length, 1000);
  assert.equal(result.ranges.length, 1);
  assert(result.matches.every((match) => match.rangeId === result.ranges[0].id));
});

test("broad snapshot query output refuses at the existing worker artifact input limit", () => {
  assert.throws(() => source("X\n".repeat(10000)).query(query({ literal: "X", maxMatches: Number.MAX_SAFE_INTEGER }), binding), (error) =>
    error.code === "FLOW_SPEC_GATE_REPAIR_INPUT_TOO_LARGE" && error.data.maximumBytes === MAX_WORKER_ARTIFACT_INPUT_BYTES
      && error.data.actualBytes > error.data.maximumBytes);
});
