import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { FlowArtifactCatalogSnapshotLimits } from "../../src/lib/flow-version.js";
import { SpecGateRepairSourceCaptureBudget } from "../../src/flow/lib/spec-gate-repair-sources.js";
import { SpecGateRepairSource, SpecGateRepairSourceSnapshots, SpecGateRepairSourceSnapshotManifest } from "../../src/flow/lib/spec-gate-repair-values.js";
import { SpecGateRepairSourcePublication } from "../../src/flow/lib/spec-gate-repair-source-storage.js";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";

function capturedSource(id, content, appliesTo = []) {
  return new SpecGateRepairSource({ id, origin: `${id}.js`, content,
    revision: createHash("sha256").update(content).digest("hex"), appliesTo });
}
function snapshots(sources) { return new SpecGateRepairSourceSnapshots(sources); }
function budget({ maxArtifactBytes, ...limits }) {
  return new SpecGateRepairSourceCaptureBudget({ limits: new FlowArtifactCatalogSnapshotLimits({ maxArtifactBytes }), ...limits });
}
function artifacts(publication) {
  const writes = publication.artifactWrites();
  return { writes, manifest: writes.find((write) => write.artifact.logicalKey === "spec.gate.repair.source.manifest"),
    blobs: writes.filter((write) => write.artifact.logicalKey === "spec.gate.repair.source.blob") };
}

test("source publication budgets exact raw UTF-8 bodies and bodyless manifest bytes including escaped text and BOM", () => {
  const sources = [
    capturedSource("source:first", '\ufeffquotes " and \\; controls \u0000\b\t\n\r; 日本語 😀 \ud800', ["src", "src/nested"]),
    capturedSource("source:second", "multiline\n\ntext", ["other"]),
  ];
  const captured = snapshots(sources);
  const expectedManifest = SpecGateRepairSourceSnapshotManifest.fromSnapshots(captured).bytes();
  const bodies = sources.map((source) => Buffer.from(source.content, "utf8"));
  const total = expectedManifest.length + bodies.reduce((sum, bytes) => sum + bytes.length, 0);
  const maxArtifactBytes = Math.max(expectedManifest.length, ...bodies.map((bytes) => bytes.length));
  const captureBudget = budget({ maxArtifactBytes, maxSerializedBytes: total });
  const saved = artifacts(new SpecGateRepairSourcePublication({ snapshots: captured, captureBudget }));
  assert.equal(captureBudget.serializedBytes, total);
  assert.equal(captureBudget.readBytes, 0);
  assert.deepEqual(saved.manifest.bytes, expectedManifest);
  assert(saved.writes.every((write) => write.bytes.length <= maxArtifactBytes));
  assert.equal(saved.blobs.length, 2);
  for (const body of bodies) assert(saved.blobs.some((write) => write.bytes.equals(body)));
  const bodyMap = new Map(saved.blobs.map((write) => [createHash("sha256").update(write.bytes).digest("hex"), write.bytes]));
  const restored = SpecGateRepairSourceSnapshotManifest.fromJSON(JSON.parse(saved.manifest.bytes)).restore((digest) => bodyMap.get(digest));
  assert.deepEqual(restored.sources().map((source) => Buffer.from(source.content, "utf8")),
    captured.sources().map((source) => Buffer.from(source.content, "utf8")));
  assert.equal(restored.sources()[0].content.codePointAt(0), 0xfeff);

  const short = budget({ maxArtifactBytes, maxSerializedBytes: total - 1 });
  assert.throws(() => new SpecGateRepairSourcePublication({ snapshots: captured, captureBudget: short }),
    (error) => error.code === "FLOW_SPEC_GATE_REPAIR_SNAPSHOT_LIMIT_EXCEEDED" && error.data.byteLength === total);
  assert.equal(short.serializedBytes, 0, "refusal does not admit a partial source publication");
});

test("individual artifact refusal preserves consumed read budget and exact aggregate read exhaustion", () => {
  const captureBudget = budget({ maxArtifactBytes: 512, maxReadBytes: 512, maxSerializedBytes: 4096 });
  const content = "\u0000".repeat(513);
  captureBudget.consumeRead(100);
  assert.equal(captureBudget.admitSource(capturedSource("source:escaped", content)), false);
  assert.throws(() => captureBudget.admitArtifact(Buffer.from(content)),
    { code: "FLOW_SPEC_GATE_REPAIR_SNAPSHOT_LIMIT_EXCEEDED" });
  assert.equal(captureBudget.serializedBytes, 0);
  assert.equal(captureBudget.readBytes, 100);
  assert.equal(captureBudget.remainingReadBytes, 412);
  captureBudget.consumeRead(captureBudget.remainingReadBytes);
  assert.equal(captureBudget.readBytes, 512);
  assert.equal(captureBudget.remainingReadBytes, 0);
  assert.throws(() => captureBudget.consumeRead(1), /remaining capture budget/);
  assert.equal(captureBudget.readBytes, 512);
});

