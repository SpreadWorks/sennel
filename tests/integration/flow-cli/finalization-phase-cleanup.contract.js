import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { SeedWorkRoot } from "../../support/builders/seed-work-root.js";
import { TestTemporaryRoot } from "../../test-temporary-root.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { runAutoRescue, recordFinalizeCleanupPostCommandMetadata } from "../../../src/flow/lib/run-finalize-cleanup.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import RunFinalizeCleanupCommand from "../../../src/flow/lib/run-finalize-cleanup.js";
import { FinalizeCommitPathSet } from "../../../src/flow/lib/finalize-commit-paths.js";
import { POINTER_REL_PATH } from "../../../src/flow/lib/run-report-show.js";
import { CanonicalFlowArtifactWrite, FlowActivity } from "../../../src/flow/lib/current-flow-state.js";
import { CanonicalPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";

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

// Git-only rescue guarantees do not require the full Finalization matrix.
// Clone a standalone repository; linked worktree .git metadata is never copied.
function rescueGit(root, args) {
  const result = runGit(args, { cwd: root });
  assert.equal(result.ok, true, result.stderr);
  return result.stdout.trim();
}

export function registerFinalizationCleanupContracts(scenario) {
  let rescueSeed;
  let rescueSeedOwner;
  before(() => {
    rescueSeedOwner = TestTemporaryRoot.createOnRepository();
    rescueSeed = rescueSeedOwner.path;
    initGitRepo(rescueSeed);
    fs.writeFileSync(path.join(rescueSeed, "README.md"), "Base input.\n");
    commitAll(rescueSeed, "test: immutable rescue Git baseline");
    rescueGit(rescueSeed, ["switch", "-c", "feature/rescue"]);
    fs.writeFileSync(path.join(rescueSeed, "rescued.txt"), "Rescued input.\n");
    commitAll(rescueSeed, "test: independent orphan commit");
    rescueGit(rescueSeed, ["switch", "main"]);
  });
  after(() => rescueSeedOwner?.remove());
  function rescueBoundary(t) {
    const work = new SeedWorkRoot(rescueSeed, { prefix: "sennel-rescue-boundary-" });
    t.after(() => work.cleanup());
    return { mainRepoPath: work.root, baseBranch: "main",
      baseline: rescueGit(work.root, ["rev-parse", "main"]),
      featureBranch: "feature/rescue", specId: "rescue-boundary" };
  }

  test("F07 cleanup metadata append preserves its producer binding and refuses stale catalog bytes", async (t) => {
    const flow = scenario(t);
    await flow.advanceTo(cleanupStep);
    for (const id of ["metric-1", "metric-2"]) recordFinalizeCleanupPostCommandMetadata({
      flowManager: flow.manager, specId: flow.specId, metrics: [{ id }] });
    flow.reload();
    const artifact = flow.manager.readArtifact({ specId: flow.specId,
      logicalKey: "finalize.cleanup.agent-metrics", consumerNodeId: cleanupStep });
    assert.deepEqual(JSON.parse(artifact.bytes), { version: 1,
      entries: [{ id: "metric-1" }, { id: "metric-2" }] });
    const producer = flow.manager.activityLedger(flow.specId).find((activity) =>
      activity.id === artifact.descriptor.activityId);
    assert.equal(producer.nodeId, cleanupStep);
    assert.equal(producer.attemptId, flow.state().attempt.id);
    assert.equal(producer.sequence, flow.state().attempt.sequence);
    const target = flow.manager.specLocation(flow.specId).resolve(artifact.relativePath);
    const persisted = new CanonicalPersistenceSnapshot(flow.manager, flow.specId, [target]);
    fs.appendFileSync(target, "\n");
    const stale = fs.readFileSync(target);
    assert.throws(() => recordFinalizeCleanupPostCommandMetadata({ flowManager: flow.manager,
      specId: flow.specId, metrics: [{ id: "metric-3" }] }),
    /canonical finalize-cleanup finalize\.cleanup\.agent-metrics is invalid|does not match the catalog/);
    assert.deepEqual(fs.readFileSync(target), stale);
    persisted.assertPhysicalUnchanged("stale cleanup metadata refusal", new Map([[target, stale]]));
  });

  test("F07 detached rescue publishes base content while preserving a feature checkout, HEAD and raw index", (t) => {
    const input = rescueBoundary(t);
    const root = input.mainRepoPath;
    rescueGit(root, ["switch", input.featureBranch]);
    const head = rescueGit(root, ["rev-parse", "HEAD"]);
    const index = fs.readFileSync(path.join(root, ".git", "index"));
    const result = runAutoRescue(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(rescueGit(root, ["branch", "--show-current"]), input.featureBranch);
    assert.equal(rescueGit(root, ["rev-parse", "HEAD"]), head);
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), index);
    assert.equal(rescueGit(root, ["show", "main:rescued.txt"]), "Rescued input.");
  });

  test("F07 rescue reconciles an applied CAS whose external Git response reports failure", (t) => {
    const input = rescueBoundary(t);
    const original = childProcess.spawnSync;
    let applied = false;
    const observer = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      const actual = original(command, args, options);
      if (command === "git" && args.includes("update-ref") && args.includes("refs/heads/main")) {
        assert.equal(actual.status, 0, actual.stderr);
        applied = true;
        return { ...actual, status: 73, stderr: "Lost external CAS response\n" };
      }
      return actual;
    });
    syncBuiltinESMExports();
    let result;
    try { result = runAutoRescue(input); }
    finally { observer.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(applied, true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(input.mainRepoPath, "rescued.txt"), "utf8"), "Rescued input.\n");
    assert.equal(rescueGit(input.mainRepoPath, ["status", "--porcelain"]), "");
  });

  test("F07 rescue reconstructs an applied ref publication after process loss before materialization", (t) => {
    const input = rescueBoundary(t);
    const moduleUrl = pathToFileURL(path.resolve("src/flow/lib/run-finalize-cleanup.js")).href;
    const child = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const original = childProcess.spawnSync;
      childProcess.spawnSync = (command, args, options) => {
        const result = original(command, args, options);
        if (command === "git" && args.includes("update-ref") && args.includes("refs/heads/main") && result.status === 0) {
          process.kill(process.pid, "SIGKILL");
        }
        return result;
      };
      syncBuiltinESMExports();
      await import(${JSON.stringify(pathToFileURL(path.resolve("src/sennel.js")).href)});
      const { runAutoRescue } = await import(${JSON.stringify(moduleUrl)});
      runAutoRescue(${JSON.stringify(input)});
    `], { cwd: input.mainRepoPath, encoding: "utf8" });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.notEqual(rescueGit(input.mainRepoPath, ["rev-parse", "main"]), input.baseline);
    assert.notEqual(rescueGit(input.mainRepoPath, ["status", "--porcelain"]), "");
    const result = runAutoRescue(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(input.mainRepoPath, "rescued.txt"), "utf8"), "Rescued input.\n");
    assert.equal(rescueGit(input.mainRepoPath, ["status", "--porcelain"]), "");
  });

  test("F07 conflict probing failure refuses rescue without changing the base checkout or ref", (t) => {
    const input = rescueBoundary(t);
    const root = input.mainRepoPath;
    rescueGit(root, ["switch", input.featureBranch]);
    fs.writeFileSync(path.join(root, "README.md"), "Feature conflict.\n");
    commitAll(root, "test: feature conflict input");
    rescueGit(root, ["switch", "main"]);
    fs.writeFileSync(path.join(root, "README.md"), "Base conflict.\n");
    commitAll(root, "test: competing base input");
    const base = rescueGit(root, ["rev-parse", "main"]);
    const original = childProcess.spawnSync;
    let probed = false;
    const observer = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command === "git" && args.includes("--diff-filter=U")) {
        probed = true;
        return { status: 74, stdout: "", stderr: "Conflict probe unavailable\n", signal: null };
      }
      return original(command, args, options);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => runAutoRescue(input), (error) => error.code === "AUTO_RESCUE_CONFLICT_PROBE_FAILED"); }
    finally { observer.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(probed, true);
    assert.equal(rescueGit(root, ["rev-parse", "main"]), base);
    assert.equal(rescueGit(root, ["status", "--porcelain"]), "");
  });

  test("F07 rescue dirtiness allowance accepts only its exact canonical audit and rejects independent or stale metadata", async (t) => {
    // Each authorization input has an independent clone of the legal producer
    // frontier. These are dirtiness decisions, not repeated phase matrices.
    for (const condition of ["exact audit", "independent fact", "unrelated publication", "stale catalog", "invalid Flow metadata"]) {
      await t.test(condition, async (caseTest) => {
        const flow = await orphanAtCleanup(caseTest, scenario);
        const location = flow.manager.specLocation(flow.specId);
        assert.equal(flow.git(["status", "--porcelain"]), "",
          "the existing orphan producer checkpoint supplies the clean audit baseline");
        await FLOW_COMMANDS.run[cleanupStep].pre(flow.context());
        flow.reload();
        assert.equal(flow.outbox(cleanupStep).status, "pending");
        flow.assertResults([cleanupStep], { terminal: false });
        const input = { mainRepoPath: flow.root, baseBranch: "main",
          baseline: flow.git(["rev-parse", "main"]), featureBranch: flow.state().execution.featureBranch,
          specId: flow.specId, allowFinalizeMetadata: true, allowedIssueLogId: "owned-conflict-audit" };
        const report = flow.report(cleanupStep);
        const feature = flow.git(["rev-parse", input.featureBranch]);
        if (condition === "invalid Flow metadata") {
          const invalid = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
          invalid.legacyField = true;
          fs.writeFileSync(location.flowStateFile, `${JSON.stringify(invalid, null, 2)}\n`);
        } else {
          flow.manager.appendIssueLog({ specId: flow.specId,
            entry: { issueLogId: input.allowedIssueLogId, reason: "Owned conflict audit." },
            idempotencyKey: input.allowedIssueLogId });
          if (condition === "independent fact") flow.manager.appendIssueLog({ specId: flow.specId,
            entry: { issueLogId: "independent-fact", reason: "Keep an independently appended fact." },
            idempotencyKey: "independent-fact" });
          if (condition === "unrelated publication") {
            const issueLog = flow.manager.readArtifact({ specId: flow.specId,
              logicalKey: "issue.log", consumerNodeId: cleanupStep });
            flow.manager.publishArtifacts({ specId: flow.specId, nodeId: cleanupStep, artifactWrites: [
              { logicalKey: "issue.log", mediaType: "application/json", bytes: issueLog.bytes },
              { logicalKey: "finalize.cleanup.agent-metrics", mediaType: "application/json",
                bytes: Buffer.from('{"version":1,"entries":[{"id":"independent-metric"}]}\n') },
            ] });
          }
          if (condition === "stale catalog") fs.appendFileSync(location.issueLogFile, "\n");
        }
        const bytes = Object.fromEntries([location.flowStateFile, location.activitiesFile, location.catalogFile,
          location.issueLogFile].filter((file) => file && fs.existsSync(file)).map((file) => [file, fs.readFileSync(file)]));
        const result = runAutoRescue(input);
        if (condition === "exact audit") {
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(flow.git(["show", "main:rescued.txt"]),
            "An actual post-squash commit must survive authorized rescue.");
          assert.equal(issueEntries(flow).filter((entry) => entry.issueLogId === input.allowedIssueLogId).length, 1);
        } else {
          assert.equal(result.ok, false);
          assert.equal(result.code, "MAIN_REPO_DIRTY");
          assert.ok(result.dirtyFiles.includes(["invalid Flow metadata", "unrelated publication"].includes(condition)
            ? location.relativeFlowStateFile : location.relativeIssueLogFile), JSON.stringify(result));
          assert.equal(flow.git(["rev-parse", "main"]), input.baseline);
          assert.equal(flow.git(["rev-parse", input.featureBranch]), feature);
          for (const [file, expected] of Object.entries(bytes)) assert.deepEqual(fs.readFileSync(file), expected);
          assert.deepEqual(fs.readFileSync(location.resolve(report.relativePath)), report.bytes);
          assert.equal(fs.existsSync(path.join(flow.root, "rescued.txt")), false);
        }
      });
    }
  });

  test("F07 force audit save failure performs no teardown and retains the exact producer/report", async (t) => {
    const flow = await orphanAtCleanup(t, scenario);
    await FLOW_COMMANDS.run[cleanupStep].pre(flow.context());
    flow.reload();
    const before = flow.snapshot();
    const persisted = new CanonicalPersistenceSnapshot(flow.manager, flow.specId, [path.join(flow.root, POINTER_REL_PATH)]);
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
    persisted.assertUnchanged(flow.manager, flow.specId, "force audit publication refusal");
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
    const pluginWrite = new CanonicalFlowArtifactWrite({
      logicalKey: "plugin.lifecycle.artifact",
      parameters: { pluginArtifactPath: "post-finalization.json" },
      mediaType: "application/json",
      bytes: "{\"version\":1}\n",
    });
    const location = flow.manager.specLocation(flow.specId);
    const persisted = new CanonicalPersistenceSnapshot(flow.manager, flow.specId, [
      location.artifact("upgrade.result"), location.resolve(pluginWrite.artifact.relativePath),
    ]);
    flow.manager.applyActivity(finalized, { specId: flow.specId });
    assert.deepEqual(flow.reload().snapshot(), canonical);
    persisted.assertUnchanged(flow.manager, flow.specId, "exact finalized Activity replay");
    assert.throws(() => flow.manager.applyActivity({ ...finalized, provider: "different-replay" },
      { specId: flow.specId }), (error) => error.code === "CANONICAL_RAW_ACTIVITY_MUTATION_FORBIDDEN");
    flow.reload();
    persisted.assertUnchanged(flow.manager, flow.specId, "mismatched finalized Activity replay");
    const approval = { version: 1, runId: flow.state().runId,
      actionDigest: "a".repeat(64), approvalToken: "b".repeat(64),
      approvedAt: "2026-10-13T00:00:00.000Z" };
    const upgrade = { version: 1, command: "sennel upgrade", dryRun: false, exitCode: 0,
      result: "success-no-change", summary: { skills: { updated: 0, unchanged: 1, removed: 0 } },
      failureReason: null, checkedPaths: [] };
    // A new identity is distinct from replay even when it carries the genuine
    // finalized producer's payload. Construct it before the refusal assertion
    // so malformed input cannot stand in for the finalized Store guard.
    const unacknowledged = new FlowActivity({ ...finalized,
      id: "post-finalization-unacknowledged-activity", confirmationOrder: flow.state().confirmationOrder + 1 });
    for (const [name, mutate] of [
      ["new note", () => flow.manager.addNote("A new observation after completion is unauthorized.", { specId: flow.specId })],
      ["new metric", () => flow.manager.appendMetric({ phase: "finalize", counter: "late", delta: 1 }, { specId: flow.specId })],
      ["changed policy", () => flow.manager.setAutoApprove(!flow.state().policy.autoApprove, { specId: flow.specId })],
      ["upgrade artifact", () => flow.manager.publishUpgradeResult({ specId: flow.specId,
        artifact: { logicalKey: "upgrade.result", mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(upgrade)}\n`, "utf8") } })],
      ["plugin artifact", () => flow.manager.publishPluginArtifacts({ specId: flow.specId,
        artifactWrites: [pluginWrite] })],
      ["dispatch approval", () => flow.manager.recordDispatchApproval({ specId: flow.specId, receipt: approval })],
      ["runtime nonblocking policy", () => flow.manager._store.runtime.activateNonblockingPolicy({
        specId: flow.specId, activityId: "post-finalization-policy",
        policy: { autoApprove: false, nonblocking: { enabled: true,
          activatedAt: "2026-10-13T00:00:00.000Z", activatedStep: "test-result-review",
          reason: "A finalized Flow cannot accept a new policy." } },
        nonblocking: { kind: "observation", sourceStep: "scenario-validity", sourceAttempt: 1,
          evidenceRef: "steps/scenario-validity/result.json", evidenceDigest: "a".repeat(64),
          definitionDigest: "b".repeat(64), resultKind: "unavailable", action: null,
          rationale: null, remainingRisk: null },
      })],
      ["direct new Activity", () => flow.manager.applyActivity(unacknowledged, { specId: flow.specId })],
    ]) {
      assert.throws(mutate, /finalized Flow rejects subsequent Activities/, `${name} must reject a new durable Activity`);
      assert.deepEqual(flow.reload().snapshot(), canonical);
      persisted.assertUnchanged(flow.manager, flow.specId, name);
      assert.deepEqual(flow.gitSnapshot(), git);
      assert.deepEqual(fs.readFileSync(path.join(flow.root, POINTER_REL_PATH)), pointer);
      assert.deepEqual(flow.report(cleanupStep), source);
    }
    flow.assertResults([cleanupStep], { expectedKinds: { [cleanupStep]: "finalize-cleanup-completed" } });
  });
}
