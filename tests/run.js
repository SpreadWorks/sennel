#!/usr/bin/env node
import { existsSync, readdirSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { globFilesSync } from "./runner/test-file-glob.js";
import { buildSearchDirs } from "./runner/test-runner-search-dirs.js";
import {
  formatLabelSummary,
  groupTestFilesByCategory,
  parsePassCount,
} from "./runner/test-runner-labels.js";
import { resolveTestFiles } from "./runner/test-selection.js";
import { TestRunner } from "./runner/test-runner.js";
import { TestSuiteManifest } from "./runner/manifest.js";
import { TestSuiteExecutionPolicy } from "./runner/suite-execution-policy.js";
import { TEST_SUITE_NAMES } from "./runner/suite-definitions.js";
import {
  MINIMUM_TEST_TMPFS_BYTES,
  TestTemporaryRoot,
} from "./test-temporary-root.js";
import {
  ChildProcessExecutionRecordCodec,
  processResultFromSpawnSync,
} from "../src/flow/lib/test-regression.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CHILD_PROCESS_RECORD_CODEC = new ChildProcessExecutionRecordCodec();

function getRealPresetNames() {
  return readdirSync(join(ROOT, "src", "presets"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, "src", "presets", entry.name, "tests", "acceptance")))
    .map((entry) => entry.name);
}

function getPresetNames() {
  return getRealPresetNames();
}

function resolveFiles(selection) {
  const manifest = TestSuiteManifest.discover(ROOT);
  const searchDirs = buildSearchDirs(
    { root: ROOT },
    {
      preset: selection.preset,
      scope: selection.scope,
      agent: selection.mode === "agent",
      all: selection.mode === "all",
      presetDirName: selection.preset,
      realPresetNames: getRealPresetNames(),
    },
  );
  const files = resolveTestFiles(selection, {
    root: ROOT,
    existsSync,
    statSync,
    readdirSync,
    globSync: globFilesSync,
    searchDirs,
  });
  // Discovery is authoritative for product suites. Explicit file selectors
  // retain their diagnostic contract and may execute temporary test files.
  if (selection.mode !== "files") {
    const allowed = new Set(manifest.files);
    for (const file of files) if (!allowed.has(file)) throw new Error(`test is not in the suite manifest: ${file}`);
  }
  return files;
}

function formatExecutionSummary(counts, incompleteCategories) {
  if (incompleteCategories.size === 0) return formatLabelSummary(counts);
  return TEST_SUITE_NAMES
    .map((category) => incompleteCategories.has(category) ? `${category}: not completed` : `${category}: ${counts[category]}`)
    .join("\n");
}

export async function executeFiles(files, {
  spawnProcess = spawn,
  write = writeSync,
  root = ROOT,
  jobs = null,
} = {}) {
  const groups = groupTestFilesByCategory(files.map((file) => resolve(root, file)));
  const counts = Object.fromEntries(TEST_SUITE_NAMES.map((name) => [name, 0]));
  const incompleteCategories = new Set();
  let sawFailure = false;
  let firstNumericFailure = null;
  const policy = new TestSuiteExecutionPolicy({ jobs });
  const suites = [...TEST_SUITE_NAMES, "other"].filter((category) => groups[category].length > 0);
  const runSuite = async (category) => {
    const concurrency = category === "other" ? (jobs ?? 1) : policy.concurrencyFor(category);
    const command = ["node", "--test", "--test-concurrency", String(concurrency), ...groups[category]];
    const result = await new Promise((resolve) => {
      const child = spawnProcess(command[0], command.slice(1), {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => resolve({ error, stdout, stderr }));
      child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    const execution = processResultFromSpawnSync(command, result);
    if (execution.stdout) write(1, execution.stdout);
    if (execution.stderr) write(2, execution.stderr);
    write(2, `${CHILD_PROCESS_RECORD_CODEC.encode(execution)}\n`);
    if (execution.completed) {
      counts[category] = parsePassCount(execution.stdout + execution.stderr);
    } else if (!execution.completed) {
      incompleteCategories.add(category);
    }
    if (execution.kind !== "passed") {
      sawFailure = true;
      if (firstNumericFailure === null && Number.isInteger(execution.exitCode) && execution.exitCode !== 0) {
        firstNumericFailure = execution.exitCode;
      }
      write(2, `\n[sennel] test suite process result\n${execution.diagnosticLines().join("\n")}\n`);
    }
  };
  for (const suite of suites) await runSuite(suite);
  write(1, `\n${formatExecutionSummary(counts, incompleteCategories)}\n`);
  return firstNumericFailure ?? (sawFailure ? 1 : 0);
}

export async function main(args = process.argv.slice(2)) {
  const runner = new TestRunner({
    presetNames: getPresetNames(),
    resolveFiles,
    executeFiles: async (files, selection) => {
      let storage = "tmpfs";
      let temporaryRoot = TestTemporaryRoot.createOnTmpfs();
      if (temporaryRoot === null) {
        storage = "system fallback";
        temporaryRoot = TestTemporaryRoot.createOnSystem();
        writeSync(
          2,
          `[sennel] test temporary storage: ${storage} ${temporaryRoot.path} (/dev/shm unavailable or below ${MINIMUM_TEST_TMPFS_BYTES / (1024n * 1024n)} MiB free; removed after run)\n`,
        );
      } else {
        writeSync(2, `[sennel] test temporary storage: ${storage} ${temporaryRoot.path} (removed after run)\n`);
      }
      return temporaryRoot.use(() => executeFiles(files, { jobs: selection.jobs }));
    },
  });
  const result = await runner.run(args);
  if (result.stdout) writeSync(1, result.stdout);
  if (result.stderr) writeSync(2, result.stderr);
  return result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().then((code) => { process.exitCode = code; });
}
