import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";

import { Container, container } from "../../../src/lib/container.js";
import { createTmpDir, removeTmpDir } from "../builders/tmp-dir.js";
import { commitAll, initGitRepo } from "./git-repo.js";
import { FLOW_DISPATCH_INVOCATION_ENV } from "../../../src/flow/lib/dispatch-invocation.js";
import { SpecGateRepairSelectedInputIdentity } from "../../../src/flow/lib/spec-gate-repair-input-unavailable.js";
import { WorkerArtifactHandoffRequest } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { Agent } from "../../../src/lib/agent.js";
import { AgentProviderCompletionEvidence } from "../../../src/lib/agent-failure.js";
import { Logger } from "../../../src/lib/log.js";

/** Bind a canonical manager and external worker to the production dispatcher. */
export function dispatchContainer({ root, mainRoot = root, inWorktree = false, config = {}, flowManager, agent }) {
  const container = new Container();
  container.register("paths", { root, agentWorkDir: path.join(root, ".tmp") });
  container.register("mainRoot", mainRoot);
  container.register("config", config);
  container.register("inWorktree", inWorktree);
  container.register("flowManager", flowManager);
  container.register("agent", agent);
  return container;
}

/** Create an isolated repository for a dispatch scenario. */
export function fixtureRepository(prefix) {
  const root = createTmpDir(prefix);
  try {
    fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
    initGitRepo(root);
    fs.writeFileSync(path.join(root, "README.md"), "flow dispatcher fixture\n");
    commitAll(root, "flow dispatcher fixture");
    return root;
  } catch (error) {
    removeTmpDir(root);
    throw error;
  }
}

export function requestInput(request, name) {
  const input = request.inputs.find((entry) => entry.name === name);
  assert.notEqual(input, undefined, `${request.stepId} request must contain ${name}`);
  if (request.stepId === "spec-gate-repair") {
    const payloadPath = requestPayloadPath(request, "spec-gate-repair.json");
    return WorkerArtifactHandoffRequest.readInput({
      requestPath: path.join(path.dirname(path.dirname(payloadPath)), "request.json"), name,
    });
  }
  return input;
}

/** Read the identity supplied to the external worker, including its non-self-referential request digest. */
export function requestSpecGateRepairIdentity(request, executionEnvironment) {
  const reference = JSON.parse(executionEnvironment[FLOW_DISPATCH_INVOCATION_ENV]);
  return SpecGateRepairSelectedInputIdentity.fromRequest({ ...request,
    requestDigest: reference.requestDigest,
    inputs: [requestInput(request, "spec-gate-repair-context.json")] });
}

export function requestPayloadPath(request, logicalName) {
  const payload = request.payloads.find((entry) => entry.logicalName === logicalName);
  assert.notEqual(payload, undefined, `${request.stepId} request must contain ${logicalName}`);
  return payload.payloadPath;
}

/** Deterministic external judgments for the exact schema transported by a Gate. */
export function passingGateProviderResponse(_prompt, options) {
  const required = options.jsonSchema?.required ?? [];
  if (required.includes("evaluations")) {
    const ids = options.jsonSchema?.properties?.evaluations?.items?.properties?.guardrail_id?.enum ?? [];
    return JSON.stringify({ evaluations: ids.map((guardrail_id) => ({
      guardrail_id, result: "pass", reason: "Scenario accepts the configured guardrail.",
    })) });
  }
  const observation = options.jsonSchema?.properties?.observations?.items;
  const requirementIds = observation?.properties?.requirementId?.enum ?? [];
  const sourceRefs = observation?.properties?.sourceRef?.enum ?? [];
  if (requirementIds.length && sourceRefs.length) return JSON.stringify({
    observations: requirementIds.flatMap((requirementId) => sourceRefs.map((sourceRef) => ({
      requirementId, sourceRef, support: [], contradictions: [], unresolved: [],
    }))),
  });
  return JSON.stringify({ observations: [], ...(required.includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}) });
}

/** Fake external Gate responses while preserving real provider admission accounting. */
export function installGateProviderFake(respond, {
  projectInvocation = null, promptCharacterLimit = null, transportContext = null,
} = {}) {
  const originalGet = container.get.bind(container);
  return mock.method(container, "get", (name) => {
    if (name !== "agent") return originalGet(name);
    const declaredLimit = typeof promptCharacterLimit === "function" ? promptCharacterLimit() : promptCharacterLimit;
    if (transportContext !== null) {
      const { root, flowManager } = transportContext();
      const agent = new ScenarioProviderAgent({
        config: { agent: { default: "fixture", timeout: 30, providers: {
          fixture: { command: "worker", args: ["{{PROMPT}}"],
            jsonSchemaFlag: "--schema", jsonSchemaMode: "inline" },
        } } },
        paths: { root, agentWorkDir: path.join(root, ".tmp") },
        logger: new Logger({ logDir: path.join(root, ".tmp", "logs"), enabled: false }),
        flowManager,
      }, { respond, promptCharacterLimit: declaredLimit });
      if (projectInvocation !== null) agent.projectInvocation = projectInvocation;
      return agent;
    }
    return {
      resolve() { return { providerKey: "fixture", profileKey: "fixture" }; },
      ...(declaredLimit === null ? {} : { promptCharacterLimit: declaredLimit }),
      ...(projectInvocation === null ? {} : { projectInvocation }),
      async call(prompt, options) {
        const admission = options.providerCallAdmission;
        admission?.claim();
        try {
          await admission?.beforeProviderAttempt({
            attempt: 1, index: 0, maxAttempts: 1,
            providerKey: "fixture", profileKey: "fixture",
          });
          return await respond(prompt, options);
        } finally {
          admission?.settle();
        }
      },
    };
  });
}

/** Keep Agent's invocation, admission, cache and retry pipeline; replace only
 * the external provider process result. Unknown failures carry no invented
 * completion evidence and must remain uncertain in the production journal. */
class ScenarioProviderAgent extends Agent {
  constructor(options, { respond, promptCharacterLimit }) {
    super(options);
    this.respond = respond;
    this.declaredPromptCharacterLimit = promptCharacterLimit;
  }

  get promptCharacterLimit() {
    return this.declaredPromptCharacterLimit ?? super.promptCharacterLimit;
  }

  async _callOnce(resolved, prompt, options) {
    const text = await this.respond(prompt, options);
    return { text, usage: null, stdout: text, stderr: "",
      providerCompletionEvidence: new AgentProviderCompletionEvidence({
        provider: resolved.providerKey, profile: resolved.profileKey,
        exitCode: 0, stdout: text,
      }) };
  }
}
