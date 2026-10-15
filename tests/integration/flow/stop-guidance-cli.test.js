import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { validateFlowQueryResponse } from "../../../src/flow/query-contract.js";
import { flowCliFailure } from "../../../src/lib/flow-cli-failure.js";
import { QueryError, serializeQueryResponse } from "../../../src/flow/query.js";
import { AgentTimeoutFailure } from "../../../src/lib/agent-failure.js";
import { flowStopPresentationDigest } from "../../../src/lib/flow-stop-guidance.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const cli = path.join(repository, "src/sennel.js");
const secret = "ownerToken=private-owner capability=private-capability SENNEL_SECRET=private-environment";

function fixture(t, { copyRuntime = false, config = null } = {}) {
  const root = createTmpDir("flow-stop-guidance-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (copyRuntime) {
    fs.cpSync(path.join(repository, "src"), path.join(root, "src"), { recursive: true });
    fs.copyFileSync(path.join(repository, "package.json"), path.join(root, "package.json"));
  }
  if (config !== null) {
    fs.mkdirSync(path.join(root, ".sennel"));
    fs.writeFileSync(path.join(root, ".sennel/config.json"), config);
  }
  return root;
}

function invoke(root, args, { entry = cli, input = "" } = {}) {
  const result = spawnSync(process.execPath, [entry, "flow", ...args], {
    cwd: root, input, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root, NODE_OPTIONS: "" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, false);
  assert.doesNotMatch(result.stdout + result.stderr, /private-owner|private-capability|private-environment|unlabeledsecret/);
  assert.equal(value.guidance.schemaVersion, 1);
  assert.ok(value.guidance.explanation.length > 0);
  assert.ok(value.guidance.nextAction.instruction.length > 0);
  return { ...result, value };
}

test("unknown group/key and parse refusal reach the final typed CLI boundary", (t) => {
  const root = fixture(t);
  for (const args of [["unknown"], ["get", "unknown"], ["get", "status", "--unknown"]]) {
    const { value } = invoke(root, args);
    assert.equal(value.errors.length, 1);
    assert.equal(value.guidance.code, value.errors[0].code);
    assert.equal(value.guidance.nextAction.kind, "external_work");
    assert.equal(value.guidance.currentState.persistence, "unconfirmed");
  }
});

test("all Flow entry groups publish initialization refusal without leaking config text", (t) => {
  const mainRoot = fixture(t, { config: JSON.stringify({ lang: "en", flow: { specDir: "specs" } }) });
  initGitRepo(mainRoot);
  commitAll(mainRoot, "Valid configuration seed");
  const root = path.join(mainRoot, "linked");
  execFileSync("git", ["worktree", "add", "--detach", root], { cwd: mainRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(mainRoot, ".sennel/config.json"), "unlabeledsecret");
  for (const args of [["get", "status"], ["set", "request"], ["run", "dispatch"], ["report"], ["resume"], ["prepare"]]) {
    const { value } = invoke(root, args);
    assert.equal(value.guidance.code, "FLOW_INITIALIZATION_FAILED");
    assert.equal(value.guidance.currentState.completion, "unconfirmed");
    assert.equal(value.guidance.nextAction.kind, "external_work");
  }
});

test("query failures project the shared guidance into one read-only canonical wire response", (t) => {
  const root = fixture(t);
  const { value, stdout } = invoke(root, ["query"], { input: `{${secret}` });
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.equal(value.error.code, "INVALID_JSON");
  assert.equal(value.guidance.code, "INVALID_JSON");
  assert.equal(value.guidance.currentState.operation, "flow query");
  assert.equal(value.guidance.nextAction.kind, "external_work");
  assert.equal(Object.hasOwn(value, "directive"), false);
  assert.deepEqual(validateFlowQueryResponse(value), []);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("a missing locale catalog preserves the original query error and canonical failure shape", (t) => {
  const root = fixture(t, { copyRuntime: true });
  fs.writeFileSync(path.join(root, "src/locale/en/messages.json"), "{invalid-locale");
  const { value } = invoke(root, ["query"], { entry: path.join(root, "src/sennel.js"), input: "{invalid-request" });
  assert.equal(value.error.code, "INVALID_JSON");
  assert.equal(value.guidance.code, "INVALID_JSON");
  assert.equal(value.guidance.nextAction.kind, "external_work");
  assert.deepEqual(validateFlowQueryResponse(value), []);
});

test("loader and semantic import failures publish the same minimal bootstrap wire schema", (t) => {
  for (const source of ["lib/runtime-loader.js", "lib/container.js"]) {
    const root = fixture(t, { copyRuntime: true });
    fs.writeFileSync(path.join(root, "src", source), `throw Object.assign(new Error(${JSON.stringify(secret)}), { code: "RUNTIME_TEST_FAILURE" });\n`);
    const entry = path.join(root, "src/sennel.js");
    for (const args of [["query"], ["get", "status"]]) {
      const { value } = invoke(root, args, { entry, input: "{}" });
      assert.equal(value.guidance.code, "FLOW_BOOTSTRAP_FAILED");
      assert.equal(value.guidance.cause.kind, "bootstrap");
      assert.equal(value.guidance.cause.code, source === "lib/runtime-loader.js" ? "RUNTIME_TEST_FAILURE" : "SYNTAX_ERROR");
      assert.equal(value.guidance.cause.recoveryHint, "unconfirmed");
      assert.match(value.guidance.diagnosticReference, /^FLOW_BOOTSTRAP_FAILED:[a-f0-9]{64}$/);
      assert.equal(value.guidance.presentationDigest, flowStopPresentationDigest(null, value.guidance.nextAction));
      assert.ok(Object.entries(value.guidance.currentState).every(([field, fact]) => field === "communicationAttempts" ? fact.length === 0 : fact === "unconfirmed"));
      assert.equal(value.guidance.nextAction.kind, "external_work");
      assert.equal(value.data ?? null, null);
      if (args[0] === "query") assert.deepEqual(validateFlowQueryResponse(value), []);
    }
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  }
});

test("CLI and query adapters retain the original typed cause while publishing safe facts", () => {
  const failure = new AgentTimeoutFailure({ message: secret, timeoutMs: 100, attemptCount: 2, maxAttempts: 3 });
  const original = new QueryError("CANONICAL_RECORD_UNREADABLE", "/canonical", "Canonical query could not be read", { cause: failure });
  const envelope = flowCliFailure(original);
  const serialized = envelope.toJSON();
  assert.equal(original.cause, failure);
  assert.equal(serialized.guidance.cause.kind, failure.kind);
  assert.equal(serialized.guidance.currentState.attemptCount, 2);
  const response = JSON.parse(serializeQueryResponse({ schemaRevision: 3, ok: false, snapshot: null, completeness: null,
    error: { code: original.code, path: original.jsonPath, message: original.message, reason: null, referenceId: null } }, { error: original }));
  assert.equal(original.cause, failure);
  assert.equal(response.guidance.cause.kind, failure.kind);
  assert.equal(response.guidance.currentState.maxAttempts, 3);
  assert.doesNotMatch(JSON.stringify(response), /private-owner|private-capability|private-environment/);
  const absent = structuredClone(response);
  delete absent.guidance;
  assert.notEqual(validateFlowQueryResponse(absent).length, 0);
  const widened = structuredClone(response);
  widened.guidance.currentState.ownerToken = secret;
  assert.notEqual(validateFlowQueryResponse(widened).length, 0);
});

test("pre-dispatch diagnostics retain stable original codes and safe messages", () => {
  const error = Object.assign(new Error("The configuration file is not readable."), { code: "CONFIG_READ_FAILED" });
  const response = flowCliFailure(error).toJSON();
  assert.equal(response.errors[0].code, "CONFIG_READ_FAILED");
  assert.deepEqual(response.errors[0].messages, [error.message]);
  assert.equal(response.guidance.cause.code, "CONFIG_READ_FAILED");
  const unsafe = flowCliFailure(Object.assign(new Error(secret), { code: "CONFIG_READ_FAILED" })).toJSON();
  assert.equal(unsafe.errors[0].code, "CONFIG_READ_FAILED");
  assert.doesNotMatch(JSON.stringify(unsafe), /private-owner|private-capability|private-environment/);
});

test("native JSON syntax failures with unlabeled snippets stay private through wrapped causes", () => {
  let syntaxError;
  try { JSON.parse("unlabeledsecret"); } catch (error) { syntaxError = error; }
  assert.ok(syntaxError instanceof SyntaxError);
  for (const error of [syntaxError, new Error("Unable to read unlabeledsecret", { cause: syntaxError })]) {
    error.code = "CONFIG_READ_FAILED";
    const response = flowCliFailure(error).toJSON();
    assert.equal(response.errors[0].code, "CONFIG_READ_FAILED");
    assert.equal(response.guidance.cause.code, "CONFIG_READ_FAILED");
    assert.doesNotMatch(JSON.stringify(response), /unlabeledsecret/);
  }
});
