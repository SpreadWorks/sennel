import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { PrepareArtifactScenario } from "../../support/prepare-artifact-scenario.js";
import { SynchronousManagedFixture } from "../../support/infrastructure/synchronous-managed-fixture.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { buildRepairFingerprint } from "../../../src/flow/lib/repair-fingerprint.js";
import { buildRepairStateManifest, captureRepairBaseline, RepairFingerprintManifest } from "../../../src/flow/lib/repair-state-identity.js";
import { ReviewTargetAuthority } from "../../../src/flow/lib/review-target-authority.js";
import { PRODUCT } from "../../../src/lib/product.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";

/** Production Prepare owns both the adopted direct and newly bound worktree paths. */
async function preparedHistoricalSource(t, worktree = false) {
  const scenario = PrepareArtifactScenario.create(t, { mode: worktree ? "worktree" : "no-branch" });
  let executionOid;
  if (!worktree) {
    scenario.git(["checkout", "-b", "existing-feature"]);
    scenario.git(["commit", "--allow-empty", "-m", "Advance execution independently"]);
    executionOid = scenario.git(["rev-parse", "HEAD"]).trim();
    assert.notEqual(executionOid, scenario.baseOid);
  }
  await scenario.initialize();
  assert.equal((await scenario.prepare()).result, "ok");
  if (worktree) {
    assert.notEqual(scenario.executionRoot, scenario.root);
    executionOid = scenario.git(["rev-parse", "HEAD"], scenario.executionRoot).trim();
    assert.equal(executionOid, scenario.baseOid, "new normal worktree starts from the preparation base");
  }
  const manager = scenario.reload();
  const saved = manager.canonicalState(scenario.specId);
  assert.deepEqual(saved.context.toJSON(), {
    baseOid: scenario.baseOid, gitSnapshot: { available: true, commit: executionOid },
  }, "Prepare persists historical base and execution snapshot independently");
  return { scenario, manager, executionOid };
}

function captureInput(scenario, manager = scenario.reload()) {
  return { root: scenario.executionRoot, artifactRoot: scenario.root,
    specPath: manager.specLocation(scenario.specId).relativeSpecFile,
    state: manager.loadReadOnly(scenario.specId), flowManager: manager };
}

