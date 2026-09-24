import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { execFile } from "child_process";
import { listChangedFilesDetailed } from "../../lib/git-helpers.js";
import { extractMakeTestTarget, readMakefile } from "../../lib/makefile.js";
import { collectTestCommandSources, selectTestCommandSource } from "../../lib/test-command-sources.js";
import { projectFilePathsFromAnalysis } from "../../docs/lib/analysis-entry.js";
import { RegressionFileSnapshotList } from "./regression-file-snapshot.js";
import { flowStateSpecLocation } from "../../lib/flow-workspace.js";
import { PRODUCT } from "../../lib/product.js";

export const DEFAULT_TEST_TIMEOUT_SECONDS = 600;
export const DEFAULT_PROCESS_HEARTBEAT_MS = 30_000;
export const MIN_PROCESS_HEARTBEAT_MS = 1000;
export const DEFAULT_CHILD_PROCESS_CAPTURE_BYTES = 64 * 1024;
export const DEFAULT_CHILD_PROCESS_RECORD_LIMIT = 128;
export const DEFAULT_CHILD_PROCESS_RECORD_LINE_BYTES = 512 * 1024;
export const TEST_EXECUTE_REGRESSION_POLICIES = Object.freeze(["targeted", "full", "skip"]);
export const NO_SUPPORTED_REGRESSION_COMMAND = "NO_SUPPORTED_REGRESSION_COMMAND";
export const CHILD_PROCESS_RESULT_KINDS = Object.freeze([
  "passed",
  "assertion-failure",
  "nonzero-exit",
  "spawn-error",
  "signal",
  "timeout",
  "max-buffer",
]);
const MAX_BUFFER_ERROR_CODES = new Set(["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ENOBUFS"]);
const ASSERTION_EVIDENCE_PATTERN = /\bERR_ASSERTION\b|\bAssertionError\b|\bassert(?:ion)?(?:\s+(?:failed|failure|detail))\b/i;
const CHILD_PROCESS_RECORD_PREFIX = "[sennel] child process execution record ";
export const REGRESSION_COMMAND_CHECKED_SOURCES = Object.freeze([
  "test.command",
  "package.json:scripts.test",
  "composer.json:scripts.test",
  "Makefile:test",
]);

