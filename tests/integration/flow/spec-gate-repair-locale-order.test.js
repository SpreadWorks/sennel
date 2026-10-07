import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runGit } from "../../../src/lib/git-helpers.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const moduleUrl = (relative) => JSON.stringify(new URL(relative, import.meta.url).href);
const imports = `
  import fs from "node:fs";
  import path from "node:path";
  import assert from "node:assert/strict";
  import { createHash } from "node:crypto";
  import { SpecGateRepairContext } from ${moduleUrl("../../../src/flow/lib/spec-gate-repair-context.js")};
  import { SpecGateRepairSourceSnapshotManifest, SpecGateRepairSourceSnapshotReference } from ${moduleUrl("../../../src/flow/lib/spec-gate-repair-values.js")};
  import { SpecGateRepairSourcePublication } from ${moduleUrl("../../../src/flow/lib/spec-gate-repair-source-storage.js")};
  import { SpecGateRepairBundle } from ${moduleUrl("../../../src/flow/lib/spec-gate-repair-bundle.js")};
  import { readSpecGateRepairSources } from ${moduleUrl("../../../src/flow/lib/spec-gate-repair-sources.js")};
  import { FlowManager } from ${moduleUrl("../../../src/lib/flow-manager.js")};
  import { readProgressBoundSpecGateRepairInput, readSpecGateRepairExecutionProgress }
    from ${moduleUrl("../../../src/flow/lib/spec-gate-repair-progress.js")};
  import { createSpecGateRepairScenario } from ${moduleUrl("../../support/infrastructure/spec-gate-repair-scenario.js")};
  import { reserveFixtureSpecGateRepairWorkerCall } from ${moduleUrl("../../support/infrastructure/spec-gate-repair-admission.js")};
  import { validWorkerHandoffSpec } from ${moduleUrl("../../support/infrastructure/worker-artifact.js")};
  import { runGit } from ${moduleUrl("../../../src/lib/git-helpers.js")};
  const snapshotIdentity = (snapshots) => {
    const publication = new SpecGateRepairSourcePublication({ snapshots });
    const writes = publication.artifactWrites();
    return { reference: publication.reference().toJSON(),
      manifest: JSON.parse(writes.find((write) => write.artifact.logicalKey === "spec.gate.repair.source.manifest").bytes),
      blobs: Object.fromEntries(writes.filter((write) => write.artifact.logicalKey === "spec.gate.repair.source.blob")
        .map((write) => [createHash("sha256").update(write.bytes).digest("hex"), write.bytes.toString("base64")])) };
  };
  const restoreSnapshots = (value) => {
    const manifest = SpecGateRepairSourceSnapshotManifest.fromJSON(value.manifest);
    new SpecGateRepairSourceSnapshotReference(value.reference).assertBytes(manifest.bytes());
    return manifest.restore((digest) => Buffer.from(value.blobs[digest], "base64"));
  };
  const locale = new Intl.Collator().resolvedOptions().locale;
  const output = (value) => console.log(JSON.stringify({ locale, collation: "ä".localeCompare("z"), ...value }));
`;

function inLocale(locale, root, script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", imports + script], {
    env: { ...process.env, LANG: `${locale}.UTF-8`, LC_ALL: `${locale}.UTF-8`, TMPDIR: root },
    encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(value.locale, locale.replace("_", "-"));
  assert.equal(Math.sign(value.collation), locale === "en_US" ? -1 : 1,
    "the regression must cross a real process collation boundary");
  return value;
}

function sourceFiles(root) {
  for (const name of ["ä", "z"]) {
    fs.mkdirSync(path.join(root, "src", name), { recursive: true });
    fs.writeFileSync(path.join(root, "src", `${name}.js`), "export const value = '漢🧭';\n");
    fs.writeFileSync(path.join(root, "src", name, "AGENTS.md"), "Preserve the existing exports.\n");
    fs.writeFileSync(path.join(root, "src", name, "code.js"), "export const nested = 1;\n");
  }
  assert.equal(runGit(["init", "-q"], { cwd: root }).ok, true);
  assert.equal(runGit(["add", "src"], { cwd: root }).ok, true);
}

