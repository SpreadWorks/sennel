import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it, mock } from "node:test";
import { AgentFileReference } from "../../../src/lib/agent-file-reference.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { ResolvedAgentInvocationProjection } from "../../../src/lib/prompt-batching.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { dispatchContainer, fixtureRepository, installGateProviderFake } from "../../support/infrastructure/flow-dispatch-scenario.js";

function snapshotCanonical(location) {
  // These files are the authorities; recursively include immutable publications too.
  const root = path.dirname(location.flowStateFile);
  const files = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== ".runtime") visit(file);
      else if (entry.isFile()) files[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  visit(root);
  for (const file of [location.flowStateFile, location.activitiesFile, location.catalogFile]) {
    assert.ok(Object.hasOwn(files, path.relative(root, file)), `Snapshot must include ${file}`);
  }
  return files;
}

function injectInputFault(phase, kind) {
  const restores = [];
  const target = (file) => String(file).includes(`${path.sep}agent-work${path.sep}${phase}-gate-`)
    && String(file).endsWith(`${path.sep}${phase}.json`);
  const originalResolve = AgentFileReference.resolve;
  let resolvingInput = false;
  let resolveHits = 0;
  restores.push(mock.method(AgentFileReference, "resolve", (input) => {
    if (!target(input.filePath)) return originalResolve.call(AgentFileReference, input);
    resolveHits += 1;
    resolvingInput = true;
    try { return originalResolve.call(AgentFileReference,
      kind === "escape" ? { ...input, filePath: "../outside-input.json" } : input); }
    finally { resolvingInput = false; }
  }));
  if (kind !== "escape") {
    const originalLstat = fs.lstatSync;
    let captures = 0;
    restores.push(mock.method(fs, "lstatSync", (file, ...args) => {
      if (resolvingInput && target(file)) {
        captures += 1;
        if (captures === 1 && ["missing", "directory", "symlink", "digest"].includes(kind)) {
          if (kind === "digest") {
            const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
          } else if (kind === "symlink") {
            fs.renameSync(file, `${file}.original`); fs.symlinkSync(`${file}.original`, file);
          } else {
            fs.unlinkSync(file);
            if (kind === "directory") fs.mkdirSync(file);
          }
        }
        if (kind === "before-response" && captures === 2) fs.unlinkSync(file);
      }
      return originalLstat(file, ...args);
    }));
    if (kind === "unreadable" || kind === "identity") {
      const originalOpen = fs.openSync;
      const originalFstat = fs.fstatSync;
      let capturedDescriptor = null;
      restores.push(mock.method(fs, "openSync", (file, ...args) => {
        if (resolvingInput && target(file) && kind === "unreadable") throw Object.assign(new Error("input permission denied"), { code: "EACCES" });
        const descriptor = originalOpen(file, ...args);
        if (resolvingInput && target(file)) capturedDescriptor = descriptor;
        return descriptor;
      }));
      if (kind === "identity") restores.push(mock.method(fs, "fstatSync", (descriptor, ...args) => {
        const stat = originalFstat(descriptor, ...args);
        if (resolvingInput && descriptor === capturedDescriptor) stat.ino += 1;
        return stat;
      }));
    }
  }
  const restore = () => { for (const injected of restores.reverse()) injected.mock.restore(); };
  Object.defineProperty(restore, "resolveHits", { get: () => resolveHits });
  return restore;
}

for (const phase of ["draft", "spec"]) {
  for (const kind of ["missing", "directory", "unreadable", "escape", "symlink", "identity", "digest", "before-response"]) {
    it(`refuses ${phase} initial file ${kind} through dispatch before provider or canonical mutation`, async () => {
      const root = fixtureRepository(`gate-file-admission-${phase}-${kind}-`);
      const specId = "6928-input-admission";
      let gateLookup;
      let restoreFault;
      try {
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const fixture = new CanonicalFlowFixture({ flowManager: manager, specId,
          runId: "run-file-input-admission", execution: { mode: "direct", baseBranch: "main" },
          specRecord: { goal: "Verify exact Gate input admission.",
            requirements: [{ id: "R1", desc: "Gate checks exact input.", task_ids: ["T1"] }],
            acceptance_criteria: ["Invalid initial input has no canonical effect."] },
        }).create();
        fixture.addTask({ id: "T1", title: "Verify admission", goal: "Exercise admission",
          test_strategy: "Verify rejected input.", parent: null, origin: "plan", added_round: 0, status: "pending" });
        fixture.registerActive().activate(`${phase}-gate`);
        fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), JSON.stringify({ guardrails: [{
          id: "EXACT", title: "Exact input", body: "Evaluate the complete input.",
          meta: { phase: [phase], category: "requirements" },
        }] }));
        let providerCalls = 0;
        gateLookup = installGateProviderFake(() => { providerCalls += 1; throw new Error("Rejected input reached provider"); }, {
          projectInvocation(prompt) { return new ResolvedAgentInvocationProjection({
            providerKey: "fixture", profileKey: "fixture", command: "fixture",
            promptCharacterCount: prompt.includes("Absolute file path:") ? 1000 : 120001,
            systemPromptCharacterCount: 1000, schemaCharacterCount: 1000,
            finalArgs: [], inlineArgvByteCount: 0, schemaMode: "file", usesStdin: true,
          }); },
        });
        const worker = { async call() { throw new Error("Gate admission must not launch a worker"); } };
        const dispatcher = new RunDispatchCommand({ agent: worker });
        dispatcher.container = dispatchContainer({ root, flowManager: manager, agent: worker });
        const before = snapshotCanonical(fixture.location());
        restoreFault = injectInputFault(phase, kind);
        const result = await dispatcher.execute({ root, mainRoot: root, executionRoot: root, specId,
          flowManager: manager, flowState: manager.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({ flowState: manager.loadReadOnly(specId),
            mainRoot: root, authorityRoot: root }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
        const refusal = result.toJSON?.() ?? result;
        assert.equal(refusal.ok, false, JSON.stringify({ refusal, failure: manager.canonicalState(specId).attempt.failure,
          settlement: manager.readCurrentStepSettlement({ specId, stepId: `${phase}-gate` }) }));
        assert.equal(refusal.data.dispatch.boundary, "blocked", JSON.stringify(refusal));
        const expectedFailure = {
          missing: /ENOENT/, directory: /regular real file/, unreadable: /input permission denied/,
          escape: /stay inside its project root/, symlink: /regular real file/,
          identity: /identity changed while opening/, digest: /differ from the caller-owned exact input/,
          "before-response": /Referenced input is unavailable/,
        };
        assert.match(JSON.stringify(refusal.errors), expectedFailure[kind]);
        assert.equal(restoreFault.resolveHits, kind === "before-response" ? 2 : 1);
        assert.equal(providerCalls, 0);
        assert.deepEqual(snapshotCanonical(fixture.location()), before);
        const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        assert.equal(restored.canonicalState(specId).attempt.failure, null);
        assert.equal(restored.readCurrentStepSettlement({ specId, stepId: `${phase}-gate` }), null);
        assert.equal(restored.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === `${phase}.gate`), false);
        assert.deepEqual(fs.readdirSync(path.join(root, ".sennel", "agent-work")), []);
      } finally {
        restoreFault?.(); gateLookup?.mock.restore(); removeTmpDir(root);
      }
    });
  }
}
