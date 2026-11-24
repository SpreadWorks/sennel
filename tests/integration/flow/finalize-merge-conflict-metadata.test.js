import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, mock, test } from "node:test";
import { execFileSync } from "node:child_process";
import { FinalizationPhaseScenario } from "../../support/finalization-phase-scenario.js";
import { SeedCleanupScope } from "../../support/builders/seed-work-root.js";
import { CanonicalPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";
import { getWorktreeStatus } from "../../../src/lib/git-helpers.js";
import { FinalizeFlowArtifactRegistry } from "../../../src/flow/lib/repair-state-identity.js";
import { FinalizeMergeTransactionError } from "../../../src/flow/lib/finalize-merge-transaction.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { FlowOutboxStore, finalizationOutboxIdentity } from "../../../src/flow/lib/flow-outbox.js";

const seedScope = new SeedCleanupScope(after, mock);
let mergeSeed;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

async function setupFixture(t) {
  mergeSeed ??= FinalizationPhaseScenario.seed(seedScope, { frontier: "finalize-merge" });
  const scenario = FinalizationPhaseScenario.fromSeed(t, await mergeSeed);
  const { root, manager, specId } = scenario;
  return { root, manager, specId, state: manager.loadReadOnly(specId), ctx: scenario.context() };
}

test("persists only active-spec metadata after finalize-merge conflict", async (t) => {
  const { root, manager, specId, ctx } = await setupFixture(t);
  const location = manager.specLocation(specId);
  const options = { pathspecExcludes: new FinalizeFlowArtifactRegistry(location.relativeSpecFile).gitPathspecExcludes() };
  const projectBefore = getWorktreeStatus(root, options);
  assert.equal(projectBefore.dirty, false, "the real producer must leave no unowned project changes");
  await FLOW_COMMANDS.run["finalize-merge"].pre(ctx);
  const before = new CanonicalPersistenceSnapshot(manager, specId);

  await FLOW_COMMANDS.run["finalize-merge"].onError(ctx, new Error("pre-merge conflict"));

  const files = git("-C", root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
    .trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(files, [location.relativeActivitiesFile, location.relativeCatalogFile,
    location.relativeFlowStateFile, location.relativeArtifact("issue.log")].sort());
  assert.deepEqual(getWorktreeStatus(root, options), projectBefore,
    "the conflict hook must preserve project cleanliness while retaining deferred Flow artifacts");
  before.assertPhysicalUnchanged("metadata-only finalize conflict", new Map(files.map((relative) => {
    const absolute = path.join(root, relative);
    return [absolute, fs.readFileSync(absolute)];
  })));
  const changedKeys = new Set(["flow.state", "flow.activities", "artifact.catalog", "issue.log"]);
  const retained = (snapshot) => snapshot.permanentArtifacts.filter(({ logicalKey }) => !changedKeys.has(logicalKey));
  assert.deepEqual(retained(new CanonicalPersistenceSnapshot(manager, specId)), retained(before),
    "deferred catalog members must retain their exact producer and bytes");
});

test("records the finalize-merge outbox before merge execution", async (t) => {
  const { manager, ctx } = await setupFixture(t);

  await FLOW_COMMANDS.run["finalize-merge"].pre(ctx);

  const entry = new FlowOutboxStore(manager).status(finalizationOutboxIdentity(manager.loadReadOnly(), "finalize-merge"));
  assert.equal(entry?.status, "pending");
});

test("external dirtiness prevents finalize-merge outbox mutation", async (t) => {
  const { root, manager, ctx } = await setupFixture(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "external.js"), "external\n");
  const before = manager.load();

  await assert.rejects(
    () => FLOW_COMMANDS.run["finalize-merge"].pre(ctx),
    (error) => error instanceof FinalizeMergeTransactionError
      && error.code === "MERGE_FEATURE_DIRTY"
      && error.data.paths.includes("src/external.js"),
  );
  assert.equal(new FlowOutboxStore(manager).status(finalizationOutboxIdentity(manager.loadReadOnly(), "finalize-merge")), null);
  assert.deepEqual(manager.loadReadOnly().steps, before.steps);
});

test("Flow-owned analysis output remains deferred without blocking finalize-merge", async (t) => {
  const { root, manager, ctx } = await setupFixture(t);
  fs.mkdirSync(path.join(root, ".sennel", "output"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel", "output", "analysis.json"), "{\"entries\":[]}\n");

  await FLOW_COMMANDS.run["finalize-merge"].pre(ctx);

  const entry = new FlowOutboxStore(manager).status(finalizationOutboxIdentity(manager.loadReadOnly(), "finalize-merge"));
  assert.equal(entry?.status, "pending");
  assert.equal(fs.existsSync(path.join(root, ".sennel", "output", "analysis.json")), true);
  assert.match(
    git("-C", root, "status", "--porcelain", "--untracked-files=all"),
    /\.sennel\/output\/analysis\.json/,
  );
});
