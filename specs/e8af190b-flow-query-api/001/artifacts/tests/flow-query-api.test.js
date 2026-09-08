// spec: R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 R11 R12 R13 R14 R15 R16 R17

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CanonicalFlowFixture,
  TaskLifecycleFixture,
  makeFlowManager,
} from "../../../../../tests/support/infrastructure/flow-setup.js";
import {
  discoverFlowCommandHooks,
  runFlowCommandHooks,
} from "../../../../../src/lib/plugin-registry.js";
import { FLOW_COMMANDS } from "../../../../../src/flow/registry.js";
import { FlowActivity } from "../../../../../src/flow/lib/current-flow-state.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../../../src/lib/flow-artifact-contract.js";
import { FlowArtifactCatalog } from "../../../../../src/lib/flow-version.js";

const roots = [];
const SPEC_ID = "517-flow-query";
const FIXED_TIME = "2026-01-02T03:04:05.000Z";
const OVERSIZED_ARTIFACT_MEDIA_TYPE = `application/x-${"a".repeat(500)}`;

function queryLimitsFromSpec() {
  const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../spec.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const constraint = spec.constraints.find((entry) => entry.startsWith("Bounded resource limits are centrally managed contract constant"));
  assert.equal(typeof constraint, "string", "spec must define the bounded query resource limits");
  const limits = Object.fromEntries(
    [...constraint.matchAll(/\b(MAX_[A-Z0-9_]+)=([0-9]+)\b/g)].map((match) => [match[1], Number(match[2])]),
  );
  for (const name of [
    "MAX_REQUEST_BYTES",
    "MAX_RESPONSE_BYTES",
    "MAX_AVAILABLE_FLOW_VERSIONS",
    "MAX_CONFIRMED_ACTIVITIES",
    "MAX_STATE_RECORD_BYTES",
    "MAX_SPEC_RECORD_BYTES",
    "MAX_CONFIRMED_LEDGER_BYTES",
    "MAX_ARTIFACT_CATALOG_BYTES",
    "MAX_ARTIFACTS",
    "MAX_IDS_PER_ARTIFACT",
    "MAX_PUBLIC_COLLECTION_ITEMS",
    "MAX_PUBLIC_STRING_BYTES",
    "MAX_ARTIFACT_ID_CANONICAL_JSON_BYTES",
    "MAX_CANONICAL_JSON_DEPTH",
  ]) {
    assert.equal(Number.isSafeInteger(limits[name]), true, `${name} must be defined by the spec contract`);
  }
  return Object.freeze(limits);
}

// Boundary fixtures consume the values from the immutable specification
// contract; this test module does not duplicate resource-limit literals.
const QUERY_LIMITS = queryLimitsFromSpec();

const TIMESTAMP_STATE_CHANGING_OPERATIONS = Object.freeze([
  "create_flow", "complete_draft_completion", "add_task", "add_approval_task", "start_attempt",
  "retry_attempt", "retry_gate_attempt", "retry_recovery_attempt", "update_attempt", "fail_attempt",
  "record_failure", "confirm_attempt", "complete_acceptance_decision_noop", "rewind", "rewind_test_evidence",
  "repair_test_review", "repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair",
  "triage_implementation_no_repair", "repair_acceptance_review", "preimplementation_bootstrap",
  "recover_existing_implementation", "reopen_draft_preimplementation", "reopen_draft_task_addition",
  "reopen_draft_spec_correction", "plan_gate_repair", "recover_attempt", "recover_missing_producer_artifact",
  "accept_final_regression_failure", "defer_failed_review", "defer_failed_gate", "recover_interrupted_finalize_sync",
  "park_flow", "resume_flow", "finalize_flow", "set_policy", "publish_artifacts", "publish_plugin_artifacts",
  "publish_upgrade_result", "update_spec_record", "begin_outbox", "reopen_outbox", "complete_outbox",
  "fail_outbox", "record_dispatch_approval", "skip_finalize_downstream", "reset_finalize_downstream",
  "continue_nonblocking",
]);

const TIMESTAMP_OBSERVATION_OPERATIONS = Object.freeze([
  "record_metric", "record_note", "record_nonblocking",
]);

const ACTIVITY_TYPE_BY_OPERATION = Object.freeze({
  create_flow: "flow_created",
  complete_draft_completion: "result_confirmed",
  add_task: "task_added",
  add_approval_task: "task_added",
  start_attempt: "attempt_started",
  retry_attempt: "attempt_retried",
  retry_gate_attempt: "attempt_retried",
  retry_recovery_attempt: "attempt_recovered",
  update_attempt: "attempt_updated",
  fail_attempt: "attempt_failed",
  record_failure: "failure_recorded",
  confirm_attempt: "result_confirmed",
  complete_acceptance_decision_noop: "result_confirmed",
  rewind: "recovery",
  rewind_test_evidence: "recovery",
  repair_test_review: "recovery",
  repair_scenario_validity: "recovery",
  repair_implementation: "recovery",
  triage_implementation_for_repair: "recovery",
  triage_implementation_no_repair: "recovery",
  repair_acceptance_review: "recovery",
  preimplementation_bootstrap: "recovery",
  recover_existing_implementation: "recovery",
  reopen_draft_preimplementation: "recovery",
  reopen_draft_task_addition: "recovery",
  reopen_draft_spec_correction: "recovery",
  plan_gate_repair: "recovery",
  recover_attempt: "recovery",
  recover_missing_producer_artifact: "recovery",
  accept_final_regression_failure: "failure_accepted",
  defer_failed_review: "failure_accepted",
  defer_failed_gate: "failure_accepted",
  recover_interrupted_finalize_sync: "recovery",
  park_flow: "flow_parked",
  resume_flow: "flow_resumed",
  finalize_flow: "flow_finalized",
  set_policy: "policy_updated",
  publish_artifacts: "artifacts_published",
  publish_plugin_artifacts: "artifacts_published",
  publish_upgrade_result: "artifacts_published",
  update_spec_record: "spec_record_updated",
  begin_outbox: "outbox_started",
  reopen_outbox: "outbox_reopened",
  complete_outbox: "outbox_completed",
  fail_outbox: "outbox_failed",
  record_dispatch_approval: "dispatch_approval_recorded",
  skip_finalize_downstream: "finalization_downstream_updated",
  reset_finalize_downstream: "finalization_downstream_updated",
  continue_nonblocking: "nonblocking_recorded",
});

// This fixture is the behavior-level portion of the migration-parity
// inventory. Each entry below has a dedicated executable regression. The
// complete route/help/args registry is checked separately in the R17 test;
// routes without a behavior-level fixture are deliberately not claimed here.
// Query is additive: it must not become the owner of any inventoried behavior.
const EXISTING_SURFACE_PARITY_FIXTURE = Object.freeze({
  registry: {
    owners: ["src/flow/registry.js", "src/lib/command-registry.js"],
    behavior: "FLOW_COMMANDS remains the single route, help, and argument registry for Flow commands.",
    regression: "All retained routes still resolve from FLOW_COMMANDS and render their existing help and args.",
    groups: ["prepare", "resume", "get", "set", "run"],
  },
  aliases: [
    {
      route: ["prepare"],
      owners: ["src/flow/registry.js", "src/flow/lib/run-prepare-spec.js"],
      behavior: "flow prepare routes to the prepare-spec lifecycle owner and accepts its existing branch/config inputs.",
      regression: "prepare --dry-run preserves its route, help, args, and no-write behavior.",
      args: {
        flags: ["--no-branch", "--worktree", "--dry-run"],
        options: ["--title", "--base", "--issue", "--request", "--run-id"],
      },
    },
    {
      route: ["resume"],
      owners: ["src/flow/registry.js", "src/flow/lib/run-resume.js"],
      behavior: "flow resume resolves a registered active Flow and returns its execution context.",
      regression: "resume --spec selects the fixture target and preserves currentStep/progress context.",
      args: {
        options: ["--spec"],
      },
    },
    {
      route: ["get", "status"],
      owners: ["src/flow/registry.js", "src/flow/lib/get-status.js"],
      behavior: "flow get status reads the active canonical state and exposes detailed status when requested.",
      regression: "status retains active/specId/phase/steps and details fields under explicit target guards.",
      args: {
        positional: ["runId"],
        flags: ["--details"],
      },
    },
    {
      route: ["report", "show"],
      owners: ["src/flow/registry.js", "src/flow/lib/run-report-show.js"],
      behavior: "flow report show remains the read-only report display route.",
      regression: "report show remains discoverable with its existing no-argument route.",
      args: { flags: [] },
    },
  ],
  run: {
    owners: ["src/flow/registry.js"],
    behavior: "The executable parity inventory covers only run-command behaviors with dedicated transition or artifact assertions.",
    regression: "Selected task, review, gate, and finalize-cleanup behaviors remain observable; every other run route is checked separately for registry compatibility.",
    categories: {
      task: {
        owners: ["src/flow/registry.js", "src/flow/lib/run-start-task.js", "src/flow/lib/run-complete-task.js"],
        behavior: "task admission and completion remain mutation owners for task work.",
        regression: "start-task and complete-task preserve their observable state transitions.",
        commands: ["start-task", "complete-task"],
      },
      review: {
        owners: ["src/flow/registry.js", "src/flow/lib/run-review.js"],
        behavior: "review remains the review execution owner with its lifecycle post hook.",
        regression: "review retains phase, dry-run, confirmation, and target argument surfaces.",
        commands: ["review"],
      },
      gate: {
        owners: ["src/flow/registry.js", "src/flow/lib/run-gate.js"],
        behavior: "gate remains the mechanical validation owner with its pre/post/error lifecycle.",
        regression: "gate retains spec, phase, runtime, and target argument surfaces.",
        commands: ["gate"],
      },
      finalize: {
        owners: ["src/flow/registry.js", "src/flow/lib/run-finalize.js", "src/flow/lib/run-finalize-cleanup.js"],
        behavior: "finalize-cleanup remains the finalization owner for teardown, pointer publication, and active-flow removal.",
        regression: "finalize-cleanup preserves its observable teardown and canonical pointer behavior.",
        commands: ["finalize-cleanup"],
      },
    },
  },
  targetAndConfig: {
    owners: ["src/lib/container.js", "src/flow/lib/flow-context.js", "src/flow/lib/get-status.js", "src/flow/lib/run-resume.js"],
    behavior: "existing commands resolve config and the requested active Flow target before command execution.",
    regression: "status, resolve-context, and resume honor the fixture config and exact spec/run target guards.",
  },
  hooks: {
    owners: ["src/flow/registry.js", "src/lib/plugin-registry.js", "src/lib/hooks.js"],
    behavior: "registered lifecycle pre/post/error hooks remain attached to their existing mutation owners.",
    regression: "prepare, gate, review, and finalize retain their expected hook callbacks.",
    callbacks: [
      { route: ["prepare"], callbacks: ["post"] },
      { route: ["run", "gate"], callbacks: ["pre", "post", "onError"] },
      { route: ["run", "review"], callbacks: ["post"] },
      { route: ["run", "finalize-commit"], callbacks: ["pre", "post", "onError"] },
      { route: ["run", "finalize-merge"], callbacks: ["pre", "post", "onError"] },
      { route: ["run", "finalize-sync"], callbacks: ["pre", "post", "onError"] },
      { route: ["run", "finalize-cleanup"], callbacks: ["pre", "onError"] },
    ],
  },
  canonicalArtifacts: {
    owners: ["src/flow/lib/run-prepare-spec.js", "src/flow/lib/canonical-flow-manager-store.js", "src/lib/flow-version.js"],
    behavior: "prepare and the Version Store own flow.json, Activity ledger, Spec record, and Artifact catalog authority.",
    regression: "a prepared Flow still creates all four canonical records, whose catalog entries hash the generated bytes.",
    files: ["flow.json", "activities.jsonl", "spec.json", "artifact-catalog.json"],
  },
  sideEffects: {
    owners: ["src/lib/repository-maintenance-lock.js", "src/lib/runtime-log.js", "src/lib/git-helpers.js"],
    behavior: "lock/cache/temporary/runtime and Git side effects remain owned by mutation/lifecycle commands, not query.",
    regression: "successful and failed query reads preserve managed side-effect tree contents and Git status.",
    paths: [".runtime", ".sennel/cache", ".sennel/temporary", ".tmp"],
  },
});

function cliPath() {
  return path.resolve("src/sennel.js");
}

function directFlowPath() {
  return path.resolve("src/flow.js");
}

function createRoot(prefix = "sennel-flow-query-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeQueryConfig(root, { logsEnabled = true } = {}) {
  writeJson(path.join(root, ".sennel", "config.json"), {
    lang: "en",
    type: "node-cli",
    docs: { languages: ["en"], defaultLanguage: "en" },
    scan: { include: ["src/**/*.js"] },
    logs: { enabled: logsEnabled },
    plugin: { sources: [], packages: [] },
  });
}

function installStubAgent(root, response) {
  const script = path.join(root, ".flow-query-stub-agent.cjs");
  fs.writeFileSync(script, [
    "#!/usr/bin/env node",
    `process.stdout.write(${JSON.stringify(response)});`,
    "",
  ].join("\n"), "utf8");
  fs.chmodSync(script, 0o755);
  const configFile = path.join(root, ".sennel", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.type = "base";
  config.agent = {
    default: "flow-query-stub",
    providers: {
      "flow-query-stub": {
        name: "flow-query-stub",
        command: process.execPath,
        args: [script],
      },
    },
  };
  writeJson(configFile, config);
}

function createPreBootstrapProbe() {
  const root = createRoot("sennel-flow-query-probe-");
  const bin = path.join(root, "bin");
  const marker = path.join(root, "git-invoked.log");
  const fakeGit = path.join(bin, "git");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(fakeGit, [
    "#!/usr/bin/env node",
    "const fs = require(\"node:fs\");",
    "fs.appendFileSync(process.env.SENNEL_QUERY_PROBE, process.argv.slice(2).join(\" \") + \"\\n\");",
    "process.exit(128);",
    "",
  ].join("\n"), "utf8");
  fs.chmodSync(fakeGit, 0o755);
  return {
    root,
    marker,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
      SENNEL_QUERY_PROBE: marker,
    },
  };
}

function createReaderSideEffectSentinel(targetRoot) {
  const sentinelRoot = createRoot("sennel-flow-query-reader-sentinel-");
  const module = path.join(sentinelRoot, "sentinel.cjs");
  const log = path.join(sentinelRoot, "events.jsonl");
  fs.writeFileSync(module, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const childProcess = require("node:child_process");',
    'const targetRoot = path.resolve(process.env.SENNEL_QUERY_SENTINEL_ROOT);',
    'const eventLog = process.env.SENNEL_QUERY_SENTINEL_LOG;',
    'const originalAppendFileSync = fs.appendFileSync.bind(fs);',
    'function target(value) {',
    '  if (typeof value !== "string") return false;',
    '  const absolute = path.resolve(value);',
    '  return absolute === targetRoot || absolute.startsWith(targetRoot + path.sep);',
    '}',
    'function canonical(value) {',
    '  if (!target(value)) return false;',
    '  return ["flow.json", "spec.json", "activities.jsonl", "artifact-catalog.json"].includes(path.basename(value));',
    '}',
    'function record(operation, value, details = {}) {',
    '  originalAppendFileSync(eventLog, `${JSON.stringify({ operation, path: typeof value === "string" ? path.resolve(value) : null, ...details })}\\n`, "utf8");',
    '}',
    'function violation(operation, value, details = {}) {',
    '  record(operation, value, { ...details, violation: true });',
    '  const error = new Error(`query reader sentinel rejected ${operation}`);',
    '  error.code = "QUERY_READER_SENTINEL";',
    '  throw error;',
    '}',
    'function wrapPath(operation, original, reject = true, predicate = target) {',
    '  return function wrapped(...args) {',
    '    const value = args[0];',
    '    if (predicate(value)) {',
    '      if (reject) return violation(operation, value);',
    '      record(operation, value);',
    '    }',
    '    return original.apply(this, args);',
    '  };',
    '}',
    'for (const operation of ["readFileSync", "readFile", "existsSync", "realpathSync", "realpath"]) {',
    '  if (typeof fs[operation] === "function") fs[operation] = wrapPath(operation, fs[operation], true, canonical);',
    '}',
    'for (const operation of ["mkdirSync", "mkdir", "rmSync", "rm", "writeFileSync", "writeFile", "appendFileSync", "appendFile", "renameSync", "rename", "unlinkSync", "unlink", "copyFileSync", "copyFile", "truncateSync", "truncate", "createWriteStream"]) {',
    '  if (typeof fs[operation] === "function") fs[operation] = wrapPath(operation, fs[operation]);',
    '}',
    'if (typeof fs.createReadStream === "function") fs.createReadStream = wrapPath("createReadStream", fs.createReadStream, true, canonical);',
    'for (const operation of ["mkdtempSync", "mkdtemp"]) {',
    '  if (typeof fs[operation] === "function") fs[operation] = function wrapped(...args) { return violation(operation, args[0]); };',
    '}',
    'for (const operation of ["mkdir", "rm", "writeFile", "appendFile", "rename", "unlink", "copyFile"]) {',
    '  if (typeof fs.promises[operation] === "function") {',
    '    const original = fs.promises[operation].bind(fs.promises);',
    '    fs.promises[operation] = function wrappedPromiseMutation(...args) {',
    '      if (target(args[0])) return violation(`promises.${operation}`, args[0]);',
    '      return original(...args);',
    '    };',
    '  }',
    '}',
    'if (typeof fs.promises.mkdtemp === "function") {',
    '  fs.promises.mkdtemp = function wrappedPromiseMkdtemp(...args) { return violation("promises.mkdtemp", args[0]); };',
    '}',
    'const originalOpenSync = fs.openSync.bind(fs);',
    'function assertReadOnlyOpen(operation, file, flags) {',
    '  if (!canonical(file)) {',
    '    if (target(file) && file.includes(`${path.sep}.runtime${path.sep}locks${path.sep}`)) return violation(operation, file, { flags });',
    '    return;',
    '  }',
    '  record(operation, file, { flags });',
    '  const constants = fs.constants;',
    '  const numeric = typeof flags === "number";',
    '  const readOnly = numeric && (flags & constants.O_ACCMODE) === constants.O_RDONLY;',
    '  const noFollow = numeric && constants.O_NOFOLLOW !== undefined && (flags & constants.O_NOFOLLOW) !== 0;',
    '  if (!readOnly || !noFollow) {',
    '    return violation(operation, file, { flags });',
    '  }',
    '}',
    'fs.openSync = function wrappedOpenSync(file, flags, ...args) {',
    '  assertReadOnlyOpen("openSync", file, flags);',
    '  return originalOpenSync(file, flags, ...args);',
    '};',
    'const originalOpen = fs.open.bind(fs);',
    'fs.open = function wrappedOpen(file, flags, ...args) {',
    '  assertReadOnlyOpen("open", file, flags);',
    '  return originalOpen(file, flags, ...args);',
    '};',
    'const originalPromisesOpen = fs.promises.open.bind(fs.promises);',
    'fs.promises.open = async function wrappedPromisesOpen(file, flags, ...args) {',
    '  assertReadOnlyOpen("promises.open", file, flags);',
    '  return originalPromisesOpen(file, flags, ...args);',
    '};',
    'for (const operation of ["readdirSync", "readdir", "opendirSync", "opendir", "statSync", "stat", "lstatSync", "lstat", "fstatSync", "fstat", "accessSync", "access"]) {',
    '  if (typeof fs[operation] === "function") fs[operation] = wrapPath(operation, fs[operation], false);',
    '}',
    'for (const operation of ["readSync", "read", "writeSync", "write", "ftruncateSync", "ftruncate"]) {',
    '  if (typeof fs[operation] === "function") {',
    '    const original = fs[operation].bind(fs);',
    '    fs[operation] = function wrappedFdOperation(...args) {',
    '      record(operation, null);',
    '      if (operation.startsWith("write") || operation.startsWith("ftruncate")) return violation(operation, null);',
    '      return original(...args);',
    '    };',
    '  }',
    '}',
    'for (const operation of ["readFile", "realpath"]) {',
    '  if (typeof fs.promises[operation] === "function") fs.promises[operation] = wrapPath(`promises.${operation}`, fs.promises[operation], true, canonical);',
    '}',
    'for (const operation of ["stat", "lstat", "access"]) {',
    '  if (typeof fs.promises[operation] === "function") fs.promises[operation] = wrapPath(`promises.${operation}`, fs.promises[operation], false, target);',
    '}',
    'for (const operation of ["spawnSync", "execFileSync", "spawn", "execFile", "fork"]) {',
    '  if (typeof childProcess[operation] === "function") childProcess[operation] = function wrappedChildProcess(...args) { return violation(`child_process.${operation}`, args[0]); };',
    '}',
    'const originalChdir = process.chdir.bind(process);',
    'process.chdir = function wrappedChdir(directory) { return violation("process.chdir", directory); };',
  ].join("\n"), "utf8");
  const nodeOptions = [
    process.env.NODE_OPTIONS || "",
    "--require",
    module,
  ].filter(Boolean).join(" ");
  return {
    log,
    env: {
      SENNEL_QUERY_SENTINEL_ROOT: targetRoot,
      SENNEL_QUERY_SENTINEL_LOG: log,
      NODE_OPTIONS: nodeOptions,
    },
  };
}

function readReaderSentinelEvents(log) {
  if (!fs.existsSync(log)) return [];
  const contents = fs.readFileSync(log, "utf8").trimEnd();
  return contents === "" ? [] : contents.split("\n").map((line) => JSON.parse(line));
}