/** Same raw-index boundary used by existing Git read-only and recovery tests. */
class GitReadProtection {
  constructor(root, git) {
    this.root = root;
    this.git = git;
    this.refs = git(["for-each-ref", "--format=%(refname) %(objectname)"]);
    this.indexPath = path.resolve(root, git(["rev-parse", "--git-path", "index"]).trim());
    this.indexHash = this.#hash();
    this.indexIdentity = this.#identity();
  }
  #hash() { return crypto.createHash("sha256").update(fs.readFileSync(this.indexPath)).digest("hex"); }
  #identity() {
    const value = fs.lstatSync(this.indexPath, { bigint: true });
    return [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs];
  }
  assertUnchanged() {
    assert.equal(this.git(["for-each-ref", "--format=%(refname) %(objectname)"]), this.refs,
      "logical ref inventory stays unchanged");
    assert.equal(this.#hash(), this.indexHash, "raw caller index bytes stay unchanged");
    assert.deepEqual(this.#identity(), this.indexIdentity, "caller index generation and modification metadata stay unchanged");
  }
}

function gitProtection(scenario) {
  return new GitReadProtection(scenario.executionRoot, (args) => scenario.git(args, scenario.executionRoot));
}

it("Prepare historical context survives reload and a moving base while execution inputs remain fresh", { timeout: 240_000 }, async (t) => {
  const { scenario, executionOid } = await preparedHistoricalSource(t);
  // A legitimate base fast-forward must not change the already prepared historical base.
  scenario.git(["branch", "-f", "main", executionOid]);
  const manager = scenario.reload();
  const input = captureInput(scenario, manager);
  const protectedGit = gitProtection(scenario);
  const first = buildRepairFingerprint(input);
  assert.equal(first.baseline.commitOid, scenario.baseOid, "prepared historical base must survive base-branch movement");
  assert.equal(first.headOid, executionOid);
  assert.equal(first.baseline.ref, null, "a value capture does not lazily create a run ref");
  assert.equal(new RepairFingerprintManifest(JSON.parse(JSON.stringify(first.toJSON()))).hash, first.hash);
  const authority = new ReviewTargetAuthority({ executionRoot: scenario.executionRoot,
    artifactRoot: scenario.root, flowState: input.state, flowManager: manager });
  assert.equal(authority.captureFingerprint().hash, first.hash, "the real Review consumer uses the same canonical authority");
  fs.writeFileSync(path.join(scenario.executionRoot, "implementation-input.txt"), "new execution input\n");
  const changed = buildRepairFingerprint(captureInput(scenario));
  assert.equal(changed.baseline.commitOid, scenario.baseOid);
  assert.notEqual(changed.hash, first.hash, "fresh working content remains part of execution identity");
  protectedGit.assertUnchanged();
});

it("worktree fingerprint binds canonical and execution roots and rejects foreign or stale selections", { timeout: 240_000 }, async (t) => {
  const { scenario, executionOid } = await preparedHistoricalSource(t, true);
  const input = captureInput(scenario);
  const protectedGit = gitProtection(scenario);
  assert.notEqual(input.root, input.artifactRoot);
  const fingerprint = buildRepairFingerprint(input);
  assert.equal(fingerprint.baseline.commitOid, scenario.baseOid);
  assert.equal(fingerprint.headOid, executionOid);
  assert.throws(() => buildRepairFingerprint({ ...input, artifactRoot: input.root }),
    { code: "CURRENT_FLOW_STATE_CONFLICT" });
  // Malformed caller selections are boundary inputs, never saved canonical state.
  assert.throws(() => buildRepairFingerprint({ ...input, state: { ...input.state, runId: "foreign-run" } }),
    { code: "FLOW_TARGET_RECOVERY_REQUIRED" });
  assert.throws(() => buildRepairFingerprint({ ...input, state: { ...input.state, flowVersionId: "stale-version" } }),
    { code: "CURRENT_FLOW_STATE_CONFLICT" });
  protectedGit.assertUnchanged();
});

it("a conflicting explicit run pin refuses the persisted Prepare authority without rewriting Git", { timeout: 240_000 }, async (t) => {
  const { scenario, executionOid } = await preparedHistoricalSource(t);
  const pinned = captureRepairBaseline({ root: scenario.executionRoot, baseRef: "HEAD", runId: scenario.runId });
  assert.equal(pinned.commitOid, executionOid);
  const protectedGit = gitProtection(scenario);
  assert.throws(() => buildRepairFingerprint(captureInput(scenario)), { code: "REPAIR_BASELINE_UNRESOLVABLE" });
  protectedGit.assertUnchanged();
});

it("nullable value capture stays read-only while the direct manifest producer retains lazy pinning", { timeout: 240_000 }, (t) => {
  const fixture = new SynchronousManagedFixture(t, "repair-historical-baseline-");
  const { root } = fixture;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  initGitRepo(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "/.tmp/\n/.sennel/\n/specs/\n");
  fs.writeFileSync(path.join(root, "source.txt"), "initial source\n");
  commitAll(root, "Initial baseline");
  const initial = git("rev-parse", "HEAD").trim();
  const specPath = "specs/standalone/001/spec.json";
  const state = { runId: "explicit-baseline", baseBranch: "main" };
  const protectedGit = () => new GitReadProtection(root, (args) => git(...args));
  const beforeValue = protectedGit();
  const observed = buildRepairFingerprint({ root, specPath, state });
  assert.equal(observed.baseline.commitOid, initial);
  assert.equal(observed.baseline.ref, null, "nullable value capture does not create a run ref");
  beforeValue.assertUnchanged();
  const produced = buildRepairStateManifest({ root, specPath, state });
  assert.equal(produced.baseline.ref, PRODUCT.flowBaselineRef(state.runId));
  assert.equal(git("rev-parse", produced.baseline.ref).trim(), initial,
    "the direct stateful Manifest API keeps its original lazy-pinning producer");
  fs.writeFileSync(path.join(root, "source.txt"), "advanced source\n");
  commitAll(root, "Advance live main");
  const advanced = git("rev-parse", "HEAD").trim();
  assert.notEqual(advanced, initial);
  const beforeReads = protectedGit();
  assert.equal(buildRepairFingerprint({ root, specPath, state }).baseline.commitOid, initial);
  assert.equal(buildRepairFingerprint({ root, specPath }).baseline.commitOid, advanced);
  beforeReads.assertUnchanged();
  fixture.complete = true;
});


it("a current canonical nullable Flow persists, reloads and observes fresh repository baselines without pinning", { timeout: 240_000 }, (t) => {
  const fixture = new SynchronousManagedFixture(t, "repair-nullable-canonical-");
  const { root } = fixture;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  initGitRepo(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "/.tmp/\n/.sennel/\n/specs/\n");
  fs.writeFileSync(path.join(root, "source.txt"), "nullable source\n");
  commitAll(root, "Initial nullable source");
  const initial = git("rev-parse", "HEAD").trim();
  const specId = "001-nullable-context";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  new CanonicalFlowFixture({ flowManager: manager, specId, runId: "nullable-context-run", context: null })
    .create().registerActive();
  const location = manager.specLocation(specId);
  const canonicalBytes = fs.readFileSync(location.flowStateFile);
  const freshInput = () => {
    const fresh = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(fresh.canonicalState(specId).context.toJSON(), null);
    return { root, artifactRoot: root, specPath: fresh.specLocation(specId).relativeSpecFile,
      state: fresh.loadReadOnly(specId), flowManager: fresh };
  };
  const beforeFirst = new GitReadProtection(root, (args) => git(...args));
  const first = buildRepairFingerprint(freshInput());
  assert.equal(first.baseline.commitOid, initial);
  assert.equal(first.baseline.ref, null);
  beforeFirst.assertUnchanged();
  fs.writeFileSync(path.join(root, "source.txt"), "advanced nullable source\n");
  commitAll(root, "Advance nullable current repository");
  const advanced = git("rev-parse", "HEAD").trim();
  assert.notEqual(advanced, initial);
  const beforeSecond = new GitReadProtection(root, (args) => git(...args));
  const second = buildRepairFingerprint(freshInput());
  assert.equal(second.baseline.commitOid, advanced,
    "without historical authority this is the old fresh repository observation");
  assert.equal(second.baseline.ref, null);
  assert.notEqual(second.hash, first.hash);
  beforeSecond.assertUnchanged();
  assert.deepEqual(fs.readFileSync(location.flowStateFile), canonicalBytes,
    "value capture does not manufacture context or rewrite canonical state");
  fixture.complete = true;
});


it("a main manager fingerprints the normal prepared worktree rather than its construction root", { timeout: 240_000 }, async (t) => {
  const { scenario } = await preparedHistoricalSource(t, true);
  const main = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false, specId: scenario.specId });
  const input = captureInput(scenario, main);
  assert.equal(main.executionVersionLocation(main.specLocation(scenario.specId).version,
    { specId: scenario.specId }).repositoryRoot, scenario.root, "construction-scoped Version location retains its original role");
  assert.equal(main.executionRoot(input.state), scenario.executionRoot, "the existing state-aware owner selects the actual worktree");
  const worktreeGit = gitProtection(scenario);
  const mainGit = new GitReadProtection(scenario.root, (args) => scenario.git(args, scenario.root));
  const current = buildRepairFingerprint(input);
  assert.equal(current.baseline.commitOid, scenario.baseOid);
  assert.equal(current.baseline.ref, null);
  assert.throws(() => buildRepairFingerprint({ ...input, root: scenario.root }), { code: "CURRENT_FLOW_STATE_CONFLICT" },
    "a canonical artifact root is not the selected worktree's execution root");
  worktreeGit.assertUnchanged(); mainGit.assertUnchanged();
});

