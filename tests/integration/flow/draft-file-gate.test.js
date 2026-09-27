import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, mock } from "node:test";

import { buildGuardrailArticleEvalPrompt, checkGuardrail } from "../../../src/flow/lib/run-gate.js";
import { PromptLogicalFootprint, ResolvedAgentInvocationProjection } from "../../../src/lib/prompt-batching.js";

const rule = (id, body = "Report every marked violation.") => ({
  id, title: id, body, meta: { phase: ["draft"], category: "requirements" },
});

function filePathFromPrompt(prompt) {
  const match = /^Absolute file path: (.+)$/m.exec(prompt);
  assert.ok(match, "Draft must reference the complete file");
  return match[1];
}

async function withRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "draft-file-gate-"));
  try { return await callback(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

it("evaluates the exact oversized Draft bytes through a temporary file and removes it", async () => withRoot(async (root) => {
  const source = `HEAD\n${"あ".repeat(70000)}\nTAIL\n`;
  const seenPaths = [];
  const agent = {
    resolve: () => true,
    promptCharacterLimit: 60000,
    async call(prompt, options) {
      const filePath = filePathFromPrompt(prompt);
      seenPaths.push(filePath);
      assert.equal(fs.readFileSync(filePath, "utf8"), source);
      assert.match(prompt, new RegExp(`SHA-256 of exact UTF-8 bytes: ${crypto.createHash("sha256").update(source).digest("hex")}`));
      assert.ok(!prompt.includes("TAIL\n"));
      assert.deepEqual(options.jsonSchema.required, ["observations", "evaluationUnavailable"]);
      return JSON.stringify({ observations: [{
        failureMode: "guardrail-violation", requirementRef: "D1",
        where: { file: "draft.json", locator: "tail" }, observed: "TAIL is invalid",
      }], evaluationUnavailable: null });
    },
  };
  const result = await checkGuardrail(root, source, "draft", undefined, [], {
    agent, loadGuardrails: () => [rule("D1")],
  });
  assert.equal(result.passed, false, JSON.stringify(result));
  assert.equal(result.evaluations[0].observations[0].where.file, "draft.json");
  assert.equal(seenPaths.length, 1);
  assert.equal(fs.existsSync(seenPaths[0]), false);
}));

it("uses inline at the configured logical limit and file immediately below it", async () => withRoot(async (root) => {
  const source = "x".repeat(4000);
  const draftRule = rule("D1");
  const footprint = PromptLogicalFootprint.measure(buildGuardrailArticleEvalPrompt(
    source, [draftRule], "draft", undefined, [],
  ).build()).total;
  const paths = [];
  for (const [limit, expectedFile] of [[footprint, false], [footprint - 1, true]]) {
    const result = await checkGuardrail(root, source, "draft", undefined, [], {
      loadGuardrails: () => [draftRule],
      agent: { resolve: () => true, promptCharacterLimit: limit, async call(prompt) {
        const filePath = /^Absolute file path: (.+)$/m.exec(prompt)?.[1];
        assert.equal(Boolean(filePath), expectedFile);
        if (filePath) {
          paths.push(filePath);
          assert.equal(fs.readFileSync(filePath, "utf8"), source);
        } else {
          assert.equal(prompt.split("## Content\n")[1], source);
        }
        return JSON.stringify(expectedFile
          ? { observations: [], evaluationUnavailable: null }
          : { observations: [] });
      } },
    });
    assert.equal(result.passed, true, JSON.stringify(result));
  }
  assert.equal(paths.length, 1);
  assert.equal(fs.existsSync(paths[0]), false);
}));

it("keeps the same Draft file through format repair, then rejects an unavailable evaluation without repair", async () => withRoot(async (root) => {
  const source = "x".repeat(130000);
  const paths = [];
  let calls = 0;
  const agent = {
    resolve: () => true,
    async call(prompt) {
      calls += 1;
      const filePath = filePathFromPrompt(prompt);
      paths.push(filePath);
      assert.equal(fs.readFileSync(filePath, "utf8"), source);
      if (calls === 1) return "not json";
      return JSON.stringify({ observations: null, evaluationUnavailable: { reason: "The file exceeds available context." } });
    },
  };
  const result = await checkGuardrail(root, source, "draft", undefined, [], {
    agent, loadGuardrails: () => [rule("D1")],
  });
  assert.equal(result.passed, false);
  assert.equal(result.failureKind, "agent-evaluation");
  assert.match(result.failureReason, /exceeds available context/);
  assert.equal(calls, 2);
  assert.deepEqual(paths, [paths[0], paths[0]]);
  assert.equal(fs.existsSync(paths[0]), false);
}));

it("rejects missing, ambiguous and malformed Draft file outcomes after format repair", async () => withRoot(async (root) => {
  for (const response of [
    {},
    { observations: null, evaluationUnavailable: null },
    { observations: "invalid", evaluationUnavailable: { reason: "unread" } },
    { observations: [], evaluationUnavailable: { reason: "unread" } },
  ]) {
    let calls = 0;
    const result = await checkGuardrail(root, "x".repeat(130000), "draft", undefined, [], {
      loadGuardrails: () => [rule("D1")],
      agent: { resolve: () => true, async call() {
        calls += 1;
        return JSON.stringify(response);
      } },
    });
    assert.equal(result.passed, false, JSON.stringify(response));
    assert.equal(result.failureKind, "schema", JSON.stringify(response));
    assert.equal(calls, 2, JSON.stringify(response));
  }
}));

it("isolates simultaneous Draft file evaluations", async () => withRoot(async (root) => {
  const entered = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const agent = {
    resolve: () => true,
    async call(prompt) {
      const filePath = filePathFromPrompt(prompt);
      entered.push(filePath);
      if (entered.length === 2) release();
      await barrier;
      assert.ok(fs.existsSync(filePath));
      return JSON.stringify({ observations: [], evaluationUnavailable: null });
    },
  };
  const results = await Promise.all(["A", "B"].map((marker) => checkGuardrail(
    root, marker.repeat(130000), "draft", undefined, [], { agent, loadGuardrails: () => [rule("D1")] },
  )));
  assert.deepEqual(results.map((result) => result.passed), [true, true]);
  assert.equal(new Set(entered).size, 2);
  assert.ok(entered.every((filePath) => !fs.existsSync(filePath)));
}));

it("keeps small Draft inline and switches to file when the real invocation projection exceeds the limit", async () => withRoot(async (root) => {
  const seen = [];
  const agent = {
    resolve: () => true,
    promptCharacterLimit: 60000,
    projectInvocation(prompt) {
      return new ResolvedAgentInvocationProjection({
        providerKey: "fixture", profileKey: "fixture", command: "fixture",
        promptCharacterCount: prompt.includes("small Draft") ? 60001 : 1000,
        systemPromptCharacterCount: 1000, schemaCharacterCount: 1000,
        finalArgs: [], inlineArgvByteCount: 0, schemaMode: "file", usesStdin: true,
      });
    },
    async call(prompt) {
      seen.push(prompt);
      if (prompt.includes("small Draft")) throw new Error("projected overflow reached provider");
      assert.equal(fs.readFileSync(filePathFromPrompt(prompt), "utf8"), "small Draft");
      return JSON.stringify({ observations: [], evaluationUnavailable: null });
    },
  };
  const result = await checkGuardrail(root, "small Draft", "draft", undefined, [], {
    agent, loadGuardrails: () => [rule("D1")],
  });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(seen.length, 1);

  const inline = await checkGuardrail(root, "small Draft", "draft", undefined, [], {
    loadGuardrails: () => [rule("D1")],
    agent: { resolve: () => true, async call(prompt) {
      assert.match(prompt, /small Draft/);
      assert.doesNotMatch(prompt, /Absolute file path:/);
      return JSON.stringify({ observations: [] });
    } },
  });
  assert.equal(inline.passed, true, JSON.stringify(inline));
}));

it("does not publish a partial pass when a later whole-rule file group is unavailable", async () => withRoot(async (root) => {
  const paths = [];
  const source = "x".repeat(130000);
  const agent = {
    resolve: () => true,
    projectInvocation(_prompt, options) {
      const count = options.jsonSchema.properties.observations.items.properties.requirementRef.enum.length;
      return new ResolvedAgentInvocationProjection({
        providerKey: "fixture", profileKey: "fixture", command: "fixture",
        promptCharacterCount: count > 1 ? 120001 : 1000,
        systemPromptCharacterCount: 1000, schemaCharacterCount: 1000,
        finalArgs: [], inlineArgvByteCount: 0, schemaMode: "file", usesStdin: true,
      });
    },
    async call(prompt, options) {
      const filePath = filePathFromPrompt(prompt);
      paths.push(filePath);
      assert.equal(fs.readFileSync(filePath, "utf8"), source);
      const id = options.jsonSchema.properties.observations.items.properties.requirementRef.enum[0];
      return id === "D1"
        ? JSON.stringify({ observations: [{
          failureMode: "guardrail-violation", requirementRef: "D1",
          where: { file: "draft.json", locator: "first" }, observed: "First rule violation",
        }], evaluationUnavailable: null })
        : JSON.stringify({ observations: null, evaluationUnavailable: { reason: "Second rule could not be evaluated." } });
    },
  };
  const result = await checkGuardrail(root, source, "draft", undefined, [], {
    agent, loadGuardrails: () => [rule("D1"), rule("D2")],
  });
  assert.equal(result.passed, false);
  assert.match(result.failureReason, /Second rule could not be evaluated/);
  assert.deepEqual(result.evaluations, []);
  assert.equal(paths.length, 2);
  assert.equal(paths[0], paths[1]);
  assert.equal(fs.existsSync(paths[0]), false);
}));

it("removes its owned directory when the atomic Draft file write fails", async () => withRoot(async (root) => {
  const originalOpen = fs.openSync;
  const injected = mock.method(fs, "openSync", (filePath, ...args) => {
    if (String(filePath).includes("draft-gate-") && String(filePath).endsWith(".tmp")) {
      throw new Error("injected atomic write failure");
    }
    return originalOpen(filePath, ...args);
  });
  let calls = 0;
  let result;
  try {
    result = await checkGuardrail(root, "x".repeat(130000), "draft", undefined, [], {
      loadGuardrails: () => [rule("D1")],
      agent: { resolve: () => true, async call() { calls += 1; return "{}"; } },
    });
  } finally {
    injected.mock.restore();
  }
  assert.equal(result.passed, false);
  assert.match(result.failureReason, /injected atomic write failure/);
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, ".sennel", "agent-work")), []);
}));

