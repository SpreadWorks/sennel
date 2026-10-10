import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import RunFinalizeCleanupCommand from "../../../src/flow/lib/run-finalize-cleanup.js";
import { FinalizeCommitPathSet } from "../../../src/flow/lib/finalize-commit-paths.js";
import { POINTER_REL_PATH } from "../../../src/flow/lib/run-report-show.js";

const cleanupStep = "finalize-cleanup";

async function orphanAtCleanup(t, scenario) {
  const flow = scenario(t);
  await flow.advanceTo("finalize-sync");
  const synchronized = await flow.runRegistered("finalize-sync");
  assert.notEqual(synchronized.ok, false, JSON.stringify(synchronized));
  flow.reload();
  assert.equal(flow.current(), cleanupStep);
  // A user can checkpoint the already-produced Spec/docs before requesting
  // rescue. Keep the real producer bytes and limit this Git input to the
  // existing target Spec/documentation scope; do not fabricate clean state.
  const source = flow.report(cleanupStep);
  const canonical = flow.snapshot();
  const paths = new FinalizeCommitPathSet({ repositoryRoot: flow.root, specRoot: "specs", specId: flow.specId });
  flow.git(["add", "-A", "--", ...paths.completionPaths.filter((entry) => fs.existsSync(path.join(flow.root, entry)))]);
  flow.git(["commit", "-m", "chore: checkpoint produced finalization evidence before rescue"]);
  assert.deepEqual(flow.reload().snapshot(), canonical, "a real Git checkpoint cannot rewrite canonical evidence");
  assert.deepEqual(flow.report(cleanupStep), source);
  assert.equal(flow.git(["status", "--porcelain"]), "", "auto-rescue begins from a clean base before its own claim");
  const feature = flow.state().execution.featureBranch;
  flow.git(["switch", feature]);
  flow.write("rescued.txt", "An actual post-squash commit must survive authorized rescue.\n");
  flow.git(["add", "rescued.txt"]);
  flow.git(["commit", "-m", "fix: preserve the post-squash change"]);
  flow.git(["switch", "main"]);
  flow.reload();
  await flow.advanceTo(cleanupStep);
  return flow;
}

function issueEntries(flow) {
  const artifact = flow.manager.readArtifact({ specId: flow.specId,
    logicalKey: "issue.log", consumerNodeId: cleanupStep, optional: true });
  return artifact === null ? [] : JSON.parse(artifact.bytes.toString("utf8")).entries;
}

function retainedRefs(flow) {
  return { main: flow.git(["rev-parse", "main"]),
    feature: flow.git(["rev-parse", flow.state().execution.featureBranch]),
    head: flow.git(["rev-parse", "HEAD"]),
    index: flow.git(["ls-files", "--stage"]),
    staged: flow.git(["diff", "--cached", "--binary"]),
    worktrees: flow.git(["worktree", "list", "--porcelain"]) };
}