export function formatElapsedMs(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(rest).padStart(2, "0")}s` : `${seconds}s`;
}

export class ParsedCommand {
  constructor({ env = {}, argv, source, metadata = {} }) {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error("regression command must have at least one argv token");
    }
    this.env = Object.freeze({ ...env });
    this.argv = Object.freeze([...argv]);
    this.source = source;
    this.metadata = Object.freeze({ ...metadata });
  }

  withTargets(targetPaths) {
    return new ParsedCommand({
      env: this.env,
      argv: [...this.argv, ...targetPaths],
      source: this.source,
      metadata: this.metadata,
    });
  }

  toString() {
    return this.argv.join(" ");
  }
}

export class RegressionCommandIdentity {
  constructor({
    command,
    commandSource,
    argv,
    env,
    source,
    metadata,
    resolvedScriptDigest = null,
    resolvedConfigDigest = null,
  }) {
    if (typeof command !== "string" || command.length === 0) throw new Error("command identity command is required");
    if (typeof commandSource !== "string" || commandSource.length === 0) throw new Error("command identity commandSource is required");
    if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== "string")) throw new Error("command identity argv must be strings");
    this.command = command;
    this.commandSource = commandSource;
    this.argv = Object.freeze([...argv]);
    this.env = Object.freeze({ ...(env || {}) });
    this.source = source;
    this.metadata = Object.freeze({ ...(metadata || {}) });
    this.resolvedScriptDigest = resolvedScriptDigest;
    this.resolvedConfigDigest = resolvedConfigDigest;
    Object.freeze(this);
  }

  toJSON() {
    return {
      command: this.command,
      commandSource: this.commandSource,
      argv: [...this.argv],
      env: { ...this.env },
      source: this.source,
      metadata: { ...this.metadata },
      resolvedScriptDigest: this.resolvedScriptDigest,
      resolvedConfigDigest: this.resolvedConfigDigest,
    };
  }
}

export class ProcessStreamSummary {
  constructor(text) {
    if (typeof text !== "string") throw new Error("process stream text must be a string");
    const nonEmptyLines = text.split(/\r?\n/).filter((line) => line.length > 0);
    this.byteLength = Buffer.byteLength(text, "utf8");
    this.firstNonEmptyLine = nonEmptyLines[0] ?? null;
    this.lastNonEmptyLine = nonEmptyLines.at(-1) ?? null;
    Object.freeze(this);
  }

  toDiagnosticLines(name) {
    return [
      `process.${name}.bytes: ${this.byteLength}`,
      `process.${name}.first: ${this.firstNonEmptyLine}`,
      `process.${name}.last: ${this.lastNonEmptyLine}`,
    ];
  }
}

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function utf8Prefix(text, byteLimit) {
  if (Buffer.byteLength(text, "utf8") <= byteLimit) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > byteLimit) break;
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function boundedDiagnosticContent(text, byteLimit) {
  if (Buffer.byteLength(text, "utf8") <= byteLimit) return text;
  const assertion = text.match(ASSERTION_EVIDENCE_PATTERN);
  return utf8Prefix(assertion ? text.slice(assertion.index) : text, byteLimit);
}

export class ProcessStreamCapture {
  constructor(text, {
    captureLimitBytes = DEFAULT_CHILD_PROCESS_CAPTURE_BYTES,
    rawOutputPath = null,
  } = {}) {
    if (typeof text !== "string") throw new Error("process stream capture text must be a string");
    assertPositiveSafeInteger(captureLimitBytes, "process stream capture limit");
    this.originalByteLength = Buffer.byteLength(text, "utf8");
    this.content = boundedDiagnosticContent(text, captureLimitBytes);
    this.capturedByteLength = Buffer.byteLength(this.content, "utf8");
    this.truncated = this.capturedByteLength < this.originalByteLength;
    if (rawOutputPath !== null && (typeof rawOutputPath !== "string" || rawOutputPath.length === 0)) {
      throw new Error("process stream capture rawOutputPath must be a non-empty string or null");
    }
    if (rawOutputPath !== null && !this.truncated) {
      throw new Error("untruncated process stream capture cannot reference raw output");
    }
    this.rawOutputPath = rawOutputPath;
    Object.freeze(this);
  }

  static fromJSON(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("process stream capture must be an object");
    }
    if (typeof value.content !== "string") throw new Error("process stream capture content must be a string");
    if (!Number.isSafeInteger(value.originalByteLength) || value.originalByteLength < 0) {
      throw new Error("process stream capture originalByteLength must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(value.capturedByteLength) || value.capturedByteLength < 0) {
      throw new Error("process stream capture capturedByteLength must be a non-negative safe integer");
    }
    if (typeof value.truncated !== "boolean") throw new Error("process stream capture truncated must be boolean");
    const capturedByteLength = Buffer.byteLength(value.content, "utf8");
    if (capturedByteLength !== value.capturedByteLength) {
      throw new Error("process stream capture content byte length mismatch");
    }
    if (value.capturedByteLength > value.originalByteLength) {
      throw new Error("process stream capture cannot exceed original byte length");
    }
    if (value.truncated !== (value.capturedByteLength < value.originalByteLength)) {
      throw new Error("process stream capture truncated flag mismatch");
    }
    const rawOutputPath = value.rawOutputPath ?? null;
    if (rawOutputPath !== null && (typeof rawOutputPath !== "string" || rawOutputPath.length === 0)) {
      throw new Error("process stream capture rawOutputPath must be a non-empty string or null");
    }
    if (rawOutputPath !== null && !value.truncated) {
      throw new Error("untruncated process stream capture cannot reference raw output");
    }
    const capture = Object.create(ProcessStreamCapture.prototype);
    capture.originalByteLength = value.originalByteLength;
    capture.capturedByteLength = value.capturedByteLength;
    capture.truncated = value.truncated;
    capture.content = value.content;
    capture.rawOutputPath = rawOutputPath;
    Object.freeze(capture);
    return capture;
  }

  withRawOutputPath(rawOutputPath) {
    if (typeof rawOutputPath !== "string" || rawOutputPath.length === 0) {
      throw new Error("process stream capture rawOutputPath must be a non-empty string");
    }
    if (!this.truncated) return this;
    return ProcessStreamCapture.fromJSON({
      ...this.toJSON(),
      rawOutputPath,
    });
  }

  toJSON() {
    return {
      originalByteLength: this.originalByteLength,
      capturedByteLength: this.capturedByteLength,
      truncated: this.truncated,
      content: this.content,
      ...(this.rawOutputPath ? { rawOutputPath: this.rawOutputPath } : {}),
    };
  }

  toEvidenceJSON() {
    return {
      originalByteLength: this.originalByteLength,
      capturedByteLength: this.capturedByteLength,
      truncated: this.truncated,
      sha256: crypto.createHash("sha256").update(this.content).digest("hex"),
    };
  }
}

function assertOptionalString(value, name) {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${name} must be a string or null`);
  }
}

