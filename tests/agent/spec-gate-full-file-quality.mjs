// Prepare with the actual configured repository: node tests/agent/spec-gate-full-file-quality.mjs --prepare --config-root=<repo>
// Then: node tests/agent/spec-gate-full-file-quality.mjs [--config-root=<repo>] [--limit=1]
// This expensive real-provider comparison is intentionally outside npm test:agent.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AtomicFile } from "../../src/lib/atomic-file.js";
import { loadRawConfigFromManagedDirectory } from "../../src/lib/config.js";
import { ensureBaselineArchive, runGateTrial, sha256 } from "./gate-quality-comparison.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baselineRevision = "4651be1e23b9ada1c978c6b89cf3137892083b8b";
const seedPath = path.join(projectRoot, "specs/256-draft-review-goal-achievability/001/spec.json");
const manifestPath = path.join(projectRoot, "tests/agent/spec-gate-full-file-quality.manifest.json");
const reportPath = path.join(projectRoot, "tests/agent/spec-gate-full-file-quality.report.json");
const runRoot = path.join(projectRoot, ".tmp/spec-gate-full-file-quality");
const baselineRoot = path.join(runRoot, "baseline");
const seedBytes = fs.readFileSync(seedPath);
const seed = JSON.parse(seedBytes);
const canonicalSeed = `${JSON.stringify(seed, null, 2)}\n`;
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

const rules = [
  { id: "k7-timeout", title: "K7 checkpoint timeout consistency",
    body: "If scope.in identifies task T-K7 as the authority for the K7 checkpoint timeout, read that task's normative timeout and compare every normative K7 checkpoint timeout decision in requirements against it. Report one separate observation at each conflicting requirement, explaining the requirement value and the task value. Only K7 checkpoint timeout decisions count; other timing values do not.",
    meta: { phase: ["spec"], category: "testing" } },
  { id: "k7-bypass-reason", title: "K7 bypass rejection reason",
    body: "If a requirement rejects the K7 bulk-bypass option, that same requirement must give a concrete reason. A reason elsewhere cannot cure its omission. Report one observation at each offending requirement. This rule applies only to K7 bulk-bypass decisions.",
    meta: { phase: ["spec"], category: "testing" } },
  { id: "k7-justified-exception", title: "K7 non-testable exception",
    body: "If a K7 glossary-only requirement declares a verification exception, accept an exact reference to an overview decision only when that decision explicitly explains why no runtime behavior, observable output, or API can be tested. Do not report a missing justification when that condition is met. A bare decision ID without the explanation is insufficient.",
    meta: { phase: ["spec"], category: "testing" } },
  { id: "spec-stage-planning", title: "Spec stage planning evidence",
    body: "For these K7 decisions, planned checks and passing conditions stated in the Spec suffice at Spec stage. Executed test results belong to later implementation and acceptance stages; their absence is never a violation of this rule.",
    meta: { phase: ["spec"], category: "testing" } },
];

function largeViolation() {
  const spec = structuredClone(seed);
  spec.scope.in.unshift("The K7 checkpoint timeout is defined by task T-K7. Requirements for this same K7 checkpoint operation must agree with the normative timeout in that task.");
  spec.overview.decisions.push({ text: "Decision K7-EX-1: a K7 glossary-only label change alters no runtime behavior, observable output, or API. No runtime verification is possible for that label-only change; this is the explicit reason for its exception." });
  spec.tasks.push({ id: "T-K7", title: "Implement K7 checkpoint", goal: "The normative timeout for the K7 checkpoint operation is exactly 14 seconds.",
    acceptance: ["A checkpoint before 14 seconds succeeds; one at 14 seconds times out."],
    implementation_notes: "Use the same K7 checkpoint operation referenced by scope.in and the requirements.",
    test_strategy: "Plan a deterministic boundary test for the 14-second timeout; executed results belong to later stages.",
    parent: null, origin: "plan", added_round: 0, status: "pending", key: "k7-checkpoint" });
  spec.requirements[20].desc += " K7 checkpoint decision A: the same K7 checkpoint operation defined by task T-K7 has a timeout of exactly 29 seconds. This requirement is normative.";
  spec.requirements[70].desc += " K7 bulk-bypass decision: reject the K7 bulk-bypass option and use the ordinary checkpoint path.";
  spec.requirements[100].desc += " K7 checkpoint decision B: the same K7 checkpoint operation defined by task T-K7 has a timeout of exactly 41 seconds. This requirement is normative.";
  spec.requirements[120].desc += " K7 glossary-only verification exception: decision K7-EX-1 gives the reason this label-only change has no testable runtime behavior.";
  return serialize(spec);
}

