import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createExecutionQueryScenario } from "../../support/infrastructure/execution-query-scenario.js";
import { createFlowQueryScenarioFixture, snapshotFlowQueryTree } from "../../support/builders/flow-query-fixture.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { CanonicalFlowVersionReader, QueryRequest, serializeQueryResponse } from "../../../src/flow/query.js";
import { validateFlowQueryResponse } from "../../../src/flow/query-contract.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { RuntimeChildExecution } from "../../../src/lib/runtime-package.js";
import { FlowProcessExecutionBinding } from "../../../src/flow/lib/flow-process-execution-binding.js";
import { FlowQueryConsumer } from "../../support/builders/flow-query-consumer.js";

const CLI = path.resolve("src/sennel.js");

async function read(scenario, resource = "executions", overrides = {}) {
  const request = new QueryRequest({ resource, condition: { specId: scenario.specId },
    ...(resource === "metadata" ? {} : { page: { limit: 100, after: null } }), ...overrides });
  const captured = await new CanonicalFlowVersionReader({ repositoryRoot: scenario.root }).read(request.specId, request.flowVersion, request);
  if (captured.version.projectionError) throw captured.version.projectionError;
  const response = captured.version.response;
  assert.deepEqual(validateFlowQueryResponse(response), []);
  assert.equal(new FlowQueryConsumer().consumeSerialized(serializeQueryResponse(response)).resource, resource);
  return response;
}

function assertReferences(response) {
  const known = new Map([...response.items.map((item) => [item.id, item.kind]), ...response.endpoints.map((endpoint) => [endpoint.ref.id, endpoint.ref.kind])]);
  const assertRef = (ref) => { if (ref) assert.equal(known.get(ref.id), ref.kind, `unresolved ${ref.kind} ${ref.id}`); };
  for (const relation of response.relations) { assertRef(relation.from); assertRef(relation.to); }
  for (const item of response.items) {
    for (const field of ["caller", "responseDestination", "parentCallRef", "logicalInvocationRef", "providerAttemptRef", "outboxAttemptRef", "resultRef", "stepResultRef"]) assertRef(item[field]);
    for (const ref of item.diagnosticRefs) assertRef(ref);
    for (const field of ["usageRef", "finalResponseUsageRef"]) if (item[field]) assert.ok(response.measurements.some((measurement) => measurement.measurementId === item[field]));
    if (item.kind === "agent-invocation") for (const ref of [item.response.receiverObservationRef, item.response.publicationRef, item.response.settlementRef]) assertRef(ref);
  }
}

// Each scenario starts with the observable result, uses normal producers, then
// discards its manager and queries the committed records. External Node provider
// output is the only substitute for an external service.
test("execution query preserves real Agent/provider/process bindings and nullable measurements across reload", async (t) => {
  const scenario = await createExecutionQueryScenario(t);
  await scenario.run({ cacheMode: "bypass" });
  const manager = scenario.reload();
  assert.notEqual(manager, scenario.flowManager);
  await scenario.shutdown();
  const before = snapshotFlowQueryTree(scenario.root);
  const response = await read(scenario);
  assertReferences(response);
  const agent = response.items.find((item) => item.kind === "agent-invocation");
  const provider = response.items.find((item) => item.kind === "provider-attempt");
  const physical = response.items.find((item) => item.kind === "process-call");
  assert.equal(agent.binding.stepAttemptId, scenario.binding.attempt.id);
  assert.equal(provider.binding.executionContractId, scenario.contract.id);
  assert.equal(physical.binding.executionGeneration, scenario.contract.generation);
  assert.equal(agent.status, "response-ready");
  assert.equal(agent.response.receivedAt, null);
  assert.equal(response.relations.some((relation) => relation.kind === "responds-to" || relation.kind === "accepted-by"), false);
  assert.equal(physical.physicalStatus, "stopped");
  assert.equal(physical.processResult.exitCode, 0);
  assert.equal(provider.providerStarted, true);
  assert.equal(provider.attempt, 1);
  assert.equal(agent.requestedModel, null);
  assert.equal(agent.reportedModel, "reported-model");
  const measurement = response.measurements.find((entry) => entry.measurementId === provider.usageRef);
  assert.equal(measurement.values.inputTokens, 0);
  assert.equal(measurement.values.cacheReadTokens, null);
  assert.equal(response.summary.providerUsage.inputTokens.knownTotal, 0);
  assert.equal(response.summary.providerUsage.cacheReadTokens.completeness, "partial");
  assert.equal(response.summary.legacyMetricCount, 0);
  assert.equal(response.summary.providerAttemptCount, 1);
  assert.equal(response.summary.logicalInvocationCount, 1);
  assert.equal(response.summary.managedCallCount, 1);
  assert.equal(physical.command.complete, false);
  assert.ok(physical.command.argv.every((argument) => argument.value === null));
  assert.equal(physical.fieldCoverage["/command/argv/0/value"].availability, "unavailable");
  assert.equal(JSON.stringify(response).includes(scenario.root), false);
  assert.deepEqual(snapshotFlowQueryTree(scenario.root), before);
});

