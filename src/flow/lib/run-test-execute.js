/**
 * src/flow/lib/run-test-execute.js
 *
 * Deterministic test execution entry point. The runner owns project-level
 * regression execution and composes test-execute-result.json version "2".
 *
 * Root regression discovery is delegated to test-regression.js and follows:
 * test.command argv parsing with KEY=value env support and shell pipe /
 * semicolon / redirection / subshell / glob rejection, then package.json
 * scripts.test via npm test --, composer.json scripts.test via composer
 * run-script test --, and Makefile test via make test. Unknown analysis,
 * execution, config, or test-contract file changes are deferred to
 * final-regression by default. test.projectPaths drives targeted project
 * test-file classification for the normal repair loop.
 * Skipped categories are docs-only, spec-artifact-only, non-project-only, and
 * mixed-non-trigger. The temporary summary lives in the Version `.runtime`
 * area and is deleted during cleanup.
 * Required regression raw output uses explicit start marker / end marker
 * sections. Started exit code 127, non-zero exit, signal, and timeout
 * outcomes become v2 fail artifacts.
 */

import fs from "fs";
import path from "path";
import { container } from "../../lib/container.js";
import { managedOutputDir } from "../../lib/config.js";
import { listChangedFilesDetailed } from "../../lib/git-helpers.js";
import { FlowCommand } from "./base-command.js";
import {
  readJsonStrict,
  validateSummaryEvidence,
  validateTestExecuteResultV2,
} from "./test-artifacts.js";
import {
  classifyRegression,
  commandIdentityFor,
  discoverRegressionCommand,
  listRegressionChangedFiles,
  planTestExecuteRegression,
  processOutputLines,
  processPassed,
  resolveTestTimeoutSeconds,
  runProcessDetailed,
} from "./test-regression.js";
import { RegressionFileSnapshotList } from "./regression-file-snapshot.js";
import { SharedSpecTestExecution } from "./shared-spec-test-execution.js";
import {
  CanonicalTestArtifactStore,
  canonicalRawEvidenceFingerprint,
  isCanonicalFlowState,
} from "./canonical-test-artifacts.js";
import { attachCanonicalCommandResultArtifact } from "./canonical-command-result.js";
import { buildRepairFingerprint } from "./repair-fingerprint.js";
import { admitTestChainDirectExecution } from "./test-chain-transition-facts.js";
import { RequirementTestArtifactStore } from "./requirement-test-store.js";
import { scanFileHeader } from "./test-headers.js";

const MAX_TEST_EXECUTE_REQUIREMENTS = 500;
const NO_TESTS_DECLARED_REASON = "no_tests_declared";

function prerequisiteIssueEntry(executionRoot, state, err) {
  let changedFileCount = null;
  try {
    changedFileCount = listChangedFilesDetailed({ cwd: executionRoot, baseBranch: state.baseBranch || "main" }).length;
  } catch (_) {
    changedFileCount = null;
  }
  return {
    step: "test-execute",
    reason: `test-execute prerequisite failed before normal v2 artifact creation: ${err.message || String(err)}`,
    failureKind: "prerequisite",
    message: err.message || String(err),
    commandSource: err.commandSource || null,
    commandCandidates: Array.isArray(err.commandCandidates) ? err.commandCandidates : [],
    changedFileCount,
    trigger: "sennel flow run test-execute",
    resolution: "fix the prerequisite failure and rerun test-execute",
    taskId: null,
    timestamp: new Date().toISOString(),
  };
}

function listSpecTestFiles(specDir) {
  const testsDir = path.join(specDir, "tests");
  if (!fs.existsSync(testsDir)) return [];
  return fs.readdirSync(testsDir)
    .filter((name) => /\.(test|spec)\.(js|mjs|ts)$/.test(name))
    .sort()
    .map((name) => path.join(testsDir, name));
}

function extractRequirementTestName(filePath, reqId) {
  const src = fs.readFileSync(filePath, "utf8");
  const re = new RegExp(`(?:it|test)\\(\\s*["'\`](${reqId}: [^"'\`]+)["'\`]`);
  return src.match(re)?.[1] || `${reqId}: requirement verification`;
}