function createQueryCallProbe() {
  const probeRoot = createRoot("sennel-flow-query-call-probe-");
  const loader = path.join(probeRoot, "query-call-probe-loader.mjs");
  const eventProbe = path.join(probeRoot, "query-event-probe.cjs");
  const log = path.join(probeRoot, "calls.jsonl");
  fs.writeFileSync(eventProbe, [
    'const fs = require("node:fs");',
    'const { EventEmitter } = require("node:events");',
    'const logFile = process.env.SENNEL_QUERY_CALL_PROBE;',
    'const forbidden = new Set([',
    '  "config-loaded", "runtime-log",',
    '  "prepare:pre", "prepare:post",',
    '  "gate:pre", "gate:post", "gate:onError",',
    '  "review:post",',
    '  "finalize:pre", "finalize:post", "finalize:onError",',
    ']);',
    'function record(name) {',
    '  fs.appendFileSync(logFile, `${JSON.stringify({ kind: "event", name })}\\n`, "utf8");',
    '  throw new Error(`query call probe rejected event:${name}`);',
    '}',
    'const originalEmit = EventEmitter.prototype.emit;',
    'EventEmitter.prototype.emit = function wrappedEmit(name, ...args) {',
    '  if (forbidden.has(String(name))) return record(String(name));',
    '  return originalEmit.call(this, name, ...args);',
    '};',
    'const originalProcessEmit = process.emit.bind(process);',
    'process.emit = function wrappedProcessEmit(name, ...args) {',
    '  if (forbidden.has(String(name))) return record(String(name));',
    '  return originalProcessEmit(name, ...args);',
    '};',
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(loader, [
    'import fs from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    'const logFile = process.env.SENNEL_QUERY_CALL_PROBE;',
    'function record(kind, name, reject = true) {',
    '  fs.appendFileSync(logFile, `${JSON.stringify({ kind, name })}\\n`, "utf8");',
    '  if (reject) throw new Error(`query call probe rejected ${kind}:${name}`);',
    '}',
    'function transformClass(source, name, methods = []) {',
    '  const declaration = new RegExp(`\\\\bexport\\\\s+class\\\\s+${name}\\\\b`);',
    '  const exportList = new RegExp(`\\\\bexport\\\\s*\\\\{[^}]*\\\\b${name}\\\\b[^}]*\\\\}`);',
    '  if (!declaration.test(source) && !exportList.test(source)) return source;',
    '  const original = `__sennelQueryProbeOriginal_${name}`;',
    '  const renamed = source.replace(declaration, `class ${original}`).replace(new RegExp(`\\\\b${name}\\\\b`, "g"), original);',
    '  const wrappers = methods.map((method) => [',
    '    `  ${method}(...args) {`,',
    '    `    record("reader", "${method}", false);`,',
    '    `    return super.${method}(...args);`,',
    '    "  }",',
    '  ].join("\\n")).join("\\n");',
    '  const constructor = methods.length > 0',
    '    ? `    record("reader", "constructor", false);\\n`',
    '    : "    record(\\"constructor\\", \\"${name}\\");\\n";',
    '  return `${renamed}\\nclass ${name} extends ${original} {\\n  constructor(...args) {\\n${constructor}    super(...args);\\n  }\\n${wrappers}\\n}\\nexport { ${name} };\\n`;',
    '}',
    'function transformFunction(source, name) {',
    '  const declaration = new RegExp(`\\\\bexport\\\\s+(async\\\\s+)?function\\\\s+${name}\\\\b`);',
    '  const match = source.match(declaration);',
    '  if (!match) return source;',
    '  const original = `__sennelQueryProbeOriginal_${name}`;',
    '  const keyword = match[1] ? "async function" : "function";',
    '  const renamed = source.replace(declaration, `${keyword} ${original}`).replace(new RegExp(`\\\\b${name}\\\\b`, "g"), original);',
    '  return `${renamed}\\nfunction ${name}(...args) {\\n  record("call", "${name}");\\n}\\nexport { ${name} };\\n`;',
    '}',
    'const targets = new Map([',
    '  ["/src/lib/container.js", { functions: ["initContainer"] }],',
    '  ["/src/lib/worktree-cli-execution.js", { functions: ["executeWorktreeLocalCli"] }],',
    '  ["/src/lib/dispatcher.js", { functions: ["dispatch"] }],',
    '  ["/src/flow/lib/flow-context.js", { functions: ["buildFlowCommandHookContext"] }],',
    '  ["/src/lib/log.js", { classes: ["Logger"] }],',
    '  ["/src/lib/agent.js", { classes: ["Agent"] }],',
    '  ["/src/lib/flow-manager.js", { classes: ["FlowManager"] }],',
    '  ["/src/flow/lib/canonical-flow-runtime.js", { classes: ["CanonicalFlowRuntime"] }],',
    '  ["/src/flow/lib/current-flow-state.js", { classes: ["CurrentFlowStateStore", "CurrentFlowVersionStore"] }],',
    '  ["/src/lib/flow-version.js", { classes: ["FlowArtifactCatalogStore"] }],',
    '  ["/src/lib/repository-maintenance-lock.js", { classes: ["RepositoryMaintenanceLock"] }],',
    '  ["/src/lib/runtime-log.js", { classes: ["RuntimeLogBlockWriter"] }],',
    ']);',
    'export async function load(url, context, nextLoad) {',
    '  const result = await nextLoad(url, context);',
    '  if (result.format !== "module") return result;',
    '  const file = url.startsWith("file:") ? fileURLToPath(url) : "";',
    '  let source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");',
    '  const target = [...targets.entries()].find(([suffix]) => file.endsWith(suffix))?.[1];',
    '  if (target) {',
    '    for (const name of target.classes ?? []) source = transformClass(source, name);',
    '    for (const name of target.functions ?? []) source = transformFunction(source, name);',
    '  }',
    '  if (file.includes("/src/flow/") && /\\bCanonicalFlowVersionReader\\b/.test(source)) {',
    '    source = transformClass(source, "CanonicalFlowVersionReader", [',
    '      "readVersionDirectoryEntries",',
    '      "readStateRecordBytes",',
    '      "readSpecRecordBytes",',
    '      "readConfirmedLedgerPrefix",',
    '      "readArtifactCatalogBytes",',
    '    ]);',
    '  }',
    '  return { ...result, source };',
    '}',
    "",
  ].join("\n"), "utf8");
  return {
    log,
    env: {
      SENNEL_QUERY_CALL_PROBE: log,
      NODE_OPTIONS: `--require ${eventProbe} --experimental-loader ${loader}`,
    },
  };
}

function combineProbeEnvironments(...probes) {
  const environment = Object.assign({}, ...probes.map((probe) => probe.env));
  const inherited = process.env.NODE_OPTIONS || "";
  const extraOptions = probes.map((probe) => probe.env.NODE_OPTIONS || "").flatMap((options) => {
    if (options === "") return [];
    if (inherited !== "" && options === inherited) return [];
    if (inherited !== "" && options.startsWith(`${inherited} `)) return [options.slice(inherited.length).trim()];
    return [options];
  });
  const nodeOptions = [inherited, ...extraOptions].filter(Boolean);
  if (nodeOptions.length > 0) environment.NODE_OPTIONS = nodeOptions.join(" ");
  return environment;
}

function readQueryCallProbeEvents(log) {
  if (!fs.existsSync(log)) return [];
  const contents = fs.readFileSync(log, "utf8").trimEnd();
  return contents === "" ? [] : contents.split("\n").map((line) => JSON.parse(line));
}

function assertNoQueryCallProbeEvents(log, label) {
  assert.deepEqual(
    readQueryCallProbeEvents(log).filter((event) => event.kind !== "reader"),
    [],
    `${label} invoked a forbidden owner or lifecycle call`,
  );
}

function assertSharedReaderBoundary(log, { minimumCalls, label }) {
  const readerEvents = readQueryCallProbeEvents(log).filter((event) => event.kind === "reader");
  assert.equal(
    readerEvents.some((event) => event.name === "constructor"),
    true,
    `${label} did not construct CanonicalFlowVersionReader`,
  );
  for (const name of [
    "readVersionDirectoryEntries",
    "readStateRecordBytes",
    "readSpecRecordBytes",
    "readConfirmedLedgerPrefix",
    "readArtifactCatalogBytes",
  ]) {
    assert.ok(
      readerEvents.filter((event) => event.name === name).length >= minimumCalls,
      `${label} did not route every query through ${name}`,
    );
  }
}

function installLifecycleHookProbe(root, marker) {
  const pluginRoot = path.join(root, ".sennel", "plugins", "query-probe");
  const hookFile = path.join(pluginRoot, "hooks", "prepare.js");
  const configFile = path.join(root, ".sennel", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.plugin.packages = [{
    id: "query-probe",
    source: "query-probe",
    commit: "0".repeat(40),
  }];
  writeJson(configFile, config);
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, [
    "import fs from \"node:fs\";",
    `fs.appendFileSync(${JSON.stringify(marker)}, "imported\\n");`,
    "export default function register(api) {",
    "  return class QueryProbeHook extends api.FlowCommandHook {",
    '    static command = "prepare";',
    '    static hook = "pre";',
    "    static priority = 0;",
    '    static failurePolicy = "required";',
    "    async run(context) {",
    `      fs.appendFileSync(${JSON.stringify(marker)}, "run\\n");`,
    '      return context.envelope.ok("query-probe", "prepare", {});',
    "    }",
    "  };",
    "}",
    "",
  ].join("\n"), "utf8");
}

function installLifecycleHookSuite(root, marker, definitions) {
  const pluginId = "query-parity-hooks";
  const configFile = path.join(root, ".sennel", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.plugin.packages = [{
    id: pluginId,
    source: pluginId,
    commit: "0".repeat(40),
  }];
  writeJson(configFile, config);
  const hooksDir = path.join(root, ".sennel", "plugins", pluginId, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const [index, definition] of definitions.entries()) {
    const className = `QueryParityHook${index}`;
    const observation = {
      command: definition.command,
      hook: definition.hook,
      priority: Number(definition.priority || 0),
    };
    const result = definition.failure
      ? `return context.envelope.fail("plugin-hook", ${JSON.stringify(definition.command)}, "QUERY_PARITY_HOOK_FAILED", "fixture hook failure");`
      : `return context.envelope.ok("plugin-hook", ${JSON.stringify(definition.command)}, { observed: true });`;
    const artifact = definition.artifact
      ? [
        `    await context.artifacts.writeJson("${definition.artifact}", ${JSON.stringify(observation)});`,
      ]
      : [];
    const source = [
      "import fs from \"node:fs\";",
      "export default function register(api) {",
      `  return class ${className} extends api.FlowCommandHook {`,
      `    static command = ${JSON.stringify(definition.command)};`,
      `    static hook = ${JSON.stringify(definition.hook)};`,
      `    static priority = ${Number(definition.priority || 0)};`,
      `    static failurePolicy = ${JSON.stringify(definition.failurePolicy || "required")};`,
      "    async run(context) {",
      `      fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${JSON.stringify(observation)}\\n`)});`,
      ...artifact,
      `      ${result}`,
      "    }",
      "  };",
      "}",
      "",
    ];
    fs.writeFileSync(
      path.join(hooksDir, `${String(index).padStart(2, "0")}-${definition.command}-${definition.hook}.js`),
      source.join("\n"),
      "utf8",
    );
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixtureSpecRecord({ capabilities = { "query.metadata": true, "query.activities": true } } = {}) {
  return {
    goal: "Expose a stable read-only query boundary.",
    background: "The canonical records are the only authority.",
    scope: { in: ["metadata", "activities"], out: ["mutation"] },
    constraints: ["No external dependencies."],
    design_principles: ["Canonical authority is read-only."],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [],
    acceptance_criteria: ["Consumers receive a bounded public projection."],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
    ...(capabilities === null ? {} : { capabilities }),
  };
}

function createFixture({
  specId = SPEC_ID,
  runId = `run-${specId}`,
  prefix = "sennel-flow-query-",
  active = true,
  issue = null,
  specRecord = fixtureSpecRecord(),
} = {}) {
  const root = createRoot(prefix);
  const flowManager = makeFlowManager(root);
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId,
    issue,
    specRecord,
  }).create();
  if (active) fixture.registerActive();
  return { root, flowManager, fixture, specId };
}

function createTaskRelationFixture() {
  const root = createRoot("sennel-flow-query-task-relation-");
  const flowManager = makeFlowManager(root);
  const scenario = new TaskLifecycleFixture({
    flowManager,
    specId: "517-flow-query-task-relation",
    runId: "run-517-flow-query-task-relation",
    taskDocuments: [{
      id: "T-1",
      title: "Query relation task",
      goal: "Expose task-owned catalog relations.",
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }],
    taskId: "T-1",
    targetStep: "task-impl",
  }).create();
  const fixture = scenario.flow.flow;
  fixture.settle("T-1-impl");
  return { root, flowManager, fixture };
}

function rawNodeById(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.steps ?? []) {
    const match = rawNodeById(child, id);
    if (match !== null) return match;
  }
  return null;
}

function persistCanonicalState(fixture, mutate) {
  const location = fixture.fixture.location();
  const state = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
  mutate(state);
  writeJson(location.flowStateFile, state);
  refreshVersionCatalog(location.directory, ["flow.json"]);
  return state;
}

function persistBlockedAttempt(fixture, { blocker, failure, incomplete = [] }) {
  const location = fixture.fixture.location();
  const state = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
  const nodeId = state.current;
  const node = rawNodeById(state, nodeId);
  assert.ok(node, "blocked fixture must have a current node");
  assert.ok(state.attempt, "blocked fixture must have a current Attempt");
  const replacementAttempt = { ...structuredClone(state.attempt), blocker, incomplete };
  const updateOrder = state.confirmationOrder + 1;
  const update = new FlowActivity({
    id: `fixture-blocker-update-${updateOrder}`,
    nodeId,
    nodeKey: node.key,
    attemptId: state.attempt.id,
    sequence: state.attempt.sequence,
    confirmationOrder: updateOrder,
    type: "attempt_updated",
    transition: {
      operation: "update_attempt",
      nodeId,
      task: null,
      attempt: replacementAttempt,
      status: null,
      policy: null,
      outbox: null,
      approval: null,
      nonblocking: null,
      finalizeSteps: null,
      gateTaskLifecycle: null,
      stepConnectionReceipt: null,
    },
    result: null,
    timing: { startedAt: FIXED_TIME, finishedAt: FIXED_TIME, durationMs: 0 },
    failure: null,
    provider: null,
    model: null,
    effort: null,
    usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null,
    note: null,
    reviewPublication: null,
  });
  const failedAttempt = { ...replacementAttempt, failure };
  const failedOrder = updateOrder + 1;
  const failed = new FlowActivity({
    id: `fixture-blocker-failure-${failedOrder}`,
    nodeId,
    nodeKey: node.key,
    attemptId: state.attempt.id,
    sequence: state.attempt.sequence,
    confirmationOrder: failedOrder,
    type: "attempt_failed",
    transition: {
      operation: "fail_attempt",
      nodeId,
      task: null,
      attempt: null,
      status: null,
      policy: null,
      outbox: null,
      approval: null,
      nonblocking: null,
      finalizeSteps: null,
      gateTaskLifecycle: null,
      stepConnectionReceipt: null,
    },
    result: {
      outcome: "failed",
      summary: failure.message,
      confirmedAt: FIXED_TIME,
      artifactRefs: [],
    },
    timing: { startedAt: FIXED_TIME, finishedAt: FIXED_TIME, durationMs: 0 },
    failure,
    provider: null,
    model: null,
    effort: null,
    usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null,
    note: null,
    reviewPublication: null,
  });
  fs.appendFileSync(location.activitiesFile, `${JSON.stringify(update.toJSON())}\n${JSON.stringify(failed.toJSON())}\n`, "utf8");
  state.attempt = failedAttempt;
  state.confirmationOrder = failedOrder;
  writeJson(location.flowStateFile, state);
  refreshVersionCatalog(location.directory, ["flow.json", "activities.jsonl"]);
}

function makeNoCreationEvidenceVersion(fixture) {
  const versionDirectory = addVersionTwo(fixture);
  const stateFile = path.join(versionDirectory, "flow.json");
  const envelope = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  envelope.state.history = {
    kind: "historical",
    execution: "dormant",
    ledger: "partial",
    creation: { status: "unavailable", reason: "NO_TRUSTED_CREATION_EVIDENCE" },
  };
  envelope.state.current = null;
  envelope.state.attempt = null;
  envelope.state.confirmationOrder = 0;
  writeJson(stateFile, envelope);
  fs.writeFileSync(path.join(versionDirectory, "activities.jsonl"), "", "utf8");
  refreshVersionCatalog(versionDirectory, ["flow.json", "activities.jsonl"]);
  return versionDirectory;
}

function settleAndFinalize({ flowManager, fixture, specId }) {
  for (const node of fixture.leaves()) fixture.settle(node.id);
  flowManager.finalizeFlow(specId);
}

function copyVersionFiles(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".runtime") continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyVersionFiles(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function copyValidVersionFiles(source, target, { excluded = new Set() } = {}) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".runtime") continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyValidVersionFiles(from, to, { excluded });
    } else if (entry.isFile() && !excluded.has(path.relative(source, from))) {
      fs.copyFileSync(from, to);
    }
  }
}

function addValidVersionedDirectory({ source, target, specId, flowVersion }) {
  copyValidVersionFiles(source, target, { excluded: new Set(["flow.json", "artifact-catalog.json"]) });

  const state = JSON.parse(fs.readFileSync(path.join(source, "flow.json"), "utf8"));
  state.specId = specId;
  state.flowVersion = flowVersion;
  writeJson(path.join(target, "flow.json"), {
    recordRevision: 1,
    specId,
    flowVersion,
    state,
  });

  const catalogFile = path.join(source, "artifact-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  for (const descriptor of catalog.artifacts) {
    if (descriptor.relativePath === "flow.json") {
      const bytes = fs.readFileSync(path.join(target, "flow.json"));
      descriptor.hash = sha256(bytes);
      descriptor.size = bytes.length;
    }
  }
  catalog.hash = sha256(Buffer.from(JSON.stringify({
    schemaRevision: catalog.schemaRevision,
    artifacts: catalog.artifacts,
  }), "utf8"));
  writeJson(path.join(target, "artifact-catalog.json"), catalog);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortedJsonValue(value[key])]),
    );
  }
  return value;
}

function encodeCursorPayload(payload) {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64url");
}

function cursorUnsignedPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== "digest"),
  );
}

function cursorCanonicalJson(payload) {
  return JSON.stringify(sortedJsonValue(cursorUnsignedPayload(payload)));
}

function cursorDigest(payload) {
  return sha256(Buffer.from(cursorCanonicalJson(payload), "utf8"));
}

function decodeCursorPayload(cursor) {
  assert.equal(typeof cursor, "string");
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const payload = JSON.parse(json);
  assert.equal(Buffer.from(json, "utf8").toString("base64url"), cursor);
  assert.equal(payload !== null && typeof payload === "object" && !Array.isArray(payload), true);
  return payload;
}

function mutateCursorPayload(cursor, mutate) {
  const payload = decodeCursorPayload(cursor);
  mutate(payload);
  return encodeCursorPayload(payload);
}

function assertOpaqueCursor(cursor, expected) {
  const payload = decodeCursorPayload(cursor);
  for (const field of [
    "version", "resource", "specId", "flowVersion", "recordedAt",
    "confirmationOrder", "digest",
  ]) {
    assert.equal(Object.hasOwn(payload, field), true, `cursor payload must bind ${field}`);
  }
  assert.equal(payload.version, 1);
  assert.equal(payload.resource, expected.resource);
  assert.equal(payload.specId, expected.specId);
  assert.equal(payload.flowVersion, expected.flowVersion);
  assert.deepEqual(payload.recordedAt, { gte: expected.gte, lt: expected.lt });
  assert.equal(payload.confirmationOrder, expected.confirmationOrder);
  assert.match(payload.digest, /^[a-f0-9]{64}$/);
  assert.equal(payload.digest, cursorDigest(payload));
  assert.equal(
    Buffer.from(JSON.stringify(sortedJsonValue(payload)), "utf8").toString("base64url"),
    cursor,
    "cursor payload must use canonical JSON serialization",
  );
  assert.equal(Object.hasOwn(payload, "offset"), false);
  assert.equal(Object.hasOwn(payload, "filesystemPosition"), false);
  return payload;
}

function addVersionTwo({ root, fixture, specId }) {
  const versionOne = fixture.location().directory;
  const versionTwo = path.join(root, "specs", specId, "002");
  copyVersionFiles(versionOne, versionTwo);

  const state = JSON.parse(fs.readFileSync(path.join(versionOne, "flow.json"), "utf8"));
  const spec = JSON.parse(fs.readFileSync(path.join(versionOne, "spec.json"), "utf8"));
  state.flowVersion = 2;
  writeJson(path.join(versionTwo, "flow.json"), {
    recordRevision: 1,
    specId,
    flowVersion: 2,
    state,
  });
  writeJson(path.join(versionTwo, "spec.json"), {
    recordRevision: 1,
    specId,
    content: spec,
  });

  const catalogFile = path.join(versionTwo, "artifact-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  for (const descriptor of catalog.artifacts) {
    if (descriptor.relativePath === "flow.json") {
      const bytes = fs.readFileSync(path.join(versionTwo, "flow.json"));
      descriptor.hash = sha256(bytes);
      descriptor.size = bytes.length;
    }
    if (descriptor.relativePath === "spec.json") {
      const bytes = fs.readFileSync(path.join(versionTwo, "spec.json"));
      descriptor.hash = sha256(bytes);
      descriptor.size = bytes.length;
    }
  }
  const content = { schemaRevision: 2, artifacts: catalog.artifacts };
  catalog.hash = sha256(Buffer.from(JSON.stringify(content), "utf8"));
  writeJson(catalogFile, catalog);
  return versionTwo;
}

function refreshVersionCatalog(versionDirectory, relativePaths = []) {
  const catalogFile = path.join(versionDirectory, "artifact-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  for (const relativePath of relativePaths) {
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === relativePath);
    assert.ok(descriptor, `fixture catalog must contain ${relativePath}`);
    const bytes = fs.readFileSync(path.join(versionDirectory, relativePath));
    descriptor.hash = sha256(bytes);
    descriptor.size = bytes.length;
  }
  const content = { schemaRevision: catalog.schemaRevision, artifacts: catalog.artifacts };
  catalog.hash = sha256(Buffer.from(JSON.stringify(content), "utf8"));
  writeJson(catalogFile, catalog);
}

function artifactIdentity(descriptor) {
  return {
    logicalKey: descriptor.logicalKey,
    kind: descriptor.kind,
    relativePath: descriptor.relativePath,
    hash: descriptor.hash,
    size: descriptor.size,
    mediaType: descriptor.mediaType,
    authority: descriptor.authority,
    cardinality: descriptor.cardinality,
    memberId: descriptor.memberId,
    publicationStep: descriptor.publicationStep,
    retention: descriptor.retention,
    activityId: descriptor.activityId,
    migrationMaterialization: descriptor.migrationMaterialization,
  };
}

function artifactCanonicalJson(descriptor) {
  return JSON.stringify(sortedJsonValue(artifactIdentity(descriptor)));
}

function publicArtifactId(descriptor) {
  const canonicalJson = artifactCanonicalJson(descriptor);
  return sha256(Buffer.from(canonicalJson, "utf8"));
}

function readActivityEntries(fixture) {
  const contents = fs.readFileSync(fixture.location().activitiesFile, "utf8").trimEnd();
  return contents === "" ? [] : contents.split("\n").map((line) => JSON.parse(line));
}

function rewriteActivityLedger(fixture, predicate, mutate) {
  const entries = readActivityEntries(fixture);
  const target = entries.find(predicate);
  assert.ok(target, "fixture requires a matching Activity");
  mutate(target);
  fs.writeFileSync(
    fixture.location().activitiesFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  refreshVersionCatalog(fixture.location().directory, ["activities.jsonl"]);
  return target;
}

function mutateConfirmedActivity(fixture, mutate, { predicate = () => true } = {}) {
  return rewriteActivityLedger(fixture, (entry) => (
    entry.transition.operation === "confirm_attempt" && entry.result !== null
    && predicate(entry)
  ), mutate);
}

function timestampForFixtureOperation(index) {
  return `2026-01-02T03:04:${String(10 + index).padStart(2, "0")}.000Z`;
}

function createTimestampOperationFixture(operation, index) {
  const fixture = createFixture({
    prefix: `sennel-flow-query-timestamp-${operation}-`,
  });
  let target;
  if (operation === "create_flow") {
    target = rewriteActivityLedger(
      fixture.fixture,
      (entry) => entry.transition.operation === "create_flow",
      (entry) => {
        entry.timing.startedAt = timestampForFixtureOperation(index);
        entry.timing.finishedAt = timestampForFixtureOperation(index);
      },
    );
  } else {
    settleAndFinalize(fixture);
    target = rewriteActivityLedger(
      fixture.fixture,
      operation === "finalize_flow"
        ? (entry) => entry.transition.operation === "finalize_flow"
        : (entry) => entry.transition.operation === "confirm_attempt",
      (entry) => {
        entry.transition.operation = operation;
        entry.type = ACTIVITY_TYPE_BY_OPERATION[operation];
        entry.timing.startedAt = timestampForFixtureOperation(index);
        entry.timing.finishedAt = timestampForFixtureOperation(index);
      },
    );
  }
  assert.equal(target.type, ACTIVITY_TYPE_BY_OPERATION[operation]);
  return { ...fixture, target };
}

function addMigrationMaterialization(fixture, {
  relativePath = "artifacts/migration/query-materialization.bin",
  mediaType = "application/octet-stream",
  memberId = "query-materialization",
} = {}) {
  const location = fixture.location();
  const bytes = Buffer.from("query migration materialization", "utf8");
  const absolutePath = path.join(location.directory, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  const catalog = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
  catalog.artifacts.push({
    logicalKey: null,
    kind: "query-migration-materialization",
    relativePath,
    hash: sha256(bytes),
    size: bytes.length,
    mediaType,
    authority: "canonical-flow-artifacts",
    cardinality: "collection",
    memberId,
    publicationStep: "system",
    retention: "permanent",
    activityId: null,
    migrationMaterialization: true,
  });
  const typed = new FlowArtifactCatalog(catalog);
  writeJson(location.catalogFile, typed.toJSON());
  return typed.artifacts.find((entry) => entry.relativePath === relativePath).toJSON();
}

function addActivityEvidenceArtifact(fixture) {
  const location = fixture.location();
  const creation = readActivityEntries(fixture).find((entry) => entry.transition.operation === "create_flow");
  assert.ok(creation, "fixture requires the canonical creation Activity");
  const evidence = FLOW_ARTIFACT_CONTRACTS.activityEvidence({
    nodeId: "flow",
    digest: "b".repeat(64),
  });
  const document = {
    schemaRevision: 1,
    activityId: creation.id,
    owner: { nodeId: "flow", nodeKey: "flow" },
    observedAt: creation.timing.finishedAt,
    source: { path: "flow.json", pointer: "/flowId", hash: "c".repeat(64) },
    note: "query Activity evidence fixture",
  };
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  const absolutePath = location.resolve(evidence.relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  const catalog = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
  catalog.artifacts.push({
    logicalKey: evidence.logicalKey,
    kind: evidence.contract.authoritySlot.kind,
    relativePath: evidence.relativePath,
    hash: sha256(bytes),
    size: bytes.length,
    mediaType: "application/json",
    authority: evidence.contract.authoritySlot.authority.toString(),
    cardinality: evidence.contract.authoritySlot.cardinality.toString(),
    memberId: evidence.memberId,
    publicationStep: evidence.contract.authoritySlot.publicationStep,
    retention: evidence.contract.retention.toString(),
    activityId: creation.id,
    migrationMaterialization: false,
  });
  const typed = new FlowArtifactCatalog(catalog);
  writeJson(location.catalogFile, typed.toJSON());
  return {
    document,
    descriptor: typed.artifacts.find((entry) => entry.relativePath === evidence.relativePath).toJSON(),
  };
}

function createOversizedMetadataFixture() {
  const fixture = createFixture({ prefix: "sennel-flow-query-response-limit-" });
  const versionDirectory = fixture.fixture.location().directory;
  const catalogFile = path.join(versionDirectory, "artifact-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const fixtureDirectory = path.join(versionDirectory, "artifacts", "migration", "response-limit");
  const bytes = Buffer.from("x", "utf8");
  const remaining = QUERY_LIMITS.MAX_ARTIFACTS - catalog.artifacts.length;
  assert.equal(remaining > 0, true, "fixture catalog must leave room below the spec artifact limit");
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  for (let index = 0; index < remaining; index += 1) {
    const memberId = `response-limit-${String(index).padStart(5, "0")}`;
    const relativePath = `artifacts/migration/response-limit/${memberId}.bin`;
    fs.writeFileSync(path.join(versionDirectory, relativePath), bytes);
    catalog.artifacts.push({
      logicalKey: null,
      kind: "query-response-limit",
      relativePath,
      hash: sha256(bytes),
      size: bytes.length,
      mediaType: OVERSIZED_ARTIFACT_MEDIA_TYPE,
      authority: "canonical-flow-artifacts",
      cardinality: "collection",
      memberId,
      publicationStep: "system",
      retention: "permanent",
      activityId: null,
      migrationMaterialization: true,
    });
  }
  catalog.artifacts.sort((left, right) => (
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1
      : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
  ));
  writeJson(catalogFile, catalog);
  refreshVersionCatalog(versionDirectory);
  const publicArtifactBytes = Buffer.byteLength(JSON.stringify({
    artifactId: "0".repeat(64),
    metadata: { logicalKey: null, schemaRevision: null, mediaType: OVERSIZED_ARTIFACT_MEDIA_TYPE },
    activityIds: [],
    nodeIds: [],
    taskIds: [],
  }), "utf8");
  assert.equal(catalog.artifacts.length, QUERY_LIMITS.MAX_ARTIFACTS);
  assert.equal(publicArtifactBytes * remaining > QUERY_LIMITS.MAX_RESPONSE_BYTES, true);
  return fixture;
}

function mutateVersionTwoFixture(mutate, { prefix = "sennel-flow-query-integrity-" } = {}) {
  const fixture = createFixture({ prefix });
  fixture.fixture.settle("draft");
  const versionDirectory = addVersionTwo(fixture);
  mutate({ fixture, versionDirectory, specId: fixture.specId });
  return fixture;
}

function mutateVersionOneFixture(mutate, { prefix = "sennel-flow-query-v1-integrity-" } = {}) {
  const fixture = createFixture({ prefix });
  fixture.fixture.settle("draft");
  const versionDirectory = fixture.fixture.location().directory;
  mutate({ fixture, versionDirectory, specId: fixture.specId });
  return fixture;
}

function versionTwoRequest(fixture, resource = "metadata") {
  return {
    resource,
    condition: { specId: fixture.specId, flowVersion: 2 },
  };
}

function assertVersionIntegrityError(result, { resource = "metadata" } = {}) {
  assertKnownError(result, {
    resource,
    code: "CANONICAL_RECORD_INCONSISTENT",
    path: "/canonical",
  });
  assert.equal(result.response.selectedFlowVersion, null);
  if (resource === "metadata") assert.equal(result.response.item, null);
  else assert.deepEqual(result.response.items, []);
}

function assertVersionUnreadableError(result, { resource = "metadata" } = {}) {
  assertKnownError(result, {
    resource,
    code: "CANONICAL_RECORD_UNREADABLE",
    path: "/canonical",
  });
  assert.equal(result.response.selectedFlowVersion, null);
  if (resource === "metadata") assert.equal(result.response.item, null);
  else assert.deepEqual(result.response.items, []);
}

function invoke(root, argv, {
  input = undefined,
  direct = false,
  cwd = root,
  workRoot = root,
  sourceRoot = root,
  bindings = true,
  env = {},
} = {}) {
  const entry = direct ? directFlowPath() : cliPath();
  const args = direct ? [entry, ...argv] : [entry, ...argv];
  const environment = invocationEnvironment({ bindings, workRoot, sourceRoot, env });
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    input,
    env: environment,
  });
  return { ...result, response: invocationResponse(result) };
}

function invokeParserLevel(root, argv, {
  direct = false,
  cwd = root,
  workRoot = root,
  sourceRoot = root,
  bindings = true,
  env = {},
} = {}) {
  const entry = direct ? directFlowPath() : cliPath();
  const parserScript = [
    `process.argv = [process.argv[0], "parser-fixture", ...${JSON.stringify(argv)}];`,
    `await import(${JSON.stringify(entry)});`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", parserScript], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: invocationEnvironment({ bindings, workRoot, sourceRoot, env }),
  });
  return { ...result, response: invocationResponse(result) };
}

function invocationEnvironment({ bindings, workRoot, sourceRoot, env }) {
  const environment = { ...process.env };
  if (bindings) {
    environment.SENNEL_WORK_ROOT = workRoot;
    environment.SENNEL_SOURCE_ROOT = sourceRoot;
  }
  Object.assign(environment, env);
  if (!bindings) {
    delete environment.SENNEL_WORK_ROOT;
    delete environment.SENNEL_SOURCE_ROOT;
  }
  return environment;
}

function invocationResponse(result) {
  let response = null;
  if ((result.stdout || "").trim() !== "") {
    try {
      response = JSON.parse(result.stdout);
    } catch {
      response = null;
    }
  }
  return response;
}

function invokeQuery(root, request, options = {}) {
  const input = options.input !== undefined
    ? options.input
    : request === undefined
      ? undefined
      : `${JSON.stringify(request)}\n`;
  const queryArgs = options.args ?? ["flow", "query"];
  return invoke(root, queryArgs, { ...options, input });
}

function invokeRequestFile(root, request, { direct = false, ...options } = {}) {
  const file = path.join(root, "request.json");
  writeJson(file, request);
  const args = direct ? ["query", "--request-file", file] : ["flow", "query", "--request-file", file];
  return invoke(root, args, { direct, ...options });
}

function invokeRequestFileContent(root, content, { direct = false, ...options } = {}) {
  const file = path.join(root, "request-content.json");
  fs.writeFileSync(file, content, "utf8");
  const args = direct ? ["query", "--request-file", file] : ["flow", "query", "--request-file", file];
  return invoke(root, args, { direct, ...options });
}

function assertSingleJsonStdout(result, label = "query response") {
  const stdout = result.stdout || "";
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, "", `${label} must be present on stdout`);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(trimmed);
  }, `${label} stdout must contain exactly one JSON document`);
  assert.deepEqual(parsed, result.response, `${label} stdout must contain only the response document`);
}

function assertDiagnosticStderr(result, label = "query error") {
  assert.equal(typeof result.stderr, "string");
  assert.equal(result.stderr.trim() !== "", true, `${label} must emit diagnostics on stderr`);
}

function assertCleanQueryOutput(result, label = "successful query") {
  assertSingleJsonStdout(result, label);
  assert.equal(result.stderr, "", `${label} must leave stderr clean`);
}

function assertBoundaryError(result, { code, errorPath } = {}) {
  assert.notEqual(result.status, 0, result.stderr);
  assertSingleJsonStdout(result, "request boundary response");
  assertDiagnosticStderr(result, "request boundary error");
  assert.ok(result.response, `expected one JSON response, got: ${result.stdout}`);
  assert.equal(result.response.schemaRevision, 1);
  assert.equal(result.response.ok, false);
  assert.equal(Object.hasOwn(result.response, "resource"), false);
  assertExactKeys(result.response, ["schemaRevision", "ok", "error"], "request boundary response");
  assertExactKeys(result.response.error, ["code", "path", "message"], "request boundary error");
  if (code !== undefined) assert.equal(result.response.error.code, code);
  if (errorPath !== undefined) assert.equal(result.response.error.path, errorPath);
  assert.equal(typeof result.response.error.message, "string");
}

function assertExactKeys(value, expected, label = "object") {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

function assertUnavailableTimestamp(value, label) {
  assertExactKeys(value, ["value", "availability", "reason", "provenance"], label);
  assert.equal(value.value, null, `${label} must not invent a timestamp`);
  assert.equal(value.availability, "unavailable");
  assert.equal(typeof value.reason, "string");
  assert.equal(value.reason.trim() !== "", true);
  assert.equal(typeof value.provenance, "string");
  assert.equal(value.provenance.trim() !== "", true);
}

function assertAvailableTimestamp(value, expectedValue, label) {
  assertExactKeys(value, ["value", "availability", "reason", "provenance"], label);
  assert.equal(value.value, expectedValue, `${label} must use confirmed Activity timing`);
  assert.equal(value.availability, "available");
  assert.equal(typeof value.provenance, "string");
  assert.equal(value.provenance.trim() !== "", true);
}

function assertKnownError(result, {
  resource,
  code,
  path: errorPath,
  label = "error",
  selectedFlowVersion,
  availableFlowVersions,
}) {
  assert.notEqual(result.status, 0, result.stderr);
  assertSingleJsonStdout(result, `${label} response`);
  assertDiagnosticStderr(result, label);
  assert.ok(result.response, `expected one JSON response, got: ${result.stdout}`);
  assert.equal(result.response.schemaRevision, 1);
  assert.equal(result.response.ok, false);
  assert.equal(result.response.resource, resource);
  assertExactKeys(result.response, resource === "metadata"
    ? [
      "schemaRevision", "ok", "resource", "selectedFlowVersion",
      "availableFlowVersions", "error", "item",
    ]
    : [
      "schemaRevision", "ok", "resource", "selectedFlowVersion",
      "availableFlowVersions", "error", "items", "pageInfo",
    ], `${label} response`);
  assert.equal(result.response.selectedFlowVersion === null || typeof result.response.selectedFlowVersion === "object", true);
  assert.equal(Array.isArray(result.response.availableFlowVersions), true);
  assert.equal(result.response.availableFlowVersions.every((version, index, versions) => (
    Number.isSafeInteger(version) && version > 0 && (index === 0 || versions[index - 1] < version)
  )), true);
  assertExactKeys(result.response.error, ["code", "path", "message"], "error");
  assert.equal(result.response.error.code, code, `${label} code`);
  assert.equal(result.response.error.path, errorPath, `${label} path`);
  assert.equal(typeof result.response.error.message, "string");
  assert.equal(result.response.error.message.includes("flow.json"), false);
  assert.equal(result.response.error.message.includes("artifact-catalog"), false);
  if (selectedFlowVersion !== undefined) {
    assert.deepEqual(result.response.selectedFlowVersion, selectedFlowVersion, `${label} selected Version`);
  }
  if (availableFlowVersions !== undefined) {
    assert.deepEqual(result.response.availableFlowVersions, availableFlowVersions, `${label} available Versions`);
  }
  if (resource === "metadata") {
    assert.equal(result.response.item, null, `${label} must not include a partial metadata item`);
  } else {
    assert.deepEqual(result.response.items, [], `${label} must not include partial Activity items`);
    assertExactKeys(result.response.pageInfo, ["limit", "endCursor", "hasNext"], `${label} pageInfo`);
    assert.equal(result.response.pageInfo.endCursor, null);
    assert.equal(result.response.pageInfo.hasNext, false);
    assert.equal(result.response.pageInfo.limit === null || Number.isInteger(result.response.pageInfo.limit), true);
  }
}

function assertNoInternalNames(value, names, label = "public response") {
  const serialized = JSON.stringify(value);
  for (const name of names.filter((entry) => typeof entry === "string" && entry !== "")) {
    assert.equal(serialized.includes(name), false, `${label} leaked internal name ${name}`);
  }
}

function fixtureInternalNames(fixture) {
  const location = fixture.fixture.location();
  let catalog = { artifacts: [] };
  if (fs.existsSync(location.catalogFile)) {
    try {
      catalog = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
    } catch {
      // A malformed catalog is itself an unreadable fixture; static names still suffice.
    }
  }
  const runtimeNames = [...snapshotTree(fixture.root).keys()]
    .filter((relative) => relative.includes(".runtime"))
    .flatMap((relative) => [relative, path.posix.basename(relative)]);
  return [
    fixture.root,
    location.directory,
    "flow.json",
    "spec.json",
    "activities.jsonl",
    "artifact-catalog.json",
    ".runtime",
    "locks",
    "cache",
    "temporary",
    ...runtimeNames,
    ...(catalog.artifacts ?? []).flatMap((descriptor) => [
      descriptor.logicalKey,
      descriptor.relativePath,
    ]),
  ];
}

function assertPublicKnownError(result, fixture, expected, internalNames = fixtureInternalNames(fixture)) {
  assertKnownError(result, expected);
  assertNoInternalNames(result.response, internalNames);
}

function assertNoInternalFields(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "relativePath",
    "flow.json",
    "activities.jsonl",
    "artifact-catalog.json",
    "rawLog",
    "prompt",
    "checkpoint",
    "transaction",
    "temporary",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `response leaked ${forbidden}`);
  }
}

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function initializeGitRepository(root) {
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "query-fixture@example.com"]);
  runGit(root, ["config", "user.name", "Query Fixture"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "seed query fixture", "--allow-empty"]);
}

function createGitBackedFlowFixture({
  specId,
  prefix,
  targetStep,
  agentResponse = null,
  execution = { mode: "direct", baseBranch: "main", featureBranch: "main" },
} = {}) {
  const root = createRoot(prefix);
  writeQueryConfig(root);
  if (agentResponse !== null) installStubAgent(root, agentResponse);
  const flowManager = makeFlowManager(root);
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId: `run-${specId}`,
    execution,
    specRecord: fixtureSpecRecord(),
  }).create().registerActive();
  initializeGitRepository(root);
  fixture.activate(targetStep);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", `activate ${targetStep} fixture`]);
  return { root, flowManager, fixture, specId };
}

function gitStatusSnapshot(root) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function snapshotTree(root, current = root, snapshot = new Map()) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      snapshot.set(relative, { kind: "directory" });
      snapshotTree(root, absolute, snapshot);
    } else if (entry.isFile()) {
      snapshot.set(relative, { kind: "file", bytes: fs.readFileSync(absolute) });
    } else if (entry.isSymbolicLink()) {
      snapshot.set(relative, { kind: "symlink", target: fs.readlinkSync(absolute) });
    }
  }
  return snapshot;
}

function assertSameTree(actual, expected) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [relative, value] of expected) {
    const actualValue = actual.get(relative);
    assert.equal(actualValue.kind, value.kind, `query changed type of ${relative}`);
    if (value.kind === "file") {
      assert.equal(actualValue.bytes.equals(value.bytes), true, `query changed ${relative}`);
    } else if (value.kind === "symlink") {
      assert.equal(actualValue.target, value.target, `query changed symlink ${relative}`);
    }
  }
}

function snapshotManagedRuntimeState(root) {
  const managedRoots = [".runtime", ".sennel/cache", ".sennel/temporary", ".sennel/tmp", ".tmp"];
  return new Map([...snapshotTree(root)].filter(([relative]) => (
    managedRoots.some((managedRoot) => relative === managedRoot || relative.startsWith(`${managedRoot}/`))
  )));
}

function snapshotQueryProbeState({ sentinel, callProbe, bootstrap, hookMarker }) {
  return {
    bootstrapMarker: fs.existsSync(bootstrap.marker),
    hookMarker: fs.existsSync(hookMarker),
    sentinelViolations: readReaderSentinelEvents(sentinel.log).filter((event) => event.violation === true),
    forbiddenCalls: readQueryCallProbeEvents(callProbe.log).filter((event) => event.kind !== "reader"),
  };
}

function assertPublicActivityString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.equal(value.trim() !== "", true, `${label} must be non-empty`);
}

function assertNullableActivityString(value, label) {
  if (value !== null) assertPublicActivityString(value, label);
}

function assertNonNegativeInteger(value, label) {
  assert.equal(Number.isSafeInteger(value), true, `${label} must be a non-negative integer`);
  assert.equal(value >= 0, true, `${label} must be a non-negative integer`);
}

function assertPositiveActivityInteger(value, label) {
  assert.equal(Number.isSafeInteger(value), true, `${label} must be a positive integer`);
  assert.equal(value > 0, true, `${label} must be a positive integer`);
}

function assertNullableNonNegativeInteger(value, label) {
  if (value !== null) assertNonNegativeInteger(value, label);
}

function assertNullableNonNegativeNumber(value, label) {
  if (value !== null) {
    assert.equal(typeof value, "number", `${label} must be a number or null`);
    assert.equal(Number.isFinite(value), true, `${label} must be finite`);
    assert.equal(value >= 0, true, `${label} must be non-negative`);
  }
}

function assertActivityIso8601(value, label) {
  assertPublicActivityString(value, label);
  assert.equal(Number.isNaN(Date.parse(value)), false, `${label} must be ISO-8601`);
  assert.match(value, /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, `${label} must include timezone`);
}

function assertActivityStringCollection(value, label) {
  assert.equal(Array.isArray(value), true, `${label} must be an array`);
  assert.equal(value.length <= QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS, true, `${label} exceeds its bound`);
  for (const [index, entry] of value.entries()) {
    assertPublicActivityString(entry, `${label}[${index}]`);
  }
  assert.equal(new Set(value).size, value.length, `${label} must be unique`);
}

function assertActivityItem(item) {
  assertExactKeys(item, [
    "activity", "node", "task", "attempt", "sequence", "confirmationOrder",
    "transition", "timing", "usage", "outcome", "failure", "blocker",
    "incomplete", "metric", "note", "evaluationIds", "findingIds",
    "repairIds", "artifactIds",
  ], "ActivityItem");
  assertExactKeys(item.activity, ["id", "type"], "ActivityItem.activity");
  assertPublicActivityString(item.activity.id, "ActivityItem.activity.id");
  assertPublicActivityString(item.activity.type, "ActivityItem.activity.type");
  assertExactKeys(item.node, ["id", "key"], "ActivityItem.node");
  assertPublicActivityString(item.node.id, "ActivityItem.node.id");
  assertPublicActivityString(item.node.key, "ActivityItem.node.key");
  if (item.task !== null) {
    assertExactKeys(item.task, ["id", "key"], "ActivityItem.task");
    assertPublicActivityString(item.task.id, "ActivityItem.task.id");
    assertPublicActivityString(item.task.key, "ActivityItem.task.key");
  }
  if (item.attempt !== null) {
    assertExactKeys(item.attempt, ["id", "sequence"], "ActivityItem.attempt");
    assertPublicActivityString(item.attempt.id, "ActivityItem.attempt.id");
    assertPositiveActivityInteger(item.attempt.sequence, "ActivityItem.attempt.sequence");
  }
  if (item.sequence !== null) assertPositiveActivityInteger(item.sequence, "ActivityItem.sequence");
  assertPositiveActivityInteger(item.confirmationOrder, "ActivityItem.confirmationOrder");
  assertExactKeys(item.transition, ["operation", "status"], "ActivityItem.transition");
  assertPublicActivityString(item.transition.operation, "ActivityItem.transition.operation");
  assertNullableActivityString(item.transition.status, "ActivityItem.transition.status");
  for (const collection of ["evaluationIds", "findingIds", "repairIds", "artifactIds"]) {
    assertActivityStringCollection(item[collection], `ActivityItem.${collection}`);
  }
  if (item.timing !== null) {
    assertExactKeys(item.timing, ["startedAt", "finishedAt", "durationMs"], "Timing");
    assertActivityIso8601(item.timing.startedAt, "Timing.startedAt");
    assertActivityIso8601(item.timing.finishedAt, "Timing.finishedAt");
    assertNullableNonNegativeInteger(item.timing.durationMs, "Timing.durationMs");
    assert.equal(Date.parse(item.timing.finishedAt) >= Date.parse(item.timing.startedAt), true, "Timing must finish after it starts");
  }
  if (item.usage !== null) {
    assertExactKeys(item.usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cost"], "Usage");
    assertNonNegativeInteger(item.usage.inputTokens, "Usage.inputTokens");
    assertNonNegativeInteger(item.usage.outputTokens, "Usage.outputTokens");
    assertNonNegativeInteger(item.usage.cacheReadTokens, "Usage.cacheReadTokens");
    assertNullableNonNegativeNumber(item.usage.cost, "Usage.cost");
  }
  if (item.outcome !== null) {
    assertExactKeys(item.outcome, ["outcome", "summary", "confirmedAt", "artifactRefs"], "Outcome");
    assert.equal(["passed", "failed", "skipped", "incomplete"].includes(item.outcome.outcome), true, "Outcome.outcome enum");
    assertPublicActivityString(item.outcome.summary, "Outcome.summary");
    assertActivityIso8601(item.outcome.confirmedAt, "Outcome.confirmedAt");
    assert.equal(Array.isArray(item.outcome.artifactRefs), true, "Outcome.artifactRefs must be an array");
    assert.equal(item.outcome.artifactRefs.length <= QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS, true, "Outcome.artifactRefs exceeds its bound");
    for (const [index, reference] of item.outcome.artifactRefs.entries()) {
      assertExactKeys(reference, ["kind", "id"], `Outcome.artifactRefs[${index}]`);
      assertPublicActivityString(reference.kind, `Outcome.artifactRefs[${index}].kind`);
      assertPublicActivityString(reference.id, `Outcome.artifactRefs[${index}].id`);
    }
  }
  if (item.failure !== null) {
    assertExactKeys(item.failure, ["category", "code", "message", "retryable", "retryKind"], "Failure");
    assertPublicActivityString(item.failure.category, "Failure.category");
    assertPublicActivityString(item.failure.code, "Failure.code");
    assertPublicActivityString(item.failure.message, "Failure.message");
    assert.equal(typeof item.failure.retryable, "boolean", "Failure.retryable must be boolean");
    assert.equal(item.failure.retryKind === null || ["semantic", "tooling"].includes(item.failure.retryKind), true, "Failure.retryKind enum");
    if (item.failure.retryable) assert.notEqual(item.failure.retryKind, null, "retryable Failure needs retryKind");
  }
  if (item.blocker !== null) {
    assertExactKeys(item.blocker, ["code", "message"], "Blocker");
    assertPublicActivityString(item.blocker.code, "Blocker.code");
    assertPublicActivityString(item.blocker.message, "Blocker.message");
  }
  if (item.incomplete !== null) {
    assertExactKeys(item.incomplete, ["code", "message", "operation", "resources"], "Incomplete");
    assertPublicActivityString(item.incomplete.code, "Incomplete.code");
    assertPublicActivityString(item.incomplete.message, "Incomplete.message");
    assertNullableActivityString(item.incomplete.operation, "Incomplete.operation");
    assertActivityStringCollection(item.incomplete.resources, "Incomplete.resources");
    if (item.incomplete.operation === null) assert.equal(item.incomplete.resources.length, 0, "Incomplete.resources requires operation");
  }
  if (item.metric !== null) {
    assertExactKeys(item.metric, [
      "phase", "counter", "delta", "reset", "kind", "provider", "profileKey",
      "callCount", "responseChars", "durationMs", "model", "tokens", "cost",
      "cachedResponse", "costIncomplete",
    ], "Metric");
    assertPublicActivityString(item.metric.phase, "Metric.phase");
    assertNullableActivityString(item.metric.counter, "Metric.counter");
    assertNullableNonNegativeInteger(item.metric.delta, "Metric.delta");
    assert.equal(typeof item.metric.reset, "boolean", "Metric.reset must be boolean");
    for (const field of ["kind", "provider", "profileKey", "model"]) {
      assertNullableActivityString(item.metric[field], `Metric.${field}`);
    }
    for (const field of ["callCount", "responseChars", "durationMs"]) {
      assertNullableNonNegativeInteger(item.metric[field], `Metric.${field}`);
    }
    if (item.metric.tokens !== null) {
      assertExactKeys(item.metric.tokens, ["input", "output", "cacheRead", "cacheCreation"], "Metric.tokens");
      for (const field of ["input", "output", "cacheRead", "cacheCreation"]) {
        assertNonNegativeInteger(item.metric.tokens[field], `Metric.tokens.${field}`);
      }
    }
    assertNullableNonNegativeNumber(item.metric.cost, "Metric.cost");
    assert.equal(typeof item.metric.cachedResponse, "boolean", "Metric.cachedResponse must be boolean");
    assert.equal(typeof item.metric.costIncomplete, "boolean", "Metric.costIncomplete must be boolean");
    assert.equal(item.metric.counter !== null || item.metric.kind !== null, true, "Metric needs a counter or kind");
    if (item.metric.counter !== null) assert.notEqual(item.metric.delta, null, "Metric counter needs delta");
  }
  assertNullableActivityString(item.note, "ActivityItem.note");
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe("sennel flow query", () => {
  it("R1: accepts exactly one stdin or request-file object through both public entrypoints", () => {
    const fixture = createFixture();
    const request = { resource: "metadata", condition: { specId: fixture.specId } };
    const stdin = invokeQuery(fixture.root, request);
    const requestFile = invokeRequestFile(fixture.root, request);
    const direct = invokeQuery(fixture.root, request, { direct: true, args: ["query"] });

    for (const result of [stdin, requestFile, direct]) {
      assert.equal(result.status, 0, result.stderr);
      assertCleanQueryOutput(result, "successful metadata query");
      assert.equal(result.response.ok, true);
    }
    const competing = invokeQuery(fixture.root, request, {
      args: ["flow", "query", "--request-file", path.join(fixture.root, "request.json")],
    });
    assert.notEqual(competing.status, 0);
    assert.ok(competing.response);

    const probe = createPreBootstrapProbe();
    const callProbe = createQueryCallProbe();
    const probedEnvironment = combineProbeEnvironments(probe, callProbe);
    const sourceRoot = createRoot("sennel-flow-query-source-");
    writeQueryConfig(fixture.root);
    installLifecycleHookProbe(fixture.root, path.join(probe.root, "hook-invoked.log"));
    const entrypoints = [
      { direct: false, args: ["flow", "query"] },
      { direct: true, args: ["query"] },
    ];
    const invokeProbed = (entrypoint, input) => invoke(fixture.root, entrypoint.args, {
      direct: entrypoint.direct,
      input,
      cwd: probe.root,
      workRoot: fixture.root,
      sourceRoot,
      env: probedEnvironment,
    });

    const validJson = JSON.stringify(request);
    const boundaryCases = [
      { label: "absent input", input: undefined, code: "INVALID_REQUEST", errorPath: "/request" },
      { label: "scalar JSON", input: "null\n", code: "INVALID_REQUEST", errorPath: "/request" },
      { label: "array JSON", input: "[]\n", code: "INVALID_REQUEST", errorPath: "/request" },
      { label: "trailing value", input: `${validJson} trailing\n`, code: "INVALID_JSON", errorPath: "/request" },
      { label: "multiple values", input: `${validJson}\n${validJson}\n`, code: "INVALID_JSON", errorPath: "/request" },
      {
        label: "request byte-limit overflow",
        input: `${validJson}${" ".repeat(QUERY_LIMITS.MAX_REQUEST_BYTES)}\n`,
        code: "INVALID_REQUEST",
        errorPath: "/request",
      },
    ];
    const beforeBoundary = snapshotTree(fixture.root);
    for (const entrypoint of entrypoints) {
      for (const boundaryCase of boundaryCases) {
        const result = invokeProbed(entrypoint, boundaryCase.input);
        assertBoundaryError(result, {
          code: boundaryCase.code,
          errorPath: boundaryCase.errorPath,
        });
        assertSameTree(snapshotTree(fixture.root), beforeBoundary);
        assert.equal(fs.existsSync(probe.marker), false, `${boundaryCase.label} bootstrapped worktree lookup`);
        assert.equal(fs.existsSync(path.join(probe.root, "hook-invoked.log")), false, `${boundaryCase.label} ran a lifecycle hook`);
      }
    }

    const requestFileContentCases = [
      { label: "scalar JSON", input: "null\n", code: "INVALID_REQUEST", errorPath: "/request" },
      { label: "array JSON", input: "[]\n", code: "INVALID_REQUEST", errorPath: "/request" },
      { label: "trailing value", input: `${validJson} trailing\n`, code: "INVALID_JSON", errorPath: "/request" },
      { label: "multiple values", input: `${validJson}\n${validJson}\n`, code: "INVALID_JSON", errorPath: "/request" },
      {
        label: "request byte-limit overflow",
        input: `${validJson}${" ".repeat(QUERY_LIMITS.MAX_REQUEST_BYTES)}\n`,
        code: "INVALID_REQUEST",
        errorPath: "/request",
      },
      {
        label: "unknown top-level field",
        input: `${JSON.stringify({ ...request, unsupported: true })}\n`,
        code: "INVALID_REQUEST",
        errorPath: "/field",
      },
      {
        label: "unknown condition field",
        input: `${JSON.stringify({ ...request, condition: { ...request.condition, unsupported: true } })}\n`,
        code: "INVALID_REQUEST",
        errorPath: "/condition/field",
      },
      {
        label: "resource-incompatible field",
        input: `${JSON.stringify({ ...request, page: { limit: 1, after: null } })}\n`,
        code: "INVALID_REQUEST",
        errorPath: "/page",
      },
    ];
    for (const entrypoint of entrypoints) {
      for (const boundaryCase of requestFileContentCases) {
        const stdin = invoke(fixture.root, entrypoint.args, {
          direct: entrypoint.direct,
          input: boundaryCase.input,
        });
        const requestFile = invokeRequestFileContent(fixture.root, boundaryCase.input, {
          direct: entrypoint.direct,
        });
        assert.equal(stdin.status, requestFile.status, `${boundaryCase.label} exit status differs by input source`);
        assert.deepEqual(requestFile.response, stdin.response, `${boundaryCase.label} response differs by input source`);
        if (boundaryCase.errorPath === "/request") {
          assertBoundaryError(requestFile, boundaryCase);
        } else {
          assert.equal(requestFile.status !== 0, true, `${boundaryCase.label} must fail`);
          assert.ok(requestFile.response, `${boundaryCase.label} must return a JSON response`);
          assert.equal(requestFile.response.ok, false);
          assert.equal(requestFile.response.error.code, boundaryCase.code);
          assert.equal(requestFile.response.error.path, boundaryCase.errorPath);
        }
      }
    }

    const probedRequestFile = path.join(fixture.root, "probed-request.json");
    writeJson(probedRequestFile, request);
    const requestDirectory = path.join(fixture.root, "request-directory");
    fs.mkdirSync(requestDirectory, { recursive: true });
    const missingRequestFile = path.join(fixture.root, "missing-request.json");
    const beforePathFailures = snapshotTree(fixture.root);
    for (const entrypoint of entrypoints) {
      for (const requestFilePath of [missingRequestFile, requestDirectory, ""]) {
        const args = entrypoint.direct
          ? ["query", "--request-file", requestFilePath]
          : ["flow", "query", "--request-file", requestFilePath];
        const result = invoke(fixture.root, args, {
          direct: entrypoint.direct,
          cwd: probe.root,
          workRoot: fixture.root,
          sourceRoot,
          env: probedEnvironment,
        });
        assertBoundaryError(result);
        assertSameTree(snapshotTree(fixture.root), beforePathFailures);
        assert.equal(fs.existsSync(probe.marker), false, "invalid request-file path bootstrapped worktree lookup");
        assert.equal(fs.existsSync(path.join(probe.root, "hook-invoked.log")), false, "invalid request-file path ran a lifecycle hook");
      }
    }

    const beforeDuplicateRequestFile = snapshotTree(fixture.root);
    for (const entrypoint of entrypoints) {
      const args = entrypoint.direct
        ? ["query", "--request-file", probedRequestFile, "--request-file", probedRequestFile]
        : ["flow", "query", "--request-file", probedRequestFile, "--request-file", probedRequestFile];
      const result = invoke(fixture.root, args, {
        direct: entrypoint.direct,
        cwd: probe.root,
        workRoot: fixture.root,
        sourceRoot,
        env: probedEnvironment,
      });
      assertBoundaryError(result);
      assertSameTree(snapshotTree(fixture.root), beforeDuplicateRequestFile);
      assert.equal(fs.existsSync(probe.marker), false, "duplicate request-file option bootstrapped worktree lookup");
      assert.equal(fs.existsSync(path.join(probe.root, "hook-invoked.log")), false, "duplicate request-file option ran a lifecycle hook");
    }

    const nulRequestFilePath = `${probedRequestFile}\u0000request.json`;
    for (const entrypoint of entrypoints) {
      const args = entrypoint.direct
        ? ["query", "--request-file", nulRequestFilePath]
        : ["flow", "query", "--request-file", nulRequestFilePath];
      const result = invokeParserLevel(fixture.root, args, {
        direct: entrypoint.direct,
        cwd: probe.root,
        workRoot: fixture.root,
        sourceRoot,
        env: probedEnvironment,
      });
      assertBoundaryError(result, { code: "INVALID_REQUEST", errorPath: "/request" });
      assertSameTree(snapshotTree(fixture.root), beforePathFailures);
      assert.equal(fs.existsSync(probe.marker), false, "NUL request-file path bootstrapped worktree lookup");
      assert.equal(fs.existsSync(path.join(probe.root, "hook-invoked.log")), false, "NUL request-file path ran a lifecycle hook");
    }

    const unreadableRequestFile = path.join(fixture.root, "unreadable-request.json");
    writeJson(unreadableRequestFile, request);
    const beforeUnreadableRequestFile = snapshotTree(fixture.root);
    const originalUnreadableMode = fs.statSync(unreadableRequestFile).mode & 0o7777;
    fs.chmodSync(unreadableRequestFile, 0o000);
    try {
      for (const entrypoint of entrypoints) {
        const args = entrypoint.direct
          ? ["query", "--request-file", unreadableRequestFile]
          : ["flow", "query", "--request-file", unreadableRequestFile];
        const result = invoke(fixture.root, args, {
          direct: entrypoint.direct,
          cwd: probe.root,
          workRoot: fixture.root,
          sourceRoot,
          env: probedEnvironment,
        });
        assertBoundaryError(result, { code: "INVALID_REQUEST", errorPath: "/request" });
        assert.equal(fs.existsSync(probe.marker), false, "unreadable request-file path bootstrapped worktree lookup");
        assert.equal(fs.existsSync(path.join(probe.root, "hook-invoked.log")), false, "unreadable request-file path ran a lifecycle hook");
      }
    } finally {
      fs.chmodSync(unreadableRequestFile, originalUnreadableMode);
    }
    assertSameTree(snapshotTree(fixture.root), beforeUnreadableRequestFile);

    const beforeSuccess = snapshotTree(fixture.root);
    for (const entrypoint of entrypoints) {
      const result = invokeProbed(entrypoint, `${validJson}\n`);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.response, `success stdout must be one JSON value: ${result.stdout}`);
      assert.equal(result.response.ok, true);
      assert.equal(result.response.resource, "metadata");
      assert.equal(result.response.item.identity.specId, fixture.specId);
      assert.equal(Object.hasOwn(result.response, "type"), false);
      assert.equal(Object.hasOwn(result.response, "key"), false);
      assertSameTree(snapshotTree(fixture.root), beforeSuccess);
      assert.equal(fs.existsSync(probe.marker), false, "success bootstrapped worktree lookup");
      assert.equal(fs.existsSync(path.join(probe.root, "hook-invoked.log")), false, "success ran a lifecycle hook");
    }

    const beforeRequestFileSuccess = snapshotTree(fixture.root);
    for (const entrypoint of entrypoints) {
      const args = entrypoint.direct
        ? ["query", "--request-file", probedRequestFile]
        : ["flow", "query", "--request-file", probedRequestFile];
      const result = invoke(fixture.root, args, {
        direct: entrypoint.direct,
        cwd: probe.root,
        workRoot: fixture.root,
        sourceRoot,
        env: probedEnvironment,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.response.ok, true);
      assert.equal(result.response.item.identity.specId, fixture.specId);
      assertSameTree(snapshotTree(fixture.root), beforeRequestFileSuccess);
      assert.equal(fs.existsSync(probe.marker), false, "request-file success bootstrapped worktree lookup");
      assert.equal(fs.existsSync(path.join(probe.root, "hook-invoked.log")), false, "request-file success ran a lifecycle hook");
    }

    const normalizedRelativeRequestFilePath = path.normalize(path.relative(fixture.root, probedRequestFile));
    assert.equal(path.isAbsolute(normalizedRelativeRequestFilePath), false);
    const beforeRelativeRequestFileSuccess = snapshotTree(fixture.root);
    for (const entrypoint of entrypoints) {
      const args = entrypoint.direct
        ? ["query", "--request-file", normalizedRelativeRequestFilePath]
        : ["flow", "query", "--request-file", normalizedRelativeRequestFilePath];
      const result = invoke(fixture.root, args, {
        direct: entrypoint.direct,
        cwd: fixture.root,
        workRoot: fixture.root,
        sourceRoot,
        env: probedEnvironment,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.response, `relative request-file stdout must be one JSON value: ${result.stdout}`);
      assert.equal(result.response.ok, true);
      assert.equal(result.response.item.identity.specId, fixture.specId);
      assertSameTree(snapshotTree(fixture.root), beforeRelativeRequestFileSuccess);
      assert.equal(fs.existsSync(probe.marker), false, "relative request-file success bootstrapped worktree lookup");
      assert.equal(fs.existsSync(path.join(probe.root, "hook-invoked.log")), false, "relative request-file success ran a lifecycle hook");
    }

    const beforeUnboundSuccess = snapshotTree(fixture.root);
    for (const entrypoint of entrypoints) {
      const result = invoke(fixture.root, entrypoint.args, {
        direct: entrypoint.direct,
        cwd: fixture.root,
        bindings: false,
        env: probedEnvironment,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.response, `unbound success stdout must be one JSON value: ${result.stdout}`);
      assert.equal(result.response.ok, true);
      assert.equal(result.response.item.identity.specId, fixture.specId);
      assertSameTree(snapshotTree(fixture.root), beforeUnboundSuccess);
      assert.equal(fs.existsSync(probe.marker), false, "unbound query bootstrapped worktree lookup");
      assert.equal(fs.existsSync(path.join(probe.root, "hook-invoked.log")), false, "unbound query ran a lifecycle hook");
    }
    assertNoQueryCallProbeEvents(callProbe.log, "R1 query boundary");
  });

  it("R2: validates the plain request object, identifier, and optional Version selector", () => {
    const fixture = createFixture();
    const validCondition = { specId: fixture.specId };

    const invalidTopLevel = [null, "request", 1, true, []];
    for (const request of invalidTopLevel) {
      const result = invokeQuery(fixture.root, request);
      assertBoundaryError(result, { code: "INVALID_REQUEST", errorPath: "/request" });
    }

    const invalidResource = [
      { condition: validCondition },
      { resource: null, condition: validCondition },
      { resource: "", condition: validCondition },
      { resource: " ", condition: validCondition },
      { resource: "Metadata", condition: validCondition },
      { resource: "unknown", condition: validCondition },
      { resource: 1, condition: validCondition },
      { resource: true, condition: validCondition },
      { resource: [], condition: validCondition },
      { resource: {}, condition: validCondition },
    ];
    for (const request of invalidResource) {
      const result = invokeQuery(fixture.root, request);
      assertBoundaryError(result, { code: "INVALID_REQUEST", errorPath: "/resource" });
    }

    const invalidCondition = [
      { resource: "metadata" },
      { resource: "metadata", condition: null },
      { resource: "metadata", condition: [] },
      { resource: "metadata", condition: "condition" },
      { resource: "metadata", condition: 1 },
      { resource: "metadata", condition: true },
    ];
    for (const request of invalidCondition) {
      const result = invokeQuery(fixture.root, request);
      assertKnownError(result, { resource: "metadata", code: "INVALID_REQUEST", path: "/condition" });
    }

    const invalidSpecId = [
      {},
      { specId: null },
      { specId: 1 },
      { specId: true },
      { specId: [] },
      { specId: {} },
      { specId: "" },
      { specId: "   " },
      { specId: "\t\n" },
      { specId: "bad id" },
      { specId: "bad/id" },
      { specId: "bad@id" },
      { specId: "-bad" },
    ];
    for (const condition of invalidSpecId) {
      const result = invokeQuery(fixture.root, { resource: "metadata", condition });
      assertKnownError(result, { resource: "metadata", code: "INVALID_REQUEST", path: "/condition/specId" });
    }

    const invalidFlowVersion = [
      null,
      0,
      -1,
      -Number.MAX_SAFE_INTEGER,
      1.5,
      Number.MIN_VALUE,
      "1",
      true,
      [],
      {},
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_VALUE,
    ];
    for (const flowVersion of invalidFlowVersion) {
      const result = invokeQuery(fixture.root, {
        resource: "metadata",
        condition: { specId: fixture.specId, flowVersion },
      });
      assertKnownError(result, {
        resource: "metadata",
        code: "INVALID_REQUEST",
        path: "/condition/flowVersion",
      });
    }

    const safeUpperBound = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId, flowVersion: Number.MAX_SAFE_INTEGER },
    });
    assertKnownError(safeUpperBound, {
      resource: "metadata",
      code: "FLOW_VERSION_NOT_FOUND",
      path: "/condition/flowVersion",
    });

    const unknownConditionField = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId, extra: true },
    });
    assertKnownError(unknownConditionField, {
      resource: "metadata",
      code: "INVALID_REQUEST",
      path: "/condition/field",
    });

    const incompatibleField = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: validCondition,
      page: { limit: 1 },
    });
    assertKnownError(incompatibleField, { resource: "metadata", code: "INVALID_REQUEST", path: "/page" });
  });

  it("R3: discovers unique Versions and selects an explicit Version without fallback", () => {
    const fixture = createFixture();
    addVersionTwo(fixture);
    const unrelatedSpecId = `${fixture.specId}-unrelated`;
    new CanonicalFlowFixture({
      flowManager: fixture.flowManager,
      specId: unrelatedSpecId,
      runId: `run-${unrelatedSpecId}`,
      specRecord: fixtureSpecRecord(),
    }).create().registerActive();
    const selected = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId, flowVersion: 2 },
    });
    assert.equal(selected.status, 0, selected.stderr);
    assert.deepEqual(selected.response.selectedFlowVersion, { specId: fixture.specId, flowVersion: 2 });
    assert.deepEqual(selected.response.availableFlowVersions, [1, 2]);

    const unrelated = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: unrelatedSpecId },
    });
    assert.equal(unrelated.status, 0, unrelated.stderr);
    assert.deepEqual(unrelated.response.selectedFlowVersion, { specId: unrelatedSpecId, flowVersion: 1 });
    assert.deepEqual(unrelated.response.availableFlowVersions, [1]);

    const missing = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId, flowVersion: 9 },
    });
    assertKnownError(missing, {
      resource: "metadata",
      code: "FLOW_VERSION_NOT_FOUND",
      path: "/condition/flowVersion",
    });
    assert.equal(missing.response.selectedFlowVersion, null);
    assert.deepEqual(missing.response.availableFlowVersions, [1, 2]);
  });

  it("R15: validates direct Version 1 records through the shared reader", () => {
    const inconsistentCases = [
      {
        name: "state-spec-identity",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          state.specId = "other-spec";
          writeJson(file, state);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "state-structural-revision",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          state.schemaRevision = 999;
          writeJson(file, state);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "state-result-revision",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          state.version = 2;
          writeJson(file, state);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "spec-record-format",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "spec.json");
          writeJson(file, []);
          refreshVersionCatalog(versionDirectory, ["spec.json"]);
        },
      },
      {
        name: "ledger-record-format",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "activities.jsonl");
          const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
          const activity = JSON.parse(lines[0]);
          activity.type = "unsupported_activity_revision";
          lines[0] = JSON.stringify(activity);
          fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
          refreshVersionCatalog(versionDirectory, ["activities.jsonl"]);
        },
      },
      {
        name: "non-contiguous-ledger",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "activities.jsonl");
          const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
          assert.ok(lines.length >= 2, "Version 1 fixture requires a second Activity for ledger continuity corruption");
          const activity = JSON.parse(lines[1]);
          activity.confirmationOrder += 1;
          lines[1] = JSON.stringify(activity);
          fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
          refreshVersionCatalog(versionDirectory, ["activities.jsonl"]);
        },
      },
      {
        name: "catalog-schema-revision",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "artifact-catalog.json");
          const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
          catalog.schemaRevision = 1;
          writeJson(file, catalog);
          refreshVersionCatalog(versionDirectory);
        },
      },
    ];

    for (const entry of inconsistentCases) {
      const fixture = mutateVersionOneFixture(entry.mutate, {
        prefix: `sennel-flow-query-v1-${entry.name}-`,
      });
      for (const resource of ["metadata", "activities"]) {
        const result = invokeQuery(fixture.root, {
          resource,
          condition: { specId: fixture.specId, flowVersion: 1 },
        });
        assertVersionIntegrityError(result, { resource });
      }
    }
  });

  it("R3: rejects duplicate, over-limit, and independently corrupted canonical Version records without fallback", () => {
    const inconsistentCases = [
      {
        name: "state-envelope-revision",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.recordRevision = 2;
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "state-envelope-spec-identity",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.specId = "other-spec";
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "state-envelope-version-identity",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.flowVersion = 1;
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "state-inner-spec-identity",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.state.specId = "other-spec";
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "state-inner-version-identity",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.state.flowVersion = 1;
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "state-inner-version-missing",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          delete envelope.state.flowVersion;
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "state-structural-revision",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.state.schemaRevision = 999;
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "state-result-revision",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.state.version = 2;
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "spec-envelope-revision",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "spec.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.recordRevision = 2;
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["spec.json"]);
        },
      },
      {
        name: "spec-envelope-identity",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "spec.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.specId = "other-spec";
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["spec.json"]);
        },
      },
      {
        name: "spec-record-format",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "spec.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.content = [];
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["spec.json"]);
        },
      },
      {
        name: "malformed-state-envelope",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          writeJson(file, []);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "non-contiguous-ledger",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "activities.jsonl");
          const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
          assert.ok(lines.length >= 2, "fixture requires a second Activity for ledger continuity corruption");
          const activity = JSON.parse(lines[1]);
          activity.confirmationOrder += 1;
          lines[1] = JSON.stringify(activity);
          fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
          refreshVersionCatalog(versionDirectory, ["activities.jsonl"]);
        },
      },
      {
        name: "ledger-record-format",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "activities.jsonl");
          const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
          const activity = JSON.parse(lines[0]);
          activity.type = "unsupported_activity_revision";
          lines[0] = JSON.stringify(activity);
          fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
          refreshVersionCatalog(versionDirectory, ["activities.jsonl"]);
        },
      },
      {
        name: "catalog-schema-revision",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "artifact-catalog.json");
          const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
          catalog.schemaRevision = 1;
          writeJson(file, catalog);
          refreshVersionCatalog(versionDirectory);
        },
      },
      {
        name: "catalog-descriptor-identity",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "artifact-catalog.json");
          const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
          const descriptor = catalog.artifacts.find((entry) => entry.relativePath === "flow.json");
          assert.ok(descriptor, "fixture requires the canonical state descriptor");
          descriptor.logicalKey = "flow.activities";
          writeJson(file, catalog);
          refreshVersionCatalog(versionDirectory);
        },
      },
      {
        name: "catalog-digest",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "artifact-catalog.json");
          const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
          catalog.hash = "0".repeat(64);
          writeJson(file, catalog);
        },
      },
      {
        name: "catalog-activity-relation",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "artifact-catalog.json");
          const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
          const descriptor = catalog.artifacts.find((entry) => entry.activityId !== null);
          assert.ok(descriptor, "fixture requires an Activity-associated artifact");
          descriptor.activityId = "missing-activity";
          writeJson(file, catalog);
          refreshVersionCatalog(versionDirectory);
        },
      },
    ];

    for (const entry of inconsistentCases) {
      const fixture = mutateVersionTwoFixture(entry.mutate, {
        prefix: `sennel-flow-query-${entry.name}-`,
      });
      const result = invokeQuery(fixture.root, versionTwoRequest(fixture));
      assertVersionIntegrityError(result);
    }

    const malformedLedger = mutateVersionTwoFixture(({ versionDirectory }) => {
      const file = path.join(versionDirectory, "activities.jsonl");
      const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
      lines[0] = "{";
      fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
      refreshVersionCatalog(versionDirectory, ["activities.jsonl"]);
    }, { prefix: "sennel-flow-query-malformed-ledger-" });
    const unreadable = invokeQuery(malformedLedger.root, versionTwoRequest(malformedLedger));
    assertVersionUnreadableError(unreadable);

    const duplicate = createFixture({ prefix: "sennel-flow-query-duplicate-version-" });
    const duplicateVersion = addVersionTwo(duplicate);
    copyVersionFiles(
      duplicateVersion,
      path.join(duplicate.root, "specs", duplicate.specId, "0002"),
    );
    const duplicateResult = invokeQuery(duplicate.root, versionTwoRequest(duplicate));
    assertVersionIntegrityError(duplicateResult);

    const overflow = createFixture({ prefix: "sennel-flow-query-version-overflow-" });
    const versionTwo = addVersionTwo(overflow);
    const versionRoot = path.join(overflow.root, "specs", overflow.specId);
    for (let version = 3; version <= QUERY_LIMITS.MAX_AVAILABLE_FLOW_VERSIONS + 1; version += 1) {
      addValidVersionedDirectory({
        source: versionTwo,
        target: path.join(versionRoot, String(version).padStart(3, "0")),
        specId: overflow.specId,
        flowVersion: version,
      });
    }
    const overflowResult = invokeQuery(overflow.root, versionTwoRequest(overflow));
    assertVersionIntegrityError(overflowResult);
  });

  it("R4: returns the exact metadata success envelope with one item", () => {
    const fixture = createFixture();
    const result = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId },
    });
    assert.equal(result.status, 0, result.stderr);
    assertExactKeys(result.response, [
      "schemaRevision", "ok", "resource", "selectedFlowVersion",
      "availableFlowVersions", "item",
    ], "metadata response");
    assert.equal(result.response.schemaRevision, 1);
    assert.equal(result.response.ok, true);
    assert.equal(result.response.resource, "metadata");
    assert.deepEqual(result.response.selectedFlowVersion, { specId: fixture.specId, flowVersion: 1 });
    assert.deepEqual(result.response.availableFlowVersions, [1]);
    assert.ok(result.response.item);
    assert.equal(Object.hasOwn(result.response, "items"), false);

    const oversizedFixture = createOversizedMetadataFixture();
    const before = snapshotTree(oversizedFixture.root);
    const oversized = invokeQuery(oversizedFixture.root, {
      resource: "metadata",
      condition: { specId: oversizedFixture.specId },
    });
    assertKnownError(oversized, {
      resource: "metadata",
      code: "CANONICAL_RECORD_INCONSISTENT",
      path: "/canonical",
    });
    assert.deepEqual(oversized.response.selectedFlowVersion, {
      specId: oversizedFixture.specId,
      flowVersion: 1,
    });
    assert.deepEqual(oversized.response.availableFlowVersions, [1]);
    assert.equal(oversized.response.item, null);
    assert.equal(Object.hasOwn(oversized.response, "items"), false);
    assertSameTree(snapshotTree(oversizedFixture.root), before);
  });

  it("R5: projects metadata through the public whitelist and derives lifecycle and capabilities", () => {
    const fixture = createFixture();
    const result = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId },
    });
    assert.equal(result.status, 0, result.stderr);
    const item = result.response.item;
    assertExactKeys(item, [
      "identity", "lifecycle", "location", "structure", "relationships",
      "timestamps", "capabilities", "artifacts", "metrics",
    ], "MetadataItem");
    assertExactKeys(item.identity, ["flowId", "flowVersionId", "runId", "specId", "flowVersion"], "identity");
    assert.equal(item.identity.specId, fixture.specId);
    assert.equal(item.identity.flowVersion, 1);
    assertExactKeys(item.lifecycle, ["lifecycle", "blocked", "blocker", "nextAction"], "lifecycle");
    assert.equal(["active", "parked", "finalized"].includes(item.lifecycle.lifecycle), true);
    assert.equal(item.lifecycle.blocked, false);
    assert.equal(item.lifecycle.blocker, null);
    assertExactKeys(item.location, ["phase", "stepId", "taskId", "git"], "location");
    assertExactKeys(item.location.git, ["available", "commit"], "location.git");
    assert.deepEqual(item.location.git, { available: false, commit: null });
    assertExactKeys(item.structure, ["phaseId", "stepIds", "taskIds"], "structure");
    assertExactKeys(item.relationships, ["stepTasks", "taskNodes", "issues"], "relationships");
    assert.deepEqual(item.relationships.issues, []);
    assert.deepEqual(item.capabilities, { "query.metadata": true, "query.activities": true });
    for (const descriptor of item.artifacts) {
      assertExactKeys(descriptor, ["artifactId", "metadata", "activityIds", "nodeIds", "taskIds"], "ArtifactDescriptor");
      assertExactKeys(descriptor.metadata, ["logicalKey", "schemaRevision", "mediaType"], "ArtifactDescriptor.metadata");
    }
    assertExactKeys(item.metrics, [
      "activityCount", "artifactCount", "stepCount", "taskCount", "durationMs",
      "inputTokens", "outputTokens", "cacheReadTokens", "cost", "provenance",
    ], "AggregateMetrics");
    assertNoInternalFields(item);

    const issueFixture = createFixture({
      issue: 517,
      prefix: "sennel-flow-query-issue-relationship-",
    });
    const issueResult = invokeQuery(issueFixture.root, {
      resource: "metadata",
      condition: { specId: issueFixture.specId },
    });
    assert.equal(issueResult.status, 0, issueResult.stderr);
    assert.deepEqual(issueResult.response.item.relationships.issues, [
      { number: 517, relationship: "tracks" },
    ]);

    const gitFixture = createFixture({ prefix: "sennel-flow-query-git-snapshot-" });
    const canonicalCommit = "a".repeat(64);
    persistCanonicalState(gitFixture, (state) => {
      state.context = {
        operation: "fixture",
        resumeToken: "fixture-git-snapshot",
        gitSnapshot: { available: true, commit: canonicalCommit },
      };
    });
    const gitResult = invokeQuery(gitFixture.root, {
      resource: "metadata",
      condition: { specId: gitFixture.specId },
    });
    assert.equal(gitResult.status, 0, gitResult.stderr);
    assert.deepEqual(gitResult.response.item.location.git, {
      available: true,
      commit: canonicalCommit,
    });

    const capabilityFixture = createFixture({
      prefix: "sennel-flow-query-capabilities-canonical-only-",
      specRecord: fixtureSpecRecord({ capabilities: null }),
    });
    const capabilityResult = invokeQuery(capabilityFixture.root, {
      resource: "metadata",
      condition: { specId: capabilityFixture.specId },
    });
    assert.equal(capabilityResult.status, 0, capabilityResult.stderr);
    assert.deepEqual(capabilityResult.response.item.capabilities, {});

    const failureFallback = createFixture({ prefix: "sennel-flow-query-failure-blocker-" });
    failureFallback.fixture.settleBefore("impl-gate").activate("impl-gate");
    failureFallback.flowManager.failCurrentAttempt({
      specId: failureFallback.specId,
      failure: {
        category: "semantic",
        code: "FAILURE_BLOCKER",
        message: "The failure is the blocker fallback.",
        retryable: false,
        retryKind: null,
      },
      result: {
        outcome: "failed",
        summary: "The failure is the blocker fallback.",
        confirmedAt: FIXED_TIME,
        artifactRefs: [],
      },
    });
    const failureFallbackResult = invokeQuery(failureFallback.root, {
      resource: "metadata",
      condition: { specId: failureFallback.specId },
    });
    assert.equal(failureFallbackResult.status, 0, failureFallbackResult.stderr);
    assert.equal(failureFallbackResult.response.item.lifecycle.nextAction.operation, "blocked");
    assert.deepEqual(failureFallbackResult.response.item.lifecycle.blocker, {
      code: "FAILURE_BLOCKER",
      message: "The failure is the blocker fallback.",
    });

    const persistedBlocker = createFixture({ prefix: "sennel-flow-query-persisted-blocker-" });
    persistedBlocker.fixture.settleBefore("impl-gate").activate("impl-gate");
    persistBlockedAttempt(persistedBlocker, {
      blocker: {
        code: "PERSISTED_BLOCKER",
        message: "The persisted blocker has precedence.",
      },
      failure: {
        category: "semantic",
        code: "LOWER_PRIORITY_FAILURE",
        message: "The lower-priority failure must not win.",
        retryable: false,
        retryKind: null,
      },
    });
    const persistedBlockerResult = invokeQuery(persistedBlocker.root, {
      resource: "metadata",
      condition: { specId: persistedBlocker.specId },
    });
    assert.equal(persistedBlockerResult.status, 0, persistedBlockerResult.stderr);
    assert.equal(persistedBlockerResult.response.item.lifecycle.nextAction.operation, "blocked");
    assert.deepEqual(persistedBlockerResult.response.item.lifecycle.blocker, {
      code: "PERSISTED_BLOCKER",
      message: "The persisted blocker has precedence.",
    });

    const dispositionReasonFallback = createFixture({ prefix: "sennel-flow-query-disposition-reason-fallback-" });
    dispositionReasonFallback.fixture.settleBefore("impl-gate").activate("impl-gate");
    persistCanonicalState(dispositionReasonFallback, (state) => {
      state.attempt.failure = {
        category: "semantic",
        code: "",
        message: "",
        retryable: false,
        retryKind: null,
      };
      state.attempt.blocker = null;
    });
    const dispositionReasonFallbackResult = invokeQuery(dispositionReasonFallback.root, {
      resource: "metadata",
      condition: { specId: dispositionReasonFallback.specId },
    });
    assert.equal(dispositionReasonFallbackResult.status, 0, dispositionReasonFallbackResult.stderr);
    assert.equal(dispositionReasonFallbackResult.response.item.lifecycle.nextAction.operation, "blocked");
    assert.deepEqual(dispositionReasonFallbackResult.response.item.lifecycle.blocker, {
      code: "FLOW_BLOCKED",
      message: "the definition blocks after this terminal failure",
    });

    const missingBlockedSources = createFixture({ prefix: "sennel-flow-query-missing-blocked-sources-" });
    missingBlockedSources.fixture.settleBefore("impl-gate").activate("impl-gate");
    persistBlockedAttempt(missingBlockedSources.fixture, {
      blocker: null,
      failure: {
        category: "semantic",
        code: "",
        message: "",
        retryable: false,
        retryKind: null,
      },
    });
    const missingBlockedSourcesResult = invokeQuery(missingBlockedSources.root, {
      resource: "metadata",
      condition: { specId: missingBlockedSources.specId },
    });
    assertKnownError(missingBlockedSourcesResult, {
      resource: "metadata",
      code: "CANONICAL_RECORD_INCONSISTENT",
      path: "/canonical",
    });
    assert.equal(missingBlockedSourcesResult.response.item, null);

    const gitWithoutSnapshot = createFixture({ prefix: "sennel-flow-query-git-without-snapshot-" });
    initializeGitRepository(gitWithoutSnapshot.root);
    const gitWithoutSnapshotResult = invokeQuery(gitWithoutSnapshot.root, {
      resource: "metadata",
      condition: { specId: gitWithoutSnapshot.specId },
    });
    assert.equal(gitWithoutSnapshotResult.status, 0, gitWithoutSnapshotResult.stderr);
    assert.deepEqual(gitWithoutSnapshotResult.response.item.location.git, {
      available: false,
      commit: null,
    });
  });

  it("R6: sources Timestamp availability only from confirmed state-changing Activity timing", () => {
    const fixture = createFixture();
    settleAndFinalize(fixture);
    const activities = fixture.flowManager.activityLedger(fixture.specId);
    const stateChanging = new Set(TIMESTAMP_STATE_CHANGING_OPERATIONS);
    const created = activities.find((activity) => activity.transition.operation === "create_flow");
    const finalized = [...activities].reverse().find((activity) => activity.transition.operation === "finalize_flow");
    const updated = [...activities].filter((activity) => stateChanging.has(activity.transition.operation)).at(-1);
    const result = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId },
    });
    assert.equal(result.status, 0, result.stderr);
    const timestamps = result.response.item.timestamps;
    for (const [name, timestamp, expectedValue] of [
      ["createdAt", timestamps.createdAt, created.timing.finishedAt],
      ["updatedAt", timestamps.updatedAt, updated.timing.finishedAt],
      ["finalizedAt", timestamps.finalizedAt, finalized.timing.finishedAt],
    ]) {
      assert.equal(timestamp.value, expectedValue, `${name} must use confirmed Activity timing`);
      assert.equal(timestamp.availability, "available", `${name} must be available when evidence exists`);
      assert.equal(typeof timestamp.provenance, "string", `${name} provenance must be a string`);
      assert.equal(timestamp.provenance.trim() !== "", true, `${name} provenance must be non-empty`);
    }
    for (const timestamp of [timestamps.createdAt, timestamps.updatedAt, timestamps.finalizedAt]) {
      assertExactKeys(timestamp, ["value", "availability", "reason", "provenance"], "Timestamp");
    }

    for (const [index, operation] of TIMESTAMP_STATE_CHANGING_OPERATIONS.entries()) {
      const operationFixture = createTimestampOperationFixture(operation, index);
      const operationActivities = readActivityEntries(operationFixture.fixture);
      assert.equal(
        operationActivities.some((entry) => entry.transition.operation === operation),
        true,
        `${operation} must be present in its canonical ledger fixture`,
      );
      const operationResult = invokeQuery(operationFixture.root, {
        resource: "metadata",
        condition: { specId: operationFixture.specId },
      });
      assert.equal(operationResult.status, 0, operationResult.stderr);
      assertAvailableTimestamp(
        operationResult.response.item.timestamps.updatedAt,
        operationFixture.target.timing.finishedAt,
        `${operation} must update updatedAt from confirmed timing`,
      );
    }

    for (const operation of TIMESTAMP_OBSERVATION_OPERATIONS) {
      const observationFixture = createFixture({
        prefix: `sennel-flow-query-timestamp-observation-${operation}-`,
      });
      let before;
      if (operation === "record_metric") {
        before = invokeQuery(observationFixture.root, {
          resource: "metadata",
          condition: { specId: observationFixture.specId },
        });
        observationFixture.flowManager.appendMetric({
          phase: "query",
          kind: "timestamp observation",
          callCount: 1,
        }, { specId: observationFixture.specId });
      } else if (operation === "record_note") {
        before = invokeQuery(observationFixture.root, {
          resource: "metadata",
          condition: { specId: observationFixture.specId },
        });
        observationFixture.flowManager.addNote("timestamp observation", { specId: observationFixture.specId });
      } else {
        observationFixture.fixture.activate("draft");
        const activeState = observationFixture.flowManager.load(observationFixture.specId);
        observationFixture.flowManager.activateNonblockingPolicy({
          specId: observationFixture.specId,
          policy: {
            enabled: true,
            activatedAt: FIXED_TIME,
            activatedStep: activeState.currentNodeId,
            reason: "R6 observation timestamp fixture",
          },
        });
        before = invokeQuery(observationFixture.root, {
          resource: "metadata",
          condition: { specId: observationFixture.specId },
        });
        observationFixture.flowManager.recordNonblocking({
          specId: observationFixture.specId,
          nodeId: activeState.currentNodeId,
          record: {
            kind: "observation",
            sourceStep: activeState.currentNodeId,
            sourceAttempt: activeState.attempt.sequence,
            evidenceRef: "steps/draft/result.json",
            evidenceDigest: "e".repeat(64),
            resultKind: "unavailable",
            action: null,
            rationale: null,
            remainingRisk: null,
          },
        });
      }
      assert.equal(before.status, 0, before.stderr);
      const after = invokeQuery(observationFixture.root, {
        resource: "metadata",
        condition: { specId: observationFixture.specId },
      });
      assert.equal(after.status, 0, after.stderr);
      assert.equal(
        readActivityEntries(observationFixture.fixture).at(-1).transition.operation,
        operation,
        `${operation} must be present in the observation ledger fixture`,
      );
      assert.deepEqual(
        after.response.item.timestamps,
        before.response.item.timestamps,
        `${operation} must not update metadata timestamps`,
      );
    }

    const wrongTypeCreation = createFixture({
      prefix: "sennel-flow-query-wrong-creation-type-",
    });
    const wrongTypeActivity = rewriteActivityLedger(
      wrongTypeCreation.fixture,
      (entry) => entry.transition.operation === "create_flow",
      (entry) => { entry.type = "flow_resumed"; },
    );
    assert.equal(wrongTypeActivity.transition.operation, "create_flow");
    assert.notEqual(wrongTypeActivity.type, "flow_created");
    const wrongTypeResult = invokeQuery(wrongTypeCreation.root, {
      resource: "metadata",
      condition: { specId: wrongTypeCreation.specId },
    });
    assert.equal(wrongTypeResult.status, 0, wrongTypeResult.stderr);
    const wrongTypeTimestamps = wrongTypeResult.response.item.timestamps;
    assertUnavailableTimestamp(wrongTypeTimestamps.createdAt, "wrong-type create_flow createdAt");
    assertAvailableTimestamp(
      wrongTypeTimestamps.updatedAt,
      wrongTypeActivity.timing.finishedAt,
      "wrong-type create_flow updatedAt",
    );
    assertUnavailableTimestamp(wrongTypeTimestamps.finalizedAt, "wrong-type create_flow finalizedAt");

    const observationFixture = createFixture({ prefix: "sennel-flow-query-observation-only-ledger-" });
    const observationActivities = observationFixture.flowManager.activityLedger(observationFixture.specId);
    const observationCreated = observationActivities.find((activity) => (
      activity.transition.operation === "create_flow"
    ));
    observationFixture.flowManager.appendMetric({
      phase: "query",
      kind: "observation-only",
      callCount: 1,
    }, { specId: observationFixture.specId });
    observationFixture.flowManager.addNote("observation-only note", { specId: observationFixture.specId });
    const observationResult = invokeQuery(observationFixture.root, {
      resource: "metadata",
      condition: { specId: observationFixture.specId },
    });
    assert.equal(observationResult.status, 0, observationResult.stderr);
    const observationTimestamps = observationResult.response.item.timestamps;
    assert.equal(observationTimestamps.createdAt.value, observationCreated.timing.finishedAt);
    assert.equal(observationTimestamps.createdAt.availability, "available");
    assertAvailableTimestamp(
      observationTimestamps.updatedAt,
      observationCreated.timing.finishedAt,
      "observation-only updatedAt",
    );
    assertUnavailableTimestamp(observationTimestamps.finalizedAt, "observation-only finalizedAt");

    const laterNonblocking = createFixture({
      prefix: "sennel-flow-query-later-nonblocking-",
    });
    laterNonblocking.fixture.activate("draft");
    const activeState = laterNonblocking.flowManager.load(laterNonblocking.specId);
    laterNonblocking.flowManager.activateNonblockingPolicy({
      specId: laterNonblocking.specId,
      policy: {
        enabled: true,
        activatedAt: FIXED_TIME,
        activatedStep: activeState.currentNodeId,
        reason: "R6 observation-only timestamp fixture",
      },
    });
    const beforeNonblocking = invokeQuery(laterNonblocking.root, {
      resource: "metadata",
      condition: { specId: laterNonblocking.specId },
    });
    assert.equal(beforeNonblocking.status, 0, beforeNonblocking.stderr);
    const beforeNonblockingTimestamps = beforeNonblocking.response.item.timestamps;
    laterNonblocking.flowManager.recordNonblocking({
      specId: laterNonblocking.specId,
      nodeId: activeState.currentNodeId,
      record: {
        kind: "observation",
        sourceStep: activeState.currentNodeId,
        sourceAttempt: activeState.attempt.sequence,
        evidenceRef: "steps/draft/result.json",
        evidenceDigest: "d".repeat(64),
        resultKind: "unavailable",
        action: null,
        rationale: null,
        remainingRisk: null,
      },
    });
    const afterNonblocking = invokeQuery(laterNonblocking.root, {
      resource: "metadata",
      condition: { specId: laterNonblocking.specId },
    });
    assert.equal(afterNonblocking.status, 0, afterNonblocking.stderr);
    assert.deepEqual(
      afterNonblocking.response.item.timestamps,
      beforeNonblockingTimestamps,
      "record_nonblocking must not change any metadata timestamp",
    );

    const noCreationEvidence = createFixture({
      prefix: "sennel-flow-query-no-creation-evidence-",
    });
    makeNoCreationEvidenceVersion(noCreationEvidence);
    const noCreationResult = invokeQuery(noCreationEvidence.root, {
      resource: "metadata",
      condition: { specId: noCreationEvidence.specId, flowVersion: 2 },
    });
    assert.equal(noCreationResult.status, 0, noCreationResult.stderr);
    assert.deepEqual(noCreationResult.response.selectedFlowVersion, {
      specId: noCreationEvidence.specId,
      flowVersion: 2,
    });
    const noCreationTimestamps = noCreationResult.response.item.timestamps;
    assertUnavailableTimestamp(noCreationTimestamps.createdAt, "no-evidence createdAt");
    assertUnavailableTimestamp(noCreationTimestamps.updatedAt, "no-evidence updatedAt");
    assertUnavailableTimestamp(noCreationTimestamps.finalizedAt, "no-evidence finalizedAt");
  });

  it("R7: exposes deterministic public ArtifactDescriptors and validated Activity relations only", () => {
    const fixture = createFixture();
    fixture.settleBefore("draft").settle("draft");
    const evidence = addActivityEvidenceArtifact(fixture);
    const migration = addMigrationMaterialization(fixture);
    const activity = mutateConfirmedActivity(fixture, (entry) => {
      entry.references.artifacts = [{ id: evidence.descriptor.relativePath, label: "optional evidence" }];
      entry.result.artifactRefs = [
        { kind: "path", id: "spec.json" },
        { kind: "logical", id: "flow.state" },
        { kind: "activity-ledger", id: "activities.jsonl" },
      ];
    });
    const catalog = JSON.parse(fs.readFileSync(fixture.location().catalogFile, "utf8"));
    const source = catalog.artifacts.find((entry) => entry.logicalKey === "spec.record");
    const referenceDescriptors = [
      { kind: "path", id: "spec.json", descriptor: source },
      {
        kind: "logical",
        id: "flow.state",
        descriptor: catalog.artifacts.find((entry) => entry.logicalKey === "flow.state"),
      },
      {
        kind: "activity-ledger",
        id: "activities.jsonl",
        descriptor: catalog.artifacts.find((entry) => entry.kind === "activity-ledger"),
      },
    ];
    assert.equal(referenceDescriptors.every((entry) => entry.descriptor !== undefined), true);
    const canonicalJson = artifactCanonicalJson(source);
    assert.equal(Buffer.byteLength(canonicalJson, "utf8") <= QUERY_LIMITS.MAX_ARTIFACT_ID_CANONICAL_JSON_BYTES, true);

    const result = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId },
    });
    assert.equal(result.status, 0, result.stderr);
    const publicArtifact = result.response.item.artifacts.find((entry) => entry.metadata.logicalKey === "spec.record");
    assert.ok(publicArtifact);
    assert.equal(publicArtifact.artifactId, publicArtifactId(source));
    assert.equal(publicArtifact.artifactId, sha256(Buffer.from(canonicalJson, "utf8")));
    assert.deepEqual(publicArtifact.activityIds, [source.activityId]);
    assert.deepEqual(publicArtifact.nodeIds, ["flow"]);
    assert.deepEqual(publicArtifact.taskIds, []);
    for (const field of ["activityIds", "nodeIds", "taskIds"]) {
      assert.equal(new Set(publicArtifact[field]).size, publicArtifact[field].length);
      assert.equal(publicArtifact[field].length <= QUERY_LIMITS.MAX_IDS_PER_ARTIFACT, true);
    }

    const evidencePublic = result.response.item.artifacts.find((entry) => (
      entry.metadata.logicalKey === "activity.evidence"
    ));
    assert.ok(evidencePublic);
    assert.equal(evidencePublic.metadata.schemaRevision, evidence.document.schemaRevision);
    assert.deepEqual(evidencePublic.activityIds, [evidence.descriptor.activityId]);
    assert.deepEqual(evidencePublic.nodeIds, ["flow"]);
    assert.deepEqual(evidencePublic.taskIds, []);

    const migrationPublic = result.response.item.artifacts.find((entry) => (
      entry.metadata.logicalKey === null
      && entry.metadata.mediaType === migration.mediaType
    ));
    assert.ok(migrationPublic);
    assert.equal(migrationPublic.metadata.schemaRevision, null);
    assert.deepEqual(migrationPublic.activityIds, []);
    assert.deepEqual(migrationPublic.nodeIds, []);
    assert.deepEqual(migrationPublic.taskIds, []);
    assertNoInternalFields(publicArtifact);
    assertNoInternalFields(evidencePublic);
    assertNoInternalFields(migrationPublic);

    const activities = invokeQuery(fixture.root, {
      resource: "activities",
      condition: { specId: fixture.specId },
    });
    assert.equal(activities.status, 0, activities.stderr);
    const publicActivity = activities.response.items.find((entry) => entry.activity.id === activity.id);
    assert.ok(publicActivity);
    assert.equal(publicActivity.artifactIds.includes(publicArtifactId(evidence.descriptor)), true);
    for (const reference of referenceDescriptors) {
      const publicId = publicArtifactId(reference.descriptor);
      const outcomeReference = publicActivity.outcome.artifactRefs.find((entry) => entry.kind === reference.kind);
      assert.deepEqual(outcomeReference, { kind: reference.kind, id: publicId });
    }

    const taskRelation = createTaskRelationFixture();
    const taskCatalog = JSON.parse(fs.readFileSync(taskRelation.fixture.location().catalogFile, "utf8"));
    const taskStateDescriptor = taskCatalog.artifacts.find((entry) => entry.logicalKey === "flow.state");
    const taskResult = invokeQuery(taskRelation.root, {
      resource: "metadata",
      condition: { specId: taskRelation.fixture.specId },
    });
    assert.equal(taskResult.status, 0, taskResult.stderr);
    const taskPublic = taskResult.response.item.artifacts.find((entry) => (
      entry.artifactId === publicArtifactId(taskStateDescriptor)
    ));
    assert.ok(taskPublic);
    assert.deepEqual(taskPublic.activityIds, [taskStateDescriptor.activityId]);
    assert.deepEqual(taskPublic.nodeIds, ["T-1-impl"]);
    assert.deepEqual(taskPublic.taskIds, ["T-1"]);
  });

  it("R7: omits optional unresolved references but rejects unresolved canonical relations", () => {
    const optional = createFixture({ prefix: "sennel-flow-query-optional-reference-" });
    optional.fixture.settleBefore("draft").settle("draft");
    const missingOptional = `steps/system/activity-evidence/${"d".repeat(64)}.json`;
    const optionalActivity = mutateConfirmedActivity(optional.fixture, (entry) => {
      entry.references.artifacts = [{ id: missingOptional, label: "optional missing evidence" }];
    });
    const optionalResult = invokeQuery(optional.root, {
      resource: "activities",
      condition: { specId: optional.specId },
    });
    assert.equal(optionalResult.status, 0, optionalResult.stderr);
    const optionalItem = optionalResult.response.items.find((entry) => entry.activity.id === optionalActivity.id);
    assert.ok(optionalItem);
    assert.equal(optionalItem.artifactIds.includes(missingOptional), false);

    const required = createFixture({ prefix: "sennel-flow-query-required-reference-" });
    required.fixture.settleBefore("draft").settle("draft");
    mutateConfirmedActivity(required.fixture, (entry) => {
      entry.result.artifactRefs = [{ kind: "path", id: "artifacts/missing-required.json" }];
    });
    const requiredResult = invokeQuery(required.root, {
      resource: "activities",
      condition: { specId: required.specId },
    });
    assertKnownError(requiredResult, {
      resource: "activities",
      code: "CANONICAL_RECORD_INCONSISTENT",
      path: "/canonical",
    });
    assert.deepEqual(requiredResult.response.items, []);
  });

  it("R7: rejects each catalog descriptor hash mismatch instead of exposing stored identity", () => {
    for (const [label, relativePath] of [
      ["activity ledger", "activities.jsonl"],
      ["state", "flow.json"],
      ["spec snapshot", "revisions/001/spec.json"],
      ["spec record", "spec.json"],
    ]) {
      const fixture = createFixture({ prefix: `sennel-flow-query-${label.replaceAll(" ", "-")}-hash-` });
      const catalogFile = fixture.location().catalogFile;
      const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
      const descriptor = catalog.artifacts.find((entry) => entry.relativePath === relativePath);
      assert.ok(descriptor, `fixture requires ${label} descriptor`);
      descriptor.hash = "0".repeat(64);
      writeJson(catalogFile, catalog);
      refreshVersionCatalog(fixture.location().directory);
      const result = invokeQuery(fixture.root, {
        resource: "metadata",
        condition: { specId: fixture.specId },
      });
      assertKnownError(result, {
        resource: "metadata",
        code: "CANONICAL_RECORD_INCONSISTENT",
        path: "/canonical",
      });
      assert.equal(result.response.item, null);
    }
  });

  it("R7: enforces canonical artifact identity size/depth boundaries and public collection limits", () => {
    const oversized = createFixture({ prefix: "sennel-flow-query-artifact-id-size-" });
    const oversizedDescriptor = addMigrationMaterialization(oversized, {
      relativePath: "artifacts/migration/query-canonical-id-too-large.bin",
      mediaType: `application/x-${"m".repeat(QUERY_LIMITS.MAX_ARTIFACT_ID_CANONICAL_JSON_BYTES)}`,
      memberId: "query-canonical-id-too-large",
    });
    assert.equal(Buffer.byteLength(artifactCanonicalJson(oversizedDescriptor), "utf8") > QUERY_LIMITS.MAX_ARTIFACT_ID_CANONICAL_JSON_BYTES, true);
    const oversizedResult = invokeQuery(oversized.root, {
      resource: "metadata",
      condition: { specId: oversized.specId },
    });
    assertKnownError(oversizedResult, {
      resource: "metadata",
      code: "CANONICAL_RECORD_INCONSISTENT",
      path: "/canonical",
    });

    // JSON/NDJSON cannot persist a cyclic value; the reader must still reject
    // the representable nested-value form before canonical identity creation.
    const nested = createFixture({ prefix: "sennel-flow-query-artifact-id-depth-" });
    const nestedCatalog = JSON.parse(fs.readFileSync(nested.fixture.location().catalogFile, "utf8"));
    const nestedDescriptor = nestedCatalog.artifacts.find((entry) => entry.logicalKey === "spec.record");
    let nestedValue = "leaf";
    for (let depth = 0; depth <= QUERY_LIMITS.MAX_CANONICAL_JSON_DEPTH; depth += 1) nestedValue = { value: nestedValue };
    nestedDescriptor.mediaType = nestedValue;
    writeJson(nested.fixture.location().catalogFile, nestedCatalog);
    refreshVersionCatalog(nested.fixture.location().directory);
    const nestedResult = invokeQuery(nested.root, {
      resource: "metadata",
      condition: { specId: nested.specId },
    });
    assertKnownError(nestedResult, {
      resource: "metadata",
      code: "CANONICAL_RECORD_INCONSISTENT",
      path: "/canonical",
    });

    const collection = createFixture({ prefix: "sennel-flow-query-public-collection-limit-" });
    collection.fixture.settleBefore("draft").settle("draft");
    mutateConfirmedActivity(collection.fixture, (entry) => {
      entry.references.evaluations = Array.from(
        { length: QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS + 1 },
        (_, index) => ({ id: `evaluation-${String(index).padStart(5, "0")}`, label: null }),
      );
    });
    const collectionResult = invokeQuery(collection.root, {
      resource: "activities",
      condition: { specId: collection.specId },
    });
    assertKnownError(collectionResult, {
      resource: "activities",
      code: "CANONICAL_RECORD_INCONSISTENT",
      path: "/canonical",
    });
    assert.deepEqual(collectionResult.response.items, []);
  });

  it("R8: returns only the bounded confirmed Activity prefix in confirmationOrder", () => {
    const fixture = createFixture();
    const before = snapshotTree(fixture.root);
    const result = invokeQuery(fixture.root, {
      resource: "activities",
      condition: { specId: fixture.specId },
    });
    const after = snapshotTree(fixture.root);
    assert.equal(result.status, 0, result.stderr);
    assertExactKeys(result.response, [
      "schemaRevision", "ok", "resource", "selectedFlowVersion",
      "availableFlowVersions", "items", "pageInfo",
    ], "activities response");
    assert.equal(result.response.resource, "activities");
    assert.equal(Array.isArray(result.response.items), true);
    assert.equal(result.response.items.length <= QUERY_LIMITS.MAX_CONFIRMED_ACTIVITIES, true);
    assertExactKeys(result.response.pageInfo, ["limit", "endCursor", "hasNext"], "pageInfo");
    assert.equal(result.response.pageInfo.limit, 100);
    assert.equal(result.response.pageInfo.endCursor, null);
    assert.equal(result.response.pageInfo.hasNext, false);
    for (let index = 0; index < result.response.items.length; index += 1) {
      assertActivityItem(result.response.items[index]);
      assert.equal(result.response.items[index].confirmationOrder, index + 1);
    }
    assertSameTree(after, before);
  });

  it("R8: classifies missing or symlinked records and stops at the confirmed ledger prefix", () => {
    for (const relativePath of ["flow.json", "spec.json", "activities.jsonl", "artifact-catalog.json"]) {
      const fixture = createFixture({ prefix: `sennel-flow-query-missing-${relativePath.replace(/[^a-z]+/gi, "-")}-` });
      fs.unlinkSync(path.join(fixture.fixture.location().directory, relativePath));
      const result = invokeQuery(fixture.root, {
        resource: "metadata",
        condition: { specId: fixture.specId },
      });
      assertVersionUnreadableError(result);
    }

    const symlinked = createFixture({ prefix: "sennel-flow-query-symlink-record-" });
    const location = symlinked.fixture.location();
    const originalSpec = path.join(location.directory, "spec.json");
    const target = path.join(location.directory, "spec-record-target.json");
    fs.copyFileSync(originalSpec, target);
    fs.unlinkSync(originalSpec);
    fs.symlinkSync(path.basename(target), originalSpec);
    const symlinkResult = invokeQuery(symlinked.root, {
      resource: "metadata",
      condition: { specId: symlinked.specId },
    });
    assertVersionUnreadableError(symlinkResult);

    const bounded = createFixture({ prefix: "sennel-flow-query-confirmed-prefix-" });
    const boundedLocation = bounded.fixture.location();
    const boundedState = JSON.parse(fs.readFileSync(boundedLocation.flowStateFile, "utf8"));
    boundedState.confirmationOrder = 1;
    writeJson(boundedLocation.flowStateFile, boundedState);
    fs.appendFileSync(boundedLocation.activitiesFile, "{ malformed journal suffix\n", "utf8");
    refreshVersionCatalog(boundedLocation.directory, ["flow.json", "activities.jsonl"]);
    const boundedResult = invokeQuery(bounded.root, {
      resource: "activities",
      condition: { specId: bounded.specId },
    });
    assert.equal(boundedResult.status, 0, boundedResult.stderr);
    assert.deepEqual(boundedResult.response.items.map((item) => item.confirmationOrder), [1]);
  });

  it("R8: enforces each canonical record byte limit before parsing", () => {
    const oversizedRecords = [
      ["flow.json", QUERY_LIMITS.MAX_STATE_RECORD_BYTES],
      ["spec.json", QUERY_LIMITS.MAX_SPEC_RECORD_BYTES],
      ["activities.jsonl", QUERY_LIMITS.MAX_CONFIRMED_LEDGER_BYTES],
      ["artifact-catalog.json", QUERY_LIMITS.MAX_ARTIFACT_CATALOG_BYTES],
    ];
    for (const [relativePath, limit] of oversizedRecords) {
      const fixture = createFixture({ prefix: `sennel-flow-query-byte-limit-${relativePath.replace(/[^a-z]+/gi, "-")}-` });
      fs.truncateSync(path.join(fixture.fixture.location().directory, relativePath), limit + 1);
      const result = invokeQuery(fixture.root, {
        resource: "metadata",
        condition: { specId: fixture.specId },
      });
      assertVersionUnreadableError(result);
    }
  });

  it("R8: uses bounded no-follow readers without materializing or invoking mutation owners", () => {
    const fixture = createFixture({ prefix: "sennel-flow-query-reader-sentinel-fixture-" });
    writeQueryConfig(fixture.root);
    const probe = createPreBootstrapProbe();
    const hookMarker = path.join(probe.root, "hook-invoked.log");
    installLifecycleHookProbe(fixture.root, hookMarker);
    for (const relativePath of [
      ".runtime/locks/query.lock",
      ".runtime/query.runtime-log",
      ".sennel/cache/query.cache",
      ".sennel/tmp/query.temp",
    ]) {
      const file = path.join(fixture.root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `fixture-${relativePath}\n`, "utf8");
    }
    initializeGitRepository(fixture.root);
    const sentinel = createReaderSideEffectSentinel(fixture.root);
    const before = snapshotTree(fixture.root);
    const gitBefore = gitStatusSnapshot(fixture.root);
    const invokeEntrypoint = (direct, request) => invokeQuery(fixture.root, request, {
      direct,
      args: direct ? ["query"] : ["flow", "query"],
      cwd: probe.root,
      workRoot: fixture.root,
      sourceRoot: fixture.root,
      env: { ...probe.env, ...sentinel.env },
    });
    const results = [];
    for (const direct of [false, true]) {
      results.push(invokeEntrypoint(direct, {
        resource: "metadata",
        condition: { specId: fixture.specId },
      }));
      results.push(invokeEntrypoint(direct, {
        resource: "metadata",
        condition: { specId: fixture.specId, flowVersion: 99 },
      }));
    }
    assert.equal(results.filter((result) => result.status === 0).length, 2);
    assert.equal(results.filter((result) => result.status !== 0).length, 2);
    assertSameTree(snapshotTree(fixture.root), before);
    assert.deepEqual(gitStatusSnapshot(fixture.root), gitBefore);
    assert.equal(fs.existsSync(probe.marker), false, "reader must not invoke Git or worktree discovery");
    assert.equal(fs.existsSync(hookMarker), false, "reader must not load or run a lifecycle hook");

    const events = readReaderSentinelEvents(sentinel.log);
    assert.equal(events.some((event) => event.violation === true), false);
    assert.equal(events.some((event) => event.operation.startsWith("child_process.")), false);
    assert.equal(events.some((event) => [
      "readFileSync", "readFile", "promises.readFile", "existsSync", "realpathSync", "realpath",
    ].includes(event.operation)), false);
    const canonicalDirectory = fixture.fixture.location().directory;
    for (const relativePath of ["flow.json", "spec.json", "activities.jsonl", "artifact-catalog.json"]) {
      const absolutePath = path.join(canonicalDirectory, relativePath);
      assert.equal(events.some((event) => event.path === absolutePath && [
        "openSync", "open", "promises.open",
      ].includes(event.operation)), true, `reader must bounded-open ${relativePath}`);
    }
    for (const event of events.filter((entry) => ["openSync", "open", "promises.open"].includes(entry.operation))) {
      assert.equal(typeof event.flags, "number");
      assert.equal((event.flags & fs.constants.O_ACCMODE) === fs.constants.O_RDONLY, true);
      assert.equal((event.flags & fs.constants.O_NOFOLLOW) !== 0, true);
    }
  });

  it("R9: applies the default page, exact page bounds, and finishedAt datetime filter", () => {
    const fixture = createFixture();
    const location = fixture.fixture.location();
    const activities = readActivityEntries(fixture.fixture);
    const timedActivity = activities.find((entry) => entry.timing?.finishedAt);
    assert.ok(timedActivity, "fixture requires an Activity with timing.finishedAt");
    const finishedAtMs = Date.parse(timedActivity.timing.finishedAt);
    assert.equal(Number.isFinite(finishedAtMs), true);
    const recordedAt = {
      gte: timedActivity.timing.finishedAt,
      lt: new Date(finishedAtMs + 1).toISOString(),
    };
    const unrelatedFilesystemTime = new Date("1970-01-01T00:00:00.000Z");
    for (const relativePath of ["flow.json", "spec.json", "activities.jsonl", "artifact-catalog.json"]) {
      const file = path.join(location.directory, relativePath);
      fs.utimesSync(file, unrelatedFilesystemTime, unrelatedFilesystemTime);
    }

    const timingFiltered = invokeQuery(fixture.root, {
      resource: "activities",
      condition: { specId: fixture.specId },
      page: { limit: 100, after: null },
      recordedAt,
    });
    assert.equal(timingFiltered.status, 0, timingFiltered.stderr);
    assert.equal(
      timingFiltered.response.items.some((item) => item.activity.id === timedActivity.id),
      true,
      "recordedAt must filter by canonical Activity timing.finishedAt",
    );
    assert.equal(timingFiltered.response.items.every((item) => {
      const itemFinishedAt = item.timing === null ? NaN : Date.parse(item.timing.finishedAt);
      return itemFinishedAt >= finishedAtMs && itemFinishedAt < finishedAtMs + 1;
    }), true);

    const empty = invokeQuery(fixture.root, {
      resource: "activities",
      condition: { specId: fixture.specId },
      page: { limit: 1, after: null },
      recordedAt: { gte: "2099-01-01T00:00:00.000Z", lt: "2099-01-02T00:00:00.000Z" },
    });
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(empty.response.items, []);
    assert.deepEqual(empty.response.pageInfo, { limit: 1, endCursor: null, hasNext: false });

    const invalid = [
      { request: { resource: "activities", condition: { specId: fixture.specId }, page: { limit: 0, after: null } } },
      { request: { resource: "activities", condition: { specId: fixture.specId }, page: { limit: 101, after: null } } },
      { request: { resource: "activities", condition: { specId: fixture.specId }, page: { limit: 1, after: "not base64url" } } },
      { request: { resource: "activities", condition: { specId: fixture.specId }, recordedAt: { gte: "2026-01-02T00:00:00.000Z", lt: "2025-01-01T00:00:00.000Z" } } },
    ];
    for (const { request } of invalid) {
      const result = invokeQuery(fixture.root, request);
      assert.notEqual(result.status, 0);
      assert.ok(result.response);
      assert.equal(result.response.ok, false);
    }

    const exactShapeCases = [
      {
        request: {
          resource: "activities",
          condition: { specId: fixture.specId },
          page: { limit: 1 },
        },
        path: "/page/after",
      },
      {
        request: {
          resource: "activities",
          condition: { specId: fixture.specId },
          page: { limit: 1, after: null, extra: true },
        },
        path: "/page/field",
      },
      {
        request: {
          resource: "activities",
          condition: { specId: fixture.specId },
          recordedAt: { gte: null },
        },
        path: "/recordedAt/lt",
      },
      {
        request: {
          resource: "activities",
          condition: { specId: fixture.specId },
          recordedAt: { gte: null, lt: null, extra: true },
        },
        path: "/recordedAt/field",
      },
    ];
    for (const { request, path: errorPath } of exactShapeCases) {
      assertKnownError(invokeQuery(fixture.root, request), {
        resource: "activities",
        code: "INVALID_REQUEST",
        path: errorPath,
      });
    }
  });

  it("R10: validates opaque cursor payloads, stateless reuse, bindings, and pagination position", () => {
    const fixture = createFixture();
    fixture.fixture.settle("draft");
    addVersionTwo(fixture);
    const request = {
      resource: "activities",
      condition: { specId: fixture.specId },
      page: { limit: 1, after: null },
      recordedAt: { gte: null, lt: null },
    };
    const first = invokeQuery(fixture.root, request);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.response.items.length, 1);
    const firstItem = first.response.items[0];
    const firstCursor = first.response.pageInfo.endCursor;
    assert.equal(typeof firstCursor, "string");
    assertOpaqueCursor(firstCursor, {
      resource: "activities",
      specId: fixture.specId,
      flowVersion: 1,
      gte: null,
      lt: null,
      confirmationOrder: firstItem.confirmationOrder,
    });

    const next = invokeQuery(fixture.root, {
      ...request,
      page: { limit: 1, after: firstCursor },
    });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.response.items.length, 1);
    assert.equal(next.response.items[0].confirmationOrder > firstItem.confirmationOrder, true);

    const replay = invokeQuery(fixture.root, {
      ...request,
      page: { limit: 1, after: firstCursor },
    });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(replay.response, next.response);

    const secondSpec = createFixture({ specId: "517-flow-query-cursor-other" });
    secondSpec.fixture.settle("draft");
    addVersionTwo(secondSpec);
    const secondSpecFirst = invokeQuery(secondSpec.root, {
      ...request,
      condition: { specId: secondSpec.specId },
    });
    assert.equal(secondSpecFirst.status, 0, secondSpecFirst.stderr);
    const secondSpecCursor = secondSpecFirst.response.pageInfo.endCursor;
    assertOpaqueCursor(secondSpecCursor, {
      resource: "activities",
      specId: secondSpec.specId,
      flowVersion: 1,
      gte: null,
      lt: null,
      confirmationOrder: secondSpecFirst.response.items[0].confirmationOrder,
    });

    const versionTwoFirst = invokeQuery(fixture.root, {
      ...request,
      condition: { specId: fixture.specId, flowVersion: 2 },
    });
    assert.equal(versionTwoFirst.status, 0, versionTwoFirst.stderr);
    const versionTwoCursor = versionTwoFirst.response.pageInfo.endCursor;
    assertOpaqueCursor(versionTwoCursor, {
      resource: "activities",
      specId: fixture.specId,
      flowVersion: 2,
      gte: null,
      lt: null,
      confirmationOrder: versionTwoFirst.response.items[0].confirmationOrder,
    });

    const gteRequest = {
      ...request,
      recordedAt: { gte: "2026-01-02T00:00:00.000Z", lt: null },
    };
    const gteFirst = invokeQuery(fixture.root, gteRequest);
    assert.equal(gteFirst.status, 0, gteFirst.stderr);
    const gteCursor = gteFirst.response.pageInfo.endCursor;
    assertOpaqueCursor(gteCursor, {
      resource: "activities",
      specId: fixture.specId,
      flowVersion: 1,
      gte: gteRequest.recordedAt.gte,
      lt: null,
      confirmationOrder: gteFirst.response.items[0].confirmationOrder,
    });

    const ltRequest = {
      ...request,
      recordedAt: { gte: null, lt: "2026-01-03T00:00:00.000Z" },
    };
    const ltFirst = invokeQuery(fixture.root, ltRequest);
    assert.equal(ltFirst.status, 0, ltFirst.stderr);
    const ltCursor = ltFirst.response.pageInfo.endCursor;
    assert.equal(typeof ltCursor, "string");
    assertOpaqueCursor(ltCursor, {
      resource: "activities",
      specId: fixture.specId,
      flowVersion: 1,
      gte: null,
      lt: ltRequest.recordedAt.lt,
      confirmationOrder: ltFirst.response.items[0].confirmationOrder,
    });

    const mismatchCases = [
      { name: "specId", cursor: secondSpecCursor },
      { name: "flowVersion", cursor: versionTwoCursor },
      { name: "recordedAt.gte", cursor: gteCursor },
      { name: "recordedAt.lt", cursor: ltCursor },
    ];
    for (const mismatch of mismatchCases) {
      const result = invokeQuery(fixture.root, {
        ...request,
        page: { limit: 1, after: mismatch.cursor },
      });
      assertKnownError(result, {
        resource: "activities",
        code: "CURSOR_QUERY_MISMATCH",
        path: "/page/after",
        label: `${mismatch.name} mismatch`,
      });
    }

    const tamperedFields = [
      ["version", (payload) => { payload.version = 2; }],
      ["resource", (payload) => { payload.resource = "metadata"; }],
      ["specId", (payload) => { payload.specId = secondSpec.specId; }],
      ["flowVersion", (payload) => { payload.flowVersion = 2; }],
      ["recordedAt", (payload) => { payload.recordedAt = { gte: "2026-01-02T00:00:00.000Z", lt: null }; }],
      ["confirmationOrder", (payload) => { payload.confirmationOrder += 1; }],
    ];
    for (const [field, mutate] of tamperedFields) {
      const tampered = invokeQuery(fixture.root, {
        ...request,
        page: { limit: 1, after: mutateCursorPayload(firstCursor, mutate) },
      });
      assertKnownError(tampered, {
        resource: "activities",
        code: "INVALID_CURSOR",
        path: "/page/after",
        label: `${field} tamper`,
      });
    }

    const missingDigestPayload = decodeCursorPayload(firstCursor);
    delete missingDigestPayload.digest;
    assertKnownError(invokeQuery(fixture.root, {
      ...request,
      page: { limit: 1, after: encodeCursorPayload(missingDigestPayload) },
    }), {
      resource: "activities",
      code: "INVALID_CURSOR",
      path: "/page/after",
      label: "missing cursor digest",
    });

    const incorrectDigestPayload = decodeCursorPayload(firstCursor);
    incorrectDigestPayload.digest = "0".repeat(64);
    assertKnownError(invokeQuery(fixture.root, {
      ...request,
      page: { limit: 1, after: encodeCursorPayload(incorrectDigestPayload) },
    }), {
      resource: "activities",
      code: "INVALID_CURSOR",
      path: "/page/after",
      label: "incorrect cursor digest",
    });

    const nonCanonicalPayload = decodeCursorPayload(firstCursor);
    nonCanonicalPayload.recordedAt = { lt: null, gte: null };
    assert.equal(nonCanonicalPayload.digest, cursorDigest(nonCanonicalPayload));
    assert.notEqual(
      JSON.stringify(nonCanonicalPayload),
      JSON.stringify(sortedJsonValue(nonCanonicalPayload)),
      "fixture must encode a non-canonical cursor payload",
    );
    assertKnownError(invokeQuery(fixture.root, {
      ...request,
      page: { limit: 1, after: encodeCursorPayload(nonCanonicalPayload) },
    }), {
      resource: "activities",
      code: "INVALID_CURSOR",
      path: "/page/after",
      label: "non-canonical cursor serialization",
    });
  });

  it("R11: projects every non-null ActivityItem component from confirmed canonical facts", () => {
    const fixture = createFixture({ prefix: "sennel-flow-query-r11-components-" });
    fixture.fixture.settleBefore("draft").settle("draft");
    const evidence = addActivityEvidenceArtifact(fixture.fixture);
    const rawActivity = mutateConfirmedActivity(fixture.fixture, (entry) => {
      entry.timing = {
        startedAt: "2026-01-02T03:04:10.000Z",
        finishedAt: "2026-01-02T03:04:10.000Z",
        durationMs: 0,
      };
      entry.usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cost: 0,
      };
      entry.result = {
        ...entry.result,
        summary: "R11 confirmed Activity with measured usage.",
        confirmedAt: FIXED_TIME,
        artifactRefs: [{ kind: "path", id: evidence.descriptor.relativePath }],
      };
      entry.references = {
        evaluations: [{ id: "evaluation-r11", label: "evaluation fixture" }],
        findings: [{ id: "finding-r11", label: null }],
        repairs: [{ id: "repair-r11", label: "repair fixture" }],
        artifacts: [{ id: evidence.descriptor.relativePath, label: "optional evidence" }],
      };
    });
    const metric = {
      phase: "r11",
      counter: "confirmedActivities",
      delta: 0,
      reset: true,
      kind: "agent",
      provider: "fixture-provider",
      profileKey: "fixture-profile",
      callCount: 0,
      responseChars: 0,
      durationMs: 0,
      model: "fixture-model",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      cost: 0,
      cachedResponse: true,
      costIncomplete: false,
    };
    const nullableMetric = {
      phase: "r11-nullable",
      counter: null,
      delta: null,
      reset: false,
      kind: "agent",
      provider: null,
      profileKey: null,
      callCount: null,
      responseChars: null,
      durationMs: null,
      model: null,
      tokens: null,
      cost: null,
      cachedResponse: false,
      costIncomplete: true,
    };
    fixture.flowManager.appendMetric(metric, { specId: fixture.specId, taskId: null });
    fixture.flowManager.appendMetric(nullableMetric, { specId: fixture.specId, taskId: null });
    fixture.flowManager.addNote("R11 durable Activity note.", { specId: fixture.specId, taskId: null });

    const result = invokeQuery(fixture.root, {
      resource: "activities",
      condition: { specId: fixture.specId },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.response.items.length >= 4);
    for (const item of result.response.items) {
      assertActivityItem(item);
      assert.equal(typeof item.activity.id, "string");
      assert.equal(typeof item.activity.type, "string");
      assert.equal(item.confirmationOrder > 0, true);
      assert.equal(item.artifactIds.every((id) => /^[a-f0-9]{64}$/.test(id)), true);
      if (item.outcome !== null) {
        assert.equal(["passed", "failed", "skipped", "incomplete"].includes(item.outcome.outcome), true);
        assert.equal(item.outcome.confirmedAt.length > 0, true);
      }
    }

    const item = result.response.items.find((entry) => entry.activity.id === rawActivity.id);
    assert.ok(item);
    assert.deepEqual(item.activity, { id: rawActivity.id, type: rawActivity.type });
    assert.deepEqual(item.node, { id: rawActivity.nodeId, key: rawActivity.nodeKey });
    assert.deepEqual(item.attempt, { id: rawActivity.attemptId, sequence: rawActivity.sequence });
    assert.equal(item.sequence, rawActivity.sequence);
    assert.equal(item.confirmationOrder, rawActivity.confirmationOrder);
    assert.deepEqual(item.transition, {
      operation: rawActivity.transition.operation,
      status: rawActivity.transition.status,
    });
    assert.deepEqual(item.timing, rawActivity.timing);
    assert.deepEqual(item.usage, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cost: 0,
    });
    assert.deepEqual(item.outcome, {
      outcome: rawActivity.result.outcome,
      summary: "R11 confirmed Activity with measured usage.",
      confirmedAt: FIXED_TIME,
      artifactRefs: [{ kind: "path", id: publicArtifactId(evidence.descriptor) }],
    });
    assert.equal(item.failure, null);
    assert.equal(item.blocker, null);
    assert.equal(item.incomplete, null);
    assert.equal(item.metric, null);
    assert.equal(item.note, null);
    assert.deepEqual(item.evaluationIds, ["evaluation-r11"]);
    assert.deepEqual(item.findingIds, ["finding-r11"]);
    assert.deepEqual(item.repairIds, ["repair-r11"]);
    assert.equal(item.artifactIds.includes(publicArtifactId(evidence.descriptor)), true);
    assert.equal(item.artifactIds.includes(evidence.descriptor.relativePath), false);

    const metricItem = result.response.items.find((entry) => entry.transition.operation === "record_metric");
    assert.ok(metricItem);
    assertActivityItem(metricItem);
    assert.deepEqual(metricItem.metric, metric);
    assert.equal(metricItem.note, null);
    assert.equal(metricItem.usage, null);
    assert.equal(metricItem.outcome, null);

    const nullableMetricItem = result.response.items.find((entry) => entry.transition.operation === "record_metric" && entry.metric.phase === "r11-nullable");
    assert.ok(nullableMetricItem);
    assertActivityItem(nullableMetricItem);
    assert.deepEqual(nullableMetricItem.metric, nullableMetric);

    const noteItem = result.response.items.find((entry) => entry.transition.operation === "record_note");
    assert.ok(noteItem);
    assertActivityItem(noteItem);
    assert.equal(noteItem.note, "R11 durable Activity note.");
    assert.equal(noteItem.metric, null);
    assert.equal(noteItem.usage, null);
    assert.equal(noteItem.outcome, null);

    const unmeasured = result.response.items.find((entry) => entry.transition.operation === "start_attempt");
    assert.ok(unmeasured);
    assert.equal(unmeasured.usage, null);
    assertNoInternalFields(result.response);
  });

  it("R11: projects task, failure, outcome, blocker, and incomplete sources without cross-Activity fallback", () => {
    const taskFixture = createTaskRelationFixture();
    const taskRaw = taskFixture.flowManager.activityLedger(taskFixture.fixture.specId)
      .find((entry) => entry.transition.operation === "add_task");
    assert.ok(taskRaw);
    const taskResult = invokeQuery(taskFixture.root, {
      resource: "activities",
      condition: { specId: taskFixture.fixture.specId },
    });
    assert.equal(taskResult.status, 0, taskResult.stderr);
    const taskItem = taskResult.response.items.find((entry) => entry.activity.id === taskRaw.id);
    assert.ok(taskItem);
    assert.deepEqual(taskItem.task, {
      id: taskRaw.transition.task.id,
      key: taskRaw.transition.task.key,
    });
    assert.equal(taskItem.attempt, null);
    assert.equal(taskItem.sequence, null);

    const failed = createFixture({ prefix: "sennel-flow-query-r11-failure-" });
    failed.fixture.settleBefore("impl-gate").activate("impl-gate", { settlePredecessors: false });
    const failure = {
      category: "semantic",
      code: "R11_FAILURE",
      message: "R11 failure projection fixture.",
      retryable: true,
      retryKind: "semantic",
    };
    const outcome = {
      outcome: "failed",
      summary: "R11 failure outcome fixture.",
      confirmedAt: FIXED_TIME,
      artifactRefs: [],
    };
    failed.flowManager.failCurrentAttempt({
      specId: failed.specId,
      failure,
      result: outcome,
    });
    const failureResult = invokeQuery(failed.root, {
      resource: "activities",
      condition: { specId: failed.specId },
    });
    assert.equal(failureResult.status, 0, failureResult.stderr);
    const failedItem = failureResult.response.items.find((entry) => entry.transition.operation === "fail_attempt");
    assert.ok(failedItem);
    assertActivityItem(failedItem);
    assert.deepEqual(failedItem.failure, failure);
    assert.deepEqual(failedItem.outcome, outcome);
    assert.equal(failedItem.blocker, null);
    assert.equal(failedItem.incomplete, null);

    const blocked = createFixture({ prefix: "sennel-flow-query-r11-incomplete-" });
    blocked.fixture.settleBefore("impl-gate").activate("impl-gate", { settlePredecessors: false });
    const blocker = { code: "R11_BLOCKER", message: "R11 blocker source fixture." };
    const blockedFailure = {
      category: "semantic",
      code: "R11_BLOCKED_FAILURE",
      message: "R11 blocked failure source fixture.",
      retryable: false,
      retryKind: null,
    };
    const incomplete = {
      code: "R11_INCOMPLETE",
      message: "R11 incomplete source fixture.",
      operation: null,
      resources: [],
    };
    persistBlockedAttempt(blocked.fixture, {
      blocker,
      failure: blockedFailure,
      incomplete: [incomplete],
    });
    const blockedResult = invokeQuery(blocked.root, {
      resource: "activities",
      condition: { specId: blocked.specId },
    });
    assert.equal(blockedResult.status, 0, blockedResult.stderr);
    const updatedItem = blockedResult.response.items.find((entry) => entry.transition.operation === "update_attempt");
    assert.ok(updatedItem);
    assert.deepEqual(updatedItem.blocker, blocker);
    assert.deepEqual(updatedItem.incomplete, incomplete);
    assert.equal(updatedItem.failure, null);
    const blockedFailureItem = blockedResult.response.items.find((entry) => entry.transition.operation === "fail_attempt");
    assert.ok(blockedFailureItem);
    assert.deepEqual(blockedFailureItem.failure, blockedFailure);
    assert.equal(blockedFailureItem.blocker, null);
    assert.equal(blockedFailureItem.incomplete, null);
  });

  it("R11: rejects ambiguous incomplete claims and every public Activity collection over the bound", () => {
    const ambiguous = createFixture({ prefix: "sennel-flow-query-r11-multiple-incomplete-" });
    ambiguous.fixture.settleBefore("impl-gate").activate("impl-gate", { settlePredecessors: false });
    const claim = (suffix) => ({
      code: `R11_INCOMPLETE_${suffix}`,
      message: `R11 incomplete claim ${suffix}.`,
      operation: "publish_artifacts",
      resources: [`activity.evidence.${suffix}`],
    });
    persistBlockedAttempt(ambiguous.fixture, {
      blocker: { code: "R11_AMBIGUOUS", message: "R11 has multiple incomplete claims." },
      failure: {
        category: "semantic",
        code: "R11_AMBIGUOUS_FAILURE",
        message: "R11 ambiguous incomplete failure.",
        retryable: false,
        retryKind: null,
      },
      incomplete: [claim("one"), claim("two")],
    });
    const ambiguousResult = invokeQuery(ambiguous.root, {
      resource: "activities",
      condition: { specId: ambiguous.specId },
    });
    assertKnownError(ambiguousResult, {
      resource: "activities",
      code: "CANONICAL_RECORD_INCONSISTENT",
      path: "/canonical",
    });
    assert.deepEqual(ambiguousResult.response.items, []);

    const oversized = createFixture({ prefix: "sennel-flow-query-r11-collection-limit-" });
    oversized.fixture.settleBefore("draft").settle("draft");
    mutateConfirmedActivity(oversized.fixture, (entry) => {
      entry.references.evaluations = Array.from(
        { length: QUERY_LIMITS.MAX_PUBLIC_COLLECTION_ITEMS + 1 },
        (_, index) => ({ id: `r11-evaluation-${String(index).padStart(5, "0")}`, label: null }),
      );
    });
    const oversizedResult = invokeQuery(oversized.root, {
      resource: "activities",
      condition: { specId: oversized.specId },
    });
    assertKnownError(oversizedResult, {
      resource: "activities",
      code: "CANONICAL_RECORD_INCONSISTENT",
      path: "/canonical",
    });
    assert.deepEqual(oversizedResult.response.items, []);
  });

  it("R12: covers every canonical failure class for both resources with public error envelopes", () => {
    const resources = ["metadata", "activities"];
    const requestFor = (fixture, resource, condition = { specId: fixture.specId }) => ({
      resource,
      condition,
    });

    const missingSpec = createFixture({ prefix: "sennel-flow-query-missing-spec-" });
    for (const resource of resources) {
      assertPublicKnownError(
        invokeQuery(missingSpec.root, requestFor(missingSpec, resource, { specId: "does-not-exist" })),
        missingSpec,
        {
          resource,
          code: "SPEC_NOT_FOUND",
          path: "/condition/specId",
          selectedFlowVersion: null,
          availableFlowVersions: [],
        },
      );
    }

    const missingRecordCases = [
      {
        name: "state record",
        remove(location) { fs.unlinkSync(location.flowStateFile); },
      },
      {
        name: "Spec record",
        remove(location) { fs.unlinkSync(location.specFile); },
      },
      {
        name: "Activity ledger",
        remove(location) { fs.unlinkSync(location.activitiesFile); },
      },
      {
        name: "Artifact catalog",
        remove(location) { fs.unlinkSync(location.catalogFile); },
      },
    ];
    for (const entry of missingRecordCases) {
      const fixture = createFixture({ prefix: `sennel-flow-query-missing-${entry.name.replaceAll(" ", "-")}-` });
      const internalNames = fixtureInternalNames(fixture);
      entry.remove(fixture.fixture.location());
      for (const resource of resources) {
        assertPublicKnownError(
          invokeQuery(fixture.root, requestFor(fixture, resource)),
          fixture,
          {
            resource,
            code: "CANONICAL_RECORD_UNREADABLE",
            path: "/canonical",
            selectedFlowVersion: null,
            availableFlowVersions: [1],
          },
          internalNames,
        );
      }
    }

    const malformedRecordCases = [
      {
        name: "state record",
        corrupt(location) {
          fs.writeFileSync(location.flowStateFile, "{\n", "utf8");
          refreshVersionCatalog(location.directory, ["flow.json"]);
        },
      },
      {
        name: "Spec record",
        corrupt(location) {
          fs.writeFileSync(location.specFile, "{\n", "utf8");
          refreshVersionCatalog(location.directory, ["spec.json"]);
        },
      },
      {
        name: "Activity ledger",
        corrupt(location) {
          fs.writeFileSync(location.activitiesFile, "{\n", "utf8");
          refreshVersionCatalog(location.directory, ["activities.jsonl"]);
        },
      },
      {
        name: "Artifact catalog",
        corrupt(location) { fs.writeFileSync(location.catalogFile, "{\n", "utf8"); },
      },
    ];
    for (const entry of malformedRecordCases) {
      const fixture = createFixture({ prefix: `sennel-flow-query-malformed-${entry.name.replaceAll(" ", "-")}-` });
      const internalNames = fixtureInternalNames(fixture);
      entry.corrupt(fixture.fixture.location());
      for (const resource of resources) {
        assertPublicKnownError(
          invokeQuery(fixture.root, requestFor(fixture, resource)),
          fixture,
          {
            resource,
            code: "CANONICAL_RECORD_UNREADABLE",
            path: "/canonical",
            selectedFlowVersion: null,
            availableFlowVersions: [1],
          },
          internalNames,
        );
      }
    }

    const inconsistentCases = [
      {
        name: "state schema revision",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "flow.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.state.schemaRevision = 999;
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["flow.json"]);
        },
      },
      {
        name: "Spec identity",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "spec.json");
          const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
          envelope.specId = "internal-other-spec";
          writeJson(file, envelope);
          refreshVersionCatalog(versionDirectory, ["spec.json"]);
        },
      },
      {
        name: "ledger continuity",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "activities.jsonl");
          const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
          assert.ok(lines.length >= 2, "fixture requires a second Activity for ledger continuity corruption");
          const activity = JSON.parse(lines[1]);
          activity.confirmationOrder += 1;
          lines[1] = JSON.stringify(activity);
          fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
          refreshVersionCatalog(versionDirectory, ["activities.jsonl"]);
        },
      },
      {
        name: "catalog digest",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "artifact-catalog.json");
          const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
          catalog.hash = "0".repeat(64);
          writeJson(file, catalog);
        },
      },
      {
        name: "catalog relation",
        mutate({ versionDirectory }) {
          const file = path.join(versionDirectory, "artifact-catalog.json");
          const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
          const descriptor = catalog.artifacts.find((entry) => entry.activityId !== null);
          assert.ok(descriptor, "fixture requires an Activity-associated artifact");
          descriptor.activityId = "internal-missing-activity";
          writeJson(file, catalog);
          refreshVersionCatalog(versionDirectory);
        },
      },
    ];
    for (const entry of inconsistentCases) {
      const fixture = mutateVersionTwoFixture(entry.mutate, {
        prefix: `sennel-flow-query-r12-${entry.name.replaceAll(" ", "-")}-`,
      });
      const internalNames = [...fixtureInternalNames(fixture), "internal-other-spec", "internal-missing-activity"];
      for (const resource of resources) {
        assertPublicKnownError(
          invokeQuery(fixture.root, versionTwoRequest(fixture, resource)),
          fixture,
          {
            resource,
            code: "CANONICAL_RECORD_INCONSISTENT",
            path: "/canonical",
            selectedFlowVersion: null,
            availableFlowVersions: [1, 2],
          },
          internalNames,
        );
      }
    }

    const missingVersion = createFixture({ prefix: "sennel-flow-query-r12-missing-version-" });
    addVersionTwo(missingVersion);
    const versionInternalNames = fixtureInternalNames(missingVersion);
    for (const resource of resources) {
      assertPublicKnownError(
        invokeQuery(missingVersion.root, {
          resource,
          condition: { specId: missingVersion.specId, flowVersion: 9 },
        }),
        missingVersion,
        {
          resource,
          code: "FLOW_VERSION_NOT_FOUND",
          path: "/condition/flowVersion",
          selectedFlowVersion: null,
          availableFlowVersions: [1, 2],
        },
        versionInternalNames,
      );
    }
  });

  it("R13: maps every public error pointer and redacts internal storage names", () => {
    const fixture = createFixture({ prefix: "sennel-flow-query-r13-errors-" });
    const internalNames = fixtureInternalNames(fixture);
    const condition = { specId: fixture.specId };
    const requestFor = (resource, extra = {}) => ({ resource, condition, ...extra });

    const invalidJsonCases = [
      { input: "{\n", code: "INVALID_JSON", path: "/request" },
      { input: "null\n", code: "INVALID_REQUEST", path: "/request" },
    ];
    for (const entry of invalidJsonCases) {
      const result = invokeQuery(fixture.root, undefined, { input: entry.input });
      assertBoundaryError(result, { code: entry.code, errorPath: entry.path });
      assertNoInternalNames(result.response, internalNames);
    }

    const invalidResource = invokeQuery(fixture.root, {
      resource: "unknown",
      condition,
    });
    assertBoundaryError(invalidResource, { code: "INVALID_REQUEST", errorPath: "/resource" });
    assertNoInternalNames(invalidResource.response, internalNames);

    const commonCases = [
      {
        name: "unknown top-level field",
        request: (resource) => requestFor(resource, { unsupported: true }),
        code: "INVALID_REQUEST",
        path: "/field",
      },
      {
        name: "unknown condition field",
        request: (resource) => requestFor(resource, { condition: { ...condition, unsupported: true } }),
        code: "INVALID_REQUEST",
        path: "/condition/field",
      },
      {
        name: "invalid Spec identifier",
        request: (resource) => requestFor(resource, { condition: { specId: "bad/id" } }),
        code: "INVALID_REQUEST",
        path: "/condition/specId",
      },
      {
        name: "invalid Version selector",
        request: (resource) => requestFor(resource, { condition: { specId: fixture.specId, flowVersion: 1.5 } }),
        code: "INVALID_REQUEST",
        path: "/condition/flowVersion",
      },
    ];
    for (const resource of ["metadata", "activities"]) {
      for (const entry of commonCases) {
        assertPublicKnownError(
          invokeQuery(fixture.root, entry.request(resource)),
          fixture,
          {
            resource,
            code: entry.code,
            path: entry.path,
            selectedFlowVersion: null,
            availableFlowVersions: [],
          },
          internalNames,
        );
      }
    }

    const metadataFieldCases = [
      {
        name: "metadata page",
        request: requestFor("metadata", { page: { limit: 1, after: null } }),
        path: "/page",
      },
      {
        name: "metadata recordedAt",
        request: requestFor("metadata", { recordedAt: { gte: null, lt: null } }),
        path: "/recordedAt",
      },
    ];
    for (const entry of metadataFieldCases) {
      assertPublicKnownError(
        invokeQuery(fixture.root, entry.request),
        fixture,
        {
          resource: "metadata",
          code: "INVALID_REQUEST",
          path: entry.path,
          selectedFlowVersion: null,
          availableFlowVersions: [],
        },
        internalNames,
      );
    }

    const activityFieldCases = [
      {
        name: "page limit",
        request: requestFor("activities", { page: { limit: 0, after: null } }),
        code: "INVALID_REQUEST",
        path: "/page/limit",
      },
      {
        name: "malformed cursor",
        request: requestFor("activities", { page: { limit: 1, after: "not base64url" } }),
        code: "INVALID_CURSOR",
        path: "/page/after",
      },
      {
        name: "recordedAt.gte",
        request: requestFor("activities", { recordedAt: { gte: "not-a-datetime", lt: null } }),
        code: "INVALID_REQUEST",
        path: "/recordedAt/gte",
      },
      {
        name: "recordedAt.lt",
        request: requestFor("activities", { recordedAt: { gte: null, lt: "not-a-datetime" } }),
        code: "INVALID_REQUEST",
        path: "/recordedAt/lt",
      },
    ];
    for (const entry of activityFieldCases) {
      assertPublicKnownError(
        invokeQuery(fixture.root, entry.request),
        fixture,
        {
          resource: "activities",
          code: entry.code,
          path: entry.path,
        },
        internalNames,
      );
    }
  });

  it("R14: represents active, parked, derived-blocked, and finalized Versions as public lifecycle data", () => {
    const active = createFixture({ prefix: "sennel-flow-query-active-" });
    const activeResult = invokeQuery(active.root, {
      resource: "metadata",
      condition: { specId: active.specId },
    });
    assert.equal(activeResult.status, 0, activeResult.stderr);
    assert.equal(activeResult.response.item.lifecycle.lifecycle, "active");

    const parked = createFixture({ prefix: "sennel-flow-query-parked-" });
    parked.flowManager.parkFlow(parked.specId);
    const parkedResult = invokeQuery(parked.root, {
      resource: "metadata",
      condition: { specId: parked.specId },
    });
    assert.equal(parkedResult.status, 0, parkedResult.stderr);
    assert.equal(parkedResult.response.item.lifecycle.lifecycle, "parked");

    const blocked = createFixture({ prefix: "sennel-flow-query-blocked-" });
    blocked.fixture.settleBefore("impl-gate").activate("impl-gate");
    blocked.flowManager.failCurrentAttempt({
      specId: blocked.specId,
      failure: {
        category: "semantic",
        code: "FIXTURE_BLOCKED",
        message: "The fixture is intentionally blocked.",
        retryable: false,
        retryKind: null,
      },
      result: {
        outcome: "failed",
        summary: "The fixture is intentionally blocked.",
        confirmedAt: FIXED_TIME,
        artifactRefs: [],
      },
    });
    const blockedResult = invokeQuery(blocked.root, {
      resource: "metadata",
      condition: { specId: blocked.specId },
    });
    assert.equal(blockedResult.status, 0, blockedResult.stderr);
    assert.equal(blockedResult.response.item.lifecycle.blocked, true);
    assert.equal(blockedResult.response.item.lifecycle.lifecycle, "active");
    assert.deepEqual(blockedResult.response.item.lifecycle.blocker, {
      code: "FIXTURE_BLOCKED",
      message: "The fixture is intentionally blocked.",
    });

    const finalized = createFixture({ prefix: "sennel-flow-query-finalized-" });
    settleAndFinalize(finalized);
    const first = invokeQuery(finalized.root, {
      resource: "metadata",
      condition: { specId: finalized.specId },
    });
    const second = invokeQuery(finalized.root, {
      resource: "metadata",
      condition: { specId: finalized.specId },
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.response.item.lifecycle.lifecycle, "finalized");
    assert.deepEqual(second.response, first.response);
  });

  it("R15: uses one version-aware reader for fresh and migrated state, Spec, ledger, and catalog records", () => {
    const fresh = createFixture({
      specId: "517-flow-query-fresh",
      prefix: "sennel-flow-query-r15-fresh-",
      specRecord: fixtureSpecRecord({
        capabilities: {
          "query.metadata": true,
          "query.activities": true,
          "fixture.fresh": true,
        },
      }),
    });
    const migrated = createFixture({
      specId: "517-flow-query-migrated",
      prefix: "sennel-flow-query-r15-migrated-",
      specRecord: fixtureSpecRecord({
        capabilities: {
          "query.metadata": true,
          "query.activities": true,
          "fixture.migrated": true,
        },
      }),
    });
    migrated.fixture.settle("draft");
    const migratedVersionTwo = addVersionTwo(migrated);

    const scenarios = [
      {
        name: "fresh",
        fixture: fresh,
        capabilities: {
          "query.metadata": true,
          "query.activities": true,
          "fixture.fresh": true,
        },
        versions: [{ flowVersion: 1, directory: fresh.fixture.location().directory }],
        availableFlowVersions: [1],
      },
      {
        name: "migrated",
        fixture: migrated,
        capabilities: {
          "query.metadata": true,
          "query.activities": true,
          "fixture.migrated": true,
        },
        versions: [
          { flowVersion: 1, directory: migrated.fixture.location().directory },
          { flowVersion: 2, directory: migratedVersionTwo },
        ],
        availableFlowVersions: [1, 2],
      },
    ];

    const observations = new Map();
    for (const scenario of scenarios) {
      for (const version of scenario.versions) {
        const state = JSON.parse(fs.readFileSync(path.join(version.directory, "flow.json"), "utf8"));
        const spec = JSON.parse(fs.readFileSync(path.join(version.directory, "spec.json"), "utf8"));
        const catalog = JSON.parse(fs.readFileSync(path.join(version.directory, "artifact-catalog.json"), "utf8"));
        const ledgerContents = fs.readFileSync(path.join(version.directory, "activities.jsonl"), "utf8").trimEnd();
        const ledger = ledgerContents === "" ? [] : ledgerContents.split("\n").map((line) => JSON.parse(line));

        if (version.flowVersion === 1) {
          assert.equal(Object.hasOwn(state, "recordRevision"), false, `${scenario.name} Version 1 state must be direct`);
          assert.equal(Object.hasOwn(spec, "recordRevision"), false, `${scenario.name} Version 1 Spec must be direct`);
          assert.equal(state.specId, scenario.fixture.specId);
        } else {
          assertExactKeys(state, ["recordRevision", "specId", "flowVersion", "state"], `${scenario.name} Version ${version.flowVersion} state envelope`);
          assert.equal(state.recordRevision, 1);
          assert.equal(state.specId, scenario.fixture.specId);
          assert.equal(state.flowVersion, version.flowVersion);
          assert.equal(state.state.specId, scenario.fixture.specId);
          assert.equal(state.state.flowVersion, version.flowVersion);
          assert.equal(state.state.schemaRevision, 3);
          assert.equal(state.state.version, 1);
          assertExactKeys(spec, ["recordRevision", "specId", "content"], `${scenario.name} Version ${version.flowVersion} Spec envelope`);
          assert.equal(spec.recordRevision, 1);
          assert.equal(spec.specId, scenario.fixture.specId);
        }

        const metadata = invokeQuery(scenario.fixture.root, {
          resource: "metadata",
          condition: { specId: scenario.fixture.specId, flowVersion: version.flowVersion },
        });
        const activities = invokeQuery(scenario.fixture.root, {
          resource: "activities",
          condition: { specId: scenario.fixture.specId, flowVersion: version.flowVersion },
        });
        assert.equal(metadata.status, 0, `${scenario.name} metadata Version ${version.flowVersion}: ${metadata.stderr}`);
        assert.equal(activities.status, 0, `${scenario.name} activities Version ${version.flowVersion}: ${activities.stderr}`);

        assertExactKeys(metadata.response, [
          "schemaRevision", "ok", "resource", "selectedFlowVersion",
          "availableFlowVersions", "item",
        ], `${scenario.name} metadata response`);
        assert.equal(metadata.response.schemaRevision, 1);
        assert.equal(metadata.response.ok, true);
        assert.equal(metadata.response.resource, "metadata");
        assert.deepEqual(metadata.response.selectedFlowVersion, {
          specId: scenario.fixture.specId,
          flowVersion: version.flowVersion,
        });
        assert.deepEqual(metadata.response.availableFlowVersions, scenario.availableFlowVersions);
        assert.equal(metadata.response.item.identity.specId, scenario.fixture.specId);
        assert.equal(metadata.response.item.identity.flowVersion, version.flowVersion);
        assert.deepEqual(metadata.response.item.capabilities, scenario.capabilities);
        assert.equal(Array.isArray(metadata.response.item.artifacts), true);
        assert.equal(metadata.response.item.artifacts.length, catalog.artifacts.length);
        for (const descriptor of metadata.response.item.artifacts) {
          assertExactKeys(descriptor, ["artifactId", "metadata", "activityIds", "nodeIds", "taskIds"], `${scenario.name} public artifact`);
          assertExactKeys(descriptor.metadata, ["logicalKey", "schemaRevision", "mediaType"], `${scenario.name} public artifact metadata`);
          assert.match(descriptor.artifactId, /^[a-f0-9]{64}$/);
        }
        assertNoInternalFields(metadata.response.item);
        assert.equal(metadata.response.item.metrics.activityCount, ledger.length);
        assert.equal(metadata.response.item.metrics.artifactCount, catalog.artifacts.length);

        assertExactKeys(activities.response, [
          "schemaRevision", "ok", "resource", "selectedFlowVersion",
          "availableFlowVersions", "items", "pageInfo",
        ], `${scenario.name} activities response`);
        assert.equal(activities.response.schemaRevision, 1);
        assert.equal(activities.response.ok, true);
        assert.equal(activities.response.resource, "activities");
        assert.deepEqual(activities.response.selectedFlowVersion, metadata.response.selectedFlowVersion);
        assert.deepEqual(activities.response.availableFlowVersions, scenario.availableFlowVersions);
        assert.equal(activities.response.pageInfo.limit, 100);
        assert.equal(activities.response.pageInfo.hasNext, false);
        assert.equal(activities.response.pageInfo.endCursor, null);
        assert.deepEqual(
          activities.response.items.map((item) => item.activity.id),
          ledger.map((entry) => entry.id),
          `${scenario.name} Version ${version.flowVersion} must read the confirmed ledger prefix`,
        );
        for (const item of activities.response.items) {
          assertActivityItem(item);
        }
        assertNoInternalFields(activities.response);
        observations.set(`${scenario.name}:${version.flowVersion}`, { metadata, activities });
      }
    }

    const migratedV1 = observations.get("migrated:1");
    const migratedV2 = observations.get("migrated:2");
    assert.deepEqual(
      migratedV2.activities.response.items.map((item) => ({
        id: item.activity.id,
        type: item.activity.type,
        confirmationOrder: item.confirmationOrder,
        transition: item.transition,
      })),
      migratedV1.activities.response.items.map((item) => ({
        id: item.activity.id,
        type: item.activity.type,
        confirmationOrder: item.confirmationOrder,
        transition: item.transition,
      })),
      "direct Version 1 and Version 2 envelope ledgers must project the same Activity history",
    );
    assert.deepEqual(
      migratedV2.metadata.response.item.identity,
      { ...migratedV1.metadata.response.item.identity, flowVersion: 2 },
      "Version 2 identity must be selected from its directory binding while preserving state identity",
    );
    assert.deepEqual(
      migratedV2.metadata.response.item.capabilities,
      migratedV1.metadata.response.item.capabilities,
      "the Version 2 Spec envelope must use the same Spec projection",
    );
    assert.deepEqual(
      migratedV2.metadata.response.item.structure,
      migratedV1.metadata.response.item.structure,
      "the Version 2 state envelope must use the same state projection",
    );

    const sentinel = createReaderSideEffectSentinel(migrated.root);
    const callProbe = createQueryCallProbe();
    const probeEnvironment = combineProbeEnvironments(sentinel, callProbe);
    for (const direct of [false, true]) {
      for (const version of [1, 2]) {
        for (const resource of ["metadata", "activities"]) {
          const result = invokeQuery(migrated.root, {
            resource,
            condition: { specId: migrated.specId, flowVersion: version },
          }, {
            direct,
            args: direct ? ["query"] : ["flow", "query"],
            env: probeEnvironment,
          });
          assert.equal(result.status, 0, `${resource} Version ${version} through ${direct ? "direct" : "top-level"} entrypoint: ${result.stderr}`);
        }
      }
    }
    const events = readReaderSentinelEvents(sentinel.log);
    assert.equal(events.some((event) => event.violation === true), false);
    for (const versionDirectory of [migrated.fixture.location().directory, migratedVersionTwo]) {
      for (const relativePath of ["flow.json", "spec.json", "activities.jsonl", "artifact-catalog.json"]) {
        const absolutePath = path.join(versionDirectory, relativePath);
        assert.equal(events.some((event) => event.path === absolutePath && [
          "openSync", "open", "promises.open",
        ].includes(event.operation)), true, `shared reader must bounded-open ${relativePath} for ${versionDirectory}`);
      }
    }
    for (const event of events.filter((entry) => ["openSync", "open", "promises.open"].includes(entry.operation))) {
      assert.equal((event.flags & fs.constants.O_ACCMODE) === fs.constants.O_RDONLY, true);
      assert.equal((event.flags & fs.constants.O_NOFOLLOW) !== 0, true);
    }
    assertSharedReaderBoundary(callProbe.log, {
      minimumCalls: 8,
      label: "R15 shared reader boundary",
    });
    assertNoQueryCallProbeEvents(callProbe.log, "R15 shared reader boundary");
  });

  it("R16: leaves canonical files, runtime state, Git, and probes unchanged on canonical failures", () => {
    const failureCases = [
      {
        label: "missing canonical record",
        expectedCode: "CANONICAL_RECORD_UNREADABLE",
        prepare(fixture) {
          fs.unlinkSync(fixture.fixture.location().specFile);
        },
      },
      {
        label: "malformed canonical record",
        expectedCode: "CANONICAL_RECORD_UNREADABLE",
        prepare(fixture) {
          fs.writeFileSync(fixture.fixture.location().specFile, "{ malformed canonical record\\n", "utf8");
        },
      },
      {
        label: "symlinked canonical record",
        expectedCode: "CANONICAL_RECORD_UNREADABLE",
        prepare(fixture) {
          const location = fixture.fixture.location();
          const target = path.join(location.directory, "spec-record-target.json");
          fs.copyFileSync(location.specFile, target);
          fs.unlinkSync(location.specFile);
          fs.symlinkSync(path.basename(target), location.specFile);
        },
      },
      {
        label: "non-regular canonical record",
        expectedCode: "CANONICAL_RECORD_UNREADABLE",
        prepare(fixture) {
          const specFile = fixture.fixture.location().specFile;
          fs.unlinkSync(specFile);
          fs.mkdirSync(specFile);
        },
      },
      {
        label: "canonical digest mismatch",
        expectedCode: "CANONICAL_RECORD_INCONSISTENT",
        prepare(fixture) {
          const location = fixture.fixture.location();
          const state = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
          state.runId = `${state.runId}-digest-mismatch`;
          writeJson(location.flowStateFile, state);
        },
      },
      {
        label: "canonical schema mismatch",
        expectedCode: "CANONICAL_RECORD_INCONSISTENT",
        prepare(fixture) {
          const location = fixture.fixture.location();
          const state = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
          state.schemaRevision = 999;
          writeJson(location.flowStateFile, state);
          refreshVersionCatalog(location.directory, ["flow.json"]);
        },
      },
      {
        label: "response limit",
        expectedCode: "CANONICAL_RECORD_INCONSISTENT",
        create() {
          return createOversizedMetadataFixture();
        },
        prepare() {},
      },
    ];

    for (const failureCase of failureCases) {
      const fixture = failureCase.create ? failureCase.create() : createFixture({
        prefix: `sennel-flow-query-r16-${failureCase.label.replace(/[^a-z]+/gi, "-")}-`,
      });
      writeQueryConfig(fixture.root);
      const bootstrap = createPreBootstrapProbe();
      const hookMarker = path.join(bootstrap.root, "hook-invoked.log");
      installLifecycleHookProbe(fixture.root, hookMarker);
      failureCase.prepare(fixture);
      for (const relativePath of [
        ".runtime/locks/query.lock",
        ".runtime/query.runtime-log",
        ".sennel/cache/query.cache",
        ".sennel/temporary/query.temp",
        ".tmp/query.tmp",
      ]) {
        const file = path.join(fixture.root, relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `fixture-${relativePath}\\n`, "utf8");
      }
      initializeGitRepository(fixture.root);

      const sentinel = createReaderSideEffectSentinel(fixture.root);
      const callProbe = createQueryCallProbe();
      const probeEnvironment = combineProbeEnvironments(bootstrap, sentinel, callProbe);
      const invokeEntrypoint = (direct) => invokeQuery(fixture.root, {
        resource: "metadata",
        condition: { specId: fixture.specId },
      }, {
        direct,
        args: direct ? ["query"] : ["flow", "query"],
        cwd: bootstrap.root,
        workRoot: fixture.root,
        sourceRoot: fixture.root,
        env: probeEnvironment,
      });

      for (const direct of [false, true]) {
        const beforeTree = snapshotTree(fixture.root);
        const beforeRuntime = snapshotManagedRuntimeState(fixture.root);
        const beforeGit = gitStatusSnapshot(fixture.root);
        const beforeProbes = snapshotQueryProbeState({ sentinel, callProbe, bootstrap, hookMarker });
        const result = invokeEntrypoint(direct);
        const afterTree = snapshotTree(fixture.root);
        const afterRuntime = snapshotManagedRuntimeState(fixture.root);
        const afterGit = gitStatusSnapshot(fixture.root);
        const afterProbes = snapshotQueryProbeState({ sentinel, callProbe, bootstrap, hookMarker });

        assertKnownError(result, {
          resource: "metadata",
          code: failureCase.expectedCode,
          path: "/canonical",
          label: `${failureCase.label} (${direct ? "direct flow" : "top-level CLI"})`,
        });
        assertSameTree(afterTree, beforeTree);
        assertSameTree(afterRuntime, beforeRuntime);
        assert.deepEqual(afterGit, beforeGit, `${failureCase.label} changed Git status`);
        assert.deepEqual(afterProbes, beforeProbes, `${failureCase.label} changed query probes`);
        assertNoQueryCallProbeEvents(callProbe.log, `R16 ${failureCase.label} query side-effect boundary`);
      }
    }
  });

  it("R17: executes every retained lifecycle hook and preserves priority and error policy", async () => {
    const inventory = EXISTING_SURFACE_PARITY_FIXTURE.hooks.callbacks;
    const successRoot = createRoot("sennel-flow-query-r17-hooks-");
    writeQueryConfig(successRoot);
    const successMarker = path.join(successRoot, "hook-calls.jsonl");
    const callbackDefinitions = inventory.flatMap((surface) => surface.callbacks.map((hook) => ({
      command: surface.route.at(-1),
      hook,
      priority: surface.route.at(-1) === "gate" && hook === "pre" ? 30 : 0,
    })));
    installLifecycleHookSuite(successRoot, successMarker, [
      { command: "gate", hook: "pre", priority: 20 },
      { command: "gate", hook: "pre", priority: 10 },
      ...callbackDefinitions,
    ]);
    const successPlans = await discoverFlowCommandHooks(successRoot);
    const runHook = (command, hook) => runFlowCommandHooks(successRoot, successPlans, {
      command,
      hook,
      flow: { specId: "517-flow-query-hooks", phase: "spec", runId: "run-hooks" },
      result: { ok: hook !== "onError" },
    });

    for (const definition of callbackDefinitions) {
      const result = await runHook(definition.command, definition.hook);
      assert.equal(result.ok, true, `${definition.command}.${definition.hook} hook failed`);
    }
    const successfulCalls = fs.readFileSync(successMarker, "utf8")
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const gatePrePriorities = successfulCalls
      .filter((entry) => entry.command === "gate" && entry.hook === "pre")
      .map((entry) => entry.priority);
    assert.deepEqual(gatePrePriorities, [10, 20, 30], "hooks must execute in priority order");
    for (const definition of callbackDefinitions) {
      assert.equal(
        successfulCalls.some((entry) => entry.command === definition.command && entry.hook === definition.hook),
        true,
        `missing executable ${definition.command}.${definition.hook} hook observation`,
      );
    }

    const errorRoot = createRoot("sennel-flow-query-r17-hook-errors-");
    writeQueryConfig(errorRoot);
    const errorMarker = path.join(errorRoot, "hook-errors.jsonl");
    installLifecycleHookSuite(errorRoot, errorMarker, [
      { command: "gate", hook: "pre", priority: 20 },
      { command: "gate", hook: "pre", priority: 10 },
      { command: "gate", hook: "onError", failure: true, failurePolicy: "advisory" },
      { command: "finalize-commit", hook: "onError", failure: true, failurePolicy: "required" },
    ]);
    const errorPlans = await discoverFlowCommandHooks(errorRoot);
    const gatePre = await runFlowCommandHooks(errorRoot, errorPlans, {
      command: "gate",
      hook: "pre",
      flow: { specId: "517-flow-query-hook-errors" },
      result: { ok: true },
    });
    assert.equal(gatePre.ok, true);
    assert.deepEqual(
      fs.readFileSync(errorMarker, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)).map((entry) => entry.priority),
      [10, 20],
      "priority ordering must be observable before error handling",
    );
    const advisory = await runFlowCommandHooks(errorRoot, errorPlans, {
      command: "gate",
      hook: "onError",
      flow: { specId: "517-flow-query-hook-errors" },
      result: { ok: false },
    });
    assert.equal(advisory.ok, true, "advisory hook failure must preserve the command result");
    assert.equal(advisory.outcome.isRequiredFailure, false);
    assert.equal(advisory.warnings[0].code, "PLUGIN_HOOK_FAILED");
    assert.equal(advisory.issueLogEntries.length, 1);
    const required = await runFlowCommandHooks(errorRoot, errorPlans, {
      command: "finalize-commit",
      hook: "onError",
      flow: { specId: "517-flow-query-hook-errors" },
      result: { ok: false },
    });
    assert.equal(required.ok, false, "required hook failure must fail the lifecycle");
    assert.equal(required.outcome.isRequiredFailure, true);
    assert.equal(required.outcome.policy, "required");
    assert.equal(required.warnings.length, 0);
  });

  it("R17: preserves prepare hook invocation and canonical plugin artifact publication", () => {
    const root = createRoot("sennel-flow-query-r17-prepare-hook-");
    writeQueryConfig(root);
    const marker = path.join(root, "prepare-hook.jsonl");
    installLifecycleHookSuite(root, marker, [{
      command: "prepare",
      hook: "post",
      artifact: "prepare-observed.json",
    }]);
    writeJson(path.join(root, "package.json"), {
      name: "flow-query-prepare-hook-fixture",
      version: "1.0.0",
    });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "index.js"), "export const prepareHookFixture = true;\n", "utf8");

    const prepared = invoke(root, [
      "flow", "prepare", "--no-branch", "--title", "Prepare hook parity",
      "--base", "main", "--request", "preserve prepare hook behavior",
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(prepared.response.ok, true);
    const hookCalls = fs.readFileSync(marker, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(hookCalls, [{ command: "prepare", hook: "post", priority: 0 }]);

    const specId = fs.readdirSync(path.join(root, "specs"), { withFileTypes: true })
      .find((entry) => entry.isDirectory()).name;
    const location = makeFlowManager(root).specLocation(specId);
    const catalog = new FlowArtifactCatalog(JSON.parse(fs.readFileSync(location.catalogFile, "utf8")));
    const descriptor = catalog.artifacts.find((entry) => entry.logicalKey === "plugin.lifecycle.artifact");
    assert.ok(descriptor, "prepare hook output must be cataloged by the canonical artifact owner");
    const bytes = fs.readFileSync(location.resolve(descriptor.relativePath));
    assert.equal(descriptor.size, bytes.length);
    assert.equal(descriptor.hash, sha256(bytes));
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), {
      command: "prepare",
      hook: "post",
      priority: 0,
    });
  });

  it("R17: preserves task admission and completion as observable Flow command transitions", () => {
    const root = createRoot("sennel-flow-query-r17-task-");
    writeQueryConfig(root);
    const flowManager = makeFlowManager(root);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "517-flow-query-task-command",
      runId: "run-517-flow-query-task-command",
      execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
      specRecord: fixtureSpecRecord(),
    }).create().addTask({
      id: "T-1",
      title: "Command parity task",
      goal: "Exercise the retained task commands.",
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }).registerActive();
    fixture.prepareTaskFrontier();
    const started = invoke(root, ["flow", "run", "start-task", "--task-id", "T-1"]);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.response.ok, true);
    assert.deepEqual(started.response.data, {
      taskId: "T-1",
      currentTaskId: "T-1",
      status: "in_progress",
    });
    assert.equal(flowManager.loadReadOnly().tasks.find((task) => task.id === "T-1").status, "in_progress");

    fixture.settle("T-1-impl").settle("T-1-review").settle("T-1-gate");
    const completed = invoke(root, ["flow", "run", "complete-task", "--task-id", "T-1"]);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(completed.response.ok, true);
    assert.equal(completed.response.data.completedTaskId, "T-1");
    assert.equal(completed.response.data.completed, true);
    const task = flowManager.loadReadOnly().tasks.find((entry) => entry.id === "T-1");
    assert.equal(task.status, "done");
    assert.equal(flowManager.loadReadOnly().currentTaskId, null);
  });

  it("R17: preserves gate execution, post-hook settlement, and canonical result artifacts", () => {
    const fixture = createGitBackedFlowFixture({
      specId: "517-flow-query-gate-command",
      prefix: "sennel-flow-query-r17-gate-",
      targetStep: "spec-gate",
      agentResponse: JSON.stringify({ observations: [] }),
    });
    const beforeCatalog = fs.readFileSync(fixture.fixture.location().catalogFile);
    const gate = invoke(fixture.root, ["flow", "run", "gate", "--phase", "spec"]);
    assert.equal(gate.status, 0, `${gate.stderr}\n${gate.stdout}`);
    assert.equal(gate.response.ok, true);
    assert.equal(gate.response.data.result, "pass");
    const state = fixture.flowManager.loadReadOnly(fixture.specId);
    assert.equal(rawNodeById(state, "spec-gate").status, "done");
    const latestActivity = fixture.flowManager.activityLedger(fixture.specId).at(-1);
    assert.equal(latestActivity.transition.operation, "confirm_attempt");
    const catalog = fixture.flowManager.artifactCatalog(fixture.specId);
    assert.equal(
      catalog.artifacts.some((descriptor) => descriptor.activityId === latestActivity.id),
      true,
      "gate post-hook must attach the canonical result to the confirming Activity",
    );
    assert.notEqual(
      sha256(beforeCatalog),
      sha256(fs.readFileSync(fixture.fixture.location().catalogFile)),
      "gate execution must publish its canonical result artifact",
    );
  });

  it("R17: preserves review execution and spec-review publication through the retained route", () => {
    const fixture = createGitBackedFlowFixture({
      specId: "517-flow-query-review-command",
      prefix: "sennel-flow-query-r17-review-",
      targetStep: "spec-review",
      agentResponse: JSON.stringify({ blockingFindings: [], advisoryFindings: [] }),
    });
    const review = invoke(fixture.root, [
      "flow", "run", "review", "--phase", "spec", "--skip-confirm",
    ]);
    assert.equal(review.status, 0, `${review.stderr}\n${review.stdout}`);
    assert.equal(review.response.ok, true);
    assert.equal(review.response.data.artifacts.verdict, "PASS");
    const state = fixture.flowManager.loadReadOnly(fixture.specId);
    assert.equal(rawNodeById(state, "spec-review").status, "done");
    const latestActivity = fixture.flowManager.activityLedger(fixture.specId).at(-1);
    assert.equal(latestActivity.transition.operation, "confirm_attempt");
    assert.equal(
      fixture.flowManager.artifactCatalog(fixture.specId).artifacts.some((descriptor) => (
        descriptor.logicalKey === "spec.review"
        && descriptor.activityId === latestActivity.id
      )),
      true,
      "review post-hook must retain the canonical spec-review publication",
    );
  });

  it("R17: preserves finalize-cleanup completion, pointer publication, and inactive status", () => {
    const fixture = createGitBackedFlowFixture({
      specId: "517-flow-query-finalize-command",
      prefix: "sennel-flow-query-r17-finalize-",
      targetStep: "finalize-cleanup",
    });
    const cleanup = invoke(fixture.root, ["flow", "run", "finalize-cleanup"]);
    assert.equal(cleanup.status, 0, `${cleanup.stderr}\n${cleanup.stdout}`);
    assert.equal(cleanup.response.ok, true);
    const pointer = path.join(fixture.root, ".sennel", "last-finalized-spec");
    assert.equal(fs.readFileSync(pointer, "utf8").trim(), fixture.specId);
    const active = invoke(fixture.root, ["flow", "get", "status"]);
    assert.equal(active.status, 0, active.stderr);
    assert.equal(active.response.ok, true);
    assert.equal(active.response.data.active, false);
    assert.equal(
      fs.existsSync(path.join(fixture.root, ".sennel", ".active-flow")),
      false,
      "finalize-cleanup must clear the active Flow registration",
    );
  });

  it("R17: preserves the inventoried owners and behavior of every existing Flow surface", () => {
    const inventory = EXISTING_SURFACE_PARITY_FIXTURE;
    const entryFor = (route) => route.reduce(
      (entry, segment) => entry?.[segment] ?? null,
      FLOW_COMMANDS,
    );
    const ownerFiles = new Set([
      ...inventory.registry.owners,
      ...inventory.aliases.flatMap((surface) => surface.owners),
      ...inventory.run.owners,
      ...Object.values(inventory.run.categories).flatMap((category) => category.owners),
      ...inventory.targetAndConfig.owners,
      ...inventory.hooks.owners,
      ...inventory.canonicalArtifacts.owners,
      ...inventory.sideEffects.owners,
    ]);

    for (const file of ownerFiles) {
      assert.equal(fs.existsSync(path.resolve(file)), true, `inventory owner is missing: ${file}`);
    }
    for (const surface of [
      inventory.registry,
      ...inventory.aliases,
      inventory.run,
      inventory.targetAndConfig,
      inventory.hooks,
      inventory.canonicalArtifacts,
      inventory.sideEffects,
    ]) {
      assert.equal(typeof surface.behavior, "string");
      assert.equal(surface.behavior.trim() !== "", true);
      assert.equal(typeof surface.regression, "string");
      assert.equal(surface.regression.trim() !== "", true);
    }
    for (const group of inventory.registry.groups) {
      assert.equal(typeof FLOW_COMMANDS[group], "object", `Flow registry lost group: ${group}`);
    }

    const assertRouteHelpAndArgs = (surface) => {
      const entry = entryFor(surface.route);
      assert.ok(entry, `Flow registry lost route: ${surface.route.join(" ")}`);
      assert.equal(typeof entry.help, "string", `${surface.route.join(" ")} help`);
      assert.equal(typeof entry.args, "object", `${surface.route.join(" ")} args`);
      for (const [field, values] of Object.entries(surface.args ?? {})) {
        if (field === "positional") {
          assert.deepEqual(entry.args[field] ?? [], values, `${surface.route.join(" ")} positional args`);
          continue;
        }
        for (const value of values) {
          assert.equal(
            (entry.args[field] ?? []).includes(value),
            true,
            `${surface.route.join(" ")} must retain ${field} ${value}`,
          );
        }
      }
    };

    for (const surface of inventory.aliases) assertRouteHelpAndArgs(surface);
    for (const hookSurface of inventory.hooks.callbacks) {
      const entry = entryFor(hookSurface.route);
      assert.ok(entry, `Flow registry lost hook route: ${hookSurface.route.join(" ")}`);
      for (const callback of hookSurface.callbacks) {
        assert.equal(typeof entry[callback], "function", `${hookSurface.route.join(" ")} must retain ${callback} hook`);
      }
    }
    const legacyRoutes = inventory.aliases;
    const legacyRegistrySnapshot = legacyRoutes.map((surface) => {
      const entry = entryFor(surface.route);
      return {
        route: surface.route.join(" "),
        args: structuredClone(entry.args),
        help: entry.help,
      };
    });
    const runCommands = Object.keys(FLOW_COMMANDS.run);
    const behaviorRunCommands = Object.values(inventory.run.categories).flatMap((category) => category.commands);
    assert.equal(new Set(behaviorRunCommands).size, behaviorRunCommands.length, "behavior inventory must not duplicate a command");
    assert.equal(
      behaviorRunCommands.every((command) => runCommands.includes(command)),
      true,
      "every behavior-inventoried command must remain an existing run route",
    );
    for (const category of Object.values(inventory.run.categories)) {
      for (const command of category.commands) {
        const entry = FLOW_COMMANDS.run[command];
        assert.ok(entry, `Flow registry lost run command: ${command}`);
        assert.equal(typeof entry.help, "string", `run ${command} help`);
        assert.equal(typeof entry.args, "object", `run ${command} args`);
      }
    }

    const fixture = createFixture({ prefix: "sennel-flow-query-r17-parity-" });
    fixture.fixture.activate("draft");
    writeQueryConfig(fixture.root);
    initializeGitRepository(fixture.root);

    const helpBefore = invoke(fixture.root, ["flow", "--help"]);
    assert.equal(helpBefore.status, 0, helpBefore.stderr);
    for (const route of [
      ...inventory.aliases.map((surface) => surface.route),
      ...runCommands.map((command) => ["run", command]),
    ]) {
      const help = invoke(fixture.root, ["flow", ...route, "--help"]);
      assert.equal(help.status, 0, `${route.join(" ")} help: ${help.stderr}`);
      assert.equal(
        help.stdout.startsWith(`Usage: sennel flow ${route.join(" ")}`),
        true,
        `${route.join(" ")} help must retain its usage line`,
      );
      assert.equal(help.stderr, "", `${route.join(" ")} help must not write diagnostics`);
    }

    const dryRunRoot = createRoot("sennel-flow-query-r17-prepare-dry-run-");
    writeQueryConfig(dryRunRoot);
    const dryRunBefore = snapshotTree(dryRunRoot);
    const dryRun = invoke(dryRunRoot, [
      "flow", "prepare", "--dry-run", "--no-branch",
      "--title", "Parity prepare", "--base", "main",
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(dryRun.response.ok, true);
    assert.equal(dryRun.response.key, "prepare-spec");
    assert.equal(dryRun.response.data.result, "dry-run");
    assert.equal(dryRun.response.data.artifacts.mode, "direct");
    assertSameTree(snapshotTree(dryRunRoot), dryRunBefore);

    const preparedRoot = createRoot("sennel-flow-query-r17-prepare-");
    writeQueryConfig(preparedRoot);
    writeJson(path.join(preparedRoot, "package.json"), {
      name: "flow-query-parity-fixture",
      version: "1.0.0",
    });
    fs.mkdirSync(path.join(preparedRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(preparedRoot, "src", "index.js"), "export const parityFixture = true;\n", "utf8");
    const prepared = invoke(preparedRoot, [
      "flow", "prepare", "--no-branch", "--title", "Parity prepare",
      "--base", "main", "--request", "preserve the prepare authority",
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(prepared.response.ok, true);
    const preparedSpecIds = fs.readdirSync(path.join(preparedRoot, "specs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.equal(preparedSpecIds.length, 1, "prepare must create one canonical Spec directory");
    const preparedSpecId = preparedSpecIds[0];
    const preparedLocation = makeFlowManager(preparedRoot).specLocation(preparedSpecId);
    for (const relativePath of inventory.canonicalArtifacts.files) {
      const absolutePath = path.join(preparedLocation.directory, relativePath);
      assert.equal(fs.statSync(absolutePath).isFile(), true, `prepare must create ${relativePath}`);
    }
    const preparedState = JSON.parse(fs.readFileSync(preparedLocation.flowStateFile, "utf8"));
    const preparedSpec = JSON.parse(fs.readFileSync(preparedLocation.specFile, "utf8"));
    const preparedCatalog = new FlowArtifactCatalog(JSON.parse(fs.readFileSync(preparedLocation.catalogFile, "utf8")));
    assert.equal(preparedState.specId, preparedSpecId);
    assert.equal(preparedState.runId, prepared.response.data.runId);
    assert.equal(preparedSpec && typeof preparedSpec === "object", true);
    assert.equal(preparedCatalog.schemaRevision, 2);
    for (const relativePath of ["flow.json", "activities.jsonl", "spec.json"]) {
      const descriptor = preparedCatalog.artifacts.find((entry) => entry.relativePath === relativePath);
      assert.ok(descriptor, `catalog must own ${relativePath}`);
      const bytes = fs.readFileSync(path.join(preparedLocation.directory, relativePath));
      assert.equal(descriptor.size, bytes.length, `${relativePath} catalog size authority`);
      assert.equal(descriptor.hash, sha256(bytes), `${relativePath} catalog digest authority`);
    }
    assert.equal(fs.existsSync(path.join(preparedRoot, ".sennel", ".active-flow")), true);

    const targetStatus = invoke(fixture.root, [
      "flow", "get", "status", fixture.fixture.state().runId, "--details",
      "--expect-no-issue", "--expect-spec", fixture.specId,
      "--expect-run-id", fixture.fixture.state().runId,
    ]);
    assert.equal(targetStatus.status, 0, targetStatus.stderr);
    assert.equal(targetStatus.response.ok, true);
    assert.equal(targetStatus.response.data.active, true);
    assert.equal(targetStatus.response.data.specId, fixture.specId);
    assert.equal(targetStatus.response.data.runId, fixture.fixture.state().runId);
    assert.equal(typeof targetStatus.response.data.phase, "string");
    assert.equal(Array.isArray(targetStatus.response.data.steps), true);
    assert.equal(Array.isArray(targetStatus.response.data.metrics), true);
    assert.equal(targetStatus.response.data.steps.some((step) => step.status === "in_progress"), true);

    const targetContext = invoke(fixture.root, [
      "flow", "get", "resolve-context", "--expect-no-issue",
      "--expect-spec", fixture.specId, "--expect-run-id", fixture.fixture.state().runId,
    ]);
    assert.equal(targetContext.status, 0, targetContext.stderr);
    assert.equal(targetContext.response.ok, true);
    assert.equal(targetContext.response.data.activeFlow, fixture.specId);
    assert.equal(targetContext.response.data.specId, fixture.specId);
    assert.equal(typeof targetContext.response.data.currentStep, "string");

    const resumed = invoke(fixture.root, [
      "flow", "resume", "--spec", fixture.specId, "--expect-no-issue",
      "--expect-spec", fixture.specId, "--expect-run-id", fixture.fixture.state().runId,
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.response.ok, true);
    assert.equal(resumed.response.data.specId, fixture.specId);
    assert.equal(resumed.response.data.activeFlow, fixture.specId);
    assert.equal(typeof resumed.response.data.currentStep, "string");
    assert.equal(resumed.response.data.progress.total > 0, true);

    const beforeTree = snapshotTree(fixture.root);
    const beforeGit = gitStatusSnapshot(fixture.root);
    const querySuccess = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId },
    });
    const queryFailure = invokeQuery(fixture.root, {
      resource: "metadata",
      condition: { specId: fixture.specId, flowVersion: 99 },
    });
    const afterTree = snapshotTree(fixture.root);
    const afterGit = gitStatusSnapshot(fixture.root);
    assert.equal(querySuccess.status, 0, querySuccess.stderr);
    assert.notEqual(queryFailure.status, 0, queryFailure.stderr);
    assertSameTree(afterTree, beforeTree);
    assert.deepEqual(afterGit, beforeGit, "query must preserve Git status");
    for (const sideEffectPath of inventory.sideEffects.paths) {
      const beforeEntries = [...beforeTree.keys()].filter((entry) => (
        entry === sideEffectPath
        || entry.endsWith(`/${sideEffectPath}`)
        || entry.includes(`/${sideEffectPath}/`)
      )).sort();
      const afterEntries = [...afterTree.keys()].filter((entry) => (
        entry === sideEffectPath
        || entry.endsWith(`/${sideEffectPath}`)
        || entry.includes(`/${sideEffectPath}/`)
      )).sort();
      assert.deepEqual(afterEntries, beforeEntries, `query changed ${sideEffectPath} inventory`);
    }

    const helpAfter = invoke(fixture.root, ["flow", "--help"]);
    assert.equal(helpAfter.status, helpBefore.status);
    assert.equal(helpAfter.stdout, helpBefore.stdout, "query must not change the registry help output");
    assert.equal(helpAfter.stderr, helpBefore.stderr);
    const legacyRegistryAfter = legacyRoutes.map((surface) => {
      const entry = entryFor(surface.route);
      return {
        route: surface.route.join(" "),
        args: structuredClone(entry.args),
        help: entry.help,
      };
    });
    assert.deepEqual(legacyRegistryAfter, legacyRegistrySnapshot, "query must not replace legacy registry metadata");

    const targetStatusAfter = invoke(fixture.root, [
      "flow", "get", "status", fixture.fixture.state().runId, "--details",
      "--expect-no-issue", "--expect-spec", fixture.specId,
      "--expect-run-id", fixture.fixture.state().runId,
    ]);
    assert.equal(targetStatusAfter.status, targetStatus.status);
    assert.equal(targetStatusAfter.stdout, targetStatus.stdout, "status behavior must remain stable after query");
    assert.equal(targetStatusAfter.stderr, targetStatus.stderr);
  });
});
