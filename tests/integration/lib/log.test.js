import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
/**
 * Tests for the unified JSONL Logger.
 *
 * Logger is a container-managed service. These tests construct Logger
 * instances directly via `new Logger({ ... })` and verify:
 *
 *   - No-op behavior when `enabled` is false (R7).
 *   - Daily JSONL and per-request prompt JSON output (R1, R2, R3).
 *   - spec / flowPhase auto-resolution via the injected FlowManager (R4).
 *   - Logger.git / Logger.event API surface (R9).
 *   - requestId 8-char hex linkage between start/end and prompt files (R12).
 *   - I/O failure tolerance (AC10).
 *   - Caller-frame extraction excludes Logger's own file regardless of
 *     path representation differences (spec 186 R5).
 *   - No metric accumulation is attempted by the Logger (spec 186 R3).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { Logger } from "../../../src/lib/log.js";
import { todayLocal, readJsonl } from "../../support/infrastructure/log-fixtures.js";

/** Build a Logger with sensible defaults for tests. */
function buildLogger(tmpDir, opts = {}) {
  return new Logger({
    logDir: opts.logDir ?? tmpDir,
    enabled: opts.enabled ?? true,
    entryCommand: opts.entryCommand ?? "test",
    flowManager: opts.flowManager ?? null,
    flowAttribution: opts.flowAttribution ?? "ambient",
    cwd: opts.cwd ?? tmpDir,
  });
}

describe("Logger — disabled behavior", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTestDirectory("logger-init-");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("agent() is no-op when enabled=false", async () => {
    const inst = buildLogger(tmpDir, { enabled: false });
    await inst.agent({ phase: "start", requestId: "abcdef01" });
    await inst.agent({ phase: "end", requestId: "abcdef01", prompt: { user: "x" }, response: { text: "y" } });
    await inst.flush();
    assert.equal(fs.readdirSync(tmpDir).length, 0, "no files should be written when disabled");
  });

  it("git() and event() are no-op when disabled", async () => {
    const inst = buildLogger(tmpDir, { enabled: false });
    await inst.git({ cmd: ["status"], exitCode: 0, stderr: "" });
    await inst.event("test-event", { foo: "bar" });
    await inst.flush();
    assert.equal(fs.readdirSync(tmpDir).length, 0);
  });

  it("enabled flag reflects constructor value", () => {
    assert.equal(buildLogger(tmpDir, { enabled: false }).enabled, false);
    assert.equal(buildLogger(tmpDir, { enabled: true }).enabled, true);
  });
});

