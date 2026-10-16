import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FlowManager } from "../../src/lib/flow-manager.js";
import { ActiveFlowRegistry } from "../../src/lib/active-flow-registry.js";
import { FlowTargetIdentityAuthority } from "../../src/lib/flow-target-identity-authority.js";
import { CurrentFlowVersionStore } from "../../src/flow/lib/current-flow-state.js";
import { buildCurrentFlowDefinition } from "../../src/flow/definition.js";
import { CanonicalFlowFixture } from "../support/infrastructure/flow-setup.js";
import { dispatchContainer, dispatchFlowCommand } from "../support/infrastructure/flow-dispatch-scenario.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { SeedWorkRoot } from "../support/builders/seed-work-root.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";

const LEGACY_SEED = fileURLToPath(new URL("../fixtures/legacy-activity-v1/project", import.meta.url));
const LEGACY_SPEC_ID = "001-legacy-activity";
const CLI = path.resolve("src/sennel.js");

function project(t, specId = "2bfc-format-guidance") {
  const root = createTmpDir("sennel-flow-format-");
  t.after(() => removeTmpDir(root));
  writeJson(root, ".sennel/config.json", { flow: { specDir: "specs" } });
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  return { root, specId, manager };
}

function storedSnapshot(root) {
  return new StoredFlowPersistenceSnapshot(root, { ignoredDirectories: [".tmp"] });
}

function assertMigrationPreview(result) {
  assert.equal(result.data.directive.kind, "single_user_action");
  assert.equal(result.data.directive.actionId, "PREVIEW_FLOW_MIGRATION");
  assert.equal(result.guidance.nextAction.kind, "single_user_action");
  assert.equal(result.guidance.nextAction.instruction, result.data.directive.instruction);
  assert.ok(result.guidance.nextAction.instruction.includes(result.data.dryRunCommand));
  assert.match(result.guidance.nextAction.instruction, /revision order \(2, 3\)/);
  for (const field of ["command", "binding", "nextAction", "continuation"]) {
    assert.equal(Object.hasOwn(result.data.directive, field), false);
  }
}

async function refusal(manager, root, group, name, argv = []) {
  return (await dispatchFlowCommand({
    container: dispatchContainer({ root, flowManager: manager }), group, name, argv,
  })).envelope;
}

