import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeJson } from "./tmp-dir.js";
import { CanonicalFlowFixture, makeFlowManager } from "../infrastructure/flow-setup.js";

export const SENNEL = join(process.cwd(), "src/sennel.js");

export function writeBaseConfig(tmp) {
  writeJson(tmp, ".sennel/config.json", {
    lang: "ja",
    type: "base",
    docs: { languages: ["ja"], defaultLanguage: "ja" },
  });
}

export function runToken(tmp, args = []) {
  return execFileSync("node", [SENNEL, "metrics", "token", ...args], {
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    cwd: tmp,
  });
}

export function runTokenJson(tmp) {
  return runToken(tmp, ["--format", "json"]);
}

export function runTokenCapture(tmp, args = ["--format", "json"]) {
  const res = spawnSync("node", [SENNEL, "metrics", "token", ...args], {
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: tmp, SENNEL_SOURCE_ROOT: tmp },
    cwd: tmp,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

export function readTokenCache(tmp) {
  return JSON.parse(readFileSync(join(tmp, ".sennel/output/metrics.json"), "utf8"));
}

export function writeTokenCache(tmp, cache) {
  mkdirSync(join(tmp, ".sennel", "output"), { recursive: true });
  writeFileSync(
    join(tmp, ".sennel/output/metrics.json"),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
}

function canonicalUsage(metric) {
  const tokens = metric.tokens ?? {};
  return {
    input_tokens: metric.input ?? tokens.input ?? 0,
    output_tokens: metric.output ?? tokens.output ?? 0,
    cache_read_tokens: metric.cacheRead ?? tokens.cacheRead ?? 0,
    cache_creation_tokens: metric.cacheCreation ?? tokens.cacheCreation ?? 0,
    ...(metric.cost === undefined ? {} : { cost_usd: metric.cost }),
  };
}

/**
 * Purpose-built fixture for the normal V1 token-metrics reader. It admits a
 * Flow with the production creation request, records Activity observations,
 * then reaches finalization through every typed lifecycle transition. It is
 * not a converter for arbitrary old flow.json blobs.
 */
export function createCanonicalTokenMetricsFlow(tmp, {
  specId = "001-alpha",
  request = "Collect token metrics.",
  goal = "Collect token metrics.",
  requirements = [],
  draftQuestions = 0,
  agentMetrics = [{ phase: "draft", input: 100, output: 50, cacheRead: 20, cacheCreation: 10, cost: 0.01, callCount: 2 }],
  issueEntries = [],
  finalized = true,
} = {}) {
  if (!Array.isArray(requirements) || !Array.isArray(agentMetrics) || !Array.isArray(issueEntries)) {
    throw new TypeError("canonical token metrics fixture collections must be arrays");
  }
  if (!Number.isSafeInteger(draftQuestions) || draftQuestions < 0) {
    throw new TypeError("canonical token metrics fixture draftQuestions must be a non-negative safe integer");
  }
  const flowManager = makeFlowManager(tmp);
  const normalizedRequirements = requirements.map((requirement, index) => ({
    ...requirement,
    task_ids: requirement.task_ids ?? [`T-metrics-${index + 1}`],
    ...(requirement.testable === undefined && requirement.preimplementation_test_expectation === undefined
      ? { testable: false }
      : {}),
  }));
  const flow = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId: `token-metrics-${specId}`,
    request,
    execution: { mode: "direct" },
    specRecord: { goal, requirements: normalizedRequirements },
  }).create();
  const taskIds = new Set(normalizedRequirements.flatMap((requirement) => requirement.task_ids));
  for (const taskId of taskIds) {
    flow.addTask({
      id: taskId,
      title: `Metrics fixture Task ${taskId}`,
      goal: `Provide canonical ownership for ${taskId}.`,
      origin: "plan",
      added_round: 0,
      status: "pending",
    });
  }

  for (let index = 0; index < draftQuestions; index += 1) {
    flowManager.incrementMetric("draft", "question", { specId });
  }
  for (const metric of agentMetrics) {
    if (metric === null || typeof metric !== "object" || Array.isArray(metric)) {
      throw new TypeError("canonical token metric must be an object");
    }
    flowManager.accumulateAgentMetrics(metric.phase ?? "draft", {
      specId,
      provider: metric.provider ?? "test-provider",
      profileKey: metric.profileKey ?? "test-profile",
      model: metric.model ?? "test-model",
      responseChars: metric.responseChars ?? 0,
      durationMs: metric.durationMs,
      usage: canonicalUsage(metric),
    });
  }
  if (issueEntries.length > 0) {
    flow.activate("branch", { settlePredecessors: false });
    for (const [index, entry] of issueEntries.entries()) {
      flowManager.appendIssueLog({
        specId,
        entry,
        idempotencyKey: `token-metrics-${specId}-issue-${index + 1}`,
      });
    }
    flow.settle("branch");
  }
  if (finalized) {
    const leafIds = flow.leaves().map((step) => step.id);
    for (const nodeId of leafIds) flow.settle(nodeId);
    flowManager.finalizeFlow(specId);
  }
  return Object.freeze({
    flowManager,
    flow,
    specId,
    location: flowManager.specLocation(specId),
  });
}
