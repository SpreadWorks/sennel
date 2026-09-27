// Run directly: node tests/agent/draft-gate-full-file-quality.mjs [--limit=1]
// This expensive real-provider comparison is intentionally outside npm test:agent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baselineRevision = "aea1f13cf1a3556444aa50d7a8b6afc1bc3a168a";
const runRoot = path.join(projectRoot, ".tmp/draft-gate-full-file-quality");
const fixtureRoot = path.join(runRoot, "fixtures");
const manifestPath = path.join(projectRoot, "tests/agent/draft-gate-full-file-quality.manifest.json");
const baselineRoot = path.join(runRoot, "baseline");
const reportPath = path.join(projectRoot, "tests/agent/draft-gate-full-file-quality.report.json");
const originalPath = path.join(projectRoot, "specs/252-persistent-rules-injection/001/steps/draft/result.json");
const configured = JSON.parse(fs.readFileSync(path.join(projectRoot, ".sennel/config.json"), "utf8"));
const config = { agent: configured.agent };
const expectedProvider = "codex/gpt-6-sol-medium";
const original = fs.readFileSync(originalPath, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalSourceDigest = "2e54559096c0047638189df1cd643e4354216db81df4ce596bf951394218da6d";
assert.equal(sha256(original), canonicalSourceDigest, "Historical Draft seed changed; review expected outcomes before rerunning");

const rules = [
  {
    id: "checkpoint-timeout",
    title: "K7 checkpoint timeout consistency",
    body: "If this Draft defines a K7 checkpoint timeout, every normative K7 checkpoint timeout decision in a QA answer must equal the 14-second timeout stated in analysis.validation. Report one observation at each conflicting QA answer. Distinct conflicting answers are distinct violations. This rule applies only to K7 checkpoint timeout decisions, not other timing values.",
    meta: { phase: ["draft"], category: "testing" },
  },
  {
    id: "checkpoint-rejection-reason",
    title: "K7 rejected option reason",
    body: "If a QA answer rejects the K7 bulk-bypass option, that same answer must state a concrete reason for rejecting it. A reason in another answer cannot cure the omission. Report one observation at each offending QA answer. This rule applies only to K7 bulk-bypass decisions.",
    meta: { phase: ["draft"], category: "testing" },
  },
  {
    id: "draft-stage-validation",
    title: "Draft stage validation",
    body: "At Draft stage, a planned validation method in analysis.validation suffices. Executed test results belong to later stages. Their absence is never a violation of this Draft rule.",
    meta: { phase: ["draft"], category: "testing" },
  },
];

function syntheticQa(question, answer) {
  return { question, answer, evidence: "Synthetic comparison fixture; no external evidence asserted.",
    why: "This controlled entry tests complete-Draft evaluation.", considered: "No other option changes this K7 decision." };
}

function largeDraft(violation) {
  const draft = JSON.parse(original);
  draft.analysis.validation += " Controlled comparison addition: K7 checkpoint timeout is exactly 14 seconds. Planned validation compares the configured K7 timeout with 14 seconds before implementation; no tests have run at Draft stage.";
  const filler = Array.from({ length: 9 }, (_, index) => syntheticQa(
    `Synthetic comparison context ${index + 1}: what is the migration inventory boundary?`,
    `The existing migration inventory remains unchanged. ${"This paragraph records background on the existing rule migration without defining K7 checkpoint behavior. ".repeat(17)}`,
  ));
  draft.qa.splice(2, 0, ...filler.slice(0, 3));
  draft.qa.splice(9, 0, syntheticQa("Synthetic K7 checkpoint decision A: what timeout applies?",
    `The K7 checkpoint timeout is exactly ${violation ? 29 : 14} seconds. This is a normative decision for the same K7 checkpoint operation named in analysis.validation.`));
  draft.qa.splice(12, 0, ...filler.slice(3, 6));
  draft.qa.splice(19, 0, syntheticQa("Synthetic K7 rejected option decision: why reject bulk-bypass?",
    violation ? "The K7 bulk-bypass option is rejected. The planned implementation uses the ordinary checkpoint path."
      : "The K7 bulk-bypass option is rejected because bypassing the checkpoint would lose the audit record required for recovery. The planned implementation uses the ordinary checkpoint path."));
  draft.qa.splice(21, 0, ...filler.slice(6));
  draft.qa.push(syntheticQa("Synthetic K7 checkpoint decision B: what timeout applies?",
    `The K7 checkpoint timeout is exactly ${violation ? 41 : 14} seconds. This is a normative decision for the same K7 checkpoint operation named in analysis.validation.`));
  const text = `${JSON.stringify(draft, null, 2)}\n`;
  assert.ok(text.length > 60_000, `large Draft must exceed configured prompt limit: ${text.length}`);
  return text;
}

function smallDraft() {
  return `${JSON.stringify({
    devType: "feature",
    goal: "Plan a K7 checkpoint with a consistent timeout and a recorded decision.",
    analysis: {
      problem: "A checkpoint may lose its audit record if it is bypassed.",
      proposedApproach: "Use the normal checkpoint path and keep an audit record.",
      validation: "K7 checkpoint timeout is exactly 14 seconds. A planned deterministic check will verify the 14-second setting; execution belongs to later stages.",
    },
    decisionMap: { knownFacts: [], decisionPoints: [], resolvedByProjectRules: [], requiresUserJudgment: [], deferredToSpec: [] },
    scopeVerification: { in: ["K7 checkpoint"], out: [] }, impactOnExisting: [],
    questionLedger: { revision: 0, publication: "fixture", evidenceDigest: "a".repeat(64), questions: [] },
    qa: [syntheticQa("Why reject the K7 bulk-bypass option?",
      "The K7 bulk-bypass option is rejected because bypassing the checkpoint would lose the audit record needed for recovery. The K7 checkpoint timeout is exactly 14 seconds.")],
    openQuestions: [],
  }, null, 2)}\n`;
}

const cases = [
  { id: "large-violation", source: largeDraft(true), expected: [
    { rule: "checkpoint-timeout", marker: "29 seconds", locator: "Synthetic K7 checkpoint decision A" },
    { rule: "checkpoint-timeout", marker: "41 seconds", locator: "Synthetic K7 checkpoint decision B" },
    { rule: "checkpoint-rejection-reason", marker: "bulk-bypass", locator: "Synthetic K7 rejected option decision" },
  ] },
  { id: "large-normal", source: largeDraft(false), expected: [] },
  { id: "small-normal", source: smallDraft(), expected: [] },
];

function materializeFixtures() {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  for (const scenario of cases) {
    const file = path.join(fixtureRoot, `${scenario.id}.json`);
    if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, "utf8"), scenario.source,
      `Frozen fixture ${scenario.id} changed; review expectations before rerunning`);
    else fs.writeFileSync(file, scenario.source);
  }
  const metadata = {
    baselineRevision, historicalSeed: path.relative(projectRoot, originalPath), historicalSeedSha256: canonicalSourceDigest,
    historicalSeedCharacters: original.length, syntheticChanges: [
      "analysis.validation adds a planned K7 14-second checkpoint validation",
      "nine neutral QA entries extend the real Draft beyond 60,000 characters",
      "three K7 QA entries at separated positions vary between violation and normal versions",
      "small-normal is entirely synthetic and follows the current canonical Draft shape",
    ],
    rules, cases: cases.map(({ id, source, expected }) => ({ id, sha256: sha256(source), characters: source.length, expected })),
  };
  const file = manifestPath;
  const bytes = `${JSON.stringify(metadata, null, 2)}\n`;
  if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, "utf8"), bytes,
    "Frozen fixture manifest changed; review expected outcomes before rerunning");
  else fs.writeFileSync(file, bytes);
  return metadata;
}