it("removes the complete Draft file after a provider exception", async () => withRoot(async (root) => {
  let filePath;
  const result = await checkGuardrail(root, "x".repeat(130000), "draft", undefined, [], {
    loadGuardrails: () => [rule("D1")],
    agent: { resolve: () => true, async call(prompt) {
      filePath = filePathFromPrompt(prompt);
      assert.ok(fs.existsSync(filePath));
      throw new Error("provider unavailable");
    } },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.evaluations, []);
  assert.equal(fs.existsSync(filePath), false);
}));

it("refuses a single rule that cannot fit with the file reference before any provider call", async () => withRoot(async (root) => {
  let calls = 0;
  const result = await checkGuardrail(root, "x".repeat(130000), "draft", undefined, [], {
    loadGuardrails: () => [rule("D1", "r".repeat(130000))],
    agent: { resolve: () => true, async call() { calls += 1; return "{}"; } },
  });
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, "PROMPT_ELEMENT_TOO_LARGE");
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, ".sennel", "agent-work")), []);
}));

it("changes the file reference digest when Draft bytes change", async () => withRoot(async (root) => {
  const prompts = [];
  const agent = { resolve: () => true, async call(prompt) {
    prompts.push(prompt);
    return JSON.stringify({ observations: [], evaluationUnavailable: null });
  } };
  for (const marker of ["A", "B"]) {
    const result = await checkGuardrail(root, marker.repeat(130000), "draft", undefined, [], {
      agent, loadGuardrails: () => [rule("D1")],
    });
    assert.equal(result.passed, true, JSON.stringify(result));
  }
  const digests = prompts.map((prompt) => /^SHA-256 of exact UTF-8 bytes: ([a-f0-9]{64})$/m.exec(prompt)?.[1]);
  assert.deepEqual(digests, ["A", "B"].map((marker) => crypto.createHash("sha256").update(marker.repeat(130000)).digest("hex")));
  assert.notEqual(digests[0], digests[1]);
}));

it("fails safely when the Draft file cannot be created", async () => withRoot(async (root) => {
  fs.mkdirSync(path.join(root, ".sennel"));
  fs.writeFileSync(path.join(root, ".sennel", "agent-work"), "blocked");
  let calls = 0;
  const result = await checkGuardrail(root, "x".repeat(130000), "draft", undefined, [], {
    loadGuardrails: () => [rule("D1")],
    agent: { resolve: () => true, async call() { calls += 1; return "{}"; } },
  });
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, "GATE_REQUIRED_AGENT_EVALUATION");
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(path.join(root, ".sennel", "agent-work"), "utf8"), "blocked");
}));