describe("Logger.agent — start/end events and JSONL output", () => {
  let tmpDir;
  let logFile;

  beforeEach(() => {
    tmpDir = createTestDirectory("logger-agent-");
    logFile = path.join(tmpDir, `sennel-${todayLocal()}.jsonl`);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes start event with minimal fields to daily JSONL", async () => {
    const inst = buildLogger(tmpDir, { entryCommand: "flow run gate" });
    await inst.agent({ phase: "start", requestId: "abcdef01" });
    await inst.flush();

    assert.ok(fs.existsSync(logFile));
    const entries = readJsonl(logFile);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.type, "agent");
    assert.equal(e.phase, "start");
    assert.equal(e.requestId, "abcdef01");
    assert.equal(e.entryCommand, "flow run gate");
    assert.ok(typeof e.ts === "string" && e.ts.length > 0);
    assert.ok(typeof e.pid === "number");
    assert.ok(typeof e.callerFile === "string");
    assert.ok(typeof e.callerLine === "number");
  });

  it("writes end event with denormalized rich record", async () => {
    const inst = buildLogger(tmpDir, { entryCommand: "flow run gate" });
    await inst.agent({
      phase: "end",
      requestId: "abcdef01",
      agentKey: "spec.gate",
      model: "claude-opus-4-6",
      prompt: { system: "sys", user: "user prompt body" },
      response: { text: "response body", exitCode: 0 },
      durationSec: 1.234,
    });
    await inst.flush();

    const entries = readJsonl(logFile);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.type, "agent");
    assert.equal(e.phase, "end");
    assert.equal(e.requestId, "abcdef01");
    assert.equal(e.agentKey, "spec.gate");
    assert.equal(e.model, "claude-opus-4-6");
    assert.equal(e.exitCode, 0);
    assert.equal(typeof e.promptChars, "number");
    assert.equal(typeof e.systemChars, "number");
    assert.equal(typeof e.userChars, "number");
    assert.equal(typeof e.promptLines, "number");
    assert.equal(typeof e.responseChars, "number");
    assert.equal(typeof e.responseLines, "number");
    assert.equal(typeof e.durationSec, "number");
    assert.equal(typeof e.promptFile, "string");
    assert.ok(e.promptFile.includes("prompts/"));
  });

  it("end event creates a self-contained prompt JSON file", async () => {
    const inst = buildLogger(tmpDir, { entryCommand: "flow run gate" });
    await inst.agent({
      phase: "end",
      requestId: "deadbeef",
      agentKey: "spec.gate",
      model: "claude-opus-4-6",
      prompt: { system: "system text", user: "user text" },
      response: { text: "response text", stdout: "raw stdout", stderr: "raw stderr", exitCode: 0 },
      durationSec: 0.5,
    });
    await inst.flush();

    const entries = readJsonl(logFile);
    const promptFile = path.resolve(tmpDir, entries[0].promptFile);
    assert.ok(fs.existsSync(promptFile));

    const promptJson = JSON.parse(fs.readFileSync(promptFile, "utf8"));
    assert.equal(promptJson.requestId, "deadbeef");
    assert.ok(promptJson.ts);
    assert.equal(promptJson.context.entryCommand, "flow run gate");
    assert.equal(promptJson.agent.key, "spec.gate");
    assert.equal(promptJson.agent.model, "claude-opus-4-6");
    assert.equal(promptJson.prompt.system, "system text");
    assert.equal(promptJson.prompt.user, "user text");
    assert.equal(typeof promptJson.prompt.stats.totalChars, "number");
    assert.equal(promptJson.response.text, "response text");
    assert.equal(promptJson.response.stdout, "raw stdout");
    assert.equal(promptJson.response.stderr, "raw stderr");
    assert.equal(promptJson.response.exitCode, 0);
  });

  it("spec and flowPhase are resolved via injected flowManager", async () => {
    const flowManager = {
      resolveCurrentContext: () => ({ specId: "153-unified-jsonl-logger", flowPhase: "gate" }),
    };
    const inst = buildLogger(tmpDir, { flowManager });
    await inst.agent({
      phase: "end",
      requestId: "abcdef02",
      agentKey: "spec.gate",
      model: "m",
      prompt: { user: "u" },
      response: { text: "r", exitCode: 0 },
      durationSec: 0.1,
    });
    await inst.flush();

    const entries = readJsonl(logFile);
    assert.equal(entries[0].specId, "153-unified-jsonl-logger");
    assert.equal(entries[0].flowPhase, "gate");
  });

  it("spec/flowPhase are null when no flowManager is provided", async () => {
    const inst = buildLogger(tmpDir);
    await inst.agent({
      phase: "end",
      requestId: "abcdef03",
      agentKey: "k",
      model: "m",
      prompt: { user: "u" },
      response: { text: "r", exitCode: 0 },
      durationSec: 0.1,
    });
    await inst.flush();
    const entries = readJsonl(logFile);
    assert.equal(entries[0].specId, null);
    assert.equal(entries[0].flowPhase, null);
  });

  it("does not inspect an ambient Flow when attribution is disabled", async () => {
    let contextReads = 0;
    const flowManager = {
      resolveCurrentContext: () => {
        contextReads += 1;
        throw new Error("stale active Flow must remain unread");
      },
    };
    const inst = buildLogger(tmpDir, { flowManager, flowAttribution: "none" });

    await inst.git({ cmd: ["git", "status"], exitCode: 0, stderr: "" });
    await inst.agent({ phase: "start", requestId: "abcdef05" });
    await inst.flush();

    assert.equal(contextReads, 0);
    const entries = readJsonl(logFile);
    assert.deepEqual(entries.map((entry) => entry.type), ["git", "agent"]);
    assert.equal(entries[1].specId, null);
    assert.equal(entries[1].flowPhase, null);
  });

  it("requestId links start/end and prompt file name", async () => {
    const inst = buildLogger(tmpDir);
    const reqId = "12345678";
    await inst.agent({ phase: "start", requestId: reqId });
    await inst.agent({
      phase: "end",
      requestId: reqId,
      agentKey: "k",
      model: "m",
      prompt: { user: "u" },
      response: { text: "r", exitCode: 0 },
      durationSec: 0.1,
    });
    await inst.flush();

    const entries = readJsonl(logFile);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].requestId, reqId);
    assert.equal(entries[1].requestId, reqId);
    const promptFile = path.resolve(tmpDir, entries[1].promptFile);
    assert.ok(promptFile.endsWith(`${reqId}.json`));
  });

  it("appends multiple events to the same daily file", async () => {
    const inst = buildLogger(tmpDir);
    await inst.agent({ phase: "start", requestId: "aaaaaaaa" });
    await inst.agent({ phase: "start", requestId: "bbbbbbbb" });
    await inst.agent({ phase: "start", requestId: "cccccccc" });
    await inst.flush();
    const entries = readJsonl(logFile);
    assert.equal(entries.length, 3);
  });

  it("does not call accumulateAgentMetrics (metric is agent's responsibility)", async () => {
    let called = false;
    const flowManager = {
      resolveCurrentContext: () => ({ spec: "186-logger-container-service", flowPhase: "test" }),
      accumulateAgentMetrics: () => { called = true; },
    };
    const inst = buildLogger(tmpDir, { flowManager });
    await inst.agent({
      phase: "end",
      requestId: "abcdef04",
      agentKey: "k",
      model: "m",
      prompt: { user: "u" },
      response: { text: "r", exitCode: 0 },
      durationSec: 0.1,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await inst.flush();
    assert.equal(called, false, "Logger must not accumulate metrics directly");
  });
});

