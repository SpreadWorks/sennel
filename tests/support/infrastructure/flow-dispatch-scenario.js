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
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { Logger } from "../../../src/lib/log.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { flowCommands } from "../../../src/lib/command-registry.js";
import { buildFlowCommandHookContext } from "../../../src/flow/lib/flow-context.js";
import { normalizeManagedGitignore } from "../../../src/lib/gitignore.js";

export class FlowDispatchExecution {
  constructor(name, argv) {
    this.name = name;
    this.argv = argv;
    this.result = null;
    this.exitCode = 0;
    this.stdout = "";
    this.stderr = "";
  }

  get envelope() { return JSON.parse(this.stdout); }
}

/** Capture the production registry, hooks and dispatcher output in-process. */
export async function dispatchFlowCommand({ container, group, name, argv = [], runtimeLog = false,
  execution = new FlowDispatchExecution(name, argv) }) {
  const entry = flowCommands[group][name];
  assert.ok(entry, `production ${group} command ${name} must exist`);
  await dispatch({ container, entry, argv, envelopeType: group, envelopeKey: name, runtimeLog,
    buildHookCtx: (container, input) => buildFlowCommandHookContext(container, entry, input),
    stdout: (text) => { execution.stdout += text; },
    stderr: (text) => { execution.stderr += text; },
    setExitCode: (code) => { execution.exitCode = code; } });
  return execution;
}

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

/** Apply the normal setup policy before a fixture captures repository authority. */
export function configureManagedFixtureRepository(root) {
  fs.writeFileSync(path.join(root, ".gitignore"), normalizeManagedGitignore(".tmp/\n"));
  commitAll(root, "configure managed fixture paths");
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

/** Observe the final parent-issued request identity at the external worker boundary. */
export class WorkerRequestIdentityObserver {
  #requestDigests = new Map();

  constructor(worker) { this.worker = worker; }

  call(prompt, options) {
    const reference = JSON.parse(options.executionEnvironment[FLOW_DISPATCH_INVOCATION_ENV]);
    this.#requestDigests.set(reference.dispatchInvocationId, reference.requestDigest);
    return this.worker(prompt, options);
  }

  requestDigest(dispatchInvocationId) { return this.#requestDigests.get(dispatchInvocationId); }
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
    return createScenarioProviderFake(respond, { projectInvocation, promptCharacterLimit: declaredLimit });
  });
}

/** A provider boundary that participates in the canonical Prompt reservation. */
export function createScenarioProviderFake(respond, { projectInvocation = null, promptCharacterLimit = null } = {}) {
  return {
    resolve() { return { providerKey: "fixture", profileKey: "fixture" }; },
    ...(promptCharacterLimit === null ? {} : { promptCharacterLimit }),
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
}

/** Adapt an imperative fixture worker while preserving its preflight methods.
 * A worker that writes files and exits without a report has empty stdout. */
const admittedScenarioProviders = new WeakSet();
export function withScenarioProviderAdmission(agent) {
  if (admittedScenarioProviders.has(agent)) return agent;
  const worker = agent.call.bind(agent);
  agent.call = createScenarioProviderFake(async (prompt, options) => {
    const response = await worker(prompt, options);
    return response === undefined ? "" : response;
  }).call;
  admittedScenarioProviders.add(agent);
  return agent;
}

/** Keep Agent's invocation, admission, cache and retry pipeline. Durable managed
 * claims use a real Node provider for the precomputed response. Unknown failures
 * carry no invented completion evidence and remain uncertain in the journal. */
class ScenarioProviderAgent extends Agent {
  constructor(options, { respond, promptCharacterLimit }) {
    super(options);
    this.respond = respond;
    this.declaredPromptCharacterLimit = promptCharacterLimit;
  }

  get promptCharacterLimit() {
    return this.declaredPromptCharacterLimit ?? super.promptCharacterLimit;
  }

  async _callOnce(resolved, prompt, options, materializedInvocation) {
    const text = await this.respond(prompt, options);
    if (ProcessExecutionRuntime.current() !== null && options.providerCallAdmission?.processExecutionIdentity != null) {
      // The configured profile is ProviderRegistry's raw command descriptor.
      // Let Agent own the actual managed transport, receipt and observer path.
      return super._callOnce({ ...resolved, profile: { ...resolved.profile, command: process.execPath } },
        prompt, options, { ...materializedInvocation,
          finalArgs: ["-e", "process.stdin.pipe(process.stdout)"], stdinContent: text });
    }
    return { text, usage: null, stdout: text, stderr: "",
      providerCompletionEvidence: new AgentProviderCompletionEvidence({
        provider: resolved.providerKey, profile: resolved.profileKey,
        exitCode: 0, stdout: text,
      }) };
  }
}
