// Explicit real-provider measurement: node tests/agent/file-read-reference-measurement.mjs
// Deliberately outside npm test:agent discovery; results are written even on failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../../src/lib/agent.js";
import { loadConfig } from "../../src/lib/config.js";
import { Logger } from "../../src/lib/log.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { checkGuardrail } from "../../src/flow/lib/run-gate.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = loadConfig(sourceRoot);
const reportPath = process.env.SENNEL_FILE_REFERENCE_REPORT ?? "/tmp/sennel-6928-real-ai.json";
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const report = { startedAt: new Date().toISOString(), sourceRoot, hostCwd: process.cwd(),
  commandId: "flow.spec.gate", cacheMode: "bypass", trials: [] };
let failed = false;
for (const phase of ["draft", "spec"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sennel-6928-${phase}-`));
  const initialCwd = path.join(root, "agent-initial-cwd");
  const trial = { phase, root, initialCwd,
    responseCalls: [], toolCommands: [], promptMetrics: [] };
  report.trials.push(trial);
  try {
    fs.mkdirSync(initialCwd);
    // Match an ordinary project repository; keep the configured CLI's trust checks.
    const git = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    const real = new Agent({ config, paths: { root, agentWorkDir: initialCwd },
      registry: new ProviderRegistry(config.agent.providers ?? {}),
      logger: new Logger({ logDir: path.join(root, "logs"), enabled: false }) });
    const resolved = real.resolve("flow.spec.gate");
    trial.provider = resolved?.providerKey;
    trial.profile = resolved?.profileKey;
    trial.profileDefinition = resolved?.profile;
    assert.ok(resolved, "configured Gate provider must resolve");
    const version = spawnSync(resolved.profile.command, ["--version"],
      { cwd: initialCwd, encoding: "utf8", timeout: 15_000 });
    trial.cliVersion = { status: version.status, stdout: version.stdout?.trim(), stderr: version.stderr?.trim() };
    const canonical = phase === "draft"
      ? { goal: "The checkpoint timeout is exactly 17 seconds.", analysis: {
        problem: "A checkpoint requires one consistent timeout.",
        proposedApproach: "Use the same checkpoint timeout everywhere.",
        validation: "Plan to compare every checkpoint timeout with 17 seconds." },
        qa: [{ question: "Background context?", answer: "Neutral inventory background. ".repeat(5_000) },
          { question: "Which checkpoint timeout applies?", answer: "The checkpoint timeout is exactly 29 seconds." }] }
      : { goal: "The checkpoint timeout is exactly 17 seconds.",
        background: "Neutral inventory background. ".repeat(5_000),
        requirements: [{ id: "R1", desc: "The checkpoint timeout is exactly 29 seconds.",
          testable: true, task_ids: ["T1"] }],
        tasks: [{ id: "T1", goal: "Use a consistent checkpoint timeout.",
          test_strategy: "Plan a timeout consistency check." }] };
    const source = `${JSON.stringify(canonical, null, 2)}\n`;
    trial.inputDigest = digest(source);
    trial.inputByteLength = Buffer.byteLength(source);
    assert.ok(source.length > real.promptCharacterLimit, "fixture must force complete-file evaluation");
    const agent = {
      promptCharacterLimit: real.promptCharacterLimit,
      resolve: (...args) => real.resolve(...args),
      projectInvocation: (prompt, options) => real.projectInvocation(prompt, { ...options, executionWorkDir: initialCwd }),
      async call(prompt, options) {
        const absolutePath = /^Absolute file path: (.+)$/m.exec(prompt)?.[1];
        const projectRoot = /^Project root: (.+)$/m.exec(prompt)?.[1];
        const projectRelativePath = /^Project-root-relative file path: (.+)$/m.exec(prompt)?.[1];
        assert.equal(projectRoot, root);
        assert.equal(path.resolve(projectRoot, projectRelativePath), absolutePath);
        assert.notEqual(path.resolve(initialCwd, projectRelativePath), absolutePath);
        assert.equal(digest(fs.readFileSync(absolutePath)), trial.inputDigest);
        const call = { responseAttemptOrdinal: trial.responseCalls.length + 1,
          absolutePath, projectRoot, projectRelativePath, cacheMode: options.cacheMode,
          startedAt: new Date().toISOString() };
        trial.responseCalls.push(call);
        let buffer = "";
        try {
          const output = await real.call(prompt, { ...options, cacheMode: "bypass", flowAttribution: "none", executionWorkDir: initialCwd,
            onStdout(chunk) {
              buffer += chunk;
              let end;
              while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                try {
                  const event = JSON.parse(line);
                  if (event.item?.type === "command_execution" && event.type === "item.completed") {
                    trial.toolCommands.push({ responseAttemptOrdinal: call.responseAttemptOrdinal,
                      command: event.item.command, exitCode: event.item.exit_code });
                  }
                  if (event.type === "turn.completed") call.usage = event.usage;
                } catch { /* Stream diagnostics are not protocol responses. */ }
              }
            } });
          call.output = output;
          call.providerAttemptCount = options.providerCallAdmission.attemptCount;
          return output;
        } catch (error) {
          call.error = { code: error.code, message: error.message };
          throw error;
        } finally { call.endedAt = new Date().toISOString(); }
      },
    };
    const rule = { id: "CHECKPOINT-CONSISTENCY", title: "One checkpoint timeout",
      body: "Read the complete artifact. Its goal defines the checkpoint timeout as exactly 17 seconds. Every other normative checkpoint timeout must equal that value. Report each inconsistent value with its actual location and both numbers. Planned checks suffice at Draft/Spec stage; no executed tests are required.",
      meta: { phase: [phase], category: "requirements" } };
    trial.result = await checkGuardrail(root, source, phase, undefined, [], {
      agent, loadGuardrails: () => [rule],
      recordPromptMetric: (metric) => trial.promptMetrics.push(metric),
      ...(phase === "spec" ? { specTargetScope: { spec: canonical,
        specRevision: `sha256:${trial.inputDigest}` } } : {}),
    });
    assert.equal(trial.result.failureCode, undefined, JSON.stringify(trial.result));
    assert.equal(trial.result.passed, false, "tail inconsistency must prevent false PASS");
    const observations = trial.result.evaluations.flatMap((entry) => entry.observations ?? []);
    assert.ok(observations.some((entry) => /17/.test(entry.observed) && /29/.test(entry.observed)),
      JSON.stringify(observations));
    trial.measurement = "verified";
  } catch (error) {
    failed = true;
    trial.measurement = "failed";
    trial.failure = { code: error.code ?? error.name, message: error.message };
  } finally {
    trial.sennelResponseRetries = Math.max(0, trial.responseCalls.length - 1);
    trial.observedFailedToolCommands = trial.toolCommands.filter((entry) => entry.exitCode !== 0).length;
    trial.toolRetryInterpretation = "Failed tool commands are measured separately; successful tool calls are not Sennel response retries.";
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${phase}: ${trial.measurement}, ${trial.responseCalls.length} response calls, ${trial.toolCommands.length} observed tool commands\n`);
  }
}
report.finishedAt = new Date().toISOString();
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (failed) process.exitCode = 1;