function lockRef(t, flow, branch) {
  const lockPath = path.join(flow.root, ".git", "refs", "heads", `${branch}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "A different Git operation owns this ref.\n", { flag: "wx" });
  const release = () => { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); };
  t.after(release);
  return release;
}

export function registerFinalizationCleanupContracts(scenario) {
  test("F07 force audit save failure performs no teardown and retains the exact producer/report", async (t) => {
    const flow = await orphanAtCleanup(t, scenario);
    await FLOW_COMMANDS.run[cleanupStep].pre(flow.context());
    flow.reload();
    const before = flow.snapshot();
    const refs = retainedRefs(flow);
    const report = flow.report(cleanupStep);
    const entries = issueEntries(flow);
    let injected = false;
    const failure = new Error("force audit canonical publication could not be saved");
    flow.reload({ versionStoreFaultInjector({ phase }) {
      if (!injected && phase === "before-current-flow-state-temp-write") {
        injected = true;
        throw failure;
      }
    } });
    const result = await new RunFinalizeCleanupCommand().execute({ ...flow.context(), force: true });
    assert.equal(injected, true, "the real force audit must reach canonical persistence before destructive effects");
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "ISSUE_LOG_AUDIT_FAILED");
    flow.reload();
    assert.deepEqual(flow.snapshot(), before);
    assert.deepEqual(retainedRefs(flow), refs);
    assert.deepEqual(issueEntries(flow), entries);
    assert.deepEqual(flow.report(cleanupStep), report);
    assert.equal(fs.existsSync(path.join(flow.root, POINTER_REL_PATH)), false);
    assert.equal(flow.state().lifecycle.state, "active");
  });

  test("F07 forced branch deletion failure and retry preserve independent facts and one exact audit", async (t) => {
    const flow = await orphanAtCleanup(t, scenario);
    await FLOW_COMMANDS.run[cleanupStep].pre(flow.context());
    flow.reload();
    const independent = ["existing-other-audit", "independently-appended-fact"];
    for (const issueLogId of independent) flow.manager.appendIssueLog({ specId: flow.specId,
      entry: { step: cleanupStep, issueLogId, reason: `Keep ${issueLogId} through teardown failure.` },
      idempotencyKey: issueLogId });
    flow.reload();
    const refs = retainedRefs(flow);
    const release = lockRef(t, flow, flow.state().execution.featureBranch);
    const failed = await new RunFinalizeCleanupCommand().execute({ ...flow.context(), force: true });
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((entry) => entry.code === "BRANCH_DELETE_FAILED"));
    flow.reload();
    assert.deepEqual(retainedRefs(flow), refs);
    const afterFailure = issueEntries(flow);
    for (const id of independent) assert.equal(afterFailure.filter((entry) => entry.issueLogId === id).length, 1,
      "failure compensation must never erase an independent fact");
    const audit = afterFailure.filter((entry) => entry.reason.startsWith("FORCED_ORPHAN_DROP"));
    assert.equal(audit.length, 1, "the saved destructive authorization remains exact on interrupted teardown");
    assert.ok(audit[0].issueLogId);
    const journalPath = flow.manager.specLocation(flow.specId).artifact("finalize.cleanup.journal");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    assert.equal(journal.phase, "worktree-removed");
    assert.equal(journal.featureSha, refs.feature);
    assert.equal(journal.runId, flow.state().runId);
    release();
    const result = await flow.runRegistered(cleanupStep, { force: true });
    assert.notEqual(result.ok, false, JSON.stringify(result));
    flow.reload();
    const finished = issueEntries(flow);
    for (const id of independent) assert.equal(finished.filter((entry) => entry.issueLogId === id).length, 1);
    assert.deepEqual(finished.filter((entry) => entry.reason.startsWith("FORCED_ORPHAN_DROP")), audit);
    assert.equal(flow.state().lifecycle.state, "finalized");
    flow.assertResults([cleanupStep]);
  });

  test("F07 actual auto-rescue retains an orphan commit in main before branch teardown", async (t) => {
    const flow = await orphanAtCleanup(t, scenario);
    const source = flow.report(cleanupStep);
    const base = flow.git(["rev-parse", "main"]);
    const result = await flow.runRegistered(cleanupStep, { autoRescue: true });
    assert.notEqual(result.ok, false, JSON.stringify(result));
    flow.reload();
    assert.notEqual(flow.git(["rev-parse", "main"]), base);
    assert.equal(flow.git(["show", "main:rescued.txt"]),
      "An actual post-squash commit must survive authorized rescue.");
    assert.equal(flow.git(["branch", "--show-current"]), "main");
    assert.equal(flow.git(["for-each-ref", "--format=%(refname)", `refs/heads/${flow.state().execution.featureBranch}`]), "");
    assert.equal(flow.state().lifecycle.state, "finalized");
    assert.deepEqual(flow.report(cleanupStep), source);
    flow.assertResults([cleanupStep], { expectedKinds: { [cleanupStep]: "finalize-cleanup-completed" } });
  });

  test("F07 auto-rescue cannot publish over a locked base ref or lose the orphan/report", async (t) => {
    const flow = await orphanAtCleanup(t, scenario);
    const refs = retainedRefs(flow);
    const source = flow.report(cleanupStep);
    const release = lockRef(t, flow, "main");
    const original = childProcess.spawnSync;
    const publications = [];
    const observer = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      const update = args.indexOf("update-ref");
      if (command === "git" && update >= 0 && args[update + 1] === "refs/heads/main") {
        publications.push(args.slice(update));
      }
      return original(command, args, options);
    });
    syncBuiltinESMExports();
    let result;
    try { result = await flow.runRegistered(cleanupStep, { autoRescue: true }); }
    finally { observer.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(publications.length, 1, "the real rescue must attempt expected-ref publication before this refusal counts");
    assert.equal(publications[0][3], refs.main, "the rejected publication must compare the actual saved base SHA");
    assert.equal(result.ok, false, "a failed real expected-ref publication must stop before teardown");
    assert.ok(result.errors.length > 0);
    flow.reload();
    assert.deepEqual(retainedRefs(flow), refs);
    assert.deepEqual(flow.report(cleanupStep), source);
    assert.equal(flow.state().lifecycle.state, "active");
    assert.equal(fs.existsSync(path.join(flow.root, POINTER_REL_PATH)), false);
    release();
  });

  test("F07 auto-rescue refuses unknown dirty input without losing the orphan or producer report", async (t) => {
    const flow = await orphanAtCleanup(t, scenario);
    const refs = retainedRefs(flow);
    const source = flow.report(cleanupStep);
    const foreign = "An independent edit cannot be classified as owned rescue evidence.\n";
    flow.write("independent-rescue-input.txt", foreign);
    const result = await flow.runRegistered(cleanupStep, { autoRescue: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((entry) => entry.code === "MAIN_REPO_DIRTY"), JSON.stringify(result));
    assert.ok(result.data.dirtyFiles.includes("independent-rescue-input.txt"));
    flow.reload();
    assert.deepEqual(retainedRefs(flow), refs);
    assert.equal(fs.readFileSync(path.join(flow.root, "independent-rescue-input.txt"), "utf8"), foreign);
    assert.deepEqual(flow.report(cleanupStep), source);
    assert.equal(flow.state().lifecycle.state, "active");
    assert.equal(fs.existsSync(path.join(flow.root, POINTER_REL_PATH)), false);
  });

  test("F07 auto-rescue expected-SHA publication preserves a real competing base commit", async (t) => {
    const flow = await orphanAtCleanup(t, scenario);
    const baseline = flow.git(["rev-parse", "main"]);
    const feature = flow.git(["rev-parse", flow.state().execution.featureBranch]);
    const report = flow.report(cleanupStep);
    const tree = flow.git(["rev-parse", "main^{tree}"]);
    const competingCommit = flow.git(["commit-tree", tree, "-p", baseline,
      "-m", "fix: an independent writer advanced the base ref"]);
    const original = childProcess.spawnSync;
    let intervened = false;
    // A deterministic competing Git writer runs after rescue has acquired its
    // expected baseline and prepared its new commit, before the actual ref
    // publication. Every Git process and its result remain real.
    const observer = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      const update = args.indexOf("update-ref");
      if (!intervened && command === "git" && update >= 0
        && args[update + 1] === "refs/heads/main") {
        intervened = true;
        const competing = original("git", ["-C", flow.root, "update-ref", "refs/heads/main",
          competingCommit, baseline], options);
        assert.equal(competing.status, 0, competing.stderr);
      }
      return original(command, args, options);
    });
    syncBuiltinESMExports();
    let result;
    try { result = await flow.runRegistered(cleanupStep, { autoRescue: true }); }
    finally { observer.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(intervened, true, "the actual rescue must reach its prepared ref publication");
    assert.equal(result.ok, false, "a stale expected SHA must stop rescue before teardown/materialization");
    assert.ok(result.errors.length > 0);
    flow.reload();
    assert.equal(flow.git(["rev-parse", "main"]), competingCommit,
      "rescue cannot overwrite an independently published base commit");
    assert.equal(flow.git(["rev-parse", flow.state().execution.featureBranch]), feature);
    assert.deepEqual(flow.report(cleanupStep), report);
    assert.equal(flow.state().lifecycle.state, "active");
    assert.equal(fs.existsSync(path.join(flow.root, POINTER_REL_PATH)), false);
  });

  test("F07 unobservable Git status safely retains the branch, raw index and report", async (t) => {
    const flow = scenario(t);
    await flow.advanceTo(cleanupStep);
    const base = flow.git(["rev-parse", "main"]);
    const feature = flow.git(["rev-parse", flow.state().execution.featureBranch]);
    const source = flow.report(cleanupStep);
    const indexPath = path.join(flow.root, ".git", "index");
    const originalIndex = fs.readFileSync(indexPath);
    t.after(() => { if (fs.existsSync(indexPath)) fs.writeFileSync(indexPath, originalIndex); });
    const malformedIndex = Buffer.from("a physically unreadable Git index\n");
    fs.writeFileSync(indexPath, malformedIndex);
    const result = await flow.runRegistered(cleanupStep);
    assert.equal(result.ok, false, "unknown status cannot authorize destruction");
    assert.ok(result.errors.some((entry) => entry.messages.some((message) => /status|index|Git|git/i.test(message))));
    flow.reload();
    assert.equal(flow.git(["rev-parse", "main"]), base);
    assert.equal(flow.git(["rev-parse", flow.state().execution.featureBranch]), feature);
    assert.deepEqual(fs.readFileSync(indexPath), malformedIndex);
    assert.deepEqual(flow.report(cleanupStep), source);
    assert.equal(flow.state().lifecycle.state, "active");
    assert.equal(fs.existsSync(path.join(flow.root, POINTER_REL_PATH)), false);
    fs.writeFileSync(indexPath, originalIndex);
  });

  test("F07 real completion accepts exact Activity replay and rejects every new durable mutation", async (t) => {
    const flow = scenario(t);
    await flow.advanceTo(cleanupStep);
    const result = await flow.runRegistered(cleanupStep);
    assert.notEqual(result.ok, false, JSON.stringify(result));
    flow.reload();
    assert.equal(flow.state().lifecycle.state, "finalized");
    const finalized = flow.manager.activityLedger(flow.specId).findLast((entry) => entry.type === "flow_finalized");
    assert.ok(finalized, "the real cleanup producer must save its finalization Activity");
    const canonical = flow.snapshot();
    const git = flow.gitSnapshot();
    const pointer = fs.readFileSync(path.join(flow.root, POINTER_REL_PATH));
    const source = flow.report(cleanupStep);
    flow.manager.applyActivity(finalized, { specId: flow.specId });
    assert.deepEqual(flow.reload().snapshot(), canonical);
    for (const [name, mutate] of [
      ["new note", () => flow.manager.addNote("A new observation after completion is unauthorized.", { specId: flow.specId })],
      ["new metric", () => flow.manager.appendMetric({ phase: "finalize", counter: "late", delta: 1 }, { specId: flow.specId })],
      ["changed policy", () => flow.manager.setAutoApprove(!flow.state().policy.autoApprove, { specId: flow.specId })],
    ]) {
      assert.throws(mutate, /finalized Flow rejects subsequent Activities/, `${name} must reject a new durable Activity`);
      assert.deepEqual(flow.reload().snapshot(), canonical);
      assert.deepEqual(flow.gitSnapshot(), git);
      assert.deepEqual(fs.readFileSync(path.join(flow.root, POINTER_REL_PATH)), pointer);
      assert.deepEqual(flow.report(cleanupStep), source);
    }
    flow.assertResults([cleanupStep], { expectedKinds: { [cleanupStep]: "finalize-cleanup-completed" } });
  });
}