function ensureBaseline() {
  const marker = path.join(baselineRoot, "src/flow/lib/run-gate.js");
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(baselineRoot, { recursive: true });
  const archive = spawnSync("git", ["archive", baselineRevision, "--", "src", "package.json"],
    { cwd: projectRoot, maxBuffer: 100 * 1024 * 1024 });
  assert.equal(archive.status, 0, archive.stderr?.toString());
  const extract = spawnSync("tar", ["-x", "-C", baselineRoot], { input: archive.stdout });
  assert.equal(extract.status, 0, extract.stderr?.toString());
  assert.equal(fs.existsSync(path.join(baselineRoot, ".git")), false);
}

class ProviderOutputMeter {
  constructor() { this.buffer = ""; this.launches = 0; this.usages = []; }
  add(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started") this.launches++;
        if (event.type === "turn.completed" && event.usage) this.usages.push(event.usage);
      } catch { /* Codex may emit non-JSON diagnostics; the gate owns response parsing. */ }
    }
  }
}

function classify(scenario, result) {
  if (result.failureCode || result.failureKind) return { category: "error", reason: result.failureReason ?? result.failureCode };
  const findings = (result.evaluations ?? []).filter((item) => item.result === "fail").map((item) => ({
    rule: item.guardrail_id, observed: item.reason ?? "", where: item.observations?.[0]?.where ?? null,
  }));
  const qa = JSON.parse(scenario.source).qa;
  const matches = (finding, expected) => {
    if (finding.rule !== expected.rule || finding.where?.file !== "draft.json") return false;
    const index = qa.findIndex((entry) => entry.question === `${expected.locator}: ${
      expected.rule === "checkpoint-rejection-reason" ? "why reject bulk-bypass?" : "what timeout applies?"}`);
    assert.notEqual(index, -1, `missing frozen QA location: ${expected.locator}`);
    const locator = finding.where.locator?.toLowerCase() ?? "";
    const pointsToQa = locator.includes(expected.locator.toLowerCase())
      || new RegExp(`(?:^|[./\\s])qa\\s*(?:\\[|[./])?${index}(?:\\]|[./\\s]|$)`, "i").test(locator);
    if (!pointsToQa || !finding.observed.toLowerCase().includes(expected.marker.toLowerCase())) return false;
    if (expected.rule === "checkpoint-timeout") {
      return /14(?:\s|-)?second|14\s*s\b/i.test(finding.observed)
        && /conflict|inconsisten|different|specifies|requires|should|change/i.test(finding.observed);
    }
    return /reason|because|why|without|missing|omits|omit|no rationale/i.test(finding.observed);
  };
  const covered = new Set();
  for (const expected of scenario.expected) {
    const match = findings.findIndex((finding, index) => !covered.has(index) && matches(finding, expected));
    if (match >= 0) covered.add(match);
  }
  const miss = scenario.expected.filter((expected) => !findings.some((finding) => matches(finding, expected)));
  const extras = findings.filter((_, index) => !covered.has(index));
  return {
    category: miss.length ? (result.passed ? "false-PASS" : "miss") : extras.length ? "false-positive" : "correct",
    miss, extras, findings,
  };
}

