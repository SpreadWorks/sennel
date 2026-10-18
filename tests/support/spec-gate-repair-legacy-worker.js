/** Produce a genuine historical Error inside one bootstrapped package realm. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSpecGateRepairScenario } from "./infrastructure/spec-gate-repair-scenario.js";
import { dispatchContainer, requestInput, requestPayloadPath, withScenarioProviderAdmission } from "./infrastructure/flow-dispatch-scenario.js";
import RunDispatchCommand from "../../src/flow/lib/run-dispatch.js";
import { FlowTargetBinding } from "../../src/lib/flow-target-guard.js";
import { SpecGateRepairBundle } from "../../src/flow/lib/spec-gate-repair-bundle.js";
import { sealWorkerArtifactHandoff } from "../../src/flow/lib/worker-artifact-handoff.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "./infrastructure/worker-artifact.js";
import { initGitRepo, commitAll } from "./infrastructure/git-repo.js";
import { ResolvedAgentInvocationProjection } from "../../src/lib/prompt-batching.js";
import { removeTmpDir } from "./builders/tmp-dir.js";

const [mode, output] = process.argv.slice(2);
const large = (prefix) => prefix + "x".repeat(34_522 - Buffer.byteLength(prefix));
const spec = validWorkerHandoffSpec();
if (mode === "unchanged") spec.requirements[0].desc = large("Preserve this exact requirement. ");
const replacement = mode === "unchanged" ? spec.requirements[0].desc
  : large("Publish the corrected canonical behavior. ");
const value = await createSpecGateRepairScenario({ specRecord: spec });
try {
  initGitRepo(value.root);
  fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
  commitAll(value.root, "Create isolated legacy repair repository");
  let providerCalls = 0;
  let context;
  let proposal;
  const agent = withScenarioProviderAdmission({
    projectInvocation(prompt) {
      return new ResolvedAgentInvocationProjection({ providerKey: "fixture", profileKey: "fixture",
        command: "fixture", promptCharacterCount: prompt.length, systemPromptCharacterCount: 0,
        schemaCharacterCount: 0, finalArgs: [], inlineArgvByteCount: 0, schemaMode: "none", usesStdin: true });
    },
    async call(_prompt, options) {
      providerCalls += 1;
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      context = requestInput(request, "spec-gate-repair-context.json").document;
      const selected = SpecGateRepairBundle.fromJSON(context.bundle).selections()[0];
      const range = selected.ranges.find((entry) => entry.writable);
      proposal = { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
        groups: [{ findingIdentities: selected.unit.findings.map((finding) => finding.identity),
          operations: [{ kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
            edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value) + (mode === "invalid" ? 1 : 0), replacement }],
            reason: "Correct the exact published finding." }] }] };
      fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(proposal));
      sealWorkerArtifactHandoff({ requestPath,
        invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
      return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
    },
  });
  const command = new RunDispatchCommand({ agent, maxDispatches: 1 });
  command.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
  const binding = FlowTargetBinding.capture({ flowState: value.flowManager.loadReadOnly(value.specId),
    mainRoot: value.root, authorityRoot: value.root }).serialize();
  const result = await command.execute({ ...value.ctx, flowState: value.flowManager.loadReadOnly(value.specId),
    expectBinding: binding, _envelopeType: "run", _envelopeKey: "dispatch" });
  assert.equal(providerCalls, 1, JSON.stringify(result));
  const state = value.flowManager.canonicalState(value.specId).toJSON();
  const error = value.flowManager.activityLedger(value.specId).findLast((entry) => entry.nodeId === "spec-gate-repair"
    && entry.result?.stepResult?.type === "error");
  assert.ok(error, JSON.stringify(result));
  assert.equal(error.transition.operation, "fail_attempt");
  assert.equal(error.result.draftSettlementReceipt.executionLifecycle.phase, "terminal");
  assert.equal(value.flowManager.canonicalState(value.specId).current.at(-1), "spec-gate-repair");
  assert.notEqual(state.attempt.failure, null);
  fs.writeFileSync(output, JSON.stringify({ root: value.root, specId: value.specId, baseRevision: context.baseRevision,
    replacement, proposal, providerCalls, binding, error: structuredClone(error) }), { flag: "wx" });
} catch (error) {
  removeTmpDir(value.root);
  throw error;
}
