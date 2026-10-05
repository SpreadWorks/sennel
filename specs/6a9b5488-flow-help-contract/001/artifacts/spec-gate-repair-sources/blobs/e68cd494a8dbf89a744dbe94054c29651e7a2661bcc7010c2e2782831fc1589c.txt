import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { runCmdAsync } from "../../lib/process.js";
import { FlowArtifactAttemptHistory } from "../../lib/flow-artifact-contract.js";
import { FlowCommand } from "./base-command.js";
import { attachCanonicalCommandResultArtifact } from "./canonical-command-result.js";
import { CanonicalTestArtifactStore, isCanonicalFlowState } from "./canonical-test-artifacts.js";
import { RequirementTestCheck } from "./requirement-test-check.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestGateObservation,
  RequirementTestGateResult,
} from "./requirement-test-artifacts.js";
import { RequirementTestArtifactStore } from "./requirement-test-store.js";
import { SharedSpecTestExecution } from "./shared-spec-test-execution.js";
import { extractTestNameReqIds, scanFileHeader } from "./test-headers.js";
import { SpecTestBootstrapValidator } from "./spec-test-bootstrap-validator.js";

const TEST_NAME_RE = /(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const SKIPPED_TEST_NAME_RE = /(?:it|test)\.skip\s*\(\s*["'`]([^"'`]+)["'`]/g;
const TEST_FILE_RE = /\.(test|spec)\.(js|ts|mjs)$/;

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function candidateSourcesByPath(candidateBundle, sourceBytes) {
  const bundle = candidateBundle instanceof RequirementTestCandidateBundle
    ? candidateBundle
    : RequirementTestCandidateBundle.fromJSON(candidateBundle);
  const entries = sourceBytes instanceof Map
    ? [...sourceBytes.entries()]
    : Object.entries(sourceBytes || {});
  const bytesByPath = new Map(entries.map(([file, bytes]) => [file, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]));
  for (const source of bundle.sources) {
    const bytes = bytesByPath.get(source.testPath);
    if (!bytes) throw new Error(`candidate source bytes are missing: ${source.testPath}`);
    if (bytes.length !== source.byteLength) throw new Error(`candidate source byte length does not match: ${source.testPath}`);
    const actualDigest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== source.digest) throw new Error(`candidate source digest is invalid: ${source.testPath}`);
  }
  for (const support of bundle.support) {
    const bytes = bytesByPath.get(support.supportPath);
    if (!bytes) throw new Error(`candidate support bytes are missing: ${support.supportPath}`);
    if (bytes.length !== support.byteLength) throw new Error(`candidate support byte length does not match: ${support.supportPath}`);
    const actualDigest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== support.digest) throw new Error(`candidate support digest is invalid: ${support.supportPath}`);
  }
  if (bytesByPath.size !== bundle.sources.length + bundle.support.length) {
    throw new Error("candidate source set contains an unassigned path");
  }
  return { bundle, bytesByPath };
}

function assignedNames(filePath, source, requirementId) {
  const ids = extractTestNameReqIds(filePath);
  if (!ids.includes(requirementId)) return [];
  const names = [];
  TEST_NAME_RE.lastIndex = 0;
  let match;
  while ((match = TEST_NAME_RE.exec(source)) !== null) {
    if (match[1].startsWith(`${requirementId}:`)) names.push(match[1]);
  }
  return names;
}

function skippedNames(source, requirementId) {
  const names = [];
  SKIPPED_TEST_NAME_RE.lastIndex = 0;
  let match;
  while ((match = SKIPPED_TEST_NAME_RE.exec(source)) !== null) {
    if (match[1].startsWith(`${requirementId}:`)) names.push(match[1]);
  }
  return names;
}

function processLines(process) {
  return [
    process.stdout || "",
    process.stderr || "",
    process.spawnError ? `spawnError: ${process.spawnError}` : "",
    process.signal ? `signal: ${process.signal}` : "",
    process.timedOut ? "timeout: true" : "",
    `exitCode: ${process.exitCode}`,
  ].filter(Boolean).join("\n");
}

function observationFor({ bundle, requirementId, specRevision, kind, testName }) {
  return new RequirementTestGateObservation({
    requirementId,
    specRevision,
    bundleRevision: bundle.bundle.revision,
    candidateDigest: bundle.digest,
    testName,
    kind,
    sourceAttempt: bundle.bundle.lineage.sourceAttempt,
  });
}

export async function runRequirementTestGate({
  repositoryRoot,
  versionLocation,
  specRevision,
  requirementId,
  bundle,
  sourceBytes,
  timeoutMs = 30_000,
} = {}) {
  requiredText(repositoryRoot, "repositoryRoot");
  requiredText(requirementId, "requirementId");
  if (!versionLocation || typeof versionLocation.resolve !== "function") throw new Error("versionLocation is required");
  const sources = candidateSourcesByPath(bundle, sourceBytes);
  const runtimeParent = versionLocation.resolve(".runtime/requirement-test-gate");
  fs.mkdirSync(runtimeParent, { recursive: true });
  const materialized = fs.mkdtempSync(path.join(runtimeParent, "candidate-"));
  try {
    const testFiles = [];
    for (const source of sources.bundle.sources) {
      if (!TEST_FILE_RE.test(source.testPath)) continue;
      const target = path.join(materialized, source.testPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, sources.bytesByPath.get(source.testPath), { mode: 0o644 });
      testFiles.push(target);
    }
    for (const support of sources.bundle.support) {
      const target = path.join(materialized, support.supportPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, sources.bytesByPath.get(support.supportPath), { mode: 0o644 });
    }
    const bootstrap = new SpecTestBootstrapValidator({
      payloadSpecDir: materialized,
      canonicalSpecDir: versionLocation.resolve("artifacts"),
      repositoryRoot,
      executionRoot: repositoryRoot,
    }).validate();
    if (!bootstrap.ok) {
      const fallbackName = `${requirementId}: assigned requirement test`;
      return {
        observation: observationFor({
          bundle: sources.bundle,
          requirementId,
          specRevision,
          kind: "invalid_test",
          testName: fallbackName,
        }),
        rawLog: bootstrap.issues.map((issue) => issue.toString()).join("\n"),
        command: null,
        process: null,
      };
    }
    const assigned = [];
    const skipped = [];
    for (const file of testFiles) {
      const source = fs.readFileSync(file, "utf8");
      const header = scanFileHeader(file);
      if (header.kind === "valid" && header.ids.includes(requirementId)) {
        assigned.push(...assignedNames(file, source, requirementId).map((testName) => ({ file, testName })));
        skipped.push(...skippedNames(source, requirementId).map((testName) => ({ file, testName })));
      }
    }
    if (skipped.length > 0) {
      return {
        observation: observationFor({ bundle: sources.bundle, requirementId, specRevision, kind: skipped.length === 1 ? "skipped" : "invalid_test", testName: skipped[0].testName }),
        rawLog: `skipped named test count: ${skipped.length}`,
        command: null,
        process: null,
      };
    }
    const fallbackName = `${requirementId}: assigned requirement test`;
    if (assigned.length === 0) {
      return {
        observation: observationFor({ bundle: sources.bundle, requirementId, specRevision, kind: "missing", testName: fallbackName }),
        rawLog: "",
        command: null,
        process: null,
      };
    }
    if (assigned.length !== 1) {
      return {
        observation: observationFor({ bundle: sources.bundle, requirementId, specRevision, kind: "invalid_test", testName: assigned[0].testName }),
        rawLog: `assigned named test count: ${assigned.length}`,
        command: null,
        process: null,
      };
    }
    const target = assigned[0];
    const execution = new SharedSpecTestExecution({
      repositoryRoot,
      executionRoot: repositoryRoot,
      specRoot: materialized,
      canonicalSpecRoot: versionLocation.resolve("artifacts"),
    });
    const relative = path.relative(repositoryRoot, target.file).split(path.sep).join("/");
    const argv = execution.nodeArgv(["--test", `--test-name-pattern=^${target.testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, relative]);
    const { NODE_TEST_CONTEXT: _nodeTestContext, ...environment } = process.env;
    const processResult = await runCmdAsync(argv[0], argv.slice(1), {
      cwd: repositoryRoot,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...environment, ...execution.environment },
    });
    const observedProcess = {
      started: !processResult.errorCode,
      exitCode: processResult.errorCode ? null : processResult.status,
      signal: processResult.signal,
      timedOut: Boolean(processResult.killed),
      spawnError: processResult.errorCode && processResult.errorCode !== "ETIMEDOUT" ? processResult.errorCode : null,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
    };
    const rawLog = processLines(observedProcess);
    const check = new RequirementTestCheck({ requirementId, testName: target.testName });
    const observed = check.observe({ process: observedProcess, rawText: rawLog });
    return {
      observation: observationFor({ bundle: sources.bundle, requirementId, specRevision, kind: observed.kind, testName: target.testName }),
      rawLog,
      command: argv.join(" "),
      process: observedProcess,
    };
  } finally {
    fs.rmSync(materialized, { recursive: true, force: true });
  }
}

