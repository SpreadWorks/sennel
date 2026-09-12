import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import os from "os";
import { EventEmitter } from "events";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { Agent, ChildProcessSupervisor } from "../../../src/lib/agent.js";
import {
  AgentAuthenticationFailure,
  EmptyAgentResponseFailure,
  AgentPermissionConfigurationFailure,
  TemporaryRateLimitFailure,
  UnknownProviderFailure,
} from "../../../src/lib/agent-failure.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { ReviewExecutionLease } from "../../../src/flow/lib/review-execution-lease.js";
import { AgentTimeoutDiagnostic } from "../../../src/lib/agent-timeout.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
}

const WORKER_ARTIFACT_HANDOFF_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/flow/schemas/next-action/worker-artifact-handoff.schema.json",
);

function makeAgent(profile, { config, paths, flowManager, logger, supervision } = {}) {
  const root = paths?.root || tmpDir();
  const agentWorkDir = paths?.agentWorkDir || path.join(root, ".tmp");
  const userProviders = profile ? { "test/exec": profile } : {};
  const cfg = config || {
    agent: {
      default: profile ? "test/exec" : "claude/opus",
      providers: userProviders,
      timeout: 300,
    },
  };
  const registry = new ProviderRegistry(cfg.agent?.providers || {});
  return new Agent({
    config: cfg,
    paths: { root, agentWorkDir, ...(paths || {}) },
    registry,
    logger: logger || new Logger({ logDir: os.tmpdir(), enabled: false }),
    flowManager,
    supervision,
  });
}

