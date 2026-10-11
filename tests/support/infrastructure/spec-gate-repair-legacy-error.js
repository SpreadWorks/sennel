import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTmpDir, removeTmpDir } from "../builders/tmp-dir.js";

/** Isolate the actual retired size predicate, never the canonical Error producer. */
export class LegacySpecGateRepairErrorSeed {
  constructor() {
    this.root = createTmpDir("spec-gate-repair-legacy-code-");
    try {
      const repository = fileURLToPath(new URL("../../../", import.meta.url));
      for (const relative of ["src", "tests/support", "package.json"]) {
        const destination = path.join(this.root, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(path.join(repository, relative), destination, { recursive: true });
      }
      const operations = path.join(this.root, "src/flow/lib/spec-repair-operations.js");
      const source = fs.readFileSync(operations, "utf8");
      const anchor = "      for (let editIndex = 0; editIndex < edits.length; editIndex += 1) {";
      assert.equal(source.split(anchor).length, 2, "retired size predicate must attach to its real constructor");
      // Exact predicate from 2ba144ef64c3e3cf02367895e3da91e5a41791d6.
      // Only this isolated copy changes; the normal factory, Step and Store remain real.
      const predicate = "      if (stableBytes(input.edits) > 32 * 1024) {\n"
        + "        throw new Error(`spec-repair.operations[${index}].edits replacements are oversized`);\n      }\n"
        + anchor;
      fs.writeFileSync(operations, source.replace(anchor, predicate));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  import(relative) { return import(pathToFileURL(path.join(this.root, relative)).href); }
  dispose() { removeTmpDir(this.root); }

  /** Return serialized identity only: old and corrected code have distinct class realms. */
  async create({ mode = "valid" } = {}) {
    const [scenario, dispatchSupport, dispatchModule, targetModule, bundleModule,
      handoff, worker, git, projection] = await Promise.all([
      this.import("tests/support/infrastructure/spec-gate-repair-scenario.js"),
      this.import("tests/support/infrastructure/flow-dispatch-scenario.js"),
      this.import("src/flow/lib/run-dispatch.js"),
      this.import("src/lib/flow-target-guard.js"),
      this.import("src/flow/lib/spec-gate-repair-bundle.js"),
      this.import("src/flow/lib/worker-artifact-handoff.js"),
      this.import("tests/support/infrastructure/worker-artifact.js"),
      this.import("tests/support/infrastructure/git-repo.js"),
      this.import("src/lib/prompt-batching.js"),
    ]);
    const large = (prefix) => prefix + "x".repeat(34_522 - Buffer.byteLength(prefix));
    const spec = worker.validWorkerHandoffSpec();
    if (mode === "unchanged") spec.requirements[0].desc = large("Preserve this exact requirement. ");
    const replacement = mode === "unchanged" ? spec.requirements[0].desc
      : large("Publish the corrected canonical behavior. ");
    const value = await scenario.createSpecGateRepairScenario({ specRecord: spec });
    try {
      git.initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      git.commitAll(value.root, "Create isolated legacy repair repository");
      let providerCalls = 0;
      let context;
      let proposal;
      const agent = {
        projectInvocation(prompt) {
          return new projection.ResolvedAgentInvocationProjection({ providerKey: "fixture", profileKey: "fixture",
            command: "fixture", promptCharacterCount: prompt.length, systemPromptCharacterCount: 0,
            schemaCharacterCount: 0, finalArgs: [], inlineArgvByteCount: 0, schemaMode: "none", usesStdin: true });
        },
        async call(_prompt, options) {
          providerCalls += 1;
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          context = dispatchSupport.requestInput(request, "spec-gate-repair-context.json").document;
          const selected = bundleModule.SpecGateRepairBundle.fromJSON(context.bundle).selections()[0];
          const range = selected.ranges.find((entry) => entry.writable);
          proposal = { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
            groups: [{ findingIdentities: selected.unit.findings.map((finding) => finding.identity),
              operations: [{ kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
                edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value) + (mode === "invalid" ? 1 : 0), replacement }],
                reason: "Correct the exact published finding." }] }] };
          fs.writeFileSync(dispatchSupport.requestPayloadPath(request, "spec-gate-repair.json"), worker.workerArtifactJson(proposal));
          handoff.sealWorkerArtifactHandoff({ requestPath,
            invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
          return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
        },
      };
      const command = new dispatchModule.default({ agent, maxDispatches: 1 });
      command.container = dispatchSupport.dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
      const binding = targetModule.FlowTargetBinding.capture({ flowState: value.flowManager.loadReadOnly(value.specId),
        mainRoot: value.root, authorityRoot: value.root }).serialize();
      const result = await command.execute({ ...value.ctx, flowState: value.flowManager.loadReadOnly(value.specId),
        expectBinding: binding, _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(providerCalls, 1, JSON.stringify(result));
      const state = value.flowManager.canonicalState(value.specId).toJSON();
      const activities = value.flowManager.activityLedger(value.specId);
      const error = activities.findLast((entry) => entry.nodeId === "spec-gate-repair"
        && entry.result?.stepResult?.type === "error");
      assert.ok(error, JSON.stringify(result));
      assert.equal(error.transition.operation, "fail_attempt");
      assert.equal(error.result.draftSettlementReceipt.executionLifecycle.phase, "terminal");
      assert.equal(value.flowManager.canonicalState(value.specId).current.at(-1), "spec-gate-repair");
      assert.notEqual(state.attempt.failure, null);
      // Do not pass the legacy manager, fixture, request or Service into new code.
      return { root: value.root, specId: value.specId, baseRevision: context.baseRevision,
        replacement, proposal, providerCalls, binding, error: structuredClone(error) };
    } catch (error) {
      removeTmpDir(value.root);
      throw error;
    }
  }
}