function assertChildProcessOutcomeInvariant({
  kind,
  started,
  completed,
  exitCode,
  signal,
  errorCode,
  timedOut,
  spawnError,
  stdout,
  stderr,
}, label) {
  if (kind === "passed" && (!started || !completed || exitCode !== 0 || signal || errorCode || timedOut || spawnError)) {
    throw new Error(`passed ${label} must be completed with exit code 0 and no failure fields`);
  }
  if (kind === "assertion-failure" && (!started || !completed || !Number.isInteger(exitCode) || exitCode === 0 || signal || errorCode || timedOut || spawnError)) {
    throw new Error(`assertion-failure ${label} must complete with a numeric non-zero exit code only`);
  }
  if (kind === "assertion-failure" && !hasAssertionEvidence(stdout, stderr)) {
    throw new Error(`assertion-failure ${label} requires assertion evidence`);
  }
  if (kind === "nonzero-exit" && (!started || !completed || !Number.isInteger(exitCode) || exitCode === 0 || signal || errorCode || timedOut || spawnError)) {
    throw new Error(`nonzero-exit ${label} must complete with a numeric non-zero exit code only`);
  }
  if (kind === "nonzero-exit" && hasAssertionEvidence(stdout, stderr)) {
    throw new Error(`nonzero-exit ${label} cannot contain assertion evidence`);
  }
  if (kind === "spawn-error" && (started || completed || exitCode !== null || signal || !errorCode || timedOut || !spawnError)) {
    throw new Error(`spawn-error ${label} must fail before started with errorCode and spawnError`);
  }
  if (kind === "signal" && (!started || completed || exitCode !== null || !signal || errorCode || timedOut || spawnError)) {
    throw new Error(`signal ${label} must start and terminate with a signal`);
  }
  if (kind === "timeout" && (!started || completed || exitCode !== null || !timedOut || spawnError)) {
    throw new Error(`timeout ${label} must start and remain incomplete with timedOut=true`);
  }
  if (kind === "max-buffer" && (!started || completed || exitCode !== null || !MAX_BUFFER_ERROR_CODES.has(errorCode) || timedOut || !spawnError)) {
    throw new Error(`max-buffer ${label} must start and preserve a max-buffer error`);
  }
}

export class ChildProcessExecutionResult {
  constructor({
    kind,
    command,
    started,
    completed,
    exitCode,
    signal,
    errorCode,
    timedOut,
    spawnError,
    stdout,
    stderr,
    captureLimitBytes = DEFAULT_CHILD_PROCESS_CAPTURE_BYTES,
  }) {
    if (!CHILD_PROCESS_RESULT_KINDS.includes(kind)) throw new Error(`invalid child process result kind: ${kind}`);
    if (!Array.isArray(command) || command.length === 0 || command.some((token) => typeof token !== "string" || token.length === 0)) {
      throw new Error("child process result command must contain non-empty argv strings");
    }
    if (typeof started !== "boolean") throw new Error("child process result started must be boolean");
    if (typeof completed !== "boolean") throw new Error("child process result completed must be boolean");
    if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error("child process result exitCode must be an integer or null");
    assertOptionalString(signal, "child process result signal");
    assertOptionalString(errorCode, "child process result errorCode");
    if (typeof timedOut !== "boolean") throw new Error("child process result timedOut must be boolean");
    assertOptionalString(spawnError, "child process result spawnError");
    if (typeof stdout !== "string") throw new Error("child process result stdout must be a string");
    if (typeof stderr !== "string") throw new Error("child process result stderr must be a string");
    const stdoutCapture = new ProcessStreamCapture(stdout, { captureLimitBytes });
    const stderrCapture = new ProcessStreamCapture(stderr, { captureLimitBytes });

    assertChildProcessOutcomeInvariant({
      kind,
      started,
      completed,
      exitCode,
      signal,
      errorCode,
      timedOut,
      spawnError,
      stdout: stdoutCapture.content,
      stderr: stderrCapture.content,
    }, "child process result");

    this.kind = kind;
    this.command = Object.freeze([...command]);
    this.started = started;
    this.completed = completed;
    this.exitCode = exitCode;
    this.signal = signal;
    this.errorCode = errorCode;
    this.timedOut = timedOut;
    this.spawnError = spawnError;
    this.stdout = stdout;
    this.stderr = stderr;
    this.stdoutSummary = new ProcessStreamSummary(stdout);
    this.stderrSummary = new ProcessStreamSummary(stderr);
    this.stdoutCapture = stdoutCapture;
    this.stderrCapture = stderrCapture;
    Object.freeze(this);
  }

  toRecord() {
    return ChildProcessExecutionRecord.fromExecution(this);
  }

  toJSON() {
    return this.toRecord().toJSON();
  }

  diagnosticLines() {
    return [
      `process.kind: ${this.kind}`,
      `process.command: ${this.command.join(" ")}`,
      `process.started: ${this.started}`,
      `process.completed: ${this.completed}`,
      `process.exitCode: ${this.exitCode}`,
      `process.signal: ${this.signal}`,
      `process.errorCode: ${this.errorCode}`,
      `process.timedOut: ${this.timedOut}`,
      ...this.stdoutSummary.toDiagnosticLines("stdout"),
      ...this.stderrSummary.toDiagnosticLines("stderr"),
    ];
  }
}