it("Review authority accepts the explicit execution-root context and retains canonical artifact ownership", { timeout: 240_000 }, async (t) => {
  const { scenario } = await preparedHistoricalSource(t, true);
  const input = captureInput(scenario);
  const explicit = { root: scenario.executionRoot, mainRoot: scenario.root,
    executionRoot: scenario.executionRoot, flowManager: input.flowManager, flowState: input.state };
  const cli = { ...explicit, root: scenario.root, repositoryRoot: scenario.root, artifactRoot: scenario.root };
  const protectedGit = gitProtection(scenario);
  const actualAuthority = ReviewTargetAuthority.fromContext(explicit);
  const canonicalAuthority = ReviewTargetAuthority.fromContext(cli);
  const actual = actualAuthority.captureFingerprint();
  const canonical = canonicalAuthority.captureFingerprint();
  assert.equal(actual.baseline.commitOid, scenario.baseOid);
  assert.equal(actual.hash, canonical.hash);
  // The existing pure projection accepts the exact immutable captures above.
  assert.equal(actualAuthority.captureTargetStateForPhase("impl", actual).digest,
    canonicalAuthority.captureTargetStateForPhase("impl", canonical).digest,
    "the exact Review target consumer agrees across the two legitimate context forms");
  assert.throws(() => ReviewTargetAuthority.fromContext({ ...explicit, artifactRoot: scenario.executionRoot }).captureFingerprint(),
    { code: "CURRENT_FLOW_STATE_CONFLICT" }, "an explicitly foreign artifact authority remains rejected");
  protectedGit.assertUnchanged();
});
