#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
await import("../src/sennel.js");
const { globFilesSync } = await import("./runner/test-file-glob.js");
const { buildSearchDirs } = await import("./runner/test-runner-search-dirs.js");
const {
  formatLabelSummary,
  groupTestFilesByCategory,
  parsePassCount,
} = await import("./runner/test-runner-labels.js");
const { resolveTestFiles } = await import("./runner/test-selection.js");
const { TestRunner } = await import("./runner/test-runner.js");
const { TestSuiteManifest } = await import("./runner/manifest.js");
const { TestSuiteExecutionPolicy } = await import("./runner/suite-execution-policy.js");
const { TEST_SUITE_NAMES } = await import("./runner/suite-definitions.js");
const {
  TestTemporaryRoot,
} = await import("./test-temporary-root.js");
const { ProcessExecutionControlFailure } = await import("../src/lib/process-execution-values.js");
const { executeManagedProcess } = await import("../src/lib/managed-process.js");
const { NativeExecutableInvocation } = await import("../src/lib/command-invocation.js");
const { standaloneTestEnvironment } = await import("../src/lib/process.js");
const {
  ChildProcessExecutionRecordCodec,
  processResultFromSpawnSync,
} = await import("../src/flow/lib/test-regression.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CHILD_PROCESS_RECORD_CODEC = new ChildProcessExecutionRecordCodec();

function writeOutput(fd, text) {
  const stream = fd === 1 ? process.stdout : process.stderr;
  stream.write(text);
}

class SuiteOutput {
  constructor(fd, write) {
    this.fd = fd;
    this.write = write;
    this.decoder = new StringDecoder("utf8");
    this.text = "";
  }

  append(chunk) {
    this.publish(this.decoder.write(Buffer.from(chunk)));
  }

  finish() {
    this.publish(this.decoder.end());
    return this.text;
  }

  publish(text) {
    if (!text) return;
    this.text += text;
    this.write(this.fd, text);
  }
}

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
  executeProcess = executeManagedProcess,
  write = writeOutput,
  root = ROOT,
  executionRoot = root,
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
    const command = [process.execPath, "--test", "--test-concurrency", String(concurrency), "--import", pathToFileURL(join(ROOT, "tests/runner/fixture-bootstrap.js")).href, ...groups[category]];
    const stdout = new SuiteOutput(1, write);
    const stderr = new SuiteOutput(2, write);
    const invocation = new NativeExecutableInvocation({ executable: command[0], args: command.slice(1),
      cwd: root, env: standaloneTestEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let result;
    try {
      const completed = await executeProcess(invocation, [], { repositoryRoot: executionRoot, timeoutMs: 3600000, maxBuffer: 256 * 1024 * 1024,
        onStdoutBytes: (chunk) => stdout.append(chunk), onStderrBytes: (chunk) => stderr.append(chunk) });
      result = { status: completed.code, signal: completed.signal, stdout: stdout.finish(), stderr: stderr.finish() };
    } catch (error) {
      if (error instanceof ProcessExecutionControlFailure) throw error;
      result = { status: typeof error.code === "number" ? error.code : null, signal: error.signal ?? null,
        error, stdout: stdout.finish(), stderr: stderr.finish() };
    }
    const execution = processResultFromSpawnSync(command, result);
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

export async function executeFilesInTemporaryRoot(files, {
  temporaryRoot = TestTemporaryRoot.select({ repositoryRoot: ROOT }),
  write = writeOutput,
  ...options
} = {}) {
  write(2, `[sennel] test temporary storage: repository ${temporaryRoot.path} (cleanup requires confirmed execution completion)\n`);
  return temporaryRoot.use(async () => {
    temporaryRoot.beginExecution();
    try {
      const result = await executeFiles(files, { ...options, write, executionRoot: temporaryRoot.path });
      temporaryRoot.completeExecution();
      return result;
    } catch (error) {
      if (error instanceof ProcessExecutionControlFailure) {
        temporaryRoot.retainOnUnconfirmedExecution();
        write(2, `[sennel] execution completion unconfirmed; retained test temporary storage: ${temporaryRoot.path}\n`);
      }
      throw error;
    }
  });
}

export async function main(args = process.argv.slice(2)) {
  const runner = new TestRunner({
    presetNames: getPresetNames(),
    resolveFiles,
    executeFiles: async (files, selection) => {
      return executeFilesInTemporaryRoot(files, { jobs: selection.jobs });
    },
  });
  const result = await runner.run(args);
  if (result.stdout) writeOutput(1, result.stdout);
  if (result.stderr) writeOutput(2, result.stderr);
  return result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().then((code) => { process.exitCode = code; });
}