export class ChildProcessExecutionRecord {
  constructor({
    kind,
    command,
    started,
    completed,
    exitCode,
    signal,
    errorCode,
    timedOut,
    spawnError,
    stdout,
    stderr,
    rawOutputPath = null,
  }) {
    if (!CHILD_PROCESS_RESULT_KINDS.includes(kind)) throw new Error(`invalid child process record kind: ${kind}`);
    if (!Array.isArray(command) || command.length === 0 || command.some((token) => typeof token !== "string" || token.length === 0)) {
      throw new Error("child process record command must contain non-empty argv strings");
    }
    if (typeof started !== "boolean") throw new Error("child process record started must be boolean");
    if (typeof completed !== "boolean") throw new Error("child process record completed must be boolean");
    if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error("child process record exitCode must be an integer or null");
    assertOptionalString(signal, "child process record signal");
    assertOptionalString(errorCode, "child process record errorCode");
    if (typeof timedOut !== "boolean") throw new Error("child process record timedOut must be boolean");
    assertOptionalString(spawnError, "child process record spawnError");
    if (!(stdout instanceof ProcessStreamCapture) || !(stderr instanceof ProcessStreamCapture)) {
      throw new Error("child process record streams must be ProcessStreamCapture instances");
    }
    assertOptionalString(rawOutputPath, "child process record rawOutputPath");
    assertChildProcessOutcomeInvariant({
      kind,
      started,
      completed,
      exitCode,
      signal,
      errorCode,
      timedOut,
      spawnError,
      stdout: stdout.content,
      stderr: stderr.content,
    }, "child process record");
    this.kind = kind;
    this.command = Object.freeze([...command]);
    this.started = started;
    this.completed = completed;
    this.exitCode = exitCode;
    this.signal = signal;
    this.errorCode = errorCode;
    this.timedOut = timedOut;
    this.spawnError = spawnError;
    this.stdout = stdout;
    this.stderr = stderr;
    this.rawOutputPath = rawOutputPath;
    Object.freeze(this);
  }

  static fromExecution(result) {
    if (!(result instanceof ChildProcessExecutionResult)) {
      throw new Error("child process execution result is required");
    }
    return new ChildProcessExecutionRecord({
      kind: result.kind,
      command: result.command,
      started: result.started,
      completed: result.completed,
      exitCode: result.exitCode,
      signal: result.signal,
      errorCode: result.errorCode,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      stdout: result.stdoutCapture,
      stderr: result.stderrCapture,
    });
  }

  static fromJSON(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("child process execution record must be an object");
    }
    return new ChildProcessExecutionRecord({
      ...value,
      stdout: ProcessStreamCapture.fromJSON(value.stdout),
      stderr: ProcessStreamCapture.fromJSON(value.stderr),
    });
  }

  withRawOutputPath(rawOutputPath) {
    return new ChildProcessExecutionRecord({
      ...this,
      command: this.command,
      stdout: this.stdout.withRawOutputPath(rawOutputPath),
      stderr: this.stderr.withRawOutputPath(rawOutputPath),
      rawOutputPath,
    });
  }

  toJSON() {
    return {
      kind: this.kind,
      command: [...this.command],
      started: this.started,
      completed: this.completed,
      exitCode: this.exitCode,
      signal: this.signal,
      errorCode: this.errorCode,
      timedOut: this.timedOut,
      spawnError: this.spawnError,
      stdout: this.stdout.toJSON(),
      stderr: this.stderr.toJSON(),
      ...(this.rawOutputPath ? { rawOutputPath: this.rawOutputPath } : {}),
    };
  }

  toArtifactJSON() {
    return {
      kind: this.kind,
      command: [...this.command],
      started: this.started,
      completed: this.completed,
      exitCode: this.exitCode,
      signal: this.signal,
      errorCode: this.errorCode,
      timedOut: this.timedOut,
      spawnError: this.spawnError,
      stdout: this.stdout.toEvidenceJSON(),
      stderr: this.stderr.toEvidenceJSON(),
      ...(this.rawOutputPath ? { rawOutputPath: this.rawOutputPath } : {}),
    };
  }
}

export class ChildProcessExecutionRecordCodec {
  constructor({
    recordLimit = DEFAULT_CHILD_PROCESS_RECORD_LIMIT,
    lineByteLimit = DEFAULT_CHILD_PROCESS_RECORD_LINE_BYTES,
  } = {}) {
    assertPositiveSafeInteger(recordLimit, "child process record limit");
    assertPositiveSafeInteger(lineByteLimit, "child process record line byte limit");
    this.recordLimit = recordLimit;
    this.lineByteLimit = lineByteLimit;
    Object.freeze(this);
  }