test("a canonical prompt receiver records received while a cache hit creates no provider or process", async (t) => {
  const scenario = await createExecutionQueryScenario(t, { inputTokens: 17 });
  await scenario.runPrompt();
  await scenario.runPrompt(scenario.reload());
  const received = await read(scenario);
  const agent = received.items.find((item) => item.kind === "agent-invocation");
  assert.equal(agent.status, "received");
  assert.ok(agent.response.receivedAt);
  assert.ok(agent.response.receiverObservationRef);
  assert.equal(agent.response.acceptedAt, null);
  assert.ok(received.relations.some((relation) => relation.kind === "responds-to"));
  assert.equal(received.relations.some((relation) => relation.kind === "accepted-by"), false);
  const providerCount = received.summary.providerAttemptCount;
  await scenario.run();
  const cached = await read(scenario);
  assert.equal(cached.summary.providerAttemptCount, providerCount);
  assert.equal(cached.summary.managedCallCount, received.summary.managedCallCount);
  assert.equal(cached.summary.cacheHitCount, 1);
  const hit = cached.items.find((item) => item.kind === "agent-invocation" && item.cache.hit);
  assert.equal(hit.response.origin, "cache");
  assert.equal(hit.reportedModel, null);
  assert.equal(hit.fieldCoverage["/reportedModel"].availability, "not-applicable");
});

test("provider retries remain separate physical measurements within one logical response", async (t) => {
  const scenario = await createExecutionQueryScenario(t, { providerSequence: [
    { result: "", inputTokens: 5 }, { result: "received", inputTokens: 17 },
  ] });
  await scenario.run({ cacheMode: "bypass", retryCount: 1 });
  await scenario.shutdown();
  const response = await read(scenario);
  const providers = response.items.filter((item) => item.kind === "provider-attempt").sort((a, b) => a.attempt - b.attempt);
  const agent = response.items.find((item) => item.kind === "agent-invocation");
  assert.equal(response.summary.logicalInvocationCount, 1);
  assert.equal(response.summary.providerAttemptCount, 2);
  assert.equal(response.summary.managedCallCount, 2);
  assert.deepEqual(providers.map((item) => item.attempt), [1, 2]);
  assert.deepEqual(providers.map((item) => item.status), ["empty", "completed"]);
  assert.ok(providers.every((item) => item.logicalInvocationRef.id === agent.id));
  assert.equal(response.summary.providerUsage.inputTokens.knownTotal, 22);
  const final = response.measurements.find((item) => item.measurementId === agent.finalResponseUsageRef);
  assert.equal(final.scope, "final-logical-response");
  assert.equal(final.values.inputTokens, 17);
  assertReferences(response);
});

