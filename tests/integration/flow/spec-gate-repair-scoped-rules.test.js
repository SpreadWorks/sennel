import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { SpecGateRepairContext } from "../../../src/flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairContextExpansion } from "../../../src/flow/lib/spec-gate-repair-context-expansion.js";
import { SpecGateRepairSource, SpecGateRepairSourceSnapshots } from "../../../src/flow/lib/spec-gate-repair-values.js";
import { readSpecGateRepairSources } from "../../../src/flow/lib/spec-gate-repair-sources.js";
import { validWorkerHandoffSpec } from "../../support/infrastructure/worker-artifact.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { saveFixtureSpecGateRepairSources } from "../../support/infrastructure/spec-gate-repair-source-snapshots.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
const rootRule = "AGENTS.md";
const aRules = [rootRule, "src/AGENTS.md", "src/a/AGENTS.md", "src/a/deep/AGENTS.md"];
const bRules = ["src/b/AGENTS.md", "src/b/deep/AGENTS.md"];
function specFixture() {
  const spec = validWorkerHandoffSpec();
  spec.requirements = ["a", "b", "c"].map((name, index) => ({ ...spec.requirements[0],
    id: `R${index + 1}`, desc: `対象src/${name}/deep/file.jsを確認する。`, task_ids: ["T1"] }));
  return spec;
}
function repository(root, { unavailable = null, missing = null, noRoot = false } = {}) {
  const rules = [...aRules, ...bRules, "src/c/AGENTS.md"];
  for (const relative of rules) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), `Rule body for ${relative}:\n${"Retain the contract.\n".repeat(relative === bRules[0] ? 500 : 1)}`);
  }
  fs.appendFileSync(path.join(root, rootRule), "Context navigation may mention src/c/deep/file.js.\n");
  fs.appendFileSync(path.join(root, bRules[1]), "Context navigation may mention src/c/deep/file.js.\n");
  for (const name of ["a", "b", "c"]) {
    fs.mkdirSync(path.join(root, `src/${name}/deep`), { recursive: true });
    // Reading B must not recursively select C merely because its body names C.
    fs.writeFileSync(path.join(root, `src/${name}/deep/file.js`), name === "b"
      ? "// src/c/deep/file.js 漢🧭\n".repeat(6000) : "export const retained = true;\n");
  }
  if (noRoot) fs.unlinkSync(path.join(root, rootRule));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n.tmp/\n");
  commitAll(root, "Capture isolated scoped-rule evidence");
  if (missing) fs.unlinkSync(path.join(root, missing));
  if (unavailable) fs.writeFileSync(path.join(root, unavailable), Buffer.from([0xff, 0xfe]));
}