async function main() {
  materializeFixtures();
  ensureBaseline();
  const [currentGate, baselineGate, currentAgentModule, baselineAgentModule, currentProviderModule,
    baselineProviderModule, currentLogModule, baselineLogModule] = await Promise.all([
    import(pathToFileURL(path.join(projectRoot, "src/flow/lib/run-gate.js"))),
    import(pathToFileURL(path.join(baselineRoot, "src/flow/lib/run-gate.js"))),
    import(pathToFileURL(path.join(projectRoot, "src/lib/agent.js"))),
    import(pathToFileURL(path.join(baselineRoot, "src/lib/agent.js"))),
    import(pathToFileURL(path.join(projectRoot, "src/lib/provider.js"))),
    import(pathToFileURL(path.join(baselineRoot, "src/lib/provider.js"))),
    import(pathToFileURL(path.join(projectRoot, "src/lib/log.js"))),
    import(pathToFileURL(path.join(baselineRoot, "src/lib/log.js"))),
  ]);
  const versions = {
    file: { gate: currentGate, Agent: currentAgentModule.Agent, ProviderRegistry: currentProviderModule.ProviderRegistry, Logger: currentLogModule.Logger },
    baseline: { gate: baselineGate, Agent: baselineAgentModule.Agent, ProviderRegistry: baselineProviderModule.ProviderRegistry, Logger: baselineLogModule.Logger },
  };
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : {
    version: 1, manifestSha256: sha256(fs.readFileSync(manifestPath)),
    baselineRevision, configuredProfile: config.agent.useProfile, configuredCommand: "flow.spec.gate",
    expectedProvider, configuredAgent: config.agent, cacheMode: "bypass", trials: [],
  };
  assert.equal(report.manifestSha256, sha256(fs.readFileSync(manifestPath)));
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice(8)) : Infinity;
  let executed = 0;
  for (const scenario of cases) {
    for (let pair = 1; pair <= 5; pair++) {
      for (const version of pair % 2 ? ["file", "baseline"] : ["baseline", "file"]) {
        const id = `${scenario.id}/${pair}/${version}`;
        if (report.trials.some((entry) => entry.id === id)) continue;
        if (executed >= limit) return;
        const trialRoot = path.join(runRoot, "trials", id.replaceAll("/", "-"));
        fs.mkdirSync(trialRoot, { recursive: true });
        const impl = versions[version];
        const real = new impl.Agent({ config, paths: { root: trialRoot, agentWorkDir: path.join(trialRoot, "agent-work") },
          registry: new impl.ProviderRegistry(config.agent.providers ?? {}),
          logger: new impl.Logger({ logDir: path.join(trialRoot, "logs"), enabled: false }) });
        const resolved = real.resolve("flow.spec.gate");
        assert.equal(resolved.profileKey, expectedProvider);
        const metering = new ProviderOutputMeter();
        const promptMetrics = [];
        const calls = [];
        const agent = {
          promptCharacterLimit: real.promptCharacterLimit,
          resolve: (...args) => real.resolve(...args),
          projectInvocation: (...args) => real.projectInvocation(...args),
          call: async (prompt, options) => {
            const start = performance.now();
            const entry = { durationMs: null, outcome: null, launches: 0, usage: [] };
            calls.push(entry);
            const meter = new ProviderOutputMeter();
            try {
              const response = await real.call(prompt, { ...options, cacheMode: "bypass", flowAttribution: "none",
                onStdout: (chunk) => { meter.add(chunk); metering.add(chunk); } });
              entry.outcome = "complete";
              return response;
            } catch (error) { entry.outcome = error.code ?? error.message; throw error; }
            finally { entry.durationMs = Math.round(performance.now() - start); entry.launches = meter.launches; entry.usage = meter.usages; }
          },
        };
        const start = performance.now();
        let result;
        try { result = await impl.gate.checkGuardrail(trialRoot, scenario.source, "draft", undefined, [],
          { agent, loadGuardrails: () => rules, recordPromptMetric: (metric) => promptMetrics.push(metric) }); }
        catch (error) { result = { failureCode: error.code ?? "THREW", failureKind: "exception", failureReason: error.message }; }
        const gateSourcePath = path.join(version === "file" ? projectRoot : baselineRoot, "src/flow/lib/run-gate.js");
        const planSourcePath = path.join(version === "file" ? projectRoot : baselineRoot, "src/flow/lib/gate-prompt-plan.js");
        const trial = { id, scenario: scenario.id, pair, version, sourceSha256: sha256(scenario.source),
          productSha256: { runGate: sha256(fs.readFileSync(gateSourcePath)), promptPlan: sha256(fs.readFileSync(planSourcePath)) },
          durationMs: Math.round(performance.now() - start), calls, cliLaunchCount: metering.launches,
          cliLaunchAuthority: "gate recordPromptMetric.callCount", promptMetrics,
          observedThreadCount: metering.launches, usage: metering.usages, result, assessment: classify(scenario, result),
          manualReview: "pending" };
        trial.cliLaunchCount = promptMetrics.reduce((total, metric) => total + (metric.callCount ?? 0), 0);
        report.trials.push(trial);
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`${id}: ${trial.assessment.category} ${trial.durationMs}ms ${trial.cliLaunchCount} CLI launches\n`);
        executed++;
      }
    }
  }
}

await main();
