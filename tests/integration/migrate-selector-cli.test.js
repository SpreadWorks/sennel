import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { brotliDecompressSync } from "node:zlib";
import { afterEach, describe, it } from "node:test";

import { MigrationSpecSelection, resolveMigrationSpecRoot } from "../../src/lib/migration-spec-root.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { ActiveFlowRegistry } from "../../src/lib/active-flow-registry.js";
import { FlowTargetIdentityAuthority } from "../../src/lib/flow-target-identity-authority.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";

const CHECKOUT = path.resolve(".");
const CLI = path.join(CHECKOUT, "src/sennel.js");
const SPEC_ID = "113af64a-flow-help-contract";
const V1_SPEC_ID = "001-legacy-activity";
const roots = [];

function project() {
  const root = createTmpDir("sennel-migrate-selector-");
  roots.push(root);
  writeJson(root, ".sennel/config.json", {
    lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
    logs: { enabled: true }, flow: { specDir: "nested/specs" },
  });
  return root;
}

function seedHistoricalQuestion(root) {
  const version = path.join(root, "nested/specs", SPEC_ID, "001");
  const archive = fs.readFileSync(new URL("../fixtures/spec-gate-repair-retired-decision.json.br", import.meta.url));
  for (const [relativePath, encoded] of JSON.parse(brotliDecompressSync(archive).toString("utf8"))) {
    const destination = path.join(version, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(encoded, "base64"));
  }
  const state = JSON.parse(fs.readFileSync(path.join(version, "flow.json"), "utf8"));
  const executionRoot = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: SPEC_ID })
    .resolveWorktreePaths(state).worktreePath;
  fs.mkdirSync(executionRoot, { recursive: true });
  fs.writeFileSync(path.join(executionRoot, "AGENTS.md"), "Review the saved historical repair evidence.\n");
  return version;
}

function seedHistoricalActivity(root) {
  const source = new URL(`../fixtures/legacy-activity-v1/project/specs/${V1_SPEC_ID}/`, import.meta.url);
  const target = path.join(root, "nested/specs", V1_SPEC_ID);
  fs.cpSync(source, target, { recursive: true });
}

function invoke(root, args, { cli = CLI, cwd = root } = {}) {
  return invokeCli(root, ["migrate", ...args], { cli, cwd });
}

function invokeCli(root, args, { cli = CLI, cwd = root } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
  });
}

function snapshot(root) {
  return new StoredFlowPersistenceSnapshot(root, { ignoredDirectories: [".git", ".tmp", "worktree"] }).digest;
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function logRecords(root) {
  const records = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".jsonl")) records.push(...fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    }
  };
  visit(path.join(root, ".tmp"));
  return records;
}

afterEach(() => {
  while (roots.length) removeTmpDir(roots.pop());
});

