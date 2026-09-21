import { describe, it, afterEach } from "node:test";
import {
  CanonicalAutoCheckScenario,
  canonicalDraftDocument,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { DraftRefineConnector } from "../../../src/flow/engine/connectors/draft/draft-refine-connector.js";
import { DraftRefineStep } from "../../../src/flow/steps/draft/draft-refine.js";
import { DraftService } from "../../../src/flow/services/draft-service.js";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, spawnSync } from "node:child_process";
import {
  writeStubAgentScript,
  writeCapturingStubAgentScript,
  stubAgentConfig,
} from "../../support/fakes/stub-agent.js";

function passResponse() {
  return JSON.stringify({
    specBuildability: 2,
    ambiguity: 2,
    verifiability: 2,
    scopeBoundedness: 2,
    targetSpecificity: 1,
    precedent: 1,
    goal: "add a progress bar",
    reason: "stub pass",
  });
}

function lowResponse() {
  return JSON.stringify({
    specBuildability: 1,
    ambiguity: 0,
    verifiability: 1,
    scopeBoundedness: 1,
    targetSpecificity: 0,
    precedent: 0,
    goal: "add a progress bar",
    reason: "stub low",
  });
}

function createTmpProject(agentResponse = passResponse()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "set-auto-"));
  fs.mkdirSync(path.join(tmp, ".sennel"), { recursive: true });
  execFileSync("git", ["init", tmp], { stdio: "ignore" });

  const stubPath = writeStubAgentScript(tmp, ".stub-agent.js", agentResponse);
  fs.writeFileSync(
    path.join(tmp, ".sennel", "config.json"),
    JSON.stringify({
      lang: "ja",
      type: "base",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
      agent: stubAgentConfig(stubPath),
    }),
  );
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture" }));
  return tmp;
}

function createFlowState(tmp, request = "add a progress bar") {
  return new CanonicalAutoCheckScenario({
    flowManager: makeFlowManager(tmp),
    specId: "001-test",
    runId: "run-001-test",
    request,
    execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
  }).create();
}

function runFlowCommand(tmp, args) {
  const script = path.resolve("src/sennel.js");
  return spawnSync("node", [script, ...args], {
    encoding: "utf8",
    cwd: tmp,
    env: { ...process.env, SENNEL_WORK_ROOT: tmp },
  });
}

function runSetAuto(tmp, value, extraArgs = []) {
  const args = ["flow", "set", "auto"];
  if (value !== undefined) args.push(value);
  args.push(...extraArgs);
  return runFlowCommand(tmp, args);
}

