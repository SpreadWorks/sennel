import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FlowArtifactCatalogSnapshotLimits } from "../../../src/lib/flow-version.js";
import { readSpecGateRepairSources, SpecGateRepairSourceCaptureBudget } from "../../../src/flow/lib/spec-gate-repair-sources.js";
import { SpecGateRepairSource, SpecGateRepairSourceSnapshots, SpecGateRepairSourceSnapshotManifest } from "../../../src/flow/lib/spec-gate-repair-values.js";
import { SpecGateRepairSourcePublication } from "../../../src/flow/lib/spec-gate-repair-source-storage.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function restore(sources, captureBudget) {
  const publication = new SpecGateRepairSourcePublication({ snapshots: new SpecGateRepairSourceSnapshots(sources), captureBudget });
  const writes = publication.artifactWrites();
  const manifestWrite = writes.find((write) => write.artifact.logicalKey === "spec.gate.repair.source.manifest");
  const blobs = new Map(writes.filter((write) => write.artifact.logicalKey === "spec.gate.repair.source.blob")
    .map((write) => [createHash("sha256").update(write.bytes).digest("hex"), write.bytes]));
  const manifest = SpecGateRepairSourceSnapshotManifest.fromJSON(JSON.parse(manifestWrite.bytes));
  return { writes, snapshots: manifest.restore((digest) => blobs.get(digest)) };
}
function capture(root, captureBudget, request = "Review the checkout", ruleSnapshots = null) {
  return readSpecGateRepairSources({ flowManager: { readArtifact: () => null },
    state: { request, issue: null }, executionRoot: root, captureBudget, ruleSnapshots });
}

test("canonical capture publishes exact UTF-8 and BOM within each artifact budget without reading unselected checkout research", (t) => {
  const root = createTmpDir("source-capture-budget-");
  t.after(() => removeTmpDir(root));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/entry.js"), "import './owner.js';\n");
  fs.writeFileSync(path.join(root, "src/owner.js"), " ".repeat(6000));
  const rules = '\ufeffRoot 漢🧭 rule "\\\u0000\r\n';
  fs.writeFileSync(path.join(root, "AGENTS.md"), rules);
  assert.equal(runGit(["init", "-q"], { cwd: root }).ok, true);
  assert.equal(runGit(["add", "AGENTS.md", "src"], { cwd: root }).ok, true);
  const limits = new FlowArtifactCatalogSnapshotLimits({ maxArtifactBytes: 5000 });
  const captureBudget = new SpecGateRepairSourceCaptureBudget({ limits });
  const sources = capture(root, captureBudget, "Inspect src/entry.js");
  const saved = restore(sources, captureBudget);
  assert(saved.writes.every((write) => write.bytes.length <= limits.maxArtifactBytes));
  assert.equal(captureBudget.serializedBytes, saved.writes.reduce((sum, write) => sum + write.bytes.length, 0));
  assert.equal(captureBudget.readBytes, Buffer.byteLength(rules));
  assert.equal(saved.snapshots.sources().find((source) => source.origin === "AGENTS.md").content, rules);
  assert.equal(saved.snapshots.sources().some((source) => source.origin.startsWith("src/")), false);
});

for (const byteLength of [6000, 2 * 1024 * 1024 + 1]) {
  test(`oversize root rules (${byteLength} bytes) retain unavailable evidence without reading or truncating the body`, (t) => {
    const root = createTmpDir("source-capture-refusal-");
    t.after(() => removeTmpDir(root));
    fs.writeFileSync(path.join(root, "AGENTS.md"), " ".repeat(byteLength));
    const limits = new FlowArtifactCatalogSnapshotLimits({ maxArtifactBytes: byteLength > 2 * 1024 * 1024 ? 8 * 1024 * 1024 : 5000 });
    const captureBudget = new SpecGateRepairSourceCaptureBudget({ limits });
    const saved = restore(capture(root, captureBudget), captureBudget);
    assert(saved.writes.every((write) => write.bytes.length <= limits.maxArtifactBytes));
    assert.equal(captureBudget.readBytes, 0);
    const rules = saved.snapshots.sources().find((source) => source.origin === "AGENTS.md");
    assert.equal(rules.availability, "unavailable");
    assert.equal(rules.content, "");
    assert.equal(rules.byteLength, 0);
    assert.equal(rules.required, true);
    assert.throws(() => rules.assertAvailable(), { code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" });
    assert.equal(saved.writes.some((write) => write.bytes.equals(Buffer.alloc(byteLength, " "))), false);
  });
}

test("aggregate saved-rule read exhaustion preserves complete admitted files and records refused optional rules as unavailable", (t) => {
  const root = createTmpDir("source-capture-aggregate-");
  t.after(() => removeTmpDir(root));
  fs.mkdirSync(path.join(root, "src/first"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/second"), { recursive: true });
  const rules = "Root rule for src/first.js and src/second.js.\n";
  const first = "export const first = '漢🧭';\n";
  const second = "export const second = 'complete';\n";
  fs.writeFileSync(path.join(root, "AGENTS.md"), rules);
  fs.writeFileSync(path.join(root, "src/first/AGENTS.md"), first);
  fs.writeFileSync(path.join(root, "src/second/AGENTS.md"), second);
  const ruleSnapshots = new SpecGateRepairSourceSnapshots([first, second].map((content, index) => {
    const scope = `src/${index === 0 ? "first" : "second"}`;
    return new SpecGateRepairSource({ id: `project-rules:${scope}/AGENTS.md`, origin: `${scope}/AGENTS.md`,
      content, revision: "saved-rule-identity", required: false, appliesTo: [scope] });
  }));
  const captureBudget = new SpecGateRepairSourceCaptureBudget({
    maxReadBytes: Buffer.byteLength(rules) + Buffer.byteLength(first), maxSerializedBytes: 5000,
    limits: new FlowArtifactCatalogSnapshotLimits({ maxArtifactBytes: 5000 }),
  });
  const saved = restore(capture(root, captureBudget, "Review the checkout", ruleSnapshots), captureBudget);
  const byOrigin = new Map(saved.snapshots.sources().map((source) => [source.origin, source]));
  assert.equal(captureBudget.readBytes, Buffer.byteLength(rules) + Buffer.byteLength(first));
  assert.equal(captureBudget.remainingReadBytes, 0);
  assert.equal(byOrigin.get("AGENTS.md").content, rules);
  assert.equal(byOrigin.get("src/first/AGENTS.md").content, first);
  assert.equal(byOrigin.get("src/second/AGENTS.md").availability, "unavailable");
  assert.equal(byOrigin.get("src/second/AGENTS.md").content, "");
  assert.throws(() => byOrigin.get("src/second/AGENTS.md").assertAvailable(), { code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" });
  assert(saved.writes.every((write) => write.bytes.length <= captureBudget.maxArtifactBytes));
});