describe("literal migration target selection", () => {
  it("rejects nonexistent and unsafe selected entries without falling back to a different spec", () => {
    const root = project();
    seedHistoricalActivity(root);
    const specRoot = resolveMigrationSpecRoot(root).root;
    assert.throws(() => MigrationSpecSelection.from("515-missing").entries(specRoot), { code: "SPEC_NOT_FOUND" });
    fs.symlinkSync(path.join(specRoot.path, V1_SPEC_ID), path.join(specRoot.path, "515-symlink"));
    assert.throws(() => MigrationSpecSelection.from("515-symlink").entries(specRoot), { code: "UNSAFE_SPEC_ROOT_ENTRY" });
    fs.writeFileSync(path.join(specRoot.path, "515-file"), "preserve\n");
    assert.throws(() => MigrationSpecSelection.from("515-file").entries(specRoot), { code: "UNSAFE_SPEC_ROOT_ENTRY" });
    const before = snapshot(root);
    const result = invoke(root, ["specs", "--to", "4", "--spec", "515-missing"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /SPEC_NOT_FOUND|selected spec does not exist/);
    assert.deepEqual(snapshot(root), before);
  });

  it("limits discovery and recovery to the configured root and literal selected spec", () => {
    const root = project();
    seedHistoricalQuestion(root);
    writeJson(root, "nested/specs/515-unrelated/flow.json", { schemaRevision: "unknown" });
    writeJson(root, ".tmp/sennel-migrate-specs/unrelated.json", { damaged: true });
    const before = snapshot(root);
    const journals = path.join(root, ".tmp/sennel-migrate-specs");
    const journalsBefore = snapshot(journals);
    const result = invoke(root, ["specs", "--to", "4", "--spec", SPEC_ID, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    const reports = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].specId, SPEC_ID);
    assert.equal(reports[0].versions[0].legacyQuestionCount, 1);
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(snapshot(journals), journalsBefore);
    const all = invoke(root, ["specs", "--to", "4", "--dry-run"]);
    assert.equal(all.status, 1, all.stdout);
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(snapshot(journals), journalsBefore);
  });

  it("selects only exact journal names for the selected spec before parsing unrelated files", () => {
    const root = project();
    const specRoot = resolveMigrationSpecRoot(root).root;
    const selection = MigrationSpecSelection.from(SPEC_ID);
    const directory = path.join(root, "journal-selection");
    fs.mkdirSync(directory);
    const selectedName = selection.journalFileName(specRoot, 3);
    fs.writeFileSync(path.join(directory, selectedName), "selected bytes");
    fs.writeFileSync(path.join(directory, "unrelated.json"), "{broken");
    fs.symlinkSync(path.join(directory, "unrelated.json"), path.join(directory, "foreign-link.json"));
    assert.deepEqual(selection.recoveryEntries(specRoot, directory).map((entry) => entry.name), [selectedName]);
    assert.equal(MigrationSpecSelection.from(null).recoveryEntries(specRoot, directory).length, 3);
  });
});

describe("migration executable attribution", () => {
  it("migrates the main canonical Flow from the worktree bootstrap, preserves the copied source, and restores normal action reads", () => {
    const root = project();
    seedHistoricalActivity(root);
    fs.cpSync(path.join(CHECKOUT, "src"), path.join(root, "src"), { recursive: true });
    writeJson(root, "package.json", { name: "@fixture/sennel-selector", type: "module", version: "0.0.0" });
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "Immutable migration CLI fixture"]);
    const worktree = path.join(root, "worktree");
    git(root, ["worktree", "add", worktree, "-b", "feature"]);
    const version = path.join(root, "nested/specs", V1_SPEC_ID, "001");
    const raw = JSON.parse(fs.readFileSync(path.join(version, "flow.json"), "utf8"));
    new ActiveFlowRegistry({ mainRoot: root, specRoot: "nested/specs" }).add(V1_SPEC_ID, "direct");
    new FlowTargetIdentityAuthority({ mainRoot: root, specRoot: "nested/specs" }).addActive(raw, "direct");
    const authorityBefore = new StoredFlowPersistenceSnapshot(path.join(root, ".sennel"));
    const invocation = { cli: path.join(root, "src/sennel.js"), cwd: worktree };
    const guard = ["--expect-spec", V1_SPEC_ID, "--expect-run-id", raw.runId];
    const before = snapshot(root);
    const worktreeBefore = snapshot(worktree);
    const originalRead = invokeCli(root, ["flow", "get", "next-action", ...guard], invocation);
    assert.equal(originalRead.status, 1, originalRead.stderr);
    const originalRefusal = JSON.parse(originalRead.stdout);
    assert.equal(originalRefusal.errors[0].code, "FLOW_MIGRATION_REQUIRED");
    assert.deepEqual(originalRefusal.data.requiredRevisions, [2, 3]);
    assert.equal(originalRefusal.data.dryRunCommand, `sennel migrate specs --to 2 --spec ${V1_SPEC_ID} --dry-run`);
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(snapshot(worktree), worktreeBefore);
    const preview = invoke(root, ["specs", "--to", "2", "--spec", V1_SPEC_ID, "--dry-run"], {
      cli: path.join(root, "src/sennel.js"), cwd: worktree,
    });
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).specId, V1_SPEC_ID);
    assert.equal(preview.stderr, "");
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(snapshot(worktree), worktreeBefore);
    const records = logRecords(root).filter((record) => record.entryCommand.startsWith("migrate "));
    assert.ok(records.some((record) => record.name === "config-loaded"));
    assert.ok(records.every((record) => record.specId == null && record.flowPhase == null && record.taskId === null));
    const help = invoke(root, ["--help"], { cli: path.join(root, "src/sennel.js"), cwd: worktree });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--spec <specId>/);
    assert.match(help.stdout, /omit for all specs/);
    assert.equal(help.stderr, "");
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(snapshot(worktree), worktreeBefore);
    const applied = invoke(root, ["specs", "--to", "2", "--spec", V1_SPEC_ID], {
      cli: path.join(root, "src/sennel.js"), cwd: worktree,
    });
    assert.equal(applied.status, 0, applied.stderr);
    const [assessmentLine, successLine, end] = applied.stdout.split("\n");
    const report = JSON.parse(assessmentLine);
    assert.equal(report.component, "specs");
    assert.equal(report.appliedMigrationRevision, 2);
    const assessment = report.remaining;
    assert.equal(assessment.specId, V1_SPEC_ID);
    assert.deepEqual(assessment.requiredRevisions, [3]);
    assert.equal(assessment.continuationReady, false);
    assert.equal(assessment.dryRunCommand, `sennel migrate specs --to 3 --spec ${V1_SPEC_ID} --dry-run`);
    assert.deepEqual(assessment.migrations, [{ revision: 3,
      dryRunCommand: `sennel migrate specs --to 3 --spec ${V1_SPEC_ID} --dry-run`,
      applyCommand: `sennel migrate specs --to 3 --spec ${V1_SPEC_ID}` }]);
    assert.equal(successLine, "migrate specs reached revision 2");
    assert.equal(end, "");
    assert.equal(applied.stderr, "");
    assert.ok(fs.existsSync(path.join(version, "revisions/001/spec.json")));
    assert.deepEqual(snapshot(worktree), worktreeBefore);
    authorityBefore.assertUnchanged();
    const stageTwoRead = invokeCli(root, ["flow", "get", "next-action", ...guard], invocation);
    assert.equal(stageTwoRead.status, 1, stageTwoRead.stderr);
    const stageTwoRefusal = JSON.parse(stageTwoRead.stdout);
    assert.equal(stageTwoRefusal.errors[0].code, "FLOW_MIGRATION_REQUIRED");
    assert.deepEqual(stageTwoRefusal.data.requiredRevisions, [3]);
    assert.equal(stageTwoRefusal.data.dryRunCommand, assessment.dryRunCommand);
    const stageThreePreview = invoke(root, ["specs", "--to", "3", "--spec", V1_SPEC_ID, "--dry-run"], invocation);
    assert.equal(stageThreePreview.status, 0, stageThreePreview.stderr);
    const finalApply = invoke(root, ["specs", "--to", "3", "--spec", V1_SPEC_ID], invocation);
    assert.equal(finalApply.status, 0, finalApply.stderr);
    assert.equal(finalApply.stdout, "migrate specs reached revision 3\n");
    assert.equal(finalApply.stderr, "");
    const finalBeforeRead = snapshot(root);
    const normalRead = invokeCli(root, ["flow", "get", "next-action", ...guard], invocation);
    assert.equal(normalRead.status, 0, normalRead.stderr || normalRead.stdout);
    const next = JSON.parse(normalRead.stdout);
    assert.equal(next.ok, true);
    assert.equal(next.data.step, "prepare-spec");
    const state = new FlowManager({ root: worktree, mainRoot: root, inWorktree: true, specId: V1_SPEC_ID, specRoot: "nested/specs" })
      .canonicalState(V1_SPEC_ID);
    assert.equal(state.runId, raw.runId);
    assert.deepEqual(state.lifecycle.toJSON(), raw.lifecycle);
    assert.deepEqual(state.findNode("branch").toJSON(), raw.steps[0].steps.find((entry) => entry.id === "branch"));
    assert.equal(state.current, null);
    assert.equal(state.nextAction().nodeId, "prepare-spec");
    assert.deepEqual(snapshot(root), finalBeforeRead);
    assert.deepEqual(snapshot(worktree), worktreeBefore);
    authorityBefore.assertUnchanged();
    assert.equal(fs.existsSync(path.join(worktree, ".sennel/flow-identity.json")), false);
    assert.equal(fs.existsSync(path.join(worktree, ".sennel/.active-flow")), false);
    assert.ok(logRecords(root).filter((record) => record.entryCommand.startsWith("migrate "))
      .every((record) => record.specId == null && record.flowPhase == null && record.taskId === null));
  });
});