test("query exposes an ongoing launcher start without promoting it to a stopped call or a ready response", async (t) => {
  let releaseFile;
  const scenario = await createExecutionQueryScenario(t, { providerProgram: `
    const fs = require('node:fs');
    const release = process.cwd() + '/release-provider';
    process.stdout.write(JSON.stringify({ result: 'received', usage: { input_tokens: 0, output_tokens: 0 } }));
    const timer = setInterval(() => { if (fs.existsSync(release)) { clearInterval(timer); } }, 10);
  ` });
  releaseFile = path.join(scenario.root, "release-provider");
  let observeStart;
  const started = new Promise((resolve) => { observeStart = resolve; });
  const invocation = scenario.run({ cacheMode: "bypass", onStdout: observeStart });
  let running;
  try {
    await Promise.race([started, invocation.then(() => { throw new Error("provider completed before its output barrier"); })]);
    const before = snapshotFlowQueryTree(scenario.root);
    const response = await read(scenario);
    running = response.items.find((item) => item.kind === "process-call");
    const provider = response.items.find((item) => item.kind === "provider-attempt");
    const agent = response.items.find((item) => item.kind === "agent-invocation");
    assert.equal(running.physicalStatus, "running");
    assert.equal(running.stopVerification, "unverified");
    assert.ok(running.timing.startedAt);
    assert.equal(running.timing.finishedAt, null);
    assert.equal(running.processResult, null);
    assert.equal(provider.providerStarted, true);
    assert.equal(provider.status, "started");
    assert.equal(provider.timing.startedAt, running.timing.startedAt);
    assert.equal(agent.status, "started");
    assert.equal(agent.response.readyAt, null);
    assert.equal(agent.response.receivedAt, null);
    assert.equal(response.relations.some((relation) => relation.kind === "responds-to" || relation.kind === "accepted-by"), false);
    assert.equal((await read(scenario)).snapshot.id, response.snapshot.id);
    assert.deepEqual(snapshotFlowQueryTree(scenario.root), before);
  } finally {
    fs.writeFileSync(releaseFile, "release");
    await invocation;
  }
  await scenario.shutdown();
  const response = await read(scenario);
  const stopped = response.items.find((item) => item.id === running.id);
  assert.equal(stopped.physicalStatus, "stopped");
  assert.equal(stopped.stopVerification, "verified");
  assert.equal(stopped.processResult.exitCode, 0);
  assert.equal(stopped.timing.startedAt, running.timing.startedAt);
  assert.ok(stopped.timing.finishedAt);
});

test("parallel and nested Agent calls keep their recorded caller and measurement ownership across reload", async (t) => {
  const scenario = await createExecutionQueryScenario(t, { inputTokens: 7 });
  let nested = null;
  const outer = scenario.run({ cacheMode: "bypass", onStdout: () => { nested ??= scenario.run({ cacheMode: "bypass" }); } });
  await Promise.all([outer, scenario.run({ cacheMode: "bypass" })]);
  assert.ok(nested);
  await nested;
  await scenario.shutdown();
  const response = await read(scenario);
  const agents = response.items.filter((item) => item.kind === "agent-invocation");
  const child = agents.find((item) => item.caller.kind === "agent-invocation");
  assert.equal(agents.length, 3);
  assert.equal(agents.filter((item) => item.caller.kind === "step-attempt").length, 2);
  assert.ok(agents.some((item) => item.id === child.caller.id));
  assert.equal(response.summary.providerAttemptCount, 3);
  assert.equal(response.summary.managedCallCount, 3);
  assert.equal(response.summary.providerUsage.inputTokens.knownTotal, 21);
  assert.equal(new Set(agents.map((item) => item.finalResponseUsageRef)).size, 3);
  for (const provider of response.items.filter((item) => item.kind === "provider-attempt")) {
    const measurement = response.measurements.find((item) => item.measurementId === provider.usageRef);
    const physical = response.items.find((item) => item.kind === "process-call" && item.providerAttemptRef?.id === provider.id);
    assert.equal(measurement.subjectRef.id, provider.id);
    assert.equal(measurement.values.inputTokens, 7);
    assert.equal(physical.logicalInvocationRef.id, provider.logicalInvocationRef.id);
    assert.equal(physical.binding.flowVersionId, provider.binding.flowVersionId);
  }
  assertReferences(response);
});

test("a nested managed call resolves its physical parent on a one-item page without inventing logical lineage", async (t) => {
  const scenario = await createExecutionQueryScenario(t);
  await scenario.run({ cacheMode: "bypass" });
  const script = path.join(scenario.root, "nested-call.mjs");
  fs.writeFileSync(script, `
    import { runManagedCmdAsync } from ${JSON.stringify(new URL("../../../src/lib/process.js", import.meta.url).href)};
    const result = await runManagedCmdAsync(process.execPath, ['-e', 'process.stdout.write("nested")'], { timeout: 20000 });
    if (!result.ok) throw new Error(result.stderr);
  `);
  const binding = FlowProcessExecutionBinding.forContract(scenario.contract, {
    flowVersionId: scenario.flowManager.canonicalState(scenario.specId).flowVersionId,
  });
  const result = await scenario.runtime.enter(() => RuntimeChildExecution.runAsync(script, [], {
    cwd: scenario.root, timeout: 40000, processExecutionBinding: binding,
  }));
  assert.equal(result.ok, true, result.stderr);
  await scenario.shutdown();
  let after = null;
  let child = null;
  do {
    const response = await read(scenario, "executions", { page: { limit: 1, after } });
    assertReferences(response);
    const item = response.items[0];
    if (item?.kind === "process-call" && item.parentCallRef !== null) {
      child = item;
      assert.equal(item.logicalInvocationRef, null);
      assert.equal(item.providerAttemptRef, null);
      assert.ok(response.endpoints.some((endpoint) => endpoint.ref.id === item.parentCallRef.id && endpoint.availability === "available"));
      assert.ok(response.relations.some((relation) => relation.kind === "calls" && relation.from.id === item.parentCallRef.id && relation.to.id === item.id));
    }
    after = response.pageInfo.hasNext ? response.pageInfo.endCursor : null;
  } while (after !== null);
  assert.ok(child);
});