  encode(value) {
    const record = value instanceof ChildProcessExecutionResult
      ? value.toRecord()
      : value;
    if (!(record instanceof ChildProcessExecutionRecord)) {
      throw new Error("child process execution record is required");
    }
    const line = `${CHILD_PROCESS_RECORD_PREFIX}${JSON.stringify(record.toJSON())}`;
    if (Buffer.byteLength(line, "utf8") > this.lineByteLimit) {
      throw new Error(`child process execution record line exceeds ${this.lineByteLimit} bytes`);
    }
    return line;
  }

  decodeAll(text) {
    if (typeof text !== "string") throw new Error("child process execution record text must be a string");
    const records = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith(CHILD_PROCESS_RECORD_PREFIX)) continue;
      if (records.length >= this.recordLimit) {
        throw new Error(`child process execution record count exceeds ${this.recordLimit}`);
      }
      if (Buffer.byteLength(line, "utf8") > this.lineByteLimit) {
        throw new Error(`child process execution record line exceeds ${this.lineByteLimit} bytes`);
      }
      const json = JSON.parse(line.slice(CHILD_PROCESS_RECORD_PREFIX.length));
      records.push(ChildProcessExecutionRecord.fromJSON(json));
    }
    return records;
  }
}

function commandArgv(command) {
  if (Array.isArray(command?.argv)) return command.argv;
  if (Array.isArray(command)) return command;
  throw new Error("child process result requires a command with argv or an argv array");
}

function processErrorMessage(err, command, stderr) {
  const message = String(stderr || err?.message || commandArgv(command)[0]);
  return err?.code ? `${err.code}: ${message}` : message;
}

function hasAssertionEvidence(stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  return ASSERTION_EVIDENCE_PATTERN.test(text);
}

function childProcessResult({
  command,
  err = null,
  stdout = "",
  stderr = "",
  started,
  exitCode,
  signal,
  captureLimitBytes = DEFAULT_CHILD_PROCESS_CAPTURE_BYTES,
}) {
  const stdoutText = String(stdout || "");
  const stderrText = String(stderr || "");
  const errorCode = err && typeof err.code === "string" ? err.code : null;
  const timedOut = Boolean(err?.killed) || errorCode === "ETIMEDOUT";
  const maxBuffer = MAX_BUFFER_ERROR_CODES.has(errorCode);
  const capturedStdout = boundedDiagnosticContent(stdoutText, captureLimitBytes);
  const capturedStderr = boundedDiagnosticContent(stderrText, captureLimitBytes);
  const kind = timedOut
    ? "timeout"
    : maxBuffer
      ? "max-buffer"
      : err && !started
        ? "spawn-error"
        : signal
          ? "signal"
          : exitCode !== 0
            ? hasAssertionEvidence(capturedStdout, capturedStderr)
              ? "assertion-failure"
              : "nonzero-exit"
            : "passed";
  const spawnError = kind === "spawn-error" || kind === "max-buffer"
    ? processErrorMessage(err, command, stderrText)
    : null;
  return new ChildProcessExecutionResult({
    kind,
    command: commandArgv(command),
    started,
    completed: kind === "passed" || kind === "assertion-failure" || kind === "nonzero-exit",
    exitCode: kind === "passed" || kind === "assertion-failure" || kind === "nonzero-exit" ? exitCode : null,
    signal: signal ?? null,
    errorCode,
    timedOut,
    spawnError,
    stdout: stdoutText,
    stderr: stderrText,
    captureLimitBytes,
  });
}

function spawnSyncStarted(result) {
  const errorCode = typeof result?.error?.code === "string" ? result.error.code : null;
  const timedOut = Boolean(result?.error?.killed) || errorCode === "ETIMEDOUT";
  return Number.isInteger(result?.status)
    || typeof result?.signal === "string"
    || timedOut
    || MAX_BUFFER_ERROR_CODES.has(errorCode);
}

export function processResultFromSpawnSync(command, result, options = {}) {
  const started = spawnSyncStarted(result);
  const exitCode = Number.isInteger(result?.status) ? result.status : result?.error ? null : 0;
  return childProcessResult({
    command,
    err: result?.error || null,
    stdout: result?.stdout,
    stderr: result?.stderr,
    started,
    exitCode,
    signal: result?.signal ?? result?.error?.signal ?? null,
    captureLimitBytes: options.captureLimitBytes,
  });
}

export function commandIdentityFor(command) {
  if (!(command instanceof ParsedCommand)) throw new Error("command identity requires ParsedCommand");
  const commandSource = command.source === "test.command" ? "config" : command.source;
  return new RegressionCommandIdentity({
    command: command.toString(),
    commandSource,
    argv: command.argv,
    env: command.env,
    source: commandSource,
    metadata: command.metadata,
    resolvedScriptDigest: null,
    resolvedConfigDigest: null,
  });
}