async function waitForFile(file, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForProcessExit(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`provider descendant ${pid} remained alive after timeout cleanup`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForLineCount(filePath, count, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const lines = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)
      : [];
    if (lines.length >= count) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${count} provider admissions`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runModuleProcess(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`concurrent cache writer exited ${code}: ${stderr}`));
    });
  });
}

function successfulSpawnRecorder(record) {
  return (command, args, options) => {
    record.command = command;
    record.args = args;
    record.options = options;
    const child = new EventEmitter();
    child.pid = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit("data", "ok");
      child.emit("close", 0, null);
    });
    return child;
  };
}

describe("Agent.call() — basic invocation", () => {
  it("reports both stdout and stderr activity to a supplied worker monitor", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const events = [];
    const monitor = {
      start(callback) { events.push("start"); this.callback = callback; },
      observeOutput() { events.push("output"); },
      stop() { events.push("stop"); },
    };
    const agent = makeAgent(
      { command: "worker", args: ["{{PROMPT}}"] },
      {
        paths: { root, agentWorkDir: path.join(root, ".tmp") },
        supervision: { spawn() {
          const child = new EventEmitter();
          child.pid = null;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          queueMicrotask(() => {
            child.stdout.emit("data", "stdout activity");
            child.stderr.emit("data", "stderr activity");
            child.emit("close", 0, null);
          });
          return child;
        } },
      },
    );

    assert.equal(await agent.call("work", { commandId: "test", retryCount: 0, activityMonitor: monitor }), "stdout activity");
    assert.deepEqual(events, ["start", "output", "output", "stop"]);
  });

  it("calls a command and returns trimmed output", async () => {
    const agent = makeAgent({ command: "echo", args: ["{{PROMPT}}"] });
    const result = await agent.call("hello world", { commandId: "test" });
    assert.equal(result, "hello world");
  });

  it("substitutes {{PROMPT}} token in args", async () => {
    const agent = makeAgent({ command: "echo", args: ["{{PROMPT}}"] });
    const result = await agent.call("test-prompt", { commandId: "test" });
    assert.equal(result, "test-prompt");
  });

  it("preserves replacement syntax as literal prompt content", async () => {
    const agent = makeAgent({ command: "echo", args: ["{{PROMPT}}"] });
    const result = await agent.call("literal $& and $1 content", { commandId: "test" });
    assert.equal(result, "literal $& and $1 content");
  });

  it("appends prompt when no {{PROMPT}} token", async () => {
    const agent = makeAgent({ command: "echo", args: ["-n"] });
    const result = await agent.call("appended", { commandId: "test" });
    assert.match(result, /appended/);
  });

  it("injects an explicit repository-local execution directory for a worker call", () => {
    const root = tmpDir();
    const executionWorkDir = path.join(root, "worker");
    fs.mkdirSync(executionWorkDir);
    const agent = makeAgent(
      {
        command: "worker",
        args: ["exec", "{{PROMPT}}"],
        workDirFlag: "--cwd",
      },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") } },
    );

    const invocation = agent._buildInvocationForTest("work", {
      commandId: "test",
      executionWorkDir,
    });

    assert.deepEqual(invocation.finalArgs, ["exec", "--cwd", executionWorkDir, "work"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts a flagless provider inside the execution work directory", async (t) => {
    const root = tmpDir();
    const executionWorkDir = path.join(root, "review-snapshot");
    fs.mkdirSync(executionWorkDir);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const spawned = {};
    const agent = makeAgent(
      { command: "worker", args: ["exec", "{{PROMPT}}"] },
      {
        paths: { root, agentWorkDir: path.join(root, ".tmp") },
        supervision: { spawn: successfulSpawnRecorder(spawned) },
      },
    );

    assert.equal(await agent.call("review", {
      commandId: "test",
      executionWorkDir,
      retryCount: 0,
    }), "ok");
    assert.equal(spawned.options.cwd, executionWorkDir);
    assert.deepEqual(spawned.args, ["exec", "review"]);
  });

  it("starts a flagged provider inside the same execution work directory", async (t) => {
    const root = tmpDir();
    const executionWorkDir = path.join(root, "review-snapshot");
    fs.mkdirSync(executionWorkDir);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const spawned = {};
    const agent = makeAgent(
      { command: "worker", args: ["exec", "{{PROMPT}}"], workDirFlag: "--cwd" },
      {
        paths: { root, agentWorkDir: path.join(root, ".tmp") },
        supervision: { spawn: successfulSpawnRecorder(spawned) },
      },
    );

    assert.equal(await agent.call("review", {
      commandId: "test",
      executionWorkDir,
      retryCount: 0,
    }), "ok");
    assert.equal(spawned.options.cwd, executionWorkDir);
    assert.deepEqual(spawned.args, ["exec", "--cwd", executionWorkDir, "review"]);
  });

  it("keeps the repository root as the default child working directory", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const spawned = {};
    const agent = makeAgent(
      { command: "worker", args: ["exec", "{{PROMPT}}"] },
      {
        paths: { root, agentWorkDir: path.join(root, ".tmp") },
        supervision: { spawn: successfulSpawnRecorder(spawned) },
      },
    );

    assert.equal(await agent.call("review", { commandId: "test", retryCount: 0 }), "ok");
    assert.equal(spawned.options.cwd, root);
  });

  it("passes the spec schema through a schema-capable provider profile", (t) => {
    const root = tmpDir();
    const agentWorkDir = path.join(root, ".tmp");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = makeAgent(null, {
      config: { agent: { default: "codex/gpt-5.6-terra-medium" } },
      paths: { root, agentWorkDir },
    });
    const schema = { type: "object", properties: { goal: { type: "string" } } };

    const invocation = agent._buildInvocationForTest("write spec", {
      commandId: "flow.dispatch",
      executionWorkDir: root,
      jsonSchema: schema,
      fmtFallback: "FALLBACK SPEC INSTRUCTIONS",
    });

    assert.ok(invocation.finalArgs.includes("--output-schema"));
    assert.equal(invocation.pendingSchemaWrite != null, true);
    const providerSchema = JSON.parse(invocation.pendingSchemaWrite.content);
    assert.deepEqual(providerSchema.required, ["goal"]);
    assert.equal(providerSchema.additionalProperties, false);
    assert.deepEqual(providerSchema.properties.goal.type, ["string", "null"]);
    assert.doesNotMatch(invocation.finalArgs.join(" "), /FALLBACK SPEC INSTRUCTIONS/);
  });

  it("writes a Codex-compatible sealed handoff response schema", (t) => {
    const root = tmpDir();
    const agentWorkDir = path.join(root, ".tmp");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = makeAgent(null, {
      config: { agent: { default: "codex/gpt-5.6-terra-medium" } },
      paths: { root, agentWorkDir },
    });
    const canonical = JSON.parse(fs.readFileSync(WORKER_ARTIFACT_HANDOFF_SCHEMA_PATH, "utf8"));

    const invocation = agent._buildInvocationForTest("seal handoff", {
      commandId: "flow.dispatch",
      executionWorkDir: root,
      jsonSchema: canonical,
    });
    const providerSchema = JSON.parse(invocation.pendingSchemaWrite.content);

    assert.deepEqual(providerSchema.properties.sealed, { const: true, type: "boolean" });
    assert.ok(providerSchema.required.includes("runtimeLog"));
    assert.deepEqual(providerSchema.properties.runtimeLog.type, ["object", "null"]);
    assert.equal(providerSchema.properties.runtimeLog.additionalProperties, false);
    assert.deepEqual(canonical.properties.sealed, { const: true });
  });

  it("uses the equivalent prompt fallback for a provider without schema support", (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = makeAgent({
      command: "worker",
      args: ["{{PROMPT}}"],
      jsonSchemaFlag: "--schema",
    }, { paths: { root, agentWorkDir: path.join(root, ".tmp") } });

    const invocation = agent._buildInvocationForTest("write spec", {
      commandId: "flow.dispatch",
      executionWorkDir: root,
      jsonSchema: { type: "object" },
      fmtFallback: "FALLBACK SPEC INSTRUCTIONS",
    });

    assert.equal(invocation.pendingSchemaWrite, null);
    assert.equal(invocation.finalArgs.includes("--schema"), false);
    assert.match(invocation.finalArgs[0], /^FALLBACK SPEC INSTRUCTIONS\n\nwrite spec$/);
  });

  it("rejects an execution directory outside the repository before spawning", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = makeAgent(
      { command: "echo", args: ["{{PROMPT}}"] },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") } },
    );

    await assert.rejects(
      agent.call("work", {
        commandId: "test",
        executionWorkDir: path.dirname(root),
      }),
      (error) => (
        error instanceof AgentPermissionConfigurationFailure
        && error.code === "AGENT_PERMISSION_CONFIGURATION_FAILED"
        && error.retryable === false
        && /executionWorkDir must stay inside/.test(error.message)
      ),
    );
  });

  it("types work-directory setup failures before spawning", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agentWorkDir = path.join(root, "agent-work-file");
    fs.writeFileSync(agentWorkDir, "not a directory\n");
    const agent = makeAgent(
      { command: "echo", args: ["{{PROMPT}}"] },
      { paths: { root, agentWorkDir } },
    );

    await assert.rejects(
      agent.call("work", { commandId: "test" }),
      (error) => (
        error instanceof AgentPermissionConfigurationFailure
        && error.code === "AGENT_PERMISSION_CONFIGURATION_FAILED"
        && error.retryable === false
        && error.attemptCount === 1
        && error.maxAttempts === 1
      ),
    );
  });

  it("waits for a provider process group before returning when requested", async (t) => {
    const root = tmpDir();
    const marker = path.join(root, "descendant-finished.txt");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const descendant = [
      "const fs=require('node:fs');",
      `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},'done');},150);`,
    ].join("");
    const provider = [
      "const {spawn}=require('node:child_process');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
      "child.unref();",
      "process.stdout.write('provider returned');",
    ].join("");
    const agent = makeAgent(
      { command: process.execPath, args: ["-e", provider] },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") } },
    );

    const result = await agent.call("", {
      commandId: "test",
      retryCount: 0,
      waitForProcessTree: true,
    });

    assert.equal(result, "provider returned");
    assert.equal(fs.readFileSync(marker, "utf8"), "done");
  });

  it("kills a forked timed-out provider tree before releasing its review execution lease", async (t) => {
    if (process.platform === "win32") t.skip("POSIX process-group containment is covered by the Windows supervisor separately");
    const root = tmpDir();
    const marker = path.join(root, "forked-provider-child.pid");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const descendant = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));`,
      "setInterval(()=>{},1_000);",
    ].join("");
    const provider = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
      "setInterval(()=>{},1_000);",
    ].join("");
    const agent = makeAgent(
      { command: process.execPath, args: ["-e", provider] },
      {
        paths: { root, agentWorkDir: path.join(root, ".tmp") },
        config: {
          agent: {
            default: "test/exec",
            providers: { "test/exec": { command: process.execPath, args: ["-e", provider] } },
            timeout: 0.2,
          },
        },
      },
    );
    const identity = { mainRoot: root, runId: "timeout-run", nodeId: "spec-review", attemptId: "timeout-attempt" };
    const lease = new ReviewExecutionLease(identity);
    lease.acquire();
    try {
      await assert.rejects(agent.call("", {
        commandId: "test",
        retryCount: 0,
        waitForProcessTree: true,
      }), /timed out/i);
    } finally {
      lease.release();
    }
    await waitForFile(marker);
    await waitForProcessExit(Number.parseInt(fs.readFileSync(marker, "utf8"), 10));
    const afterTimeout = new ReviewExecutionLease(identity);
    afterTimeout.acquire();
    afterTimeout.release();
  });

  it("kills the inherited-output process tree when the activity monitor expires", async (t) => {
    if (process.platform === "win32") t.skip("POSIX process-group containment is covered by the Windows supervisor separately");
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const descendant = [
      "process.stdout.write('descendant:' + process.pid);",
      "setInterval(()=>{},1_000);",
    ].join("");
    const provider = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});`,
      "setInterval(()=>{},1_000);",
    ].join("");
    let timeout = null;
    let expired = false;
    const activityMonitor = {
      start(callback) { timeout = callback; },
      observeOutput() {
        if (expired) return;
        expired = true;
        timeout(new AgentTimeoutDiagnostic({ reason: "inactivity", timeoutMs: 123 }));
        timeout(new AgentTimeoutDiagnostic({ reason: "maximum_lifetime", timeoutMs: 456 }));
      },
      stop() {},
    };
    const supervisorEvents = [];
    const agent = makeAgent(
      { command: process.execPath, args: ["-e", provider] },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") } },
    );

    let failure;
    try {
      await agent.call("", {
        commandId: "test",
        retryCount: 0,
        waitForProcessTree: true,
        activityMonitor,
        onSupervisorEvent(event) { supervisorEvents.push(event); },
      });
    } catch (error) {
      failure = error;
    }

    assert.equal(failure.code, "AGENT_TIMEOUT");
    assert.equal(failure.timeoutReason, "inactivity");
    assert.equal(failure.timeoutMs, 123, "inactivity reports its own configured threshold, not the hard cap");
    assert.match(failure.message, /timed out after 123ms; reason=inactivity/);
    assert.deepEqual(
      supervisorEvents.filter((event) => event.type === "timeout").map((event) => event.reason),
      ["inactivity"],
      "the first timeout owns one process-tree shutdown",
    );
    const descendantPid = Number.parseInt(/descendant:(\d+)/.exec(failure.stdout)?.[1] ?? "", 10);
    assert.ok(Number.isSafeInteger(descendantPid));
    await waitForProcessExit(descendantPid);
  });

  it("retains lexical stdout and stderr on supervisor-owned timeout rejection", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const provider = "process.stdout.write('timeout stdout'); process.stderr.write('timeout stderr'); setInterval(()=>{},1000);";
    const agent = makeAgent(
      { command: process.execPath, args: ["-e", provider] },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") }, config: {
        agent: { default: "test/exec", providers: { "test/exec": { command: process.execPath, args: ["-e", provider] } }, timeout: 0.2 },
      } },
    );
    await assert.rejects(agent.call("", { commandId: "test", retryCount: 0, waitForProcessTree: true }), (error) => {
      assert.equal(error.code, "AGENT_TIMEOUT");
      assert.equal(error.stdout, "timeout stdout");
      assert.equal(error.stderr, "timeout stderr");
      return true;
    });
  });

  it("keeps ordinary timeout diagnostics byte-for-byte compatible", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = makeAgent(
      { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") }, config: {
        agent: { default: "test/exec", providers: { "test/exec": { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } }, timeout: 0.05 },
      } },
    );
    await assert.rejects(agent.call("", { commandId: "test", retryCount: 0 }), (error) => {
      assert.equal(error.message, "Agent timed out after 50ms; final action=SIGTERM");
      assert.equal(Object.hasOwn(error, "timeoutReason"), false);
      assert.equal(Object.hasOwn(error.toJSON(), "timeoutReason"), false);
      assert.equal(error.toJSON().timeoutMs, 50);
      return true;
    });
  });

  it("throws on failing command", async () => {
    const agent = makeAgent({ command: "node", args: ["-e", "process.exit(1)"] });
    await assert.rejects(agent.call("test", { commandId: "test" }));
  });

  it("persists complete failed subprocess output and links the diagnostic log", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stdout = "stdout-" + "x".repeat(500);
    const stderr = "stderr-" + "y".repeat(500);
    const script = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(1);`;
    const logger = new Logger({ logDir: path.join(root, ".tmp", "logs"), enabled: true, cwd: root });
    const agent = makeAgent(
      { command: "node", args: ["-e", script] },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") }, logger },
    );

    let error;
    try {
      await agent.call("test", { commandId: "test", retryCount: 0 });
    } catch (caught) {
      error = caught;
    }

    assert.ok(error instanceof Error);
    assert.equal(error.stdout, stdout);
    assert.equal(error.stderr, stderr);
    assert.match(error.message, /stdoutPreview=stdout-/);
    assert.ok(error.diagnosticLog);
    assert.match(error.message, /diagnosticLog=/);
    const diagnostic = JSON.parse(fs.readFileSync(error.diagnosticLog, "utf8"));
    assert.equal(diagnostic.response.stdout, stdout);
    assert.equal(diagnostic.response.stderr, stderr);
  });

  it("falls back to stdin when args exceed threshold", async () => {
    const agent = makeAgent(
      { command: "cat", args: [] },
      { config: { agent: { default: "test/exec", providers: { "test/exec": { command: "cat", args: [] } }, stdinFallbackThreshold: 1000 } } },
    );
    const largePrompt = "X".repeat(2000);
    const result = await agent.call(largePrompt, { commandId: "test" });
    assert.equal(result, largePrompt);
  });

  it("rejects too many execution environment variables before spawning", () => {
    const agent = makeAgent({ command: "echo", args: ["{{PROMPT}}"] });
    const executionEnvironment = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`SENNEL_TEST_${index}`, "value"]),
    );

    assert.throws(
      () => agent._buildInvocationForTest("work", { commandId: "test", executionEnvironment }),
      /must contain at most 64 variables/,
    );
  });

  it("rejects an oversized execution environment before spawning", () => {
    const agent = makeAgent({ command: "echo", args: ["{{PROMPT}}"] });

    assert.throws(
      () => agent._buildInvocationForTest("work", {
        commandId: "test",
        executionEnvironment: { SENNEL_TEST_VALUE: "x".repeat(64 * 1024) },
      }),
      /must not exceed 65536 bytes/,
    );
  });
});

