import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { artifactWorkerRecoveryRegistrations } from "../../src/flow/engine/composition/artifact-worker-recovery.js";
import { StructureChecker } from "../support/structure/checker.js";
import { artifactWorkerRecoveryStructureScope } from "../support/structure/artifact-worker-recovery-scope.js";
import { MemorySourceRepository, SourceRepository } from "../support/structure/source-repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = new SourceRepository(root);
const seed = new Map(source.list("src").map((file) => [file, source.read(file)]));
const registrations = artifactWorkerRecoveryRegistrations();
function inspect(files = seed, selectedRegistrations = registrations) {
  return new StructureChecker(artifactWorkerRecoveryStructureScope(root, selectedRegistrations), new MemorySourceRepository(files)).check();
}
function success(report) { assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n")); }
function violation(report, rule, file) {
  assert.ok(report.diagnostics.some((entry) => entry.rule === rule && entry.file === file && entry.line > 0),
    report.diagnostics.map((entry) => entry.toString()).join("\n"));
}

test("artifact recovery operations retain existing producer nodes and obey the shared Step and Service rules", (t) => {
  const report = inspect();
  t.diagnostic(report.describe());
  success(report);
  assert.ok(report.serviceBoundaries.has("src/flow/services/artifact-worker-recovery-service.js"));
});

test("the operation scope rejects an excluded producer and a filtered production collection", () => {
  const file = "src/flow/engine/composition/artifact-worker-recovery.js";
  violation(inspect(seed, registrations.slice(1)), "A01", file);
  const files = new Map(seed);
  files.set(file, seed.get(file).replace(".map(createArtifactWorkerRecoveryRegistration)",
    ".filter((definition) => definition.stepId !== 'draft').map(createArtifactWorkerRecoveryRegistration)"));
  violation(inspect(files), "A11", file);
  const eager = new Map(seed);
  eager.set(file, seed.get(file).replace("let artifactWorkerRecoveryRegistrationsCache = null;",
    "let artifactWorkerRecoveryRegistrationsCache = Object.freeze([]);"));
  violation(inspect(eager), "A11", file);
  success(inspect());
});

test("operation Service IO and an execution bypass are rejected by the same shared checker", () => {
  const service = "src/flow/services/artifact-worker-recovery-service.js";
  const files = new Map(seed);
  files.set(service, `import fs from "node:fs";\n${seed.get(service).replace("get evidence() {", "get evidence() { fs.readFileSync('input');")}`);
  violation(inspect(files), "A08", service);
  const composition = "src/flow/engine/composition/artifact-worker-recovery.js";
  const bypass = new Map(seed);
  bypass.set(composition, seed.get(composition).replace("prepared.step.execute();", "if (input.bypass) return null; prepared.step.execute();"));
  violation(inspect(bypass), "A10", composition);
  success(inspect());
});

test("operation preparation cannot pass an acquired writer without its static type guard", () => {
  const file = "src/flow/engine/composition/artifact-worker-recovery.js";
  const files = new Map(seed);
  files.set(file, seed.get(file).replace(
    'if (!(writer instanceof ArtifactWorkerRecoveryWriter)) throw new TypeError("Artifact recovery requires its acquired save capability");', ""));
  violation(inspect(files), "A12", file);
  success(inspect());
});

test("operation initialization cannot run eagerly or expose its cached registration authority", () => {
  const file = "src/flow/engine/composition/artifact-worker-recovery.js";
  const eager = new Map(seed);
  eager.set(file, `${seed.get(file)}\nartifactWorkerRecoveryRegistrations();\n`);
  violation(inspect(eager), "A10", file);
  const escaped = new Map(seed);
  escaped.set(file, `${seed.get(file)}\nexport const escaped = artifactWorkerRecoveryRegistrationsCache;\n`);
  violation(inspect(escaped), "A10", file);
  const namespaced = new Map(seed);
  const consumer = "src/flow/lib/operation-escape.js";
  namespaced.set(consumer, 'import * as recovery from "../engine/composition/artifact-worker-recovery.js"; export function bypass(id) { return recovery.artifactWorkerRecoveryRegistration(id); }');
  violation(inspect(namespaced), "A10", consumer);
  success(inspect());
});

test("operation composition is acquired outside exclusion and cannot escape its declared synchronous consumer", () => {
  const file = "src/flow/lib/worker-artifact-handoff.js";
  const acquisition = 'const { executeArtifactWorkerRecovery } = await import("../engine/composition/artifact-worker-recovery.js");';
  const eager = new Map(seed);
  eager.set(file, 'import { executeArtifactWorkerRecovery } from "../engine/composition/artifact-worker-recovery.js";\n'
    + seed.get(file).replace(acquisition, ""));
  violation(inspect(eager), "A10", file);
  const escaped = new Map(seed);
  escaped.set(file, seed.get(file).replace(acquisition, `${acquisition}\nconst escapedOperation = executeArtifactWorkerRecovery;`));
  violation(inspect(escaped), "A10", file);
  const insideExclusion = new Map(seed);
  insideExclusion.set(file, seed.get(file).replace(acquisition, "").replace(
    '}, (physicalEvidence) => {\n      const current = ctx.flowManager.artifactWorkerExecutionState',
    `}, async (physicalEvidence) => {\n      ${acquisition}\n      const current = ctx.flowManager.artifactWorkerExecutionState`));
  violation(inspect(insideExclusion), "A10", file);
  success(inspect());
});