describe("Logger.git and Logger.event — API surface", () => {
  let tmpDir;
  let logFile;

  beforeEach(() => {
    tmpDir = createTestDirectory("logger-git-");
    logFile = path.join(tmpDir, `sennel-${todayLocal()}.jsonl`);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("git() writes a fixed-structure JSONL line when enabled", async () => {
    const inst = buildLogger(tmpDir);
    await inst.git({ cmd: ["git", "status"], exitCode: 0, stderr: "" });
    await inst.flush();
    const entries = readJsonl(logFile);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.type, "git");
    assert.deepEqual(e.cmd, ["git", "status"]);
    assert.equal(e.exitCode, 0);
    assert.equal(e.stderr, "");
    assert.ok(e.ts);
    assert.equal(e.entryCommand, "test");
  });

  it("event() writes a named event with arbitrary fields", async () => {
    const inst = buildLogger(tmpDir);
    await inst.event("config-loaded", { provider: "claude", retries: 2 });
    await inst.flush();
    const entries = readJsonl(logFile);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.type, "event");
    assert.equal(e.name, "config-loaded");
    assert.equal(e.provider, "claude");
    assert.equal(e.retries, 2);
  });
});

describe("Logger — caller frame extraction", () => {
  let tmpDir;
  let logFile;

  beforeEach(() => {
    tmpDir = createTestDirectory("logger-caller-");
    logFile = path.join(tmpDir, `sennel-${todayLocal()}.jsonl`);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("callerFile points to the test file, not the Logger module", async () => {
    const inst = buildLogger(tmpDir);
    await inst.event("caller-check");
    await inst.flush();
    const entries = readJsonl(logFile);
    assert.equal(entries.length, 1);
    const cf = entries[0].callerFile;
    assert.ok(cf, "callerFile should be set");
    assert.ok(!cf.endsWith("/src/lib/log.js"), `callerFile should not be Logger itself: ${cf}`);
    assert.ok(cf.endsWith("log.test.js") || cf.includes("log.test.js"), `callerFile should point to the test: ${cf}`);
  });
});

describe("Logger — I/O failure tolerance", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTestDirectory("logger-fail-");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("agent() does not throw when log dir cannot be created", async () => {
    const inst = buildLogger(tmpDir, { logDir: "/nonexistent/cannot/write/here" });
    await assert.doesNotReject(inst.agent({ phase: "start", requestId: "abcdef01" }));
  });
});

// ─── Sensitive Information Masking (spec 192) ──────────────────────────────

describe("Logger — sensitive information masking", () => {
  let tmpDir;
  let logFile;
  const savedWorkRoot = process.env.SENNEL_WORK_ROOT;

  // Synthetic fake tokens assembled at runtime so the source does not
  // contain recognizable secret literals (guardrail: No Hardcoded Secrets).
  // None of these are real credentials — they are pattern-shaped fixtures.
  const FAKE = {
    ghp: ["g", "h", "p", "_"].join("") + "a".repeat(36),
    gho: ["g", "h", "o", "_"].join("") + "a".repeat(36),
    ghs: ["g", "h", "s", "_"].join("") + "a".repeat(36),
    ghr: ["g", "h", "r", "_"].join("") + "a".repeat(36),
    ghPat: ["g", "i", "t", "h", "u", "b"].join("") + "_pat_" + "A".repeat(22) + "_" + "X".repeat(59),
    urlCred: "user-fake:token-fake",
    bearer: "fake-bearer-" + "x".repeat(20),
    aws: ["A", "K", "I", "A"].join("") + "IOSFODNN7EXAMPLE",
  };

  beforeEach(() => {
    tmpDir = createTestDirectory("logger-mask-");
    logFile = path.join(tmpDir, `sennel-${todayLocal()}.jsonl`);
    process.env.SENNEL_WORK_ROOT = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedWorkRoot === undefined) delete process.env.SENNEL_WORK_ROOT;
    else process.env.SENNEL_WORK_ROOT = savedWorkRoot;
  });

  /** Run an action on a fresh Logger, flush, and return the first JSONL entry. */
  async function writeAndReadEntry(action) {
    const inst = buildLogger(tmpDir);
    await action(inst);
    await inst.flush();
    return readJsonl(logFile)[0];
  }

  it("masks GitHub classic PAT in git stderr", async () => {
    const entry = await writeAndReadEntry((inst) =>
      inst.git({ cmd: ["push"], exitCode: 1, stderr: "auth failed: " + FAKE.ghp })
    );
    assert.ok(!entry.stderr.includes(FAKE.ghp), `raw PAT should not appear: ${entry.stderr}`);
    assert.ok(entry.stderr.includes("***"), `mask token should be present: ${entry.stderr}`);
  });

  it("masks all GitHub token prefixes", async () => {
    const tokens = [FAKE.gho, FAKE.ghs, FAKE.ghr, FAKE.ghPat];
    const entry = await writeAndReadEntry((inst) =>
      inst.event("tokens", { line: tokens.join(" ") })
    );
    for (const tok of tokens) {
      assert.ok(!entry.line.includes(tok), `token should be masked: ${tok.slice(0, 8)}...`);
    }
  });

  it("masks HTTPS user:token credentials in URL", async () => {
    const entry = await writeAndReadEntry((inst) =>
      inst.git({
        cmd: ["push", `https://${FAKE.urlCred}@github.com/org/repo.git`],
        exitCode: 0,
        stderr: "",
      })
    );
    const joined = JSON.stringify(entry);
    assert.ok(!joined.includes(FAKE.urlCred), `credentials should not leak: ${joined}`);
    assert.ok(joined.includes("github.com"), `host should be preserved: ${joined}`);
  });

  it("masks Bearer tokens", async () => {
    const entry = await writeAndReadEntry((inst) =>
      inst.event("api-call", { header: `Authorization: Bearer ${FAKE.bearer}` })
    );
    assert.ok(!entry.header.includes(FAKE.bearer), `bearer token should be masked: ${entry.header}`);
  });

  it("masks AWS access key IDs", async () => {
    const entry = await writeAndReadEntry((inst) =>
      inst.event("aws", { note: `key=${FAKE.aws} rotated` })
    );
    assert.ok(!entry.note.includes(FAKE.aws), `AWS key should be masked: ${entry.note}`);
  });

  it("masks absolute paths outside SENNEL_WORK_ROOT", async () => {
    const entry = await writeAndReadEntry((inst) =>
      inst.event("extpath", { file: "/home/otheruser/.ssh/id_rsa" })
    );
    assert.ok(!entry.file.includes("/home/otheruser/.ssh/id_rsa"), `external path should be masked: ${entry.file}`);
  });

  it("does NOT mask paths inside SENNEL_WORK_ROOT", async () => {
    const insidePath = path.join(tmpDir, "specs", "foo.md");
    const entry = await writeAndReadEntry((inst) =>
      inst.event("intpath", { file: insidePath })
    );
    assert.equal(entry.file, insidePath, `internal path should be preserved: ${entry.file}`);
  });

  it("masks values in nested objects (recursive traversal)", async () => {
    const entry = await writeAndReadEntry((inst) =>
      inst.event("nested", { outer: { mid: { inner: FAKE.ghp } } })
    );
    assert.ok(!entry.outer.mid.inner.includes(FAKE.ghp.slice(0, 8)), `nested token should be masked: ${entry.outer.mid.inner}`);
  });

  it("preserves non-string values (numbers, booleans, null)", async () => {
    const entry = await writeAndReadEntry((inst) =>
      inst.event("types", { n: 42, b: true, x: null, arr: [1, 2, 3] })
    );
    assert.equal(entry.n, 42);
    assert.equal(entry.b, true);
    assert.equal(entry.x, null);
    assert.deepEqual(entry.arr, [1, 2, 3]);
  });

  it("masks multiple matches within one string", async () => {
    const ghpA = ["g","h","p","_"].join("") + "a".repeat(36);
    const ghpB = ["g","h","p","_"].join("") + "b".repeat(36);
    const entry = await writeAndReadEntry((inst) =>
      inst.event("multi", { line: `token1=${ghpA} and token2=${ghpB}` })
    );
    assert.ok(!entry.line.includes(ghpA), `first token should be masked: ${entry.line}`);
    assert.ok(!entry.line.includes(ghpB), `second token should be masked: ${entry.line}`);
  });

  it("masks sensitive data in agent prompt payload (system/user/response)", async () => {
    const inst = buildLogger(tmpDir);
    await inst.agent({
      phase: "end",
      requestId: "01234567",
      agentKey: "test",
      prompt: {
        system: `remember token ${FAKE.ghp}`,
        user: `call https://${FAKE.urlCred}@api.example.com/v1`,
      },
      response: {
        text: `ok, Bearer ${FAKE.bearer} received`,
        stdout: `provider stdout token ${FAKE.ghp}`,
        stderr: `provider stderr https://${FAKE.urlCred}@api.example.com/v1`,
        exitCode: 0,
      },
      durationSec: 0.1,
    });
    await inst.flush();
    const promptDir = path.join(tmpDir, "prompts", todayLocal());
    const promptFile = path.join(promptDir, "01234567.json");
    const payload = JSON.parse(fs.readFileSync(promptFile, "utf8"));
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes(FAKE.ghp), `system prompt token should be masked: ${serialized}`);
    assert.ok(!serialized.includes(FAKE.urlCred), `URL credentials should be masked: ${serialized}`);
    assert.ok(!serialized.includes(FAKE.bearer), `response bearer token should be masked: ${serialized}`);
  });

  it("stops recursion at depth 10 (bounded traversal)", async () => {
    let deep = FAKE.ghp;
    for (let i = 0; i < 15; i++) deep = { nested: deep };
    const entry = await writeAndReadEntry((inst) =>
      inst.event("deep", { tree: deep })
    );
    let node = entry.tree;
    while (node && typeof node === "object" && node.nested !== undefined) {
      node = node.nested;
    }
    assert.ok(typeof node === "string", `leaf should be a string: ${typeof node}`);
    assert.ok(node.includes(FAKE.ghp.slice(0, 4)), `below-depth-limit leaf should NOT be masked: ${node}`);
  });

  it("regex patterns are linear-time (no catastrophic backtracking)", async () => {
    const { maskSensitive } = await import("../../../src/lib/log-masking.js");
    const longInput = "a".repeat(10000) + " " + FAKE.ghp + " " + "z".repeat(10000);
    const start = Date.now();
    const out = maskSensitive(longInput);
    const duration = Date.now() - start;
    assert.ok(duration < 500, `masking 20KB input should complete quickly: ${duration}ms`);
    assert.ok(!out.includes(FAKE.ghp));
  });

  it("handles circular references without infinite recursion", async () => {
    const obj = { a: 1 };
    obj.self = obj;
    const entry = await writeAndReadEntry((inst) => inst.event("cycle", { data: obj }));
    assert.equal(entry.name, "cycle");
  });
});