describe("flow set auto", () => {
  let tmp;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("sets autoApprove to true with 'on' when auto-check is eligible", () => {
    tmp = createTmpProject(passResponse());
    createFlowState(tmp);
    const res = runSetAuto(tmp, "on");
    assert.equal(res.status, 0, res.stderr);
    const output = JSON.parse(res.stdout.trim());
    assert.equal(output.ok, true);
    assert.equal(output.data.autoApprove, true);
    const state = makeFlowManager(tmp).load();
    assert.equal(state.autoApprove, true);
    assert.equal(Object.hasOwn(state, "autoCheck"), false);
  });

  it("reselects draft-refine on the same Attempt when auto is enabled after a persisted Await", async () => {
    tmp = createTmpProject(passResponse());
    const specId = "001-test";
    const manager = makeFlowManager(tmp);
    const scenario = new CanonicalAutoCheckScenario({
      flowManager: manager,
      specId,
      runId: "run-001-test",
      request: "Resolve a persisted Draft question automatically.",
      execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
    }).create();
    const source = canonicalDraftDocument({
      questions: [{
        state: "AwaitingUserAnswer",
        id: "q1",
        category: "user-visible-behavior",
        question: "Which public behavior should be selected?",
        revision: 0,
        provenance: { producer: "set-auto-regression" },
        evidenceDigest: "a".repeat(64),
      }],
    });
    scenario.draftSavedBeforeGate(`${JSON.stringify(source, null, 2)}\n`);
    scenario.flow.activate("draft-refine");
    const manualBinding = await new DraftRefineConnector({ flowManager: manager, specId }).connect();
    const awaiting = await new DraftRefineStep(new DraftService({
      flowManager: manager,
      binding: manualBinding,
    })).execute();
    assert.equal(awaiting.kind, "draft-refine-awaiting-answer");
    const retainedAttempt = manager.canonicalState(specId).attempt.toJSON();
    const beforeAutoActivities = manager.activityLedger(specId).length;

    const enabled = runSetAuto(tmp, "on");
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(JSON.parse(enabled.stdout).data.autoApprove, true);

    const reloaded = makeFlowManager(tmp);
    const next = runFlowCommand(tmp, ["flow", "get", "next-action"]);
    assert.equal(next.status, 0, next.stderr);
    const nextData = JSON.parse(next.stdout).data;
    assert.equal(nextData.step, "draft-refine");
    assert.equal(nextData.directive.kind, "execute_step");
    assert.equal(nextData.directive.requiresUserAction, false);

    const rejectedAnswer = runFlowCommand(tmp, [
      "flow", "set", "draft-answer", "q1",
      "--question-revision", "0",
      "--answer", "A fabricated answer must not be accepted.",
      "--why", "Auto mode owns the next Step selection.",
    ]);
    assert.notEqual(rejectedAnswer.status, 0);
    assert.equal(JSON.parse(rejectedAnswer.stdout).errors[0].code, "DRAFT_ANSWER_NOT_SELECTED");

    const binding = await new DraftRefineConnector({ flowManager: reloaded, specId }).connect();
    const execution = reloaded.draftStepExecutionState({ binding });
    const executionBinding = execution.workerBinding({
      inputDigest: "b".repeat(64),
      inputRevision: "c".repeat(64),
    });
    const selected = await new DraftRefineStep(new DraftService({
      flowManager: reloaded,
      binding,
      executionCheckpointer: (stepResult, settlement, selectedBinding) => (
        reloaded.checkpointDraftStepExecution({
          binding: selectedBinding,
          stepResult,
          settlement,
          executionBinding,
        })
      ),
    })).execute();

    assert.equal(selected.kind, "draft-refine-worker-required");
    assert.deepEqual(reloaded.canonicalState(specId).attempt.toJSON(), retainedAttempt);
    assert.equal(reloaded.draftStepExecutionState({ binding }).lifecycle.phase, "checkpoint");
    const autoActivities = reloaded.activityLedger(specId).slice(beforeAutoActivities);
    assert.equal(autoActivities.filter((activity) => (
      activity.type === "policy_updated" && activity.transition?.policy?.autoApprove === true
    )).length, 1);
    assert.equal(autoActivities.filter((activity) => (
      activity.result?.draftSettlementReceipt?.executionLifecycle?.phase === "checkpoint"
    )).length, 1);
    assert.equal(autoActivities.some((activity) => (
      activity.transition?.draftResumeReceipt != null
    )), false);
  });

  it("rejects 'on' with non-zero exit when auto-check is ineligible (AI scores)", () => {
    tmp = createTmpProject(lowResponse());
    createFlowState(tmp);
    const res = runSetAuto(tmp, "on");
    assert.notEqual(res.status, 0);
    const envelope = JSON.parse(res.stdout.trim());
    assert.equal(envelope.ok, false);
    assert.ok(
      envelope.errors?.some((e) => /auto-check|reject|eligible/i.test(e.messages?.join(" ") ?? "")),
      "envelope must include reject reason",
    );
    const state = makeFlowManager(tmp).load();
    assert.notEqual(state.autoApprove, true, "autoApprove must not be updated on reject");
    assert.equal(Object.hasOwn(state, "autoCheck"), false);
  });

  it("rejects 'on' when static gate hits (no AI needed)", () => {
    tmp = createTmpProject(passResponse());
    createFlowState(tmp, "reset password and run migration");
    const res = runSetAuto(tmp, "on");
    assert.notEqual(res.status, 0);
    const state = makeFlowManager(tmp).load();
    assert.notEqual(state.autoApprove, true);
    assert.equal(Object.hasOwn(state, "autoCheck"), false);
  });

  it("sets autoApprove to false with 'off' without running auto-check", () => {
    tmp = createTmpProject(passResponse());
    createFlowState(tmp);
    runSetAuto(tmp, "on");
    const res = runSetAuto(tmp, "off");
    assert.equal(res.status, 0, res.stderr);
    const output = JSON.parse(res.stdout.trim());
    assert.equal(output.ok, true);
    assert.equal(output.data.autoApprove, false);
  });

  it("sets autoApprove on a preparing flow when no flow.json exists", () => {
    tmp = createTmpProject(passResponse());
    // Create a preparing flow (no flow.json)
    const fm = makeFlowManager(tmp);
    const runId = fm.generateRunId();
    fm.createPreparingFlow(runId, { request: "add a progress bar" });

    const res = runSetAuto(tmp, "on", ["--run-id", runId]);
    assert.equal(res.status, 0, res.stderr);
    const output = JSON.parse(res.stdout.trim());
    assert.equal(output.ok, true);
    assert.equal(output.data.autoApprove, true);
    assert.equal(output.data.runId, runId);

    const preparing = fm.loadPreparingFlow(runId);
    assert.equal(preparing.autoApprove, true);
    assert.ok(preparing.autoCheck);
    assert.equal(preparing.autoCheck.eligible, true);
  });

  it("fails with MISSING_RUN_ID when no flow.json and preparing flows exist without --run-id (spec 220)", () => {
    tmp = createTmpProject(passResponse());
    const fm = makeFlowManager(tmp);
    fm.createPreparingFlow(fm.generateRunId(), { request: "a" });
    fm.createPreparingFlow(fm.generateRunId(), { request: "b" });

    const res = runSetAuto(tmp, "on");
    assert.notEqual(res.status, 0);
    const envelope = JSON.parse(res.stdout.trim());
    assert.equal(envelope.ok, false);
    const codes = (envelope.errors || []).map((e) => e.code);
    assert.ok(
      codes.includes("MISSING_RUN_ID"),
      `expected MISSING_RUN_ID, got ${codes.join(",")}`,
    );
  });

  it("fails with MISSING_RUN_ID even when only one preparing exists (spec 220 — no auto-select)", () => {
    tmp = createTmpProject(passResponse());
    const fm = makeFlowManager(tmp);
    fm.createPreparingFlow(fm.generateRunId(), { request: "sole" });

    const res = runSetAuto(tmp, "on");
    assert.notEqual(res.status, 0);
    const envelope = JSON.parse(res.stdout.trim());
    const codes = (envelope.errors || []).map((e) => e.code);
    assert.ok(
      codes.includes("MISSING_RUN_ID"),
      `expected MISSING_RUN_ID for single preparing, got ${codes.join(",")}`,
    );
  });

  it("targets a specific preparing flow via --run-id", () => {
    tmp = createTmpProject(passResponse());
    const fm = makeFlowManager(tmp);
    const runIdA = fm.generateRunId();
    const runIdB = fm.generateRunId();
    fm.createPreparingFlow(runIdA, { request: "add a progress bar" });
    fm.createPreparingFlow(runIdB, { request: "add a progress bar" });

    const script = path.resolve("src/sennel.js");
    const res = spawnSync(
      "node",
      [script, "flow", "set", "auto", "on", "--run-id", runIdB],
      { encoding: "utf8", cwd: tmp, env: { ...process.env, SENNEL_WORK_ROOT: tmp } },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fm.loadPreparingFlow(runIdA).autoApprove, false);
    assert.equal(fm.loadPreparingFlow(runIdB).autoApprove, true);
  });

  it("skips auto-check when approval step is done (R1/R2)", () => {
    tmp = createTmpProject(lowResponse()); // would reject if auto-check ran
    createFlowState(tmp, "reset password and run migration").approvalDone();

    const res = runSetAuto(tmp, "on");
    assert.equal(res.status, 0, res.stderr);
    const output = JSON.parse(res.stdout.trim());
    assert.equal(output.ok, true);
    assert.equal(output.data.autoApprove, true);

    const saved = makeFlowManager(tmp).load();
    assert.equal(saved.autoApprove, true);
    assert.equal(Object.hasOwn(saved, "autoCheck"), false);
  });

  it("appends draft.json to auto-check input when draft-gate done (spec 220)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "set-auto-draft-"));
    fs.mkdirSync(path.join(tmp, ".sennel"), { recursive: true });
    execFileSync("git", ["init", tmp], { stdio: "ignore" });

    const capturePath = path.join(tmp, "captured-prompt.txt");
    const stubPath = writeCapturingStubAgentScript(
      tmp,
      ".stub-agent.js",
      capturePath,
      passResponse(),
    );
    fs.writeFileSync(
      path.join(tmp, ".sennel", "config.json"),
      JSON.stringify({
        lang: "ja",
        type: "base",
        docs: { languages: ["ja"], defaultLanguage: "ja" },
        agent: stubAgentConfig(stubPath),
      }),
    );
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture" }));

    const DRAFT_MARKER = "UNIQUE_DRAFT_CONTENT_MARKER_QWERTY";
    const REQUEST_MARKER = "REQUEST_MARKER_APPENDED_ALONGSIDE_DRAFT";
    const draftText = JSON.stringify(canonicalDraftDocument({ goal: DRAFT_MARKER }));
    new CanonicalAutoCheckScenario({
      flowManager: makeFlowManager(tmp),
      specId: "001-test",
      runId: "run-001-test",
      request: REQUEST_MARKER,
      execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
    }).create().draftGateDone(draftText);

    const res = runSetAuto(tmp, "on");
    assert.equal(res.status, 0, res.stderr);

    const captured = fs.readFileSync(capturePath, "utf8");
    assert.ok(captured.includes(DRAFT_MARKER), "auto-check prompt must include draft content");
    assert.ok(
      captured.includes(REQUEST_MARKER),
      "spec 220: request must be included alongside draft (not replaced)",
    );
    assert.ok(captured.indexOf(REQUEST_MARKER) < captured.indexOf(DRAFT_MARKER));

    const saved = makeFlowManager(tmp).load();
    assert.equal(saved.autoApprove, true);
    assert.equal(Object.hasOwn(saved, "autoCheck"), false);
  });

  it("rejects an incomplete draft before it can reach draft-gate", () => {
    tmp = createTmpProject(passResponse());
    const scenario = new CanonicalAutoCheckScenario({
      flowManager: makeFlowManager(tmp),
      specId: "001-test",
      runId: "run-001-test",
      request: "add a progress bar",
      execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
    }).create();

    assert.throws(() => scenario.draftGateDone(JSON.stringify({
      ...canonicalDraftDocument(),
      goal: "",
    })), /draft publication is incomplete: missing or empty goal/);

    const saved = makeFlowManager(tmp).load();
    assert.equal(saved.currentNodeId, "draft");
    assert.equal(saved.autoApprove, false);
    assert.equal(Object.hasOwn(saved, "autoCheck"), false);
  });

  it("falls back to request+issue input when approval pending and no draft.json (R5)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "set-auto-fallback-"));
    fs.mkdirSync(path.join(tmp, ".sennel"), { recursive: true });
    execFileSync("git", ["init", tmp], { stdio: "ignore" });

    const capturePath = path.join(tmp, "captured-prompt.txt");
    const stubPath = writeCapturingStubAgentScript(
      tmp,
      ".stub-agent.js",
      capturePath,
      passResponse(),
    );
    fs.writeFileSync(
      path.join(tmp, ".sennel", "config.json"),
      JSON.stringify({
        lang: "ja",
        type: "base",
        docs: { languages: ["ja"], defaultLanguage: "ja" },
        agent: stubAgentConfig(stubPath),
      }),
    );
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture" }));

    const REQUEST_MARKER = "ORIGINAL_REQUEST_TEXT_MARKER_12345";
    new CanonicalAutoCheckScenario({
      flowManager: makeFlowManager(tmp),
      specId: "001-test",
      runId: "run-001-test",
      request: `add a progress bar ${REQUEST_MARKER}`,
      execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
    }).create();

    const res = runSetAuto(tmp, "on");
    assert.equal(res.status, 0, res.stderr);

    const captured = fs.readFileSync(capturePath, "utf8");
    assert.ok(
      captured.includes(REQUEST_MARKER),
      "auto-check prompt must include original request when no draft exists",
    );
  });

  it("fails without argument", () => {
    tmp = createTmpProject();
    createFlowState(tmp);
    const res = runSetAuto(tmp, undefined);
    assert.notEqual(res.status, 0);
    const output = JSON.parse(res.stdout.trim());
    assert.equal(output.ok, false);
  });

  describe("PREPARING_FLOW_NOT_FOUND for unknown --run-id", () => {
    function createCapturingFixture(prefix) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      fs.mkdirSync(path.join(dir, ".sennel"), { recursive: true });
      execFileSync("git", ["init", dir], { stdio: "ignore" });
      const capturePath = path.join(dir, "captured-prompt.txt");
      const stubPath = writeCapturingStubAgentScript(
        dir,
        ".stub-agent.js",
        capturePath,
        passResponse(),
      );
      fs.writeFileSync(
        path.join(dir, ".sennel", "config.json"),
        JSON.stringify({
          lang: "ja",
          type: "base",
          docs: { languages: ["ja"], defaultLanguage: "ja" },
          agent: stubAgentConfig(stubPath),
        }),
      );
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
      return { dir, capturePath };
    }

    function runSetAutoWithRunId(dir, value, runId) {
      const script = path.resolve("src/sennel.js");
      return spawnSync(
        "node",
        [script, "flow", "set", "auto", value, "--run-id", runId],
        { encoding: "utf8", cwd: dir, env: { ...process.env, SENNEL_WORK_ROOT: dir } },
      );
    }

    it("fails for 'on' without invoking AI", () => {
      const fixture = createCapturingFixture("set-auto-notfound-on-");
      tmp = fixture.dir;
      const nonexistent = "00000000-0000-0000-0000-000000000000";
      const res = runSetAutoWithRunId(tmp, "on", nonexistent);
      assert.notEqual(res.status, 0);
      const envelope = JSON.parse(res.stdout.trim());
      assert.equal(envelope.ok, false);
      assert.ok(
        envelope.errors?.some((e) => e.code === "PREPARING_FLOW_NOT_FOUND"),
        "envelope must include PREPARING_FLOW_NOT_FOUND code",
      );
      assert.ok(
        envelope.errors?.some((e) => (e.messages?.join(" ") ?? "").includes(nonexistent)),
        "envelope message must include the offending runId",
      );
      assert.equal(
        fs.existsSync(fixture.capturePath),
        false,
        "AI agent must not be invoked when --run-id does not exist",
      );
    });

    it("fails for 'off' without invoking AI", () => {
      const fixture = createCapturingFixture("set-auto-notfound-off-");
      tmp = fixture.dir;
      const nonexistent = "11111111-1111-1111-1111-111111111111";
      const res = runSetAutoWithRunId(tmp, "off", nonexistent);
      assert.notEqual(res.status, 0);
      const envelope = JSON.parse(res.stdout.trim());
      assert.equal(envelope.ok, false);
      assert.ok(
        envelope.errors?.some((e) => e.code === "PREPARING_FLOW_NOT_FOUND"),
        "envelope must include PREPARING_FLOW_NOT_FOUND code",
      );
      assert.equal(
        fs.existsSync(fixture.capturePath),
        false,
        "AI agent must not be invoked for 'off' path",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Spec 218: Trust previously persisted autoCheck instead of re-invoking the AI.
  // Preparing records exist before the exact V1 flow.json schema, so their
  // auto-check result remains a pre-creation handoff. Active Flow state must
  // instead reject that retired cache field rather than accepting a second
  // schema dialect.
  // ---------------------------------------------------------------------------

  function createCapturingProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-auto-trust-"));
    fs.mkdirSync(path.join(dir, ".sennel"), { recursive: true });
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    const capturePath = path.join(dir, "captured-prompt.txt");
    const stubPath = writeCapturingStubAgentScript(
      dir,
      ".stub-agent.js",
      capturePath,
      passResponse(),
    );
    fs.writeFileSync(
      path.join(dir, ".sennel", "config.json"),
      JSON.stringify({
        lang: "ja",
        type: "base",
        docs: { languages: ["ja"], defaultLanguage: "ja" },
        agent: stubAgentConfig(stubPath),
      }),
    );
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
    return { dir, capturePath };
  }

  function writeRetiredActiveAutoCheck(dir, autoCheck) {
    createFlowState(dir);
    const manager = makeFlowManager(dir);
    const location = manager.specLocation("001-test");
    const state = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
    state.autoCheck = autoCheck;
    fs.writeFileSync(location.flowStateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  it("trusts persisted autoCheck on preparing flow without re-invoking the agent", () => {
    const { dir, capturePath } = createCapturingProject();
    tmp = dir;
    const fm = makeFlowManager(tmp);
    const runId = fm.generateRunId();
    fm.createPreparingFlow(runId, { issue: 230 });
    fm.mutatePreparingFlow(runId, (s) => {
      s.autoCheck = {
        eligible: true,
        score: 20,
        maxScore: 24,
        threshold: 18,
        breakdown: {},
        staticGates: { G: false, H: false, I: false },
        goalGate: { checked: true, passed: true },
        reason: "persisted by run auto-check",
      };
    });

    const res = runSetAuto(tmp, "on", ["--run-id", runId]);
    assert.equal(res.status, 0, res.stderr);
    const output = JSON.parse(res.stdout.trim());
    assert.equal(output.ok, true);
    assert.equal(output.data.autoApprove, true);

    assert.equal(
      fs.existsSync(capturePath),
      false,
      "agent must not be invoked when a verdict is already persisted",
    );

    const preparing = fm.loadPreparingFlow(runId);
    assert.equal(preparing.autoApprove, true);
    assert.equal(preparing.autoCheck.reason, "persisted by run auto-check");
  });

  it("rejects persisted autoCheck on preparing flow without re-invoking the agent (eligible:false)", () => {
    const { dir, capturePath } = createCapturingProject();
    tmp = dir;
    const fm = makeFlowManager(tmp);
    const runId = fm.generateRunId();
    fm.createPreparingFlow(runId, { issue: 230 });
    fm.mutatePreparingFlow(runId, (s) => {
      s.autoCheck = {
        eligible: false,
        score: 4,
        maxScore: 24,
        threshold: 18,
        breakdown: {},
        staticGates: { G: false, H: false, I: false },
        goalGate: { checked: true, passed: false },
        reason: "persisted ineligible",
      };
    });

    const res = runSetAuto(tmp, "on", ["--run-id", runId]);
    assert.notEqual(res.status, 0);
    const envelope = JSON.parse(res.stdout.trim());
    assert.equal(envelope.ok, false);
    assert.ok(
      envelope.errors?.some((e) => /AUTO_CHECK_INELIGIBLE/.test(e.code ?? "")),
      "envelope must signal AUTO_CHECK_INELIGIBLE",
    );

    assert.equal(
      fs.existsSync(capturePath),
      false,
      "agent must not be invoked when a verdict is already persisted",
    );

    const preparing = fm.loadPreparingFlow(runId);
    assert.notEqual(preparing.autoApprove, true);
    assert.equal(preparing.autoCheck.reason, "persisted ineligible");
  });

  it("rejects a retired active autoCheck cache without invoking the agent", () => {
    const { dir, capturePath } = createCapturingProject();
    tmp = dir;
    writeRetiredActiveAutoCheck(tmp, {
      eligible: true,
      score: 20,
      maxScore: 24,
      threshold: 18,
      breakdown: {},
      staticGates: { G: false, H: false, I: false },
      goalGate: { checked: true, passed: true },
      reason: "retired active cache",
    });

    const res = runSetAuto(tmp, "on");
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /artifact content does not match the catalog: flow\.json/);

    assert.equal(
      fs.existsSync(capturePath),
      false,
      "agent must not be invoked when active state violates the exact schema",
    );
  });

  it("rejects a retired active cache missing goalGate as the same schema violation", () => {
    const { dir, capturePath } = createCapturingProject();
    tmp = dir;
    writeRetiredActiveAutoCheck(tmp, {
      eligible: true,
      score: 20,
      maxScore: 24,
      threshold: 18,
      breakdown: {},
      staticGates: { G: false, H: false, I: false },
      reason: "retired cache without goal gate",
    });

    const res = runSetAuto(tmp, "on");
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /artifact content does not match the catalog: flow\.json/);

    assert.equal(
      fs.existsSync(capturePath),
      false,
      "agent must not be invoked when active state violates the exact schema",
    );
  });

  it("falls back to agent invocation on preparing flow when no autoCheck is persisted", () => {
    const { dir, capturePath } = createCapturingProject();
    tmp = dir;
    const fm = makeFlowManager(tmp);
    const runId = fm.generateRunId();
    fm.createPreparingFlow(runId, { request: "add a progress bar" });

    const res = runSetAuto(tmp, "on", ["--run-id", runId]);
    assert.equal(res.status, 0, res.stderr);
    const output = JSON.parse(res.stdout.trim());
    assert.equal(output.ok, true);
    assert.equal(output.data.autoApprove, true);

    assert.ok(
      fs.existsSync(capturePath),
      "agent must be invoked when no verdict is persisted (fallback path)",
    );

    const preparing = fm.loadPreparingFlow(runId);
    assert.equal(preparing.autoApprove, true);
    assert.ok(preparing.autoCheck);
    assert.equal(preparing.autoCheck.eligible, true);
  });
});