function findSpecTestFileForReq(specDir, reqId, files = null) {
  const candidates = files ?? listSpecTestFiles(specDir);
  for (const file of candidates) {
    const header = scanFileHeader(file);
    if (header.kind === "valid" && header.ids.includes(reqId)) return file;
  }
  return null;
}

function appendRaw(lines, sectionLines) {
  const start = lines.length + 1;
  lines.push(...sectionLines);
  return { start_line: start, end_line: lines.length };
}

export async function runSpecLocalTests({ repositoryRoot, executionRoot, specDir, timeoutMs, files = null, testNamePattern = null }) {
  const selected = files ?? listSpecTestFiles(specDir);
  if (selected.length === 0) {
    return {
      command: "node --test",
      noTestsDeclared: true,
      result: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null, stdout: "", stderr: "" },
    };
  }
  const execution = new SharedSpecTestExecution({
    repositoryRoot,
    executionRoot,
    specRoot: path.dirname(specDir),
  });
  const argv = execution.nodeArgv([
    "--test",
    ...(testNamePattern ? [`--test-name-pattern=${testNamePattern}`] : []),
    ...selected.map((file) => path.relative(executionRoot, file)),
  ]);
  const result = await runProcessDetailed(
    { argv, env: execution.environment, source: "spec-local-tests" },
    { cwd: executionRoot, timeoutMs },
  );
  return { command: argv.join(" "), noTestsDeclared: false, result };
}

function testableRequirementsForSummary(requirements) {
  const testable = requirements.filter((r) => r.testable !== false);
  if (testable.length > MAX_TEST_EXECUTE_REQUIREMENTS) {
    throw new Error(`test-execute requirement count exceeds max ${MAX_TEST_EXECUTE_REQUIREMENTS}`);
  }
  return testable;
}

function extractRequirementIds(text) {
  return [...String(text || "").matchAll(/\bR\d+\b/g)].map((match) => match[0]);
}

export function failedRequirementIdsFromSpecLocal(specLocal, testableRequirements) {
  if (specLocalPassed(specLocal)) return new Set();

  const validIds = new Set(testableRequirements.map((req) => req.id));
  const failedIds = new Set();
  for (const line of processOutputLines(specLocal.result)) {
    if (!/^not ok\b/.test(line)) continue;
    for (const id of extractRequirementIds(line)) {
      if (validIds.has(id)) failedIds.add(id);
    }
  }
  return failedIds.size > 0 ? failedIds : null;
}

function requirementResult(reqId, failedIds) {
  if (failedIds == null) return "fail";
  return failedIds.has(reqId) ? "fail" : "pass";
}

function requirementSummaryResult(reqId, specLocal, failedIds) {
  return specLocal.noTestsDeclared ? "not_applicable" : requirementResult(reqId, failedIds);
}

function requirementRawResultLine(req, specLocal, failedIds) {
  const result = requirementSummaryResult(req.id, specLocal, failedIds);
  return result === "not_applicable"
    ? `[sennel] requirement ${req.id} result not_applicable reason ${NO_TESTS_DECLARED_REASON}`
    : `[sennel] requirement ${req.id} result ${result}`;
}

function buildSummary({ root, specDir, testableRequirements, specLocal, range, failedIds = null, files = null, deferredReceipts = [] }) {
  const resolvedFailedIds = failedIds ?? failedRequirementIdsFromSpecLocal(specLocal, testableRequirements);
  const deferredById = new Map(deferredReceipts.map((receipt) => [receipt.requirementId, receipt]));
  return testableRequirements.map((req) => {
    const deferred = deferredById.get(req.id);
    if (deferred) return { id: req.id, result: "deferred", deferred_receipt: deferred };
    const result = requirementSummaryResult(req.id, specLocal, resolvedFailedIds);
    if (result === "not_applicable") {
      return {
        id: req.id,
        result,
        reason: NO_TESTS_DECLARED_REASON,
        evidence: {
          command: specLocal.command,
          raw_output_lines: range,
        },
      };
    }
    const file = findSpecTestFileForReq(specDir, req.id, files);
    if (!file) throw new Error(`spec-local test file missing for ${req.id}`);
    return {
      id: req.id,
      result,
      ...(result === "pass" ? {} : { error: "spec-local requirement tests failed" }),
      evidence: {
        test_file: path.relative(root, file).split(path.sep).join("/"),
        test_name: extractRequirementTestName(file, req.id),
        command: specLocal.command,
        raw_output_lines: range,
      },
    };
  });
}