describe("ChildProcessSupervisor", () => {
  it("settles after a bounded drain when the direct child exits without close", async () => {
    const child = new EventEmitter();
    const supervisor = new ChildProcessSupervisor({
      child,
      timeoutMs: 1_000,
      graceMs: 10,
      exitDrainMs: 1,
    });

    const completion = supervisor.wait();
    child.emit("exit", 0, null);

    assert.deepEqual(await completion, { code: 0, signal: null });
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.listenerCount("exit"), 0);
  });
});

describe("Agent.call() — retry behavior", () => {
  it("retries on empty response and succeeds", async () => {
    const tmp = path.join(os.tmpdir(), `agent-retry-${Date.now()}`);
    const script = `
      const fs = require("fs");
      const f = process.argv[1];
      let n = 0;
      try { n = Number(fs.readFileSync(f, "utf8")); } catch {}
      n++;
      fs.writeFileSync(f, String(n));
      if (n === 1) process.stdout.write("");
      else process.stdout.write("ok");
    `;
    const agent = makeAgent({ command: "node", args: ["-e", script, tmp] });
    const result = await agent.call("", { commandId: "test", retryCount: 2, retryDelayMs: 10 });
    assert.equal(result, "ok");
    try { fs.unlinkSync(tmp); } catch {}
  });

  it("types an empty response without retry when retryCount is 0", async () => {
    const agent = makeAgent({ command: "node", args: ["-e", ""] });
    await assert.rejects(
      agent.call("", { commandId: "test", retryCount: 0 }),
      (error) => (
        error instanceof EmptyAgentResponseFailure
        && error.retryable === true
        && error.attemptCount === 1
        && error.maxAttempts === 1
      ),
    );
  });

  it("does not retry an unexplained non-zero exit", async (t) => {
    const tmp = path.join(os.tmpdir(), `agent-retry-exit-${Date.now()}`);
    t.after(() => fs.rmSync(tmp, { force: true }));
    const script = `
      const fs = require("fs");
      const f = process.argv[1];
      let n = 0;
      try { n = Number(fs.readFileSync(f, "utf8")); } catch {}
      n++;
      fs.writeFileSync(f, String(n));
      process.exit(1);
    `;
    const agent = makeAgent({ command: "node", args: ["-e", script, tmp] });
    await assert.rejects(
      agent.call("", { commandId: "test", retryCount: 2, retryDelayMs: 10 }),
      (error) => (
        error instanceof UnknownProviderFailure
        && error.retryable === false
        && error.attemptCount === 1
        && error.maxAttempts === 3
      ),
    );
    assert.equal(fs.readFileSync(tmp, "utf8"), "1");
  });

  it("retries a rate limit and succeeds", async (t) => {
    const tmp = path.join(os.tmpdir(), `agent-retry-rate-limit-${Date.now()}`);
    t.after(() => fs.rmSync(tmp, { force: true }));
    const script = `
      const fs = require("fs");
      const f = process.argv[1];
      let n = 0;
      try { n = Number(fs.readFileSync(f, "utf8")); } catch {}
      n++;
      fs.writeFileSync(f, String(n));
      if (n === 1) {
        process.stderr.write("HTTP 429 rate limited");
        process.exit(1);
      }
      process.stdout.write("recovered");
    `;
    const agent = makeAgent({ command: "node", args: ["-e", script, tmp] });
    const result = await agent.call("", { commandId: "test", retryCount: 2, retryDelayMs: 10 });
    assert.equal(result, "recovered");
    assert.equal(fs.readFileSync(tmp, "utf8"), "2");
  });

  it("does not retry an authentication failure", async (t) => {
    const tmp = path.join(os.tmpdir(), `agent-no-retry-auth-${Date.now()}`);
    t.after(() => fs.rmSync(tmp, { force: true }));
    const script = `
      const fs = require("fs");
      const f = process.argv[1];
      let n = 0;
      try { n = Number(fs.readFileSync(f, "utf8")); } catch {}
      fs.writeFileSync(f, String(n + 1));
      process.stderr.write("HTTP 401 Unauthorized");
      process.exit(1);
    `;
    const agent = makeAgent({ command: "node", args: ["-e", script, tmp] });
    await assert.rejects(
      agent.call("", { commandId: "test", retryCount: 2, retryDelayMs: 10 }),
      (error) => (
        error instanceof AgentAuthenticationFailure
        && error.retryable === false
        && error.attemptCount === 1
        && error.maxAttempts === 3
      ),
    );
    assert.equal(fs.readFileSync(tmp, "utf8"), "1");
  });

  it("preserves bounded attempt metadata after retry exhaustion", async () => {
    const agent = makeAgent({
      command: "node",
      args: ["-e", "process.stderr.write('HTTP 429 rate limited'); process.exit(1)"],
    });
    await assert.rejects(
      agent.call("", { commandId: "test", retryCount: 1, retryDelayMs: 10 }),
      (error) => (
        error instanceof TemporaryRateLimitFailure
        && error.retryable === true
        && error.attemptCount === 2
        && error.maxAttempts === 2
      ),
    );
  });
});