test("limit one resolves every reference and preserves graph and target summary across all pages", async (t) => {
  const scenario = await createExecutionQueryScenario(t);
  await scenario.run({ cacheMode: "bypass" });
  await scenario.shutdown();
  const metadata = await read(scenario, "metadata");
  // This seed intentionally uses opaque predecessor review payloads. The
  // creation page tests cross-resource identity; full Draft detail scenarios
  // separately exercise their actual registered producers.
  const activities = await read(scenario, "activities", { expectSnapshotId: metadata.snapshot.id, page: { limit: 1, after: null } });
  assert.equal(activities.snapshot.id, metadata.snapshot.id);
  const target = { nodeId: "draft-refine", includeDescendants: false, attemptId: scenario.binding.attempt.id };
  let after = null;
  const items = new Map(), relations = new Map();
  let summary = null, total = null, firstCursor = null;
  do {
    const page = await read(scenario, "executions", { expectSnapshotId: metadata.snapshot.id, target, page: { limit: 1, after } });
    assert.equal(page.snapshot.id, metadata.snapshot.id);
    assertReferences(page);
    if (summary !== null) assert.deepEqual(page.summary, summary);
    firstCursor ??= page.pageInfo.endCursor;
    summary = page.summary;
    total = page.pageInfo.totalItems;
    for (const item of page.items) { assert.equal(items.has(item.id), false); items.set(item.id, item); }
    for (const relation of page.relations) {
      if (relations.has(relation.id)) assert.deepEqual(relation, relations.get(relation.id));
      relations.set(relation.id, relation);
    }
    after = page.pageInfo.hasNext ? page.pageInfo.endCursor : null;
  } while (after !== null);
  assert.equal(items.size, total);
  assert.equal(summary.providerAttemptCount, 1);
  assert.ok(relations.size >= 3);
  await assert.rejects(read(scenario, "executions", {
    target: { ...target, includeDescendants: true }, page: { limit: 1, after: firstCursor },
  }), { code: "CURSOR_QUERY_MISMATCH" });
});

