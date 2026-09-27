import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { Agent } from "../../src/lib/agent.js";
import { Logger } from "../../src/lib/log.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { FlowTargetBinding } from "../../src/lib/flow-target-guard.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import RunDispatchCommand from "../../src/flow/lib/run-dispatch.js";
import { sealWorkerArtifactHandoff } from "../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../support/infrastructure/flow-setup.js";
import { DraftGateRepairScenario } from "../support/infrastructure/draft-gate-repair-scenario.js";
import { dispatchContainer, fixtureRepository, requestInput, requestPayloadPath } from "../support/infrastructure/flow-dispatch-scenario.js";
import { removeTmpDir } from "../support/builders/tmp-dir.js";
import { workerArtifactJson } from "../support/infrastructure/worker-artifact.js";

const CLI = fileURLToPath(new URL("../../src/sennel.js", import.meta.url));

it("a real producer corrects a retained structural rejection through the guarded dispatcher", { timeout: 720_000 }, async () => {
  const root = fixtureRepository("draft-worker-correction-agent-");
  const originalPath = process.env.PATH;
  const evidence = { scenario: "structural rejection followed by a real producer", calls: 0, result: "incomplete" };
  try {
    const retained = process.env.SENNEL_DRAFT_CORRECTION_SNAPSHOT
      ? JSON.parse(fs.readFileSync(process.env.SENNEL_DRAFT_CORRECTION_SNAPSHOT, "utf8")) : null;
    if (process.env.SENNEL_DRAFT_CORRECTION_SOURCE) {
      for (const entry of ["src", "docs", "package.json", "AGENTS.md"]) {
        const source = path.join(process.env.SENNEL_DRAFT_CORRECTION_SOURCE, entry);
        if (fs.existsSync(source)) fs.cpSync(source, path.join(root, entry), { recursive: true });
      }
    }
    const key = "codex/gpt-6-sol";
    const config = { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" }, agent: {
      default: key, timeout: 600, retryCount: 1,
      providers: { [key]: { command: "codex", args: ["exec", "--json", "--sandbox", "workspace-write", "-m", "gpt-6-sol", "-c", 'model_reasoning_effort="medium"', "{{PROMPT}}"],
        jsonOutputFlag: "--json", jsonSchemaFlag: "--output-schema", jsonSchemaMode: "file" } },
    } };
    fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sennel", "config.json"), workerArtifactJson(config));
    const bin = path.join(root, ".test-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "sennel"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const specId = "draft-correction-agent";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-draft-correction-agent",
      request: retained?.issue ?? "Preserve existing behavior and document the retained migration inventory.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(workerArtifactJson(retained?.draft ?? canonicalDraftDocument({ goal: "Document retained interfaces and behavior." }))) }] });
    fixture.activate("draft-gate");
    const observations = retained?.observations ?? [{ kind: "violation", failureMode: "guardrail-violation", requirementRef: "parity",
      where: { file: "draft.json", locator: "analysis.validation" }, observed: "Describe verification of retained public behavior.", severity: "blocking", refs: ["parity"] }];
    new DraftGateRepairScenario({ flowManager: manager, root, specId }).select({ observations, issueLogId: "correction-agent-gate" });
    const real = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
      registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: path.join(root, ".tmp", "logs"), enabled: false }), flowManager: manager });
    const agent = { async call(prompt, options) {
      evidence.calls++;
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      if (evidence.calls > 1) {
        assert.equal(request.workerInstructions.retryFeedback.code, "FLOW_DRAFT_GATE_REPAIR_INVALID");
        evidence.feedback = request.workerInstructions.retryFeedback;
        return real.call(prompt, options);
      }
      const recurrence = requestInput(request, "gate-observation-recurrence.json").document;
      const draft = requestInput(request, "draft.json").document;
      const entries = draft.decisionMap.deferredToSpec;
      const index = entries.length > 1 ? 1 : 0;
      const invalid = { ...(entries[index] ?? { boundary: "retained behavior", relevance: "parity verification", owner: "spec" }), migrationInventory: {} };
      const payload = { version: 1, baseRevision: `sha256:${request.inputRevision}`,
        operations: [{ kind: "replace-value", path: entries.length ? `decisionMap.deferredToSpec[${index}]` : "decisionMap.deferredToSpec",
          replacement: entries.length ? invalid : [invalid], reason: "Provide migration inventory" }],
        report: { version: 1, summary: "Proposed inventory", results: recurrence.entries.map((entry) => ({ fingerprint: entry.fingerprint,
          strategy: "Describe inventory in Draft", summary: "Proposed inventory", priorRepairInsufficiency: entry.recurrenceCount > 0 ? "Inventory missing" : null })) },
      };
      fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson(payload));
      assert.throws(() => sealWorkerArtifactHandoff({ requestPath, invocationId: request.dispatchInvocationId }), { code: "FLOW_DRAFT_GATE_REPAIR_INVALID" });
      return "Unsealed invalid proposal retained for parent feedback.";
    } };
    const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 2, repositoryFingerprint: () => "draft-correction-agent" });
    dispatcher.container = dispatchContainer({ root, flowManager: manager, agent });
    const result = await dispatcher.execute({ root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
      flowState: manager.loadReadOnly(specId),
      expectBinding: FlowTargetBinding.capture({ flowState: manager.loadReadOnly(specId), mainRoot: root, authorityRoot: root }).serialize(),
      _envelopeType: "run", _envelopeKey: "dispatch" });
    evidence.dispatch = result;
    assert.equal(evidence.calls, 2, JSON.stringify(result));
    assert.equal(result.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result));
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
    const draft = JSON.parse(reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" }).bytes);
    for (const entry of draft.decisionMap.deferredToSpec) assert.deepEqual(Object.keys(entry).sort(), ["boundary", "owner", "relevance"]);
    const rejections = reloaded.activityLedger(specId).map((entry) => entry.result?.draftSettlementReceipt?.executionLifecycle?.rejection).filter(Boolean);
    assert.equal(rejections.length, 1);
    evidence.rejections = rejections;
    evidence.draft = draft;
    evidence.observations = observations.length;
    evidence.result = "passed";
  } finally {
    if (process.env.SENNEL_DRAFT_CORRECTION_EVIDENCE) fs.writeFileSync(process.env.SENNEL_DRAFT_CORRECTION_EVIDENCE, workerArtifactJson(evidence));
    process.env.PATH = originalPath;
    removeTmpDir(root);
  }
});