describe("normal Flow persisted format refusal", () => {
  it("guides indexed legacy reads and mutations through ordered targeted migrations without changing data", async (t) => {
    const clone = new SeedWorkRoot(LEGACY_SEED, { prefix: "sennel-flow-guidance-" });
    t.after(() => clone.cleanup());
    const root = clone.root;
    const raw = JSON.parse(fs.readFileSync(path.join(root, "specs", LEGACY_SPEC_ID, "001", "flow.json"), "utf8"));
    new ActiveFlowRegistry({ mainRoot: root }).add(LEGACY_SPEC_ID, "direct");
    new FlowTargetIdentityAuthority({ mainRoot: root }).addActive(raw, "direct");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    const before = storedSnapshot(root);
    const guard = ["--expect-spec", LEGACY_SPEC_ID, "--expect-run-id", raw.runId];
    for (const [group, name, argv] of [["get", "next-action", guard], ["get", "artifact", ["spec.record", "--mode", "full", ...guard]], ["set", "auto", ["on", ...guard]]]) {
      const result = await refusal(manager, root, group, name, argv);
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, "FLOW_MIGRATION_REQUIRED");
      assert.match(result.errors[0].messages[0], /migration/i);
      assert.equal(result.data.specId, LEGACY_SPEC_ID);
      assert.match(result.data.sourceContract, /flow-schema-3/);
      assert.deepEqual(result.data.requiredRevisions, [2, 3]);
      assert.equal(result.data.targetMigrationRevision, 2);
      assert.equal(result.data.dryRunCommand, `sennel migrate specs --to 2 --spec ${LEGACY_SPEC_ID} --dry-run`);
      assert.deepEqual(result.data.migrations.map((migration) => migration.applyCommand), [2, 3].map((revision) =>
        `sennel migrate specs --to ${revision} --spec ${LEGACY_SPEC_ID}`));
      assert.equal(result.data.canonicalChanged, false);
      assert.equal(result.data.continuationReady, false);
      assertMigrationPreview(result);
      assert.equal(storedSnapshot(root).digest, before.digest);
    }
    assert.throws(() => new CurrentFlowVersionStore({
      location: manager.canonicalVersionLocation(1, { specId: LEGACY_SPEC_ID }), definition: buildCurrentFlowDefinition(),
    }).load(), (error) => error.code !== "FLOW_MIGRATION_REQUIRED");
    const executable = spawnSync(process.execPath, [CLI, "flow", "get", "artifact", "spec.record", "--mode", "full", ...guard], {
      cwd: root, encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
    });
    assert.equal(executable.status, 1, executable.stderr);
    const result = JSON.parse(executable.stdout);
    assert.equal(result.errors[0].code, "FLOW_MIGRATION_REQUIRED");
    assert.equal(result.data.dryRunCommand, `sennel migrate specs --to 2 --spec ${LEGACY_SPEC_ID} --dry-run`);
    assertMigrationPreview(result);
    assert.equal(storedSnapshot(root).digest, before.digest);
  });

  it("reports pre-Version data as unsupported for both reads and mutations without accepting it", async (t) => {
    const { root, specId, manager } = project(t);
    writeJson(root, `specs/${specId}/flow.json`, { request: "Saved before Versions", steps: [] });
    const before = storedSnapshot(root);
    for (const [group, name, argv] of [["get", "status", []], ["set", "auto", ["on"]]]) {
      const result = await refusal(manager, root, group, name, argv);
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, "FLOW_FORMAT_UNSUPPORTED");
      assert.equal(result.data.specId, specId);
      assert.equal(result.data.canonicalChanged, false);
      assert.deepEqual(result.data.migrations, []);
      assert.notEqual(result.data.directive.actionId, "PREVIEW_FLOW_MIGRATION");
      assert.equal(storedSnapshot(root).digest, before.digest);
    }
  });

  it("separates an unknown state revision from a supported migration", async (t) => {
    const { root, specId, manager } = project(t);
    new CanonicalFlowFixture({ flowManager: manager, specId }).create();
    const file = manager.specLocation(specId).flowStateFile;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.schemaRevision = 99;
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    const before = storedSnapshot(root);
    const result = await refusal(manager, root, "get", "status");
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "FLOW_FORMAT_UNSUPPORTED");
    assert.match(result.data.sourceContract, /flow-schema-99/);
    assert.equal(result.data.dryRunCommand, null);
    assert.notEqual(result.data.directive.actionId, "PREVIEW_FLOW_MIGRATION");
    assert.equal(storedSnapshot(root).digest, before.digest);
  });

  it("keeps modified canonical evidence an integrity error with no migration permission", async (t) => {
    const { root, specId, manager } = project(t);
    new CanonicalFlowFixture({ flowManager: manager, specId }).create();
    const file = manager.specLocation(specId).activitiesFile;
    fs.appendFileSync(file, "{\"altered\":true}\n");
    const before = storedSnapshot(root);
    const result = await refusal(manager, root, "set", "auto", ["on"]);
    assert.equal(result.ok, false);
    assert.notEqual(result.errors[0].code, "FLOW_MIGRATION_REQUIRED");
    assert.notEqual(result.errors[0].code, "FLOW_FORMAT_UNSUPPORTED");
    assert.equal(result.data.canonicalChanged, false);
    assert.equal(result.data.continuationReady, false);
    assert.deepEqual(result.data.migrations, []);
    assert.notEqual(result.data.directive.actionId, "PREVIEW_FLOW_MIGRATION");
    assert.equal(storedSnapshot(root).digest, before.digest);
    assert.equal(fs.existsSync(path.join(root, ".sennel", "migrations", "specs")), false);
  });
});