test("runtime-only reservation changes the shared snapshot while unrelated runtime ownership does not", async (t) => {
  const scenario = await createExecutionQueryScenario(t);
  await scenario.run({ cacheMode: "bypass" });
  const first = await read(scenario, "executions", { page: { limit: 1, after: null } });
  const fixed = { ...scenario.contract, flowVersionId: scenario.flowManager.canonicalState(scenario.specId).flowVersionId };
  const call = await scenario.runtime.reserveCall({ binding: fixed, invocation: { kind: "command", commandId: "reserved-only" } });
  const changed = await read(scenario, "metadata");
  assert.notEqual(changed.snapshot.id, first.snapshot.id);
  await assert.rejects(read(scenario, "executions", { page: { limit: 1, after: first.pageInfo.endCursor } }), { code: "SNAPSHOT_CHANGED" });
  const current = await read(scenario);
  const reserved = current.items.find((item) => item.callId === call.callId);
  assert.equal(reserved.physicalStatus, "intent");
  assert.equal(reserved.timing.startedAt, null);
  assert.equal(reserved.processResult, null);
  await scenario.runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
  await scenario.shutdown();
  const stable = await read(scenario);
  const successor = await ProcessExecutionRuntime.acquire({ mainRoot: scenario.root, runId: "unrelated-run", specId: "unrelated-spec" });
  t.after(async () => { if (!successor.closed) await successor.close(); });
  const unrelated = await successor.reserveCall({ invocation: { kind: "command", commandId: "unrelated" } });
  await successor.finishCall(unrelated, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
  await successor.close();
  assert.equal((await read(scenario)).snapshot.id, stable.snapshot.id);
});

test("unobserved versions retain actual Attempt start and reject foreign targets without creating records", async (t) => {
  const scenario = await createFlowQueryScenarioFixture();
  t.after(() => removeTmpDir(scenario.root));
  scenario.flow.activate("branch");
  const before = snapshotFlowQueryTree(scenario.root);
  const response = await read(scenario);
  assert.equal(response.coverage.availability, "not-recorded");
  assert.ok(response.coverage.producerCoverage.some((entry) => entry.producer === "synchronous-command" && entry.status === "outside-managed-scope"));
  assert.ok(response.items.some((item) => item.kind === "step-attempt" && item.startedAt === scenario.flowManager.canonicalState(scenario.specId).attempt.startedAt));
  const activities = await read(scenario, "activities");
  const attempt = scenario.flowManager.canonicalState(scenario.specId).attempt;
  const started = activities.items.find((item) => item.attempt?.id === attempt.id);
  assert.equal(started.attempt.startedAt, attempt.startedAt);
  assert.equal(started.timing, null);
  await assert.rejects(read(scenario, "executions", { target: { nodeId: "missing", includeDescendants: true, attemptId: null } }), { code: "INVALID_REQUEST" });
  await assert.rejects(read(scenario, "executions", { target: { nodeId: "branch", includeDescendants: false, attemptId: "foreign" } }), { code: "INVALID_REQUEST" });
  assert.deepEqual(snapshotFlowQueryTree(scenario.root), before);
});

test("public CLI supports stdin and request files and refuses a damaged referenced source", async (t) => {
  const scenario = await createExecutionQueryScenario(t);
  setupFlowConfig(scenario.root, "en");
  await scenario.run({ cacheMode: "bypass" });
  await scenario.shutdown();
  const request = { resource: "executions", condition: { specId: scenario.specId }, page: { limit: 1, after: null } };
  const env = { ...process.env, SENNEL_WORK_ROOT: scenario.root, SENNEL_SOURCE_ROOT: scenario.root };
  const invoke = (args, input) => spawnSync(process.execPath, [CLI, "flow", "query", ...args], { cwd: scenario.root, env, input, encoding: "utf8", maxBuffer: 4_194_304 });
  const before = snapshotFlowQueryTree(scenario.root);
  const stdin = invoke([], JSON.stringify(request));
  assert.equal(stdin.status, 0, stdin.stderr + stdin.stdout);
  const response = JSON.parse(stdin.stdout);
  assert.equal(response.resource, "executions");
  assert.equal(response.pageInfo.returnedItems, 1);
  assertReferences(response);
  assert.deepEqual(snapshotFlowQueryTree(scenario.root), before);
  const requestFile = path.join(scenario.root, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify(request));
  const fromFile = invoke(["--request-file", requestFile]);
  assert.equal(fromFile.status, 0, fromFile.stderr + fromFile.stdout);
  assert.equal(JSON.parse(fromFile.stdout).snapshot.id, response.snapshot.id);
  const manifest = (await scenario.reload().readExecutionObservations({ specId: scenario.specId })).manifests.find((entry) => entry.runtimeSourceId !== null);
  const source = path.join(scenario.root, ".sennel/process-runtime");
  assert.ok(manifest);
  const namespaces = fs.readdirSync(source);
  assert.equal(namespaces.length, 1);
  const registry = path.join(source, namespaces[0], "inventory.json");
  // Deliberately corrupt only an external persisted input to prove strict failure.
  const files = fs.readdirSync(path.dirname(registry));
  const inventory = files.find((file) => file === "inventory.json" || file === "registry.json");
  assert.ok(inventory, `inventory file absent: ${files}`);
  fs.writeFileSync(path.join(path.dirname(registry), inventory), "{}");
  const damaged = invoke([], JSON.stringify(request));
  assert.equal(damaged.status, 1);
  const failure = JSON.parse(damaged.stdout);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "EXECUTION_RECORD_INCONSISTENT");
  assert.deepEqual(failure.items, []);
  assert.deepEqual(failure.relations, []);
  assert.equal(failure.summary, null);
});