function requirementExecutionLifecycle({ planArtifact, receipts, requirements }) {
  const workItems = planArtifact.plan.workItems;
  const expected = requirements.filter((requirement) => requirement.testable !== false).map((requirement) => requirement.id);
  const ids = workItems.map((item) => item.requirementId);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  const unknown = ids.filter((id) => !expected.includes(id));
  const missing = expected.filter((id) => !ids.includes(id));
  if (duplicates.length || unknown.length || missing.length) {
    throw new Error(`Requirement test plan membership invalid: missing=${missing.join(",")} unknown=${unknown.join(",")} duplicate=${duplicates.join(",")}`);
  }
  const deferredById = new Map(receipts.map((receipt) => [receipt.requirementId, receipt]));
  if (deferredById.size !== receipts.length) throw new Error("Requirement deferred receipts contain duplicate requirements");
  const promoted = [];
  for (const item of workItems) {
    if (item.status === "promoted") promoted.push(item.requirementId);
    else if (item.status !== "deferred") throw new Error(`Requirement ${item.requirementId} is not promoted or deferred`);
    if (item.status === "deferred") {
      const receipt = deferredById.get(item.requirementId);
      if (!receipt || !item.specRevision.equals(receipt.specRevision)) throw new Error(`Requirement ${item.requirementId} deferred receipt is missing or stale`);
    } else if (deferredById.has(item.requirementId)) {
      throw new Error(`Requirement ${item.requirementId} is both promoted and deferred`);
    }
  }
  const unknownReceipts = receipts.filter((receipt) => !ids.includes(receipt.requirementId));
  if (unknownReceipts.length) throw new Error(`Requirement deferred receipts contain unknown requirements: ${unknownReceipts.map((receipt) => receipt.requirementId).join(",")}`);
  return { promotedIds: new Set(promoted), deferredReceipts: receipts };
}

function specLocalPassed(specLocal) {
  return processPassed(specLocal.result);
}

function buildRegressionSnapshots(root, classification) {
  return {
    changedFiles: RegressionFileSnapshotList
      .fromChangedFiles(root, classification.changedFiles)
      .toJSON(),
    triggerRelevantChangedFiles: RegressionFileSnapshotList
      .fromChangedFiles(root, classification.triggerRelevantChangedFiles)
      .toJSON(),
  };
}

function buildSkippedRegression(root, classification) {
  const snapshots = buildRegressionSnapshots(root, classification);
  return {
    required: false,
    result: "skipped",
    mode: "none",
    category: classification.category,
    reason: classification.reason,
    classified_paths: classification.classifiedPaths,
    trigger_relevant_changed_files: snapshots.triggerRelevantChangedFiles,
    changed_files: snapshots.changedFiles,
  };
}

function buildRequiredRegression({ root, classification, rootCommand, command, result, range }) {
  const pass = processPassed(result);
  const commandIdentity = commandIdentityFor(command).toJSON();
  const snapshots = buildRegressionSnapshots(root, classification);
  return {
    required: true,
    mode: classification.mode,
    root_test_command: rootCommand.toString(),
    root_test_command_source: commandIdentity.commandSource,
    command: command.toString(),
    ...commandIdentity,
    result: pass ? "pass" : "fail",
    raw_output_lines: range,
    trigger_relevant_changed_files: snapshots.triggerRelevantChangedFiles,
    changed_files: snapshots.changedFiles,
    ...(classification.mode === "targeted" ? { target_paths: [...classification.targetPaths] } : {}),
    process: {
      started: result.started,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
    },
  };
}