function smallNormal() {
  return serialize({
    goal: "Plan a K7 checkpoint with a consistent timeout and a recorded decision.",
    background: "This is a pre-implementation Spec. Checks are planned; executed results will be supplied during implementation and acceptance.",
    scope: { in: ["Task T-K7 defines the normative K7 checkpoint timeout for this same operation."], out: [] },
    constraints: [], design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [{ text: "Decision K7-EX-1: the K7 glossary-only label changes no runtime behavior, observable output, or API, so no runtime verification is possible." }] },
    requirements: [
      { id: "R1", desc: "K7 checkpoint timeout is exactly 14 seconds. Planned verification checks success before 14 seconds and timeout at 14 seconds.", priority: "must", status: "pending" },
      { id: "R2", desc: "Reject K7 bulk-bypass because it would lose the audit record required for recovery. Use the ordinary checkpoint path.", priority: "must", status: "pending" },
      { id: "R3", desc: "K7 glossary-only verification exception: decision K7-EX-1 explains why the label-only change has no testable runtime behavior.", priority: "must", status: "pending" },
    ],
    tasks: [{ id: "T-K7", title: "Implement K7", goal: "The normative K7 checkpoint timeout is exactly 14 seconds.",
      acceptance: ["A checkpoint before 14 seconds succeeds; one at 14 seconds times out."],
      origin: "plan", added_round: 0, status: "pending" }],
    acceptance_criteria: [], clarifications: [], alternatives_considered: [], open_questions: [], keywords: [],
  });
}

const cases = [
  { id: "large-real-normal", source: canonicalSeed, sourceKind: "unchanged saved Spec", expected: [] },
  { id: "large-derived-violation", source: largeViolation(), sourceKind: "saved Spec with controlled additions", expected: [
    { rule: "k7-timeout", requirementIndex: 20, marker: "29 seconds", baseline: "14 seconds" },
    { rule: "k7-bypass-reason", requirementIndex: 70, marker: "bulk-bypass", baseline: "reason" },
    { rule: "k7-timeout", requirementIndex: 100, marker: "41 seconds", baseline: "14 seconds" },
  ] },
  { id: "small-normal", source: smallNormal(), sourceKind: "synthetic current-shape Spec", expected: [] },
];

function configuredAgentSnapshot(configRoot) {
  const basePath = path.join(configRoot, ".sennel/config.json");
  const localPath = path.join(configRoot, ".sennel/config.local.json");
  const configured = loadRawConfigFromManagedDirectory(path.dirname(basePath));
  return {
    agent: configured.agent,
    baseConfigSha256: sha256(fs.readFileSync(basePath)),
    localConfigSha256: sha256(fs.readFileSync(localPath)),
  };
}

function materializeManifest() {
  const configRootArg = process.argv.find((arg) => arg.startsWith("--config-root="));
  const configRoot = configRootArg?.slice("--config-root=".length);
  assert.ok(configRoot || fs.existsSync(manifestPath),
    "Initial preparation requires --config-root=<repository with actual config.local.json>");
  const prior = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  const configured = configRoot ? configuredAgentSnapshot(path.resolve(configRoot)) : {
    agent: prior.configuredAgent, baseConfigSha256: prior.configuredBaseSha256,
    localConfigSha256: prior.configuredLocalSha256,
  };
  const metadata = {
    version: 1,
    baselineRevision,
    savedSpec: path.relative(projectRoot, seedPath),
    savedSpecBytesSha256: sha256(seedBytes), savedSpecBytes: seedBytes.length,
    canonicalGateInputSha256: sha256(canonicalSeed), canonicalGateInputCharacters: canonicalSeed.length,
    syntheticChanges: [
      "large-derived-violation retains the saved Spec; scope.in names task T-K7 as the authority, and the new task defines 14 seconds",
      "requirements[20] and requirements[100] add separated K7 values conflicting with task T-K7",
      "requirements[70] rejects K7 bulk-bypass without a local reason",
      "requirements[120] references the explicit K7-EX-1 rationale added in overview.decisions",
      "small-normal is synthetic and follows the current Spec shape",
    ],
    configuredSource: "supplied --config-root .sennel/config.json plus .sennel/config.local.json",
    configuredBaseSha256: configured.baseConfigSha256,
    configuredLocalSha256: configured.localConfigSha256,
    configuredAgent: configured.agent,
    configuredCommand: "flow.spec.gate", expectedProvider: "codex/gpt-5.6-luna",
    cacheMode: "bypass", rules,
    cases: cases.map(({ id, source, sourceKind, expected }) => ({
      id, sourceKind, sha256: sha256(source), characters: source.length, expected,
    })),
  };
  const bytes = serialize(metadata);
  if (fs.existsSync(manifestPath)) {
    assert.equal(fs.readFileSync(manifestPath, "utf8"), bytes,
      "Frozen input, rule, or configured provider changed; review the manifest before another comparison");
  } else fs.writeFileSync(manifestPath, bytes);
  assert.ok(cases[0].source.length > configured.agent.promptCharacterLimit,
    "Unchanged saved Spec must exceed the actual configured prompt limit");
  return metadata;
}