describe("Agent.call() — prompt cache policy", () => {
  it("bypasses cache reads and writes only for cacheMode=bypass", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const countFile = path.join(root, "count.txt");
    const script = [
      "const fs=require('fs');",
      "const file=process.argv[1];",
      "let count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;",
      "count+=1;fs.writeFileSync(file,String(count));",
      "process.stdout.write('provider-'+count);",
    ].join("");
    const specId = "cache";
    const decisions = [];
    const cacheMetrics = [];
    const flowManager = {
      resolveCurrentContext() {
        return { specId, taskId: null, flowPhase: "impl" };
      },
      loadActiveFlows() { return [{ specId }]; },
      appendMetric(...args) { cacheMetrics.push(args); },
      accumulateAgentMetrics() {},
    };
    const agent = makeAgent(
      { command: "node", args: ["-e", script, countFile, "{{PROMPT}}"] },
      {
        paths: { root, agentWorkDir: path.join(root, ".tmp") },
        flowManager,
      },
    );

    const normal = await agent.call("same", {
      commandId: "test",
      onCacheDecision(decision) { decisions.push(decision); },
    });
    const cached = await agent.call("same", {
      commandId: "test",
      onCacheDecision(decision) { decisions.push(decision); },
    });
    const bypassed = await agent.call("same", {
      commandId: "test",
      cacheMode: "bypass",
      onCacheDecision(decision) { decisions.push(decision); },
    });
    const normalAgain = await agent.call("same", { commandId: "test" });

    assert.equal(normal, "provider-1");
    assert.equal(cached, "provider-1");
    assert.equal(bypassed, "provider-2");
    assert.equal(normalAgain, "provider-1");
    assert.deepEqual(decisions.map((entry) => entry.cacheOutcome), ["miss", "hit", "bypass"]);
    assert.deepEqual(cacheMetrics, [0, 1].map(() => [{
      phase: "impl",
      kind: "agent-cache",
      provider: "user",
      profileKey: "test/exec",
      callCount: 0,
      cachedResponse: true,
      responseChars: "provider-1".length,
    }, { specId, taskId: null }]));
  });

  it("refreshes without reading and stores only an accepted replacement", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const countFile = path.join(root, "count.txt");
    const script = [
      "const fs=require('fs');",
      "const file=process.argv[1];",
      "const n=(fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0)+1;",
      "fs.writeFileSync(file,String(n));process.stdout.write('provider-'+n);",
    ].join("");
    const specId = "cache-refresh";
    const flowManager = {
      resolveCurrentContext() { return { specId, taskId: null, flowPhase: "impl" }; },
      loadActiveFlows() { return [{ specId }]; },
      appendMetric() {},
      accumulateAgentMetrics() {},
    };
    const agent = makeAgent(
      { command: "node", args: ["-e", script, countFile, "{{PROMPT}}"] },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") }, flowManager },
    );
    const first = await agent.call("same", { commandId: "test" });
    const decisions = [];
    const refreshed = await agent.call("same", {
      commandId: "test",
      cacheMode: "refresh",
      validateResponseForCache: (value) => value === "provider-2",
      onCacheDecision: (decision) => decisions.push(decision),
    });
    const cached = await agent.call("same", {
      commandId: "test",
      validateResponseForCache: (value) => value === "provider-2",
    });
    assert.equal(first, "provider-1");
    assert.equal(refreshed, "provider-2");
    assert.equal(cached, "provider-2");
    assert.equal(fs.readFileSync(countFile, "utf8"), "2");
    assert.deepEqual(decisions, [{ cacheOutcome: "refresh", providerCalled: true, fresh: true }]);
  });

  it("treats an invalid cached response as a miss and replaces it only with a valid response", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const countFile = path.join(root, "count.txt");
    const script = [
      "const fs=require('fs');",
      "const file=process.argv[1];",
      "let count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;",
      "count+=1;fs.writeFileSync(file,String(count));",
      "process.stdout.write(count===1?'partial':'valid');",
    ].join("");
    const specId = "cache-contract";
    const flowManager = {
      resolveCurrentContext() { return { specId, taskId: null, flowPhase: "impl" }; },
      loadActiveFlows() { return [{ specId }]; },
      appendMetric() {},
      accumulateAgentMetrics() {},
    };
    const agent = makeAgent(
      { command: "node", args: ["-e", script, countFile, "{{PROMPT}}"] },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") }, flowManager },
    );
    await agent.call("same", { commandId: "test" });
    const decisions = [];
    const valid = await agent.call("same", {
      commandId: "test",
      validateResponseForCache: (text) => text === "valid",
      onCacheDecision: (decision) => decisions.push(decision),
    });
    const cached = await agent.call("same", {
      commandId: "test",
      validateResponseForCache: (text) => text === "valid",
      onCacheDecision: (decision) => decisions.push(decision),
    });

    assert.equal(valid, "valid");
    assert.equal(cached, "valid");
    assert.equal(fs.readFileSync(countFile, "utf8"), "2");
    assert.deepEqual(decisions.map((decision) => decision.cacheOutcome), ["invalid_hit", "hit"]);
    assert.deepEqual(decisions[0], {
      cacheOutcome: "invalid_hit",
      providerCalled: true,
      fresh: true,
    });
  });

  it("does not cache a fresh response rejected by the caller contract", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const countFile = path.join(root, "count.txt");
    const script = [
      "const fs=require('fs');",
      "const file=process.argv[1];",
      "let count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;",
      "count+=1;fs.writeFileSync(file,String(count));",
      "process.stdout.write('partial');",
    ].join("");
    const specId = "cache-fresh-contract";
    const flowManager = {
      resolveCurrentContext() { return { specId, taskId: null, flowPhase: "impl" }; },
      loadActiveFlows() { return [{ specId }]; },
      appendMetric() {},
      accumulateAgentMetrics() {},
    };
    const agent = makeAgent(
      { command: "node", args: ["-e", script, countFile, "{{PROMPT}}"] },
      { paths: { root, agentWorkDir: path.join(root, ".tmp") }, flowManager },
    );
    const options = { commandId: "test", validateResponseForCache: () => false };
    await agent.call("same", options);
    await agent.call("same", options);
    assert.equal(fs.readFileSync(countFile, "utf8"), "2");
  });

  it("serializes concurrent writers for one spec cache without losing accepted entries", async (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const specId = "concurrent";
    const cacheDirectory = path.join(root, ".sennel", "agent-cache");
    fs.mkdirSync(cacheDirectory, { recursive: true });
    // The large pre-existing v1 store keeps the legacy read-modify-write
    // windows overlapping after the barrier releases all providers.
    const entries = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [
      `existing-${index}`,
      { text: "x".repeat(4_096), storedAt: "2026-09-03T00:00:00.000Z" },
    ]));
    fs.writeFileSync(path.join(cacheDirectory, `${specId}.json`), `${JSON.stringify({ version: 1, entries })}\n`);
    const ready = path.join(root, "providers-ready.txt");
    const release = path.join(root, "release-providers");
    const module = [
      `import { Agent } from ${JSON.stringify(pathToFileURL(path.resolve("src/lib/agent.js")).href)};`,
      `import { ProviderRegistry } from ${JSON.stringify(pathToFileURL(path.resolve("src/lib/provider.js")).href)};`,
      `import { Logger } from ${JSON.stringify(pathToFileURL(path.resolve("src/lib/log.js")).href)};`,
      "import path from 'node:path';",
      "const [root, ready, release, prompt] = process.argv.slice(1);",
      "const provider = `const fs=require('fs');const [ready,release,text]=process.argv.slice(1);fs.appendFileSync(ready,text+'\\\\n');const wait=()=>fs.existsSync(release)?process.stdout.write(text):setTimeout(wait,5);wait();`;",
      "const profile = { command: process.execPath, args: ['-e', provider, ready, release, '{{PROMPT}}'] };",
      "const config = { agent: { default: 'test/exec', providers: { 'test/exec': profile }, timeout: 10 } };",
      "const flowManager = { resolveCurrentContext() { return { specId: 'concurrent', taskId: null, flowPhase: 'impl' }; }, loadActiveFlows() { return [{ specId: 'concurrent' }]; }, appendMetric() {}, accumulateAgentMetrics() {} };",
      "const agent = new Agent({ config, paths: { root, agentWorkDir: path.join(root, '.tmp') }, registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: root, enabled: false }), flowManager });",
      "await agent.call(prompt, { commandId: 'test', retryCount: 0 });",
    ].join("\n");
    const prompts = ["one", "two", "three", "four"];
    const writers = prompts.map((prompt) => runModuleProcess(module, [root, ready, release, prompt]));
    await waitForLineCount(ready, prompts.length);
    fs.writeFileSync(release, "go\n");
    await Promise.all(writers);

    const stored = JSON.parse(fs.readFileSync(path.join(cacheDirectory, `${specId}.json`), "utf8"));
    const responses = Object.values(stored.entries).map((entry) => entry.text);
    for (const prompt of prompts) assert.ok(responses.includes(prompt), `cache lost concurrent response ${prompt}`);
  });
});

