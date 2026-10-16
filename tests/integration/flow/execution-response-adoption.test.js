import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { container } from "../../../src/lib/container.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { fixtureRepository, configureManagedFixtureRepository, dispatchContainer,
  installGateProviderFake, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { capturePromptResponseAdoptionsFromView } from "../../../src/flow/lib/prompt-response-adoption-publication.js";
import { CanonicalPromptResponseSelection, CanonicalPromptResponseAdoption } from "../../../src/flow/lib/prompt-response-adoption.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { CanonicalFlowVersionReader, QueryRequest, serializeQueryResponse } from "../../../src/flow/query.js";
import { validateFlowQueryResponse } from "../../../src/flow/query-contract.js";
import { FlowActivity } from "../../../src/flow/lib/current-flow-state.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { FlowExecutionInputBaseline } from "../../../src/flow/lib/flow-execution-input-baseline.js";

test("the real worker response selected by dispatch is adopted with its exact journal identity in the publication transaction", async (t) => {
  const root = fixtureRepository("execution-response-adoption-");
  t.after(() => removeTmpDir(root));
  configureManagedFixtureRepository(root);
  const specId = "001-response-adoption";
  let manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  new CanonicalFlowFixture({ flowManager: manager, specId, runId: "adoption-run", request: "Preserve adopted response provenance",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null } }).create().registerActive().activate("draft");
  const provider = installGateProviderFake((_prompt, options) => {
    if (_prompt === "unselected response") return "discarded worker report";
    const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
    const request = JSON.parse(fs.readFileSync(requestPath));
    fs.writeFileSync(requestPayloadPath(request, "draft.json"), `${JSON.stringify(canonicalDraftDocument({ goal: "Preserve adopted response provenance", questions: [] }))}\n`);
    sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
    return "selected worker report";
  }, { transportContext: () => ({ root, flowManager: manager }) });
  t.after(() => provider.mock.restore());
  const agent = container.get("agent");
  const unselectedRuntime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, runId: "adoption-run", specId });
  try {
    await unselectedRuntime.enter(() => agent.call("unselected response", { commandId: "unselected-response", cacheMode: "bypass", retryCount: 0 }));
  } finally { await unselectedRuntime.close(); }
  await new RunDispatchCommand({ agent, maxDispatches: 1 }).run(dispatchContainer({ root, flowManager: manager, agent }),
    { expectSpec: specId, expectRunId: "adoption-run", expectNoIssue: true, _envelopeType: "run", _envelopeKey: "dispatch" });
  manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const captured = manager._store.runtime.readCanonicalTransitionView(specId, capturePromptResponseAdoptionsFromView);
  assert.equal(captured.length, 1);
  const { adoption, descriptor, activity, acceptedAt } = captured[0];
  assert.equal(adoption.selection.receivedResponses.length, 1);
  assert.equal(activity.nodeId, "draft");
  assert.equal(descriptor.activityId, activity.id);
  assert.equal(activity.references.artifacts.some((entry) => entry.id === adoption.handoffDigest), true);
  assert.equal(acceptedAt, activity.result.confirmedAt);
  const sourceStyleActivity = new FlowActivity({ ...activity.toJSON(), references: { evaluations: [], findings: [], repairs: [], artifacts: [] } });
  assert.doesNotThrow(() => adoption.assertPublication(null, sourceStyleActivity));
  const semanticInputs = new CanonicalAcceptanceArtifactStore({ flowManager: manager, state: manager.loadReadOnly(specId) }).executionInputDescriptors();
  assert.equal(semanticInputs.some((entry) => entry.relativePath === descriptor.relativePath), false);
  assert.doesNotThrow(() => semanticInputs.map((entry) => new FlowExecutionInputBaseline({ descriptor: entry })));
  const observation = adoption.selection.receivedResponses[0];
  const facts = (await manager.readExecutionObservations({ specId })).facts;
  assert.equal(facts.some((fact) => fact.kind === "agent-response-ready" && fact.entityId === observation.logicalInvocationId), true);
  assert.equal(manager.canonicalState(specId).findNode("draft").status, "done");
  const readQuery = async (resource) => {
    const request = new QueryRequest({ resource, condition: { specId }, ...(resource === "metadata" ? {} : { page: { limit: 100, after: null } }) });
    const capturedQuery = await new CanonicalFlowVersionReader({ repositoryRoot: root }).read(request.specId, request.flowVersion, request);
    if (capturedQuery.version.projectionError) throw capturedQuery.version.projectionError;
    const response = JSON.parse(serializeQueryResponse(capturedQuery.version.response));
    assert.deepEqual(validateFlowQueryResponse(response), []);
    return response;
  };
  const executions = await readQuery("executions");
  const accepted = executions.items.find((item) => item.kind === "agent-invocation" && item.logicalInvocationId === observation.logicalInvocationId);
  assert.equal(accepted.response.receivedAt, observation.receivedAt);
  assert.equal(accepted.response.readyAt !== null, true);
  assert.equal(accepted.response.acceptedAt, acceptedAt);
  const relation = executions.relations.find((entry) => entry.kind === "accepted-by" && entry.from.id === accepted.id);
  assert.deepEqual(relation.to, accepted.response.publicationRef);
  const metadata = await readQuery("metadata");
  const publication = metadata.item.artifacts.find((entry) => entry.artifactId === accepted.response.publicationRef.id);
  assert.equal(publication.metadata.logicalKey, "execution.response.adoption");
  assert.equal(publication.activityIds.includes(activity.id), true);
  const unselected = executions.items.find((item) => item.kind === "agent-invocation" && item.commandId === "unselected-response");
  assert.equal(unselected.binding.stepAttemptId, accepted.binding.stepAttemptId);
  assert.equal(unselected.response.readyAt !== null, true);
  assert.equal(unselected.response.receivedAt, null);
  assert.equal(unselected.response.acceptedAt, null);
  assert.equal(executions.relations.some((entry) => entry.kind === "accepted-by" && entry.from.id === unselected.id), false);
  const before = fs.readFileSync(manager.canonicalVersionLocation(1, { specId }).catalogFile);
  const alteredReference = { ...observation.toJSON(), receivedAt: "2000-01-01T00:00:00.000Z" };
  const forged = new CanonicalPromptResponseAdoption({ selection: new CanonicalPromptResponseSelection({
    ...adoption.selection.toJSON(), receivedResponses: [alteredReference] }), requestDigest: adoption.requestDigest,
    handoffDigest: adoption.handoffDigest, payloadDigest: adoption.payloadDigest });
  assert.throws(() => manager.publishArtifacts({ specId, nodeId: "draft", artifactWrites: [forged.artifactWrite()] }), /canonical receiver|completion|validated|Attempt|current/i);
  assert.deepEqual(fs.readFileSync(manager.canonicalVersionLocation(1, { specId }).catalogFile), before);
  assert.equal(manager._store.runtime.readCanonicalTransitionView(specId, capturePromptResponseAdoptionsFromView).length, 1);
  const afterRejection = await readQuery("executions");
  assert.equal(afterRejection.snapshot.id, executions.snapshot.id);
  assert.deepEqual(afterRejection.items, executions.items);
  assert.deepEqual(afterRejection.relations, executions.relations);
  assert.deepEqual(afterRejection.measurements, executions.measurements);
});