export function withChangedFileFingerprints(root, changedFiles = []) {
  return RegressionFileSnapshotList.fromChangedFiles(root, changedFiles).toJSON();
}

export class RegressionClassification {
  constructor({ required, mode, category = null, reason, changedFiles, triggerRelevantChangedFiles = [], classifiedPaths = [], targetPaths = [] }) {
    this.required = Boolean(required);
    this.mode = mode;
    this.category = category;
    this.reason = reason;
    this.changedFiles = Object.freeze([...(changedFiles || [])]);
    this.triggerRelevantChangedFiles = Object.freeze([...(triggerRelevantChangedFiles || [])]);
    this.classifiedPaths = Object.freeze([...(classifiedPaths || [])]);
    this.targetPaths = Object.freeze([...(targetPaths || [])]);
  }
}

export class TestExecuteRegressionPlan {
  constructor({ run, classification, reason }) {
    if (typeof run !== "boolean") throw new Error("test-execute regression plan run must be boolean");
    if (!(classification instanceof RegressionClassification)) {
      throw new Error("test-execute regression plan requires RegressionClassification");
    }
    this.run = run;
    this.classification = classification;
    this.reason = reason;
    Object.freeze(this);
  }
}

const SHELL_SYNTAX_RE = /(\|\||&&|[|&;<>`$()]|\*|\?|\[|\]|\{|\})/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseArgvCommand(command, source = "config") {
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("test.command must be a non-empty string");
  }
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let quoted = false;
  const pushToken = () => {
    if (!current) return;
    tokens.push({ value: current, quoted });
    current = "";
    quoted = false;
  };
  for (const ch of command.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("test.command has an unterminated quote");
  pushToken();
  if (tokens.length === 0) throw new Error("test.command produced no argv tokens");

  const env = {};
  while (tokens.length > 0 && !tokens[0].quoted && ENV_ASSIGN_RE.test(tokens[0].value)) {
    const [key, ...rest] = tokens.shift().value.split("=");
    env[key] = rest.join("=");
  }
  if (tokens.length === 0) throw new Error("test.command must include a command after env assignments");
  const argv = tokens.map((token) => token.value);
  const quotedNodeEvalArg = (index) => tokens[index].quoted
    && argv[0] === "node"
    && ["-e", "--eval", "-p", "--print"].includes(argv[index - 1]);
  if (tokens.some((token, index) => SHELL_SYNTAX_RE.test(token.value) && !quotedNodeEvalArg(index))) {
    throw new Error("test.command contains unsupported shell control or expansion syntax");
  }
  return new ParsedCommand({ env, argv, source });
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

class NoSupportedRegressionCommandError extends Error {
  constructor({ checkedSources }) {
    super("no supported project-level regression command found");
    this.code = NO_SUPPORTED_REGRESSION_COMMAND;
    this.checkedSources = Object.freeze([...checkedSources]);
    this.commandCandidates = [];
  }
}

function regressionCommandFromSource(source, checkedSources = REGRESSION_COMMAND_CHECKED_SOURCES) {
  if (!source) {
    throw new NoSupportedRegressionCommandError({ checkedSources });
  }
  if (source.kind === "config") return parseArgvCommand(source.command, source.source);
  if (source.kind === "package") {
    return new ParsedCommand({
      argv: ["npm", "test", "--"],
      source: source.source,
      metadata: { script: source.script },
    });
  }
  if (source.kind === "composer") {
    return new ParsedCommand({
      argv: ["composer", "run-script", "test", "--"],
      source: source.source,
      metadata: { script: source.script },
    });
  }
  if (source.kind === "makefile") {
    return new ParsedCommand({
      argv: ["make", "test"],
      source: source.source,
      metadata: { target: source.target },
    });
  }
  throw new Error(`unsupported test command source: ${source.kind}`);
}

export function discoverRegressionCommand(root, config = {}) {
  const pkg = readJsonIfExists(path.join(root, "package.json"));
  const composer = readJsonIfExists(path.join(root, "composer.json"));
  const makefileTestTarget = extractMakeTestTarget(readMakefile(path.join(root, "Makefile")));
  const configuredTestCommand = Object.hasOwn(config?.test || {}, "command") ? config.test.command : null;
  const source = selectTestCommandSource(collectTestCommandSources({
    configuredTestCommand,
    scripts: pkg?.scripts || null,
    composerScripts: composer?.scripts || null,
    makefileTestTarget,
  }));
  return regressionCommandFromSource(source, REGRESSION_COMMAND_CHECKED_SOURCES);
}

function normalizePath(p) {
  return p.split(path.sep).join("/");
}

function isTextLike(filePath) {
  return /\.(md|mdx|txt|json|ya?ml|toml|ini|csv|html?|css|scss|less|xml|svg|lock)$/i.test(filePath);
}

function isRegressionConfigPath(filePath) {
  const base = path.posix.basename(filePath);
  return filePath === PRODUCT.managedPath("config.json") ||
    base === "package.json" ||
    base === "composer.json" ||
    base === "Makefile" ||
    base === "makefile";
}

function isGeneratedSpecDrivenDevelopmentArtifact(filePath, activeSpec) {
  return filePath.startsWith(`${activeSpec}/`) || filePath.startsWith(`${PRODUCT.managedDirName}/`);
}

function isDocumentationPath(filePath) {
  return /\.(md|mdx|txt|adoc)$/i.test(filePath) || filePath.startsWith("docs/");
}

function isTriggerRelevantFile(filePath, analysisFiles) {
  if (isRegressionConfigPath(filePath)) return true;
  if (analysisFiles.has(filePath) && !isTextLike(filePath)) return true;
  if (!analysisFiles.has(filePath) && !isTextLike(filePath) && !isDocumentationPath(filePath)) return true;
  return false;
}

function classifyNonTrigger(filePath, activeSpec) {
  const normalized = normalizePath(filePath);
  if (isGeneratedSpecDrivenDevelopmentArtifact(normalized, activeSpec)) {
    return "spec-artifact-only";
  }
  if (isDocumentationPath(normalized)) {
    return "docs-only";
  }
  return "non-project-only";
}

export function isProjectTestPath(filePath, projectPaths = []) {
  const normalized = normalizePath(filePath);
  return projectPaths.some((entry) => {
    if (entry.endsWith("/")) return normalized.startsWith(entry);
    return normalized === entry;
  });
}

function categoryFor(classes) {
  const unique = [...new Set(classes)];
  return unique.length === 1 ? unique[0] : "mixed-non-trigger";
}

export function listRegressionChangedFiles({ root, state }) {
  return listChangedFilesDetailed({
    cwd: root,
    baseBranch: state.baseBranch || "main",
    untrackedFiles: "all",
  });
}

export function classifyRegression({ root, state, analysis, config, changedFiles = null }) {
  changedFiles ||= listRegressionChangedFiles({ root, state });
  const location = flowStateSpecLocation(state);
  if (location === null || state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION) {
    throw new Error("regression classification requires a manager-bound Version-1 Flow state");
  }
  const activeSpec = normalizePath(location.relativeDirectory);
  const projectPaths = config?.test?.projectPaths || [];
  const analysisFiles = analysis && typeof analysis === "object"
    ? projectFilePathsFromAnalysis(analysis, { strict: false })
    : new Set();
  const triggerFiles = [];
  const projectTestFiles = [];
  const nonTrigger = [];

  for (const entry of changedFiles) {
    const p = normalizePath(entry.path);
    if (isProjectTestPath(p, projectPaths)) {
      triggerFiles.push(entry);
      projectTestFiles.push(p);
      continue;
    }
    if (p.startsWith(`${activeSpec}/tests/`)) {
      nonTrigger.push({ path: p, category: "spec-artifact-only" });
      continue;
    }
    if (isTriggerRelevantFile(p, analysisFiles)) {
      triggerFiles.push(entry);
      continue;
    }
    nonTrigger.push({ path: p, category: classifyNonTrigger(p, activeSpec) });
  }

  if (triggerFiles.length === 0) {
    const classes = nonTrigger.map((x) => x.category);
    const category = categoryFor(classes.length ? classes : ["non-project-only"]);
    return new RegressionClassification({
      required: false,
      mode: "none",
      category,
      reason: "no trigger-relevant project files changed",
      changedFiles,
      triggerRelevantChangedFiles: [],
      classifiedPaths: nonTrigger,
    });
  }

  if (triggerFiles.length === projectTestFiles.length && projectTestFiles.length > 0) {
    return new RegressionClassification({
      required: true,
      mode: "targeted",
      reason: "all trigger-relevant changes are configured project-level test files",
      changedFiles: triggerFiles,
      triggerRelevantChangedFiles: triggerFiles,
      targetPaths: projectTestFiles,
    });
  }

  return new RegressionClassification({
    required: true,
    mode: "full",
    reason: "project, config, execution, contract, or unknown files changed",
    changedFiles: triggerFiles,
    triggerRelevantChangedFiles: triggerFiles,
  });
}

function resolveTestExecuteRegressionPolicy(config = {}) {
  const policy = config?.test?.testExecuteRegression || "targeted";
  if (!TEST_EXECUTE_REGRESSION_POLICIES.includes(policy)) {
    throw new Error(`invalid test.testExecuteRegression: ${policy}`);
  }
  return policy;
}

export function planTestExecuteRegression(classification, config = {}) {
  if (!(classification instanceof RegressionClassification)) {
    throw new Error("classification must be RegressionClassification");
  }
  if (!classification.required) {
    return new TestExecuteRegressionPlan({
      run: false,
      classification,
      reason: classification.reason,
    });
  }

  const policy = resolveTestExecuteRegressionPolicy(config);
  if (policy === "full") {
    return new TestExecuteRegressionPlan({
      run: true,
      classification,
      reason: "test.testExecuteRegression=full",
    });
  }
  if (policy === "skip") {
    return new TestExecuteRegressionPlan({
      run: false,
      classification: new RegressionClassification({
        required: false,
        mode: "none",
        category: "project-regression-skipped",
        reason: "project regression skipped by test.testExecuteRegression=skip",
        changedFiles: classification.changedFiles,
        triggerRelevantChangedFiles: classification.triggerRelevantChangedFiles,
        classifiedPaths: classification.triggerRelevantChangedFiles.map((entry) => ({
          path: normalizePath(entry.path),
          category: "project-regression-skipped",
        })),
      }),
      reason: "test.testExecuteRegression=skip",
    });
  }
  if (classification.mode === "targeted") {
    return new TestExecuteRegressionPlan({
      run: true,
      classification,
      reason: "targeted project test paths changed",
    });
  }

  return new TestExecuteRegressionPlan({
    run: false,
    classification: new RegressionClassification({
      required: false,
      mode: "none",
      category: "full-regression-deferred",
      reason: "full project regression deferred to final-regression",
      changedFiles: classification.changedFiles,
      triggerRelevantChangedFiles: classification.triggerRelevantChangedFiles,
      classifiedPaths: classification.triggerRelevantChangedFiles.map((entry) => ({
        path: normalizePath(entry.path),
        category: "full-regression-deferred",
      })),
    }),
    reason: "full project regression deferred to final-regression",
  });
}

export function processPassed(result) {
  if (result instanceof ChildProcessExecutionResult) return result.kind === "passed";
  return result.exitCode === 0 && !result.signal && !result.timedOut && !result.spawnError;
}

export function processOutputLines(result) {
  const lines = result instanceof ChildProcessExecutionResult ? result.diagnosticLines() : [];
  if (result.stdout) lines.push(...result.stdout.split(/\r?\n/).filter((line) => line.length > 0));
  if (result.stderr) lines.push(...result.stderr.split(/\r?\n/).filter((line) => line.length > 0));
  if (result.spawnError) lines.push(`spawnError: ${result.spawnError}`);
  if (result.signal) lines.push(`signal: ${result.signal}`);
  if (result.timedOut) lines.push("timeout: true");
  lines.push(`exitCode: ${result.exitCode}`);
  return lines;
}

export async function runProcessDetailed(command, opts = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let heartbeat = null;
    let started = false;
    const detailedResult = (err = null, stdout = "", stderr = "") => childProcessResult({
      command,
      err,
      stdout,
      stderr,
      started,
      exitCode: err ? (typeof err.code === "number" ? err.code : null) : 0,
      signal: err?.signal ?? null,
      captureLimitBytes: opts.captureLimitBytes,
    });
    const finish = (result) => {
      if (heartbeat) clearInterval(heartbeat);
      resolve(result);
    };
    let child;
    try {
      const { NODE_TEST_CONTEXT: _nodeTestContext, ...environment } = process.env;
      child = execFile(
        command.argv[0],
        command.argv.slice(1),
        {
          cwd: opts.cwd,
          encoding: opts.encoding || "utf8",
          timeout: opts.timeoutMs,
          // A test command must run independently when the flow itself is invoked by node:test.
          env: { ...environment, ...command.env },
          maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          finish(detailedResult(err, stdout, stderr));
        },
      );
    } catch (err) {
      finish(detailedResult(err));
      return;
    }
    child.once("spawn", () => {
      started = true;
      if (!opts.onHeartbeat) return;
      const intervalMs = Number.isSafeInteger(opts.heartbeatIntervalMs) && opts.heartbeatIntervalMs > 0
        ? Math.max(opts.heartbeatIntervalMs, MIN_PROCESS_HEARTBEAT_MS)
        : DEFAULT_PROCESS_HEARTBEAT_MS;
      heartbeat = setInterval(() => {
        try {
          opts.onHeartbeat({ elapsedMs: Date.now() - startedAt });
        } catch {
          // Progress reporting must not change the child process outcome.
        }
      }, intervalMs);
    });
  });
}

export function resolveTestTimeoutSeconds(config = {}) {
  return config?.test?.timeout || config?.agent?.timeout || DEFAULT_TEST_TIMEOUT_SECONDS;
}