test("repair evidence, index, selection and persisted bundle identities survive a real locale change", (t) => {
  const root = createTmpDir("repair-locale-identity-");
  t.after(() => removeTmpDir(root));
  sourceFiles(root);
  const script = `
    const root = ${JSON.stringify(root)};
    const spec = validWorkerHandoffSpec();
    const sources = readSpecGateRepairSources({ flowManager: { readArtifact: () => null },
      state: { request: "Inspect src/ä.js, src/z.js, src/ä/code.js and src/z/code.js", issue: null },
      executionRoot: root, spec });
    const target = { entity: "requirement", id: "R1", field: "desc" };
    const findings = ["ä", "z"].map((id) => ({
      identity: { sourceArtifact: "gate/result.json", sourceStep: "spec-gate", sourceFindingId: id,
        fingerprint: createHash("sha256").update(id).digest("hex") },
      requirementRef: "rule", observed: "Correct the planned check.", targets: [target],
      allowedTargets: [{ target, operationKinds: ["edit-text-field"] }],
    }));
    const context = new SpecGateRepairContext({ spec, baseRevision: "sha256:" + "a".repeat(64),
      findings, guardrails: [{ id: "rule", body: "State the planned check." }], sources });
    const selections = context.units().map((unit) => context.select(unit.id, {
      additionalRangeIds: context.tableOfContents().filter((range) => range.source).map((range) => range.id),
    }));
    const bundle = SpecGateRepairBundle.fromSelections(selections);
    output({ evidenceDigest: context.evidenceDigest, indexManifest: context.indexManifest().toJSON(),
      snapshots: snapshotIdentity(context.sourceSnapshots()), bundle: bundle.toJSON(), bundleDigest: bundle.digest,
      selections: bundle.selections() });
  `;
  const first = inLocale("en_US", root, script);
  const second = inLocale("sv_SE", root, script);
  const { locale: firstLocale, collation: firstCollation, ...firstIdentity } = first;
  const { locale: secondLocale, collation: secondCollation, ...secondIdentity } = second;
  assert.deepEqual(secondIdentity, firstIdentity);
  assert.equal(first.snapshots.manifest.sources.filter((source) => source.origin.startsWith("src/")).length, 6);
  const persisted = path.join(root, "saved-context.json");
  fs.writeFileSync(persisted, JSON.stringify(firstIdentity));
  const restored = inLocale("sv_SE", root, `
    const saved = JSON.parse(fs.readFileSync(${JSON.stringify(persisted)}, "utf8"));
    const snapshots = restoreSnapshots(saved.snapshots);
    const bundle = SpecGateRepairBundle.fromJSON(saved.bundle);
    output({ snapshots: snapshotIdentity(snapshots), bundle: bundle.toJSON(),
      bundleDigest: bundle.digest, selections: bundle.selections() });
  `);
  assert.deepEqual(restored.snapshots, first.snapshots);
  assert.deepEqual(restored.bundle, first.bundle);
  assert.equal(restored.bundleDigest, first.bundleDigest);
  assert.deepEqual(restored.selections, first.selections);
});

test("claimed repair checkpoint resumes under another locale and refuses only changed evidence without mutation", (t) => {
  const parent = createTmpDir("repair-locale-restart-");
  t.after(() => removeTmpDir(parent));
  const created = inLocale("en_US", parent, `
    const value = await createSpecGateRepairScenario({
      request: "Inspect src/ä.js and src/z.js.",
      beforeGate: ({ root }) => {
        fs.mkdirSync(path.join(root, "src"));
        for (const name of ["ä", "z"]) fs.writeFileSync(path.join(root, "src", name + ".js"), "export const same = 1;\\n");
        assert.equal(runGit(["init", "-q"], { cwd: root }).ok, true);
        assert.equal(runGit(["add", "src"], { cwd: root }).ok, true);
      },
    });
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
    reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) });
    const state = value.flowManager.canonicalState(value.specId);
    const lifecycle = value.flowManager.draftStepExecutionState({ binding: {
      runId: state.runId, specId: state.specId, stepId: "spec-gate-repair", attempt: state.attempt,
    } }).lifecycle;
    assert.equal(lifecycle.phase, "claimed");
    const progress = readSpecGateRepairExecutionProgress({ flowManager: value.flowManager, state, lifecycle });
    output({ root: value.root, specId: value.specId, savedContext: progress.document.context,
      snapshots: snapshotIdentity(progress.sourceSnapshots), inputDigest: request.inputDigest, inputRevision: request.inputRevision });
  `);
  const restart = `
    const root = ${JSON.stringify(created.root)};
    const specId = ${JSON.stringify(created.specId)};
    const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const state = flowManager.canonicalState(specId);
    const durable = () => ({ state: flowManager.canonicalState(specId).toJSON(),
      catalog: flowManager.artifactCatalog(specId).toJSON(), activities: flowManager.activityLedger(specId) });
    const before = durable();
    try {
      const { source } = readProgressBoundSpecGateRepairInput({ flowManager, state, executionRoot: root });
      const bundle = SpecGateRepairBundle.fromJSON(${JSON.stringify(created.savedContext.bundle)});
      assert.deepEqual(durable(), before);
      output({ evidenceDigest: source.context.evidenceDigest, indexManifest: source.context.indexManifest().toJSON(),
        snapshots: snapshotIdentity(source.context.sourceSnapshots()), bundleDigest: bundle.digest,
        binding: flowManager.draftStepExecutionState({ binding: {
          runId: state.runId, specId, stepId: "spec-gate-repair", attempt: state.attempt,
        } }).lifecycle.binding.toJSON() });
    } catch (error) {
      assert.deepEqual(durable(), before);
      output({ errorCode: error.code, message: error.message });
    }
  `;
  const resumed = inLocale("sv_SE", parent, restart);
  assert.equal(resumed.errorCode, undefined, resumed.message);
  assert.equal(resumed.evidenceDigest, created.savedContext.evidenceDigest);
  assert.deepEqual(resumed.indexManifest, created.savedContext.bundle.units[0].indexManifest);
  assert.deepEqual(resumed.snapshots, created.snapshots);
  assert.equal(resumed.binding.inputDigest, created.inputDigest);
  assert.equal(resumed.binding.inputRevision, created.inputRevision);
  fs.writeFileSync(path.join(created.root, "src/ä.js"), "export const same = 2;\n");
  const rejected = inLocale("sv_SE", parent, restart);
  assert.equal(rejected.errorCode, "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED");
});