/**
 * The normal command owns only process execution and the transient raw log.
 * Its durable result is attached to the public result object and is published
 * by the registry's current-Attempt confirmation transaction.
 */
async function executeCanonicalTestExecution(ctx, config, { runSpecLocal = runSpecLocalTests } = {}) {
  const state = ctx.flowState;
  const executionRoot = ctx.executionRoot || ctx.root;
  const artifacts = new CanonicalTestArtifactStore({ flowManager: ctx.flowManager, state });
  const testSourceRevision = artifacts.testSourceRevision();
  const repositoryRoot = artifacts.location.repositoryRoot;
  const spec = artifacts.readSpec("test-execute");
  const requirements = Array.isArray(spec.requirements) ? spec.requirements : [];
  const testableRequirements = testableRequirementsForSummary(requirements);
  const requirementStore = new RequirementTestArtifactStore({ flowManager: ctx.flowManager, state });
  const planRead = requirementStore.readPlan("test-execute");
  const lifecycle = requirementExecutionLifecycle({
    planArtifact: planRead.artifact,
    receipts: requirementStore.deferredReceipts("test-execute"),
    requirements,
  });
  const analysisPath = path.join(managedOutputDir(executionRoot), "analysis.json");
  if (!fs.existsSync(analysisPath)) {
    throw new Error(`analysis.json not found at ${analysisPath}: run docs scan before test-execute`);
  }
  const analysis = readJsonStrict(analysisPath);
  const timeoutMs = resolveTestTimeoutSeconds(config) * 1000;
  const sources = artifacts.testSources("test-execute");
  const files = sources
    .map((source) => source.absolutePath)
    .filter((file) => /\.(test|spec)\.(js|mjs|ts)$/.test(file))
    .filter((file) => {
      const header = scanFileHeader(file);
      return header.kind === "valid" && header.ids.some((id) => lifecycle.promotedIds.has(id));
    });
  const rawLines = [];
  const specLocal = await runSpecLocal({
    repositoryRoot,
    executionRoot,
    specDir: artifacts.directory,
    timeoutMs,
    files,
    testNamePattern: lifecycle.promotedIds.size > 0
      ? `^(?:${[...lifecycle.promotedIds].map((id) => `${id}:`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`
      : null,
  });
  const specLocalFailedIds = failedRequirementIdsFromSpecLocal(specLocal, testableRequirements);
  const specRange = appendRaw(rawLines, [
    "[sennel] spec-local tests start",
    `command: ${specLocal.command}`,
    ...processOutputLines(specLocal.result),
    ...testableRequirements.map((req) => lifecycle.promotedIds.has(req.id)
      ? requirementRawResultLine(req, specLocal, specLocalFailedIds)
      : `[sennel] requirement ${req.id} result deferred receipt=${JSON.stringify(lifecycle.deferredReceipts.find((receipt) => receipt.requirementId === req.id)?.toJSON())}`),
    "[sennel] spec-local tests end",
  ]);
  const summary = buildSummary({
    root: repositoryRoot,
    specDir: artifacts.directory,
    testableRequirements,
    specLocal,
    range: specRange,
    failedIds: specLocalFailedIds,
    files,
    deferredReceipts: lifecycle.deferredReceipts,
  });
  // Validate before writing any runtime diagnostic.  The test source paths
  // were catalog-resolved above, so this is a consumer validation rather than
  // an inferred legacy `tests/` directory read.
  validateSummaryEvidence(summary, {
    root: repositoryRoot,
    rawText: rawLines.join("\n"),
    rawLines,
    requirements,
    deferredReceipts: lifecycle.deferredReceipts,
  });

  const changedFiles = listRegressionChangedFiles({ root: executionRoot, state });
  const classification = classifyRegression({ root: executionRoot, state, analysis, config, changedFiles });
  const regressionPlan = planTestExecuteRegression(classification, config);
  let regression;
  if (!regressionPlan.run) {
    regression = buildSkippedRegression(executionRoot, regressionPlan.classification);
  } else {
    const rootCommand = discoverRegressionCommand(executionRoot, config);
    const command = regressionPlan.classification.mode === "targeted"
      ? rootCommand.withTargets(regressionPlan.classification.targetPaths)
      : rootCommand;
    const result = await runProcessDetailed(command, { cwd: executionRoot, timeoutMs });
    const regressionResult = processPassed(result) ? "pass" : "fail";
    const range = appendRaw(rawLines, [
      `[sennel] project regression start command=${command.toString()} mode=${regressionPlan.classification.mode}`,
      `command: ${command.toString()}`,
      `mode: ${regressionPlan.classification.mode}`,
      ...processOutputLines(result),
      `result: ${regressionResult}`,
      `[sennel] project regression end result=${regressionResult}`,
    ]);
    regression = buildRequiredRegression({
      root: executionRoot,
      classification: regressionPlan.classification,
      rootCommand,
      command,
      result,
      range,
    });
  }

  const rawText = `${rawLines.join("\n")}\n`;
  artifacts.writeRaw({
    nodeId: "test-execute",
    logicalKey: "test.execute.raw-log",
    bytes: rawText,
  });
  const fingerprint = buildRepairFingerprint({
    root: executionRoot,
    artifactRoot: ctx.root,
    specPath: artifacts.location.relativeSpecFile,
  });
  const artifact = {
    version: "2",
    repairFingerprint: fingerprint.hash,
    testSourceRevision: testSourceRevision.digest,
    rawEvidenceFingerprint: canonicalRawEvidenceFingerprint(Buffer.from(rawText, "utf8")),
    process: {
      started: specLocal.result.started,
      exitCode: specLocal.result.exitCode,
      signal: specLocal.result.signal,
      timedOut: specLocal.result.timedOut,
      spawnError: specLocal.result.spawnError,
    },
    raw_output_path: artifacts.location.relativeArtifact("test.execute.raw-log"),
    summary,
    regression,
  };
  validateSummaryEvidence(summary, {
    root: repositoryRoot,
    rawText,
    rawLines,
    requirements,
    validateRawOutputRange: true,
  });
  const validArtifact = validateTestExecuteResultV2(artifact);
  const resultPath = artifacts.location.relativeArtifact("test.execute");
  return attachCanonicalCommandResultArtifact({
    result: "ok",
    changed: [resultPath, artifacts.location.relativeArtifact("test.execute.raw-log")],
    artifacts: {
      result_path: resultPath,
      raw_output_path: artifacts.location.relativeArtifact("test.execute.raw-log"),
      completed: true,
      artifact_version: "2",
      regression: regression.result,
    },
  }, {
    logicalKey: "test.execute",
    payload: validArtifact,
  });
}

export default class RunTestExecuteCommand extends FlowCommand {
  constructor({ runSpecLocal = runSpecLocalTests } = {}) {
    super();
    if (typeof runSpecLocal !== "function") throw new Error("test-execute runSpecLocal must be a function");
    this.runSpecLocal = runSpecLocal;
  }

  async execute(ctx) {
    const { root } = ctx;
    const executionRoot = ctx.executionRoot || root;
    if (isCanonicalFlowState(ctx.flowState)) {
      admitTestChainDirectExecution({ flowManager: ctx.flowManager, specId: ctx.flowState.specId, stepId: "test-execute" });
      const config = this.container?.has?.("config")
        ? this.container.get("config") || {}
        : container.get("config") || {};
      try {
        return await executeCanonicalTestExecution(ctx, config, { runSpecLocal: this.runSpecLocal });
      } catch (err) {
        ctx.flowManager.appendIssueLog({
          specId: ctx.flowState.specId,
          entry: prerequisiteIssueEntry(executionRoot, ctx.flowState, err),
          idempotencyKey: `test-execute-prerequisite-${ctx.flowState.runId}`,
        });
        throw err;
      }
    }
    throw new Error("test-execute requires a Version-1 Flow");
  }
}