test("deduplicated blob bytes and all manifest metadata count toward the actual publication boundary", () => {
  const content = "export const boundary = 1;\n";
  const source = capturedSource("source:owner", content);
  const first = artifacts(new SpecGateRepairSourcePublication({ snapshots: snapshots([source]) }));
  const duplicate = capturedSource("source:duplicate", content);
  const expanded = artifacts(new SpecGateRepairSourcePublication({ snapshots: snapshots([source, duplicate]) }));
  assert.equal(expanded.blobs.length, 1);
  assert.deepEqual(expanded.blobs[0].bytes, Buffer.from(content));
  assert(expanded.manifest.bytes.length > first.manifest.bytes.length);
  const originalTotal = first.writes.reduce((sum, write) => sum + write.bytes.length, 0);
  const captureBudget = budget({ maxArtifactBytes: expanded.manifest.bytes.length, maxSerializedBytes: originalTotal });
  assert.throws(() => new SpecGateRepairSourcePublication({ snapshots: snapshots([source, duplicate]), captureBudget }),
    { code: "FLOW_SPEC_GATE_REPAIR_SNAPSHOT_LIMIT_EXCEEDED" });
  assert.equal(captureBudget.serializedBytes, 0);
  assert.equal(captureBudget.readBytes, 0);
  const individual = budget({ maxArtifactBytes: expanded.manifest.bytes.length - 1, maxSerializedBytes: 4096 });
  assert.throws(() => new SpecGateRepairSourcePublication({ snapshots: snapshots([source, duplicate]), captureBudget: individual }),
    { code: "FLOW_SPEC_GATE_REPAIR_SNAPSHOT_LIMIT_EXCEEDED" });
  assert.equal(individual.serializedBytes, 0);
});


test("request surrogate bytes retain identical source content and selected range identity across manifest restoration", () => {
  const request = "\ufeffConfirmed 漢🧭 request \ud800 with \udc00 and \"quotes\"\r\n";
  const expectedBytes = Buffer.from(request, "utf8");
  const source = new SpecGateRepairSource({ id: "request", origin: "flow.request", content: request,
    revision: createHash("sha256").update(expectedBytes).digest("hex") });
  const captured = snapshots([source]);
  const saved = artifacts(new SpecGateRepairSourcePublication({ snapshots: captured }));
  const restored = SpecGateRepairSourceSnapshotManifest.fromJSON(JSON.parse(saved.manifest.bytes))
    .restore((digest) => saved.blobs.find((write) => createHash("sha256").update(write.bytes).digest("hex") === digest).bytes);
  assert.equal(source.content, "\ufeffConfirmed 漢🧭 request \ufffd with \ufffd and \"quotes\"\r\n");
  assert.equal(restored.sources()[0].content, source.content);
  assert.deepEqual(restored.sources()[0].descriptor(), source.descriptor());
  assert.deepEqual(Buffer.from(restored.sources()[0].content, "utf8"), expectedBytes);
  const target = { entity: "requirement", id: "R1", field: "desc" };
  const contextFor = (sources) => new SpecGateRepairContext({
    spec: { goal: "Correct the planned check", requirements: [{ id: "R1", desc: "Repair the check", task_ids: ["T1"], testable: true }],
      tasks: [{ id: "T1", goal: "Implement the check" }] }, baseRevision: "sha256:" + "a".repeat(64), sources,
    guardrails: [{ id: "rule", body: "State the planned check." }], findings: [{
      identity: { sourceArtifact: "gate.json", sourceStep: "spec-gate", sourceFindingId: "F1", fingerprint: "b".repeat(64) },
      requirementRef: "rule", observed: "Correct the check", targets: [target],
      allowedTargets: [{ target, operationKinds: ["edit-text-field"] }],
    }],
  });
  const before = contextFor(captured.sources());
  const after = contextFor(restored.sources());
  const selected = before.select(before.units()[0].id).toJSON();
  const reselected = after.select(after.units()[0].id).toJSON();
  assert.equal(after.evidenceDigest, before.evidenceDigest);
  assert.deepEqual(reselected, selected);
  const range = reselected.ranges.find((entry) => entry.id === source.id);
  assert.equal(range.value.content, source.content);
  assert.equal(range.value.byteStart, 0);
  assert.equal(range.value.byteEnd, expectedBytes.length);
  assert.deepEqual(Buffer.from(range.value.content, "utf8"), expectedBytes);
});
