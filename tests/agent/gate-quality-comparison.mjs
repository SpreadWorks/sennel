import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function ensureBaselineArchive({ projectRoot, baselineRoot, revision }) {
  const marker = path.join(baselineRoot, "src/flow/lib/run-gate.js");
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(baselineRoot, { recursive: true });
  const archive = spawnSync("git", ["archive", revision, "--", "src", "package.json"],
    { cwd: projectRoot, maxBuffer: 100 * 1024 * 1024 });
  assert.equal(archive.status, 0, archive.stderr?.toString());
  const extract = spawnSync("tar", ["-x", "-C", baselineRoot], { input: archive.stdout });
  assert.equal(extract.status, 0, extract.stderr?.toString());
  assert.equal(fs.existsSync(path.join(baselineRoot, ".git")), false);
}

export class ProviderOutputMeter {
  constructor() { this.buffer = ""; this.launches = 0; this.usages = []; }

  add(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started") this.launches++;
        if (event.type === "turn.completed" && event.usage) this.usages.push(event.usage);
      } catch { /* Provider diagnostics may be plain text; Gate owns response parsing. */ }
    }
  }
}

export async function runGateTrial({ impl, config, trialRoot, source, phase, rules, options = {}, expectedProvider,
  onCallStart = null }) {
  fs.mkdirSync(trialRoot, { recursive: true });
  const real = new impl.Agent({
    config,
    paths: { root: trialRoot, agentWorkDir: path.join(trialRoot, "agent-work") },
    registry: new impl.ProviderRegistry(config.agent.providers ?? {}),
    logger: new impl.Logger({ logDir: path.join(trialRoot, "logs"), enabled: false }),
  });
  const resolved = real.resolve("flow.spec.gate");
  assert.equal(resolved.profileKey, expectedProvider);
  const metering = new ProviderOutputMeter();
  const promptMetrics = [];
  const calls = [];
  const agent = {
    promptCharacterLimit: real.promptCharacterLimit,
    resolve: (...args) => real.resolve(...args),
    projectInvocation: (...args) => real.projectInvocation(...args),
    call: async (prompt, callOptions) => {
      const start = performance.now();
      const entry = { durationMs: null, outcome: null, launches: 0, usage: [] };
      calls.push(entry);
      onCallStart?.(calls.length);
      const meter = new ProviderOutputMeter();
      try {
        const response = await real.call(prompt, {
          ...callOptions, cacheMode: "bypass", flowAttribution: "none",
          onStdout: (chunk) => { meter.add(chunk); metering.add(chunk); },
        });
        entry.outcome = "complete";
        return response;
      } catch (error) {
        entry.outcome = error.code ?? error.message;
        throw error;
      } finally {
        entry.durationMs = Math.round(performance.now() - start);
        entry.launches = meter.launches;
        entry.usage = meter.usages;
      }
    },
  };
  const start = performance.now();
  let result;
  try {
    result = await impl.gate.checkGuardrail(trialRoot, source, phase, undefined, [], {
      agent, loadGuardrails: () => rules, recordPromptMetric: (metric) => promptMetrics.push(metric), ...options,
    });
  } catch (error) {
    result = { failureCode: error.code ?? "THREW", failureKind: "exception", failureReason: error.message };
  }
  return {
    durationMs: Math.round(performance.now() - start),
    calls, promptMetrics,
    cliLaunchCount: promptMetrics.reduce((total, metric) => total + (metric.callCount ?? 0), 0),
    cliLaunchAuthority: "gate recordPromptMetric.callCount",
    observedThreadCount: metering.launches,
    usage: metering.usages,
    result,
  };
}