function assess(scenario, result) {
  if (result.failureCode || result.failureKind) {
    return { category: /unavailable/i.test(result.failureReason ?? "") ? "evaluation-unavailable" : "error",
      reason: result.failureReason ?? result.failureCode };
  }
  const observations = (result.evaluations ?? []).filter((entry) => entry.result === "fail").map((entry) => ({
    rule: entry.guardrail_id, observed: entry.reason ?? "", observation: entry.observations?.[0] ?? null,
  }));
  const revision = `sha256:${sha256(scenario.source)}`;
  const matches = (finding, expected) => {
    if (finding.rule !== expected.rule || finding.observation?.where?.file !== "spec.json") return false;
    const fact = `${finding.observed} ${finding.observation?.observed ?? ""}`.toLowerCase();
    if (!fact.includes(expected.marker.toLowerCase())) return false;
    if (expected.rule === "k7-timeout" && !fact.includes(expected.baseline.toLowerCase())) return false;
    const location = JSON.stringify({ where: finding.observation?.where, targets: finding.observation?.targets });
    const index = expected.requirementIndex;
    const requirementId = JSON.parse(scenario.source).requirements[index].id;
    if (!new RegExp(`\\b${requirementId}\\b|requirements(?:\\[|/|\\.)${index}(?:\\]|/|\\.|\\b)`, "i").test(location)) return false;
    return Array.isArray(finding.observation?.targets) && finding.observation.targets.length > 0
      && Array.isArray(finding.observation?.allowedTargets) && finding.observation.allowedTargets.length > 0
      && finding.observation.specRevision === revision;
  };
  const covered = new Set();
  const miss = [];
  for (const expected of scenario.expected) {
    const index = observations.findIndex((finding, i) => !covered.has(i) && matches(finding, expected));
    if (index < 0) miss.push(expected);
    else covered.add(index);
  }
  const extras = observations.filter((_, index) => !covered.has(index));
  return { category: miss.length ? (result.passed ? "false-PASS" : "miss") : extras.length ? "false-positive" : "correct",
    miss, extras, observations };
}