test("execution query refuses malformed and conflicting immutable logical observations", async (t) => {
  for (const malformed of [true, false]) {
    await t.test(malformed ? "unsupported source shape" : "duplicate logical beginning", async (t) => {
      const scenario = await createExecutionQueryScenario(t);
      await scenario.run({ cacheMode: "bypass" });
      const observations = await scenario.reload().readExecutionObservations({ specId: scenario.specId });
      const start = observations.facts.find((fact) => fact.kind === "agent-started");
      const session = scenario.flowManager.prepareExecutionObservationSession({ specId: scenario.specId, binding: start.binding });
      // Malformed boundary evidence is deliberate; ordinary generation is
      // established by the unchanged real invocation above.
      session.append({ kind: "agent-started", entityId: malformed ? "malformed-logical" : start.entityId,
        data: malformed ? {} : start.data });
      const before = snapshotFlowQueryTree(scenario.root);
      await assert.rejects(read(scenario), { code: "EXECUTION_RECORD_INCONSISTENT" });
      assert.deepEqual(snapshotFlowQueryTree(scenario.root), before);
    });
  }
});

test("a runtime record cannot borrow a valid Attempt ID with a different node or provider owner", async (t) => {
  const scenario = await createExecutionQueryScenario(t);
  await scenario.run({ cacheMode: "bypass" });
  const state = scenario.flowManager.canonicalState(scenario.specId);
  const call = await scenario.runtime.reserveCall({ binding: { flowVersionId: state.flowVersionId, runId: state.runId,
    specId: state.specId, nodeId: "branch", taskId: null, attemptId: state.attempt.id, attemptSequence: state.attempt.sequence },
  invocation: { kind: "command", commandId: "invalid-attempt-owner" } });
  await scenario.runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
  const before = snapshotFlowQueryTree(scenario.root);
  await assert.rejects(read(scenario), { code: "EXECUTION_RECORD_INCONSISTENT" });
  assert.deepEqual(snapshotFlowQueryTree(scenario.root), before);
});

test("terminal observations cannot replace the request or measurement captured at invocation start", async (t) => {
  for (const kind of ["agent", "provider"]) {
    await t.test(kind, async (t) => {
      const scenario = await createExecutionQueryScenario(t);
      await scenario.run({ cacheMode: "bypass" });
      const observations = await scenario.reload().readExecutionObservations({ specId: scenario.specId });
      const start = observations.facts.find((fact) => fact.kind === `${kind}-started`);
      const terminal = observations.facts.find((fact) => fact.kind === (kind === "agent" ? "agent-response-ready" : "provider-settled"));
      const entityId = `mismatched-${kind}`;
      const identity = kind === "agent" ? "logicalInvocationId" : "providerAttemptId";
      const changed = kind === "agent" ? "requestId" : "measurementId";
      const session = scenario.flowManager.prepareExecutionObservationSession({ specId: scenario.specId, binding: start.binding });
      // Boundary corruption: the real producer above supplies a valid shape;
      // only the repeated terminal identity is changed in the saved evidence.
      session.append({ kind: start.kind, entityId, data: { ...start.data, [identity]: entityId } });
      session.append({ kind: terminal.kind, entityId, data: { ...terminal.data, [identity]: entityId, [changed]: "another-identity" } });
      const before = snapshotFlowQueryTree(scenario.root);
      await assert.rejects(read(scenario), { code: "EXECUTION_RECORD_INCONSISTENT" });
      assert.deepEqual(snapshotFlowQueryTree(scenario.root), before);
    });
  }
});

test("Activity Outbox facts retain their historical boundary while the execution shows its terminal state", async (t) => {
  const scenario = await createFlowQueryScenarioFixture();
  t.after(() => removeTmpDir(scenario.root));
  scenario.flow.activate("branch");
  const input = { specId: scenario.specId, id: "query-operation", operation: "query-observation" };
  scenario.flowManager.beginOutbox(input);
  scenario.flowManager.completeOutbox({ ...input, result: { internal: "not-public" } });
  const activities = await read(scenario, "activities");
  const beginning = activities.items.find((item) => item.transition.operation === "begin_outbox");
  const completion = activities.items.find((item) => item.transition.operation === "complete_outbox");
  assert.equal(beginning.outbox.status, "pending");
  assert.equal(beginning.outbox.result, null);
  assert.equal(completion.outbox.status, "done");
  assert.equal(completion.outbox.result.id, completion.activity.id);
  const executions = await read(scenario);
  const outbox = executions.items.find((item) => item.kind === "outbox-attempt");
  assert.equal(outbox.status, "done");
  assert.equal(outbox.binding.stepAttemptId, scenario.flowManager.canonicalState(scenario.specId).attempt.id);
  assert.equal(JSON.stringify(activities).includes("not-public"), false);
});