// Historical inventories still replay exact identities and scopes. This fixture
// supplies the saved inventory explicitly, without invoking retired host discovery.
function historicalSources(root, request = "Review the contract") {
  const sources = [...readSpecGateRepairSources({ flowManager: { readArtifact: () => null },
    state: { issue: null, request }, executionRoot: root })];
  const origins = [...aRules.slice(1), ...bRules, "src/c/AGENTS.md",
    ...["a", "b", "c"].map((name) => `src/${name}/deep/file.js`),
    "vendor/AGENTS.md", "vendor/src/b/deep/file.js", "quoted/AGENTS.md", 'quoted/file"name.js'];
  for (const origin of origins.filter((origin) => fs.existsSync(path.join(root, origin)))) {
    const isRule = path.posix.basename(origin) === "AGENTS.md";
    sources.push(new SpecGateRepairSource({ id: `${isRule ? "project-rule" : "source"}:${origin}`,
      origin, required: false, revision: "saved-identity", content: fs.readFileSync(path.join(root, origin), "utf8"),
      ...(isRule ? { appliesTo: [path.posix.dirname(origin)] } : {}) }));
  }
  return sources;
}
function selectedRules(selection) {
  return selection.ranges.filter((range) => range.value?.appliesTo?.length).map((range) => range.value.origin).sort();
}
test("direct rule, full source, fragment and document reads retain applicable parents without sibling closure after snapshot reload", (t) => {
  const root = createTmpDir("repair-scoped-rules-");
  t.after(() => removeTmpDir(root));
  repository(root);
  fs.mkdirSync(path.join(root, "vendor/src/b/deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "vendor/AGENTS.md"), "Preserve vendor behavior.");
  fs.writeFileSync(path.join(root, "vendor/src/b/deep/file.js"), "export const vendor = true;");
  commitAll(root, "Capture a distinct origin containing another path as a suffix");
  fs.mkdirSync(path.join(root, "quoted"));
  fs.writeFileSync(path.join(root, 'quoted/file"name.js'), "export const quoted = true;");
  fs.writeFileSync(path.join(root, "quoted/AGENTS.md"), "Preserve quoted evidence.");
  commitAll(root, "Capture an origin with a literal quotation mark");
  const spec = specFixture();
  spec.overview.decisions.push({ text: "Consider vendor/src/b/deep/file.js.", evidence: "Existing consumer", consideredAlternatives: "Keep the contract" });
  const sources = historicalSources(root, '対象quoted/file"name.jsを確認する。');
  const stored = saveFixtureSpecGateRepairSources({ root, snapshots: new SpecGateRepairSourceSnapshots(sources) });
  const restored = stored.restore();
  const target = { entity: "requirement", id: "R1", field: "desc" };
  const contextFor = ({ document = false, direct = false, suffix = false, observed = "Repair the check", rationale = "", rule = "Preserve behavior" } = {}) => {
    const inputSpec = structuredClone(spec);
    if (direct) inputSpec.requirements[0].desc = "Read src/b/deep/AGENTS.md.";
    if (suffix) inputSpec.requirements[0].desc = "Read ./vendor/src/b/deep/file.js.";
    return new SpecGateRepairContext({ spec: inputSpec, baseRevision: `sha256:${"a".repeat(64)}`,
      guardrails: [{ id: "rule", body: rule }], acknowledgedRationale: rationale, sources: restored.sources(),
      findings: [{ identity: { sourceArtifact: "gate.json", sourceStep: "spec-gate", sourceFindingId: "F1", fingerprint: "b".repeat(64) },
        requirementRef: "rule", observed, targets: [document ? { document: "spec" } : target],
        allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] }] });
  };
  assert(restored.sources().some((source) => source.origin === 'quoted/file"name.js'));
  const expectedCanonicalRule = "quoted/AGENTS.md";
  const context = contextFor();
  const unitId = context.units()[0].id;
  const initial = context.select(unitId);
  t.diagnostic(`componentSelectedBytes=${Buffer.byteLength(JSON.stringify(initial.toJSON()))}`);
  assert.deepEqual(selectedRules(initial), [...aRules, expectedCanonicalRule].sort());
  const descriptors = context.tableOfContents();
  const source = descriptors.find((entry) => entry.source?.origin === "src/b/deep/file.js"
    && entry.byteEnd === entry.source.byteLength && entry.byteStart === 0);
  const fragment = descriptors.find((entry) => entry.source?.origin === "src/b/deep/file.js"
    && entry.byteEnd - entry.byteStart < entry.source.byteLength);
  assert(fragment, "the saved UTF-8 source has an actual registered fragment");
  const directRule = descriptors.find((entry) => entry.source?.origin === bRules[1]);
  assert.equal(descriptors.filter((entry) => entry.source?.origin === bRules[1]).length, 1, "rules are complete atomic sources");
  for (const id of [source.id, fragment.id, directRule.id, "requirements[R2].desc"]) {
    const expanded = new SpecGateRepairContextExpansion({ context, unitId, baseRevision: context.baseRevision, requestedRangeIds: [id] });
    assert.deepEqual(selectedRules(expanded.selection), [...aRules, ...bRules, expectedCanonicalRule].sort());
    assert.deepEqual(expanded.selection.ranges.filter((range) => range.writable), initial.ranges.filter((range) => range.writable));
  }
  for (const options of [{ observed: "Review src/b/deep/file.js" }, { rationale: "Review src/b/deep/file.js" }, { rule: "Review src/b/deep/file.js" }]) {
    const referenced = contextFor(options);
    assert.deepEqual(selectedRules(referenced.select(referenced.units()[0].id)), [...aRules, ...bRules, expectedCanonicalRule].sort());
  }
  const direct = contextFor({ direct: true });
  assert.deepEqual(selectedRules(direct.select(direct.units()[0].id)), [rootRule, "src/AGENTS.md", ...bRules, expectedCanonicalRule].sort());
  const suffix = contextFor({ suffix: true });
  assert.deepEqual(selectedRules(suffix.select(suffix.units()[0].id)), [rootRule, expectedCanonicalRule, "vendor/AGENTS.md"].sort(), "a captured origin inside a different path does not select its rules");
  const document = contextFor({ document: true });
  assert.deepEqual(selectedRules(document.select(document.units()[0].id)), [...aRules, ...bRules, "src/c/AGENTS.md", "vendor/AGENTS.md", expectedCanonicalRule].sort());
});

for (const availability of ["available", "missing", "unavailable"]) {
  test(`saved scoped-rule ${availability} identity is revalidated without discovering sibling sources`, (t) => {
    const root = createTmpDir("repair-saved-scoped-rules-");
    t.after(() => removeTmpDir(root));
    repository(root);
    const saved = new SpecGateRepairSourceSnapshots(historicalSources(root));
    const origin = "src/a/deep/AGENTS.md";
    const previousRule = saved.sources().find((source) => source.origin === origin);
    const currentText = "\ufeffUpdated scoped contract 漢🧭\r\n";
    if (availability === "available") fs.writeFileSync(path.join(root, origin), currentText);
    if (availability === "missing") fs.unlinkSync(path.join(root, origin));
    if (availability === "unavailable") fs.writeFileSync(path.join(root, origin), Buffer.from([0xff, 0xfe]));
    fs.writeFileSync(path.join(root, "src/new.js"), "export const unrelated = 999;");
    fs.mkdirSync(path.join(root, "src/new"));
    fs.writeFileSync(path.join(root, "src/new/AGENTS.md"), "Newly created unrelated rules.\n");
    const sources = readSpecGateRepairSources({ flowManager: { readArtifact: () => null },
      state: { request: "Review the contract", issue: null }, executionRoot: root, ruleSnapshots: saved });
    const stored = saveFixtureSpecGateRepairSources({ root, snapshots: new SpecGateRepairSourceSnapshots(sources) });
    const restored = stored.restore();
    const rule = restored.sources().find((source) => source.origin === origin);
    assert.equal(rule.id, previousRule.id);
    assert.equal(rule.availability, availability);
    assert.deepEqual(rule.appliesTo, ["src/a/deep"]);
    assert.equal(rule.required, false);
    assert.equal(rule.content, availability === "available" ? currentText : "");
    if (availability !== "available") assert.throws(() => rule.assertAvailable(), { code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" });
    assert.equal(restored.sources().some((source) => source.origin.endsWith(".js")), false);
    assert.equal(restored.sources().some((source) => source.origin === "src/new/AGENTS.md"), false);
    assert.equal(previousRule.availability, "available");
    assert.notEqual(previousRule.content, currentText);
  });
}

test("tracked missing root rules refuse admission while an unregistered absent root stays optional", async (t) => {
  for (const noRoot of [false, true]) {
    const value = await createSpecGateRepairScenario({ specRecord: specFixture(),
      beforeGate: ({ root }) => repository(root, noRoot ? { noRoot } : { missing: rootRule }) });
    t.after(() => removeTmpDir(value.root));
    const durable = () => ({ state: value.flowManager.canonicalState(value.specId).toJSON(),
      catalog: value.flowManager.artifactCatalog(value.specId).toJSON(), activities: value.flowManager.activityLedger(value.specId) });
    const before = durable();
    const create = () => value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.loadReadOnly(value.specId), invocation: value.invocation });
    if (noRoot) {
      const request = create();
      const selection = SpecGateRepairBundle.fromJSON(request.inputs[0].document.bundle).selections()[0];
      assert.deepEqual(selectedRules(selection), []);
    } else assert.throws(create, { code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" });
    assert.deepEqual(durable(), before);
  }
});
