import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { brotliDecompressSync } from "node:zlib";
import { afterEach, describe, it } from "node:test";

import { buildCurrentFlowDefinition } from "../../src/flow/definition.js";
import { SpecGateRepairService } from "../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairStep } from "../../src/flow/steps/spec/spec-gate-repair.js";
import { StepFactory } from "../../src/flow/engine/step-factory.js";
import { WorkerArtifactHandoffCoordinator } from "../../src/flow/lib/worker-artifact-handoff.js";
import { DraftReopenContext } from "../../src/flow/lib/draft-reopen-context.js";
import { readSpecGateRepairInput } from "../../src/flow/lib/spec-gate-repair-input.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { CanonicalRevisionRootTransaction, SpecsMigrationTransaction } from "../../src/lib/specs-migration.js";
import { resolveMigrationSpecRoot } from "../../src/lib/migration-spec-root.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";

const CLI = path.resolve("src/sennel.js");
const SPEC_ID = "113af64a-flow-help-contract";
const roots = [];

function seed() {
  const root = createTmpDir("sennel-retired-decision-");
  roots.push(root);
  writeJson(root, ".sennel/config.json", {
    lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
    flow: { specDir: "specs" },
  });
  const version = path.join(root, "specs", SPEC_ID, "001");
  const archive = fs.readFileSync(new URL("../fixtures/spec-gate-repair-retired-decision.json.br", import.meta.url));
  const files = JSON.parse(brotliDecompressSync(archive).toString("utf8"));
  for (const [relativePath, encoded] of files) {
    const destination = path.join(version, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(encoded, "base64"));
  }
  const issueLog = JSON.parse(fs.readFileSync(path.join(version, "issue-log.json"), "utf8"));
  const ids = new Set(issueLog.entries.flatMap((entry) => (
    entry.planGateRepair?.phase === "spec"
      ? entry.planGateRepair.observations.map((observation) => observation.requirementRef)
      : []
  )));
  writeJson(root, ".sennel/guardrail.json", { guardrails: [...ids].map((id) => ({
    id, body: `Preserve canonical evidence for ${id}.`,
    meta: { category: "requirements", phase: ["spec"] },
  })) });
  const savedState = JSON.parse(fs.readFileSync(path.join(version, "flow.json"), "utf8"));
  const worktreePath = manager(root).resolveWorktreePaths(savedState).worktreePath;
  assert.ok(worktreePath);
  fs.mkdirSync(worktreePath, { recursive: true });
  writeJson(worktreePath, ".sennel/guardrail.json", { guardrails: [...ids].map((id) => ({
    id, body: `Preserve canonical evidence for ${id}.`,
    meta: { category: "requirements", phase: ["spec"] },
  })) });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Main repository rules: consult the release ledger.\n");
  fs.writeFileSync(path.join(worktreePath, "AGENTS.md"),
    "Feature execution rules: review the migrated Spec Gate question.\n");
  return { root, version, worktreePath };
}

function migrate(root, args = []) {
  return spawnSync(process.execPath, [CLI, "migrate", "specs", "--to", "4", ...args], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
  });
}

function activityLedger(version) {
  return fs.readFileSync(path.join(version, "activities.jsonl"), "utf8").trimEnd()
    .split("\n").map((line) => JSON.parse(line));
}