function assertDirectGateExecution(flowManager, state) {
  const selected = flowManager.canonicalState(state.specId)?.nextAction?.() ?? null;
  if (selected?.nodeId !== "test-gate" || selected.operation !== "resume") {
    throw new Error(`Requirement test Gate direct execution rejected Definition-selected ${selected?.operation ?? "missing"}`);
  }
  const existing = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "test.requirement.gate",
    consumerNodeId: "test-gate",
    optional: true,
  });
  if (existing === null) return;
  let history;
  try {
    history = FlowArtifactAttemptHistory.fromJSON(JSON.parse(existing.bytes.toString("utf8")));
  } catch (error) {
    throw new Error(`Requirement test Gate direct execution rejected corrupt history: ${error.message}`);
  }
  if (history.attempts.some((record) => record.attempt.value === state.attempt.sequence)) {
    throw new Error("Requirement test Gate direct execution rejected an already observed Attempt");
  }
}

export default class RunRequirementTestGateCommand extends FlowCommand {
  constructor({ gateRunner = runRequirementTestGate } = {}) {
    super();
    if (typeof gateRunner !== "function") throw new Error("Requirement test Gate runner must be a function");
    this.gateRunner = gateRunner;
  }

  async execute(ctx) {
    const state = ctx.flowState;
    if (!isCanonicalFlowState(state) || state.currentNodeId !== "test-gate" || state.attempt == null) {
      throw new Error("Requirement test Gate requires the active Version-1 test-gate Attempt");
    }
    assertDirectGateExecution(ctx.flowManager, state);
    const artifacts = new RequirementTestArtifactStore({ flowManager: ctx.flowManager, state });
    const plan = artifacts.readPlan("test-gate").artifact.plan;
    const workItem = plan.activeWorkItem();
    if (workItem?.status !== "reviewed" || workItem.bundleRevision === null) {
      throw new Error("Requirement test Gate requires one reviewed active work item");
    }
    const candidate = artifacts.readCandidate({ bundle: workItem.bundleRevision, consumerNodeId: "test-gate" });
    const testArtifacts = new CanonicalTestArtifactStore({ flowManager: ctx.flowManager, state });
    const execution = await this.gateRunner({
      repositoryRoot: ctx.root,
      versionLocation: testArtifacts.location,
      specRevision: workItem.specRevision,
      requirementId: workItem.requirementId,
      bundle: candidate.candidate,
      sourceBytes: new Map([...candidate.sources, ...candidate.support]
        .map((source) => [source.targetRelativePath, source.bytes])),
    });
    const rawOutputPath = testArtifacts.location.relativeArtifact("test.requirement.gate.raw-log");
    testArtifacts.writeRaw({
      nodeId: "test-gate",
      logicalKey: "test.requirement.gate.raw-log",
      bytes: Buffer.from(`${execution.rawLog}\n`, "utf8"),
    });
    const processResult = execution.process === null
      ? { started: false, exitCode: null, signal: null, timedOut: false, spawnError: null }
      : {
          started: execution.process.started,
          exitCode: execution.process.exitCode,
          signal: execution.process.signal,
          timedOut: execution.process.timedOut,
          spawnError: execution.process.spawnError,
        };
    const artifact = new RequirementTestGateResult({
      observation: execution.observation,
      command: execution.command,
      rawOutputPath,
      process: processResult,
    });
    return attachCanonicalCommandResultArtifact({
      result: execution.observation.kind,
      changed: [rawOutputPath],
      artifacts: {
        completed: true,
        result_path: testArtifacts.location.relativeArtifact("test.requirement.gate"),
        raw_output_path: rawOutputPath,
        artifact_version: "1",
        result: execution.observation.kind,
      },
    }, {
      logicalKey: "test.requirement.gate",
      payload: artifact.toJSON(),
    });
  }
}