describe("Agent.resolve(commandId) — profile resolution", () => {
  it("returns the configured default agent when no commandId is given", () => {
    const agent = makeAgent(null, {
      config: {
        agent: {
          default: "claude/opus",
          timeout: 300,
        },
      },
    });
    const resolved = agent.resolve();
    assert.ok(resolved);
    assert.equal(resolved.profile.command, "claude");
  });

  it("returns null when no agent configured", () => {
    const agent = makeAgent(null, { config: { agent: {} } });
    assert.equal(agent.resolve(), null);
  });

  it("resolves via useProfile and profile entry", () => {
    const cfg = {
      agent: {
        default: "claude/sonnet",
        useProfile: "high",
        profiles: { high: { docs: "claude/opus" } },
      },
    };
    const agent = makeAgent(null, { config: cfg });
    const resolved = agent.resolve("docs");
    assert.equal(resolved.profile.command, "claude");
    assert.ok(resolved.profile.args.includes("opus"));
  });

  it("matches profile entry by command-id prefix", () => {
    const cfg = {
      agent: {
        default: "claude/sonnet",
        useProfile: "high",
        profiles: { high: { docs: "claude/opus" } },
      },
    };
    const agent = makeAgent(null, { config: cfg });
    const resolved = agent.resolve("docs.review");
    assert.ok(resolved.profile.args.includes("opus"));
  });

  it("falls back to the default profile when the active profile has no command entry", () => {
    const cfg = {
      agent: {
        default: "codex/gpt-5.6-terra-medium",
        useProfile: "codex",
        profiles: {
          default: {
            "plugin.sample.publish": "claude/sonnet",
          },
          codex: {
            flow: "codex/gpt-5.6-terra-medium",
          },
        },
      },
    };
    const agent = makeAgent(null, { config: cfg });
    const resolved = agent.resolve("plugin.sample.publish");
    assert.equal(resolved.profile.command, "claude");
    assert.ok(resolved.profile.args.includes("sonnet"));
  });

  it("keeps active profile entries ahead of the default profile fallback", () => {
    const cfg = {
      agent: {
        default: "claude/sonnet",
        useProfile: "codex",
        profiles: {
          default: {
            "plugin.sample.publish": "claude/sonnet",
          },
          codex: {
            "plugin.sample.publish": "codex/gpt-5.6-terra-medium",
          },
        },
      },
    };
    const agent = makeAgent(null, { config: cfg });
    const resolved = agent.resolve("plugin.sample.publish");
    assert.equal(resolved.profile.command, "codex");
  });

  it("returns null when default provider is unknown", () => {
    const cfg = {
      agent: { default: "unknown-provider" },
    };
    const agent = makeAgent(null, { config: cfg });
    assert.equal(agent.resolve(), null);
  });

  it("includes timeoutMs from config agent.timeout (seconds to ms)", () => {
    const cfg = {
      agent: {
        default: "claude/opus",
        timeout: 600,
      },
    };
    const agent = makeAgent(null, { config: cfg });
    const resolved = agent.resolve();
    assert.equal(resolved.timeoutMs, 600000);
  });

  it("defaults timeoutMs to 1800000 when not configured", () => {
    const cfg = { agent: { default: "claude/opus" } };
    const agent = makeAgent(null, { config: cfg });
    const resolved = agent.resolve();
    assert.equal(resolved.timeoutMs, 1800000);
  });

  it("throws when SENNEL_PROFILE references an undefined profile", () => {
    const cfg = { agent: { default: "claude/opus", useProfile: "missing" } };
    const agent = makeAgent(null, { config: cfg });
    assert.throws(() => agent.resolve());
  });
});