function replaceCatalogArtifact(version, relativePath, bytes) {
  fs.writeFileSync(path.join(version, relativePath), bytes);
  const catalogFile = path.join(version, "artifact-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const descriptor = catalog.artifacts.find((entry) => entry.relativePath === relativePath);
  assert.ok(descriptor, `missing Catalog descriptor: ${relativePath}`);
  descriptor.hash = crypto.createHash("sha256").update(bytes).digest("hex");
  descriptor.size = bytes.length;
  fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
}

function manager(root) {
  return new FlowManager({ root, mainRoot: root, inWorktree: false, specId: SPEC_ID });
}

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

describe("migrate specs --to 4", () => {
  it("projects an old active question into canonical Draft return input, preserves notes and exact archived sources, and is idempotent", () => {
    const { root, version, worktreePath } = seed();
    const original = Object.fromEntries(["flow.json", "activities.jsonl", "artifact-catalog.json"]
      .map((name) => [name, fs.readFileSync(path.join(version, name))]));
    const oldActivities = activityLedger(version);
    const oldQuestion = oldActivities.find((entry) => entry.result?.stepResult?.kind === "spec-gate-repair-awaiting-decision");
    assert.ok(oldQuestion);
    const publicationPath = `artifacts/spec-gate-repairs/${oldQuestion.attemptId}/progress/1-publication.json`;
    const originalPublication = fs.readFileSync(path.join(version, publicationPath));
    const preview = migrate(root, ["--dry-run"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /"legacyQuestionCount":1/);
    assert.deepEqual(fs.readFileSync(path.join(version, "activities.jsonl")), original["activities.jsonl"]);

    const migrated = migrate(root);
    assert.equal(migrated.status, 0, migrated.stderr);
    const archiveRoot = path.join(version, "artifacts/migration/spec-gate-decision-v4");
    for (const [name, bytes] of Object.entries(original)) {
      assert.deepEqual(fs.readFileSync(path.join(archiveRoot, name)), bytes);
    }
    assert.deepEqual(fs.readFileSync(path.join(archiveRoot, publicationPath)), originalPublication);
    const state = manager(root).canonicalState(SPEC_ID);
    assert.equal(state.current.at(-1), "spec-gate-repair");
    assert.equal(state.confirmationOrder, oldActivities.length);
    const current = manager(root).readCurrentStepSettlement({ specId: SPEC_ID, stepId: "spec-gate-repair" });
    assert.equal(current.result.kind, "spec-gate-repair-context-required");
    assert.equal(current.receipt.settlementKind, "execution");
    const newActivities = activityLedger(version);
    assert.deepEqual(newActivities.filter((entry) => entry.type === "note_recorded"),
      oldActivities.filter((entry) => entry.type === "note_recorded"));
    const publication = JSON.parse(fs.readFileSync(path.join(version, publicationPath), "utf8"));
    assert.equal(publication.proposal.stage, "spec-gate-repair-draft-return");
    assert.equal(publication.proposal.decision, JSON.parse(originalPublication).proposal.question);
    assert.match(publication.proposal.unresolvedBecause, /legacy worker record did not explain/);
    const worktreeSource = readSpecGateRepairInput({ flowManager: manager(root), state,
      executionRoot: worktreePath });
    const mainSource = readSpecGateRepairInput({ flowManager: manager(root), state,
      executionRoot: root });
    assert.equal(publication.context.evidenceDigest, worktreeSource.context.evidenceDigest,
      "migration baseline must use the Flow execution worktree");
    assert.notEqual(publication.context.evidenceDigest, mainSource.context.evidenceDigest,
      "main repository evidence differs from the active worktree");
    assert.equal(migrate(root).status, 0, "repeated migration must be a no-op");
    assert.deepEqual(fs.readFileSync(path.join(version, "activities.jsonl")),
      Buffer.from(newActivities.map((entry) => `${JSON.stringify(entry)}\n`).join("")));
    manager(root).reopenDraft({ specId: SPEC_ID, route: "preimplementation",
      reason: "Review the migrated decision with the canonical Draft questions" });
    const reloaded = manager(root).canonicalState(SPEC_ID);
    assert.equal(reloaded.current.at(-1), "draft");
    assert.equal(reloaded.confirmationOrder, oldActivities.length + 1);
    assert.equal(manager(root).activityLedger(SPEC_ID).find((entry) => (
      entry.id === oldQuestion.id
    ))?.result?.stepResult?.kind, "spec-gate-repair-context-required",
    "completed history must remain readable after Draft reopen");
  });

  it("recovers a root swap interrupted after source backup without losing the projected ledger", () => {
    const { root, version } = seed();
    const specRoot = resolveMigrationSpecRoot(root).root;
    const transaction = new CanonicalRevisionRootTransaction({
      root, specRoot, specId: SPEC_ID, definition: buildCurrentFlowDefinition(), revision: 4,
      faultInjector({ phase }) {
        if (phase === "source-backed-up") throw new Error("injected stop after backup");
      },
    });
    assert.throws(() => transaction.apply(), /injected stop/);
    assert.equal(fs.existsSync(version), false);
    const recovered = SpecsMigrationTransaction.recoverAll({ root, specRoot, dryRun: false });
    assert.equal(recovered[0].recovered, "placed-staging");
    const state = manager(root).canonicalState(SPEC_ID);
    assert.equal(state.current.at(-1), "spec-gate-repair");
    assert.equal(manager(root).readCurrentStepSettlement({ specId: SPEC_ID,
      stepId: "spec-gate-repair" }).result.kind, "spec-gate-repair-context-required");
    assert.equal(migrate(root).status, 0);
  });

  it("refuses a catalog-bound question publication that no longer matches the saved worker claim", () => {
    const { root, version } = seed();
    const oldQuestion = activityLedger(version).find((entry) => (
      entry.result?.stepResult?.kind === "spec-gate-repair-awaiting-decision"
    ));
    const publicationPath = `artifacts/spec-gate-repairs/${oldQuestion.attemptId}/progress/1-publication.json`;
    const publicationFile = path.join(version, publicationPath);
    const publication = JSON.parse(fs.readFileSync(publicationFile, "utf8"));
    publication.requestDigest = "f".repeat(64);
    const changed = Buffer.from(`${JSON.stringify(publication, null, 2)}\n`);
    replaceCatalogArtifact(version, publicationPath, changed);
    const before = fs.readFileSync(path.join(version, "activities.jsonl"));
    const refused = migrate(root);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not bound to its Attempt/);
    assert.deepEqual(fs.readFileSync(path.join(version, "activities.jsonl")), before);
    assert.equal(fs.existsSync(path.join(version, "artifacts/migration/spec-gate-decision-v4")), false);
  });

  it("requires earlier revisions before projecting a legacy root or schema three Version", () => {
    const { root, version } = seed();
    const legacyRoot = path.join(root, "specs", SPEC_ID, "flow.json");
    fs.copyFileSync(path.join(version, "flow.json"), legacyRoot);
    const legacy = migrate(root);
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /REVISION_TWO_REQUIRED/);
    fs.unlinkSync(legacyRoot);
    const raw = JSON.parse(fs.readFileSync(path.join(version, "flow.json"), "utf8"));
    raw.schemaRevision = 3;
    replaceCatalogArtifact(version, "flow.json", Buffer.from(`${JSON.stringify(raw, null, 2)}\n`));
    const earlier = migrate(root);
    assert.equal(earlier.status, 1);
    assert.match(earlier.stderr, /REVISION_THREE_REQUIRED/);
    assert.equal(fs.existsSync(path.join(version, "artifacts/migration/spec-gate-decision-v4")), false);
  });

  it("validates an already projected Version before accepting it as migrated", () => {
    const { root, version } = seed();
    assert.equal(migrate(root).status, 0);
    const catalogFile = path.join(version, "artifact-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    catalog.artifacts.find((entry) => entry.relativePath === "spec.json").hash = "f".repeat(64);
    fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
    const refused = migrate(root);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Catalog|hash|digest/i);
  });

  it("projects byte-exact retired history after an owner-produced Draft return with no former worktree", () => {
    const { root, version, worktreePath } = seed();
    const oldActivities = activityLedger(version);
    const oldQuestion = oldActivities.find((entry) => (
      entry.result?.stepResult?.kind === "spec-gate-repair-awaiting-decision"
    ));
    assert.ok(oldQuestion);
    const publicationPath = `artifacts/spec-gate-repairs/${oldQuestion.attemptId}/progress/1-publication.json`;
    const originalPublication = fs.readFileSync(path.join(version, publicationPath));
    assert.equal(migrate(root).status, 0);
    manager(root).reopenDraft({ specId: SPEC_ID, route: "preimplementation",
      reason: "Continue the historical Draft" });
    // Only the archived old settlement and publication are restored; the later
    // Draft transition and all other canonical state come from FlowManager.
    const historicalActivities = activityLedger(version);
    const restored = historicalActivities.map((entry) => (
      entry.id === oldQuestion.id ? oldQuestion : entry
    ));
    replaceCatalogArtifact(version, "activities.jsonl",
      Buffer.from(restored.map((entry) => `${JSON.stringify(entry)}\n`).join("")));
    replaceCatalogArtifact(version, publicationPath, originalPublication);
    const archiveRelative = "artifacts/migration/spec-gate-decision-v4";
    fs.rmSync(path.join(version, archiveRelative), { recursive: true });
    const catalogFile = path.join(version, "artifact-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    catalog.artifacts = catalog.artifacts.filter((entry) => (
      !entry.relativePath.startsWith(`${archiveRelative}/`)
    ));
    fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
    fs.rmSync(worktreePath, { recursive: true });

    const migrated = migrate(root);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.equal(manager(root).canonicalState(SPEC_ID).current.at(-1), "draft");
    assert.equal(manager(root).activityLedger(SPEC_ID).find((entry) => (
      entry.id === oldQuestion.id
    ))?.result?.stepResult?.kind, "spec-gate-repair-context-required");
    assert.deepEqual(fs.readFileSync(path.join(version, archiveRelative, publicationPath)),
      originalPublication);
  });

  it("replays a long retired question through the ordinary Step and gives Draft the unverified later notes", async () => {
    const { root, version, worktreePath } = seed();
    const oldQuestion = activityLedger(version).find((entry) => (
      entry.result?.stepResult?.kind === "spec-gate-repair-awaiting-decision"
    ));
    const publicationPath = `artifacts/spec-gate-repairs/${oldQuestion.attemptId}/progress/1-publication.json`;
    const publicationFile = path.join(version, publicationPath);
    const publication = JSON.parse(fs.readFileSync(publicationFile, "utf8"));
    const longDecision = `Which migration decision applies? ${"Review the saved evidence. ".repeat(25)}`;
    assert.ok(longDecision.length > 500);
    publication.proposal.question = longDecision;
    const changed = Buffer.from(`${JSON.stringify(publication, null, 2)}\n`);
    replaceCatalogArtifact(version, publicationPath, changed);
    assert.equal(migrate(root).status, 0);
    const flowManager = manager(root);
    const state = flowManager.canonicalState(SPEC_ID);
    const ctx = { root: worktreePath, mainRoot: root, executionRoot: worktreePath,
      specId: SPEC_ID, flowManager };
    const coordinator = new WorkerArtifactHandoffCoordinator();
    const plan = SpecGateRepairService.planWorkerExecution({ ctx, state,
      handoffCoordinator: coordinator });
    assert.equal(plan.canonicalReplay, true);
    assert.equal(plan.sealedReplay, false);
    assert.equal(plan.request, null);
    const service = await SpecGateRepairService.resumePublished({
      ctx, state, handoffCoordinator: coordinator,
    });
    const result = await new StepFactory().provide(SpecGateRepairService, service)
      .create(SpecGateRepairStep).execute();
    assert.equal(result.kind, "spec-gate-repair-draft-return-required");
    const resumed = manager(root).canonicalState(SPEC_ID);
    assert.equal(resumed.current.at(-1), "draft");
    const issue = manager(root).readArtifact({ specId: SPEC_ID, logicalKey: "issue.log",
      consumerNodeId: "draft" });
    const draftInput = DraftReopenContext.fromIssueLog(JSON.parse(issue.bytes), resumed.attempt.id);
    assert.equal(draftInput.reason, longDecision);
    assert.match(draftInput.source.evidence, /Unverified related note Activity/);
    assert.match(draftInput.source.evidence, /import graph confirms docs group help/);
    assert.deepEqual(draftInput.previousDraft.questionLedger.questions, [],
      "migration and reopen must not create an Answer or a resolved question");
  });
});