async function main() {
  const manifest = materializeManifest();
  if (process.argv.includes("--prepare")) {
    process.stdout.write(`Frozen ${cases.length} cases from ${manifest.savedSpec}; provider ${manifest.expectedProvider}.\n`);
    return;
  }
  if (process.argv.includes("--preflight")) {
    const [{ checkGuardrail }, { Agent }, { ProviderRegistry }, { Logger }] = await Promise.all([
      import("../../src/flow/lib/run-gate.js"), import("../../src/lib/agent.js"),
      import("../../src/lib/provider.js"), import("../../src/lib/log.js"),
    ]);
    for (const scenario of cases) {
      const root = path.join(runRoot, "preflight", scenario.id);
      const real = new Agent({ config: { agent: manifest.configuredAgent },
        paths: { root, agentWorkDir: path.join(root, "agent-work") },
        registry: new ProviderRegistry(manifest.configuredAgent.providers),
        logger: new Logger({ logDir: path.join(root, "logs"), enabled: false }) });
      let calls = 0;
      let fileCalls = 0;
      try {
        const spec = JSON.parse(scenario.source);
        const result = await checkGuardrail(root, scenario.source, "spec", undefined, [], {
          agent: {
            promptCharacterLimit: real.promptCharacterLimit,
            resolve: (...args) => real.resolve(...args),
            projectInvocation: (...args) => real.projectInvocation(...args),
            call: async (prompt) => {
              calls++;
              const file = /^Absolute file path: (.+)$/m.exec(prompt)?.[1];
              if (file) {
                fileCalls++;
                assert.equal(fs.readFileSync(file, "utf8"), scenario.source);
              }
              return JSON.stringify(file ? { observations: [], evaluationUnavailable: null } : { observations: [] });
            },
          },
          loadGuardrails: () => rules,
          specTargetScope: { spec, specRevision: `sha256:${sha256(scenario.source)}` },
        });
        assert.equal(result.passed, true, JSON.stringify(result));
        assert.ok(calls > 0);
        assert.equal(fileCalls > 0, scenario.source.length > manifest.configuredAgent.promptCharacterLimit);
        process.stdout.write(`${scenario.id}: ${calls} projected calls, ${fileCalls} file calls\n`);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
    fs.rmSync(runRoot, { recursive: true, force: true });
    return;
  }
  ensureBaselineArchive({ projectRoot, baselineRoot, revision: baselineRevision });
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
  const productFiles = ["src/flow/lib/run-gate.js", "src/flow/lib/gate-prompt-plan.js", "src/lib/prompt-batching.js"];
  const productSha256 = Object.fromEntries(Object.entries(versions).map(([version]) => [version,
    Object.fromEntries(productFiles.map((file) => [file, sha256(fs.readFileSync(path.join(version === "file" ? projectRoot : baselineRoot, file)))]))]));
  const manifestSha256 = sha256(fs.readFileSync(manifestPath));
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : {
    version: 1, manifestSha256, baselineRevision, configuredProvider: manifest.expectedProvider,
    configuredAgent: manifest.configuredAgent, cacheMode: "bypass", productSha256,
    timingBoundary: "checkGuardrail entry through return, including file creation, provider read, retries and cleanup; excluding canonical fetch and Flow transitions",
    trials: [],
  };
  assert.equal(report.manifestSha256, manifestSha256);
  assert.deepEqual(report.productSha256, productSha256, "Product source changed during a frozen comparison");
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice(8)) : Infinity;
  assert(Number.isInteger(limit) && limit >= 1 || limit === Infinity);
  let executed = 0;
  try {
    for (let pair = 1; pair <= 5; pair++) {
      for (const scenario of cases) {
        for (const version of pair % 2 ? ["file", "baseline"] : ["baseline", "file"]) {
          const id = `${scenario.id}/${pair}/${version}`;
          if (report.trials.some((entry) => entry.id === id)) continue;
          if (executed >= limit) return;
          const trialRoot = path.join(runRoot, "trials", id.replaceAll("/", "-"));
          fs.rmSync(trialRoot, { recursive: true, force: true });
          const impl = versions[version];
          const spec = JSON.parse(scenario.source);
          const options = { specTargetScope: { spec, specRevision: `sha256:${sha256(scenario.source)}` },
            ...(version === "baseline" ? { sharedGuardrailEvidence: true, structuredSource: spec } : {}) };
          let measured;
          try {
            process.stdout.write(`${id}: start\n`);
            measured = await runGateTrial({ impl, config: { agent: manifest.configuredAgent }, trialRoot,
              source: scenario.source, phase: "spec", rules, expectedProvider: manifest.expectedProvider, options,
              onCallStart: (call) => process.stdout.write(`${id}: call ${call} start\n`) });
          } finally { fs.rmSync(trialRoot, { recursive: true, force: true }); }
          const trial = { id, scenario: scenario.id, pair, version, sourceSha256: sha256(scenario.source),
            ...measured, assessment: assess(scenario, measured.result), manualReview: "pending" };
          report.trials.push(trial);
          new AtomicFile(reportPath).write(serialize(report));
          process.stdout.write(`${id}: ${trial.assessment.category} ${trial.durationMs}ms ${trial.cliLaunchCount} CLI launches\n`);
          executed++;
        }
      }
    }
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

await main();
