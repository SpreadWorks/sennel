import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { AcceptancePhaseScenario, acceptanceProviderResponse } from "../../support/acceptance-phase-scenario.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { UnknownProviderFailure } from "../../../src/lib/agent-failure.js";
import { CanonicalPromptResponseContributionSelection } from "../../../src/flow/lib/prompt-response-adoption.js";
import { capturePromptResponseAdoptionsFromView } from "../../../src/flow/lib/prompt-response-adoption-publication.js";
import { CanonicalFlowVersionReader, QueryRequest, serializeQueryResponse } from "../../../src/flow/query.js";
import { validateFlowQueryResponse } from "../../../src/flow/query-contract.js";

function reload(scenario) {
  return new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
}
function adoptions(scenario, attemptId) {
  return reload(scenario)._store.runtime.readCanonicalTransitionView(scenario.specId, capturePromptResponseAdoptionsFromView)
    .filter((entry) => entry.adoption.selection instanceof CanonicalPromptResponseContributionSelection
      && entry.adoption.selection.executionContract.attemptId === attemptId);
}
async function executions(scenario, attemptId) {
  const request = new QueryRequest({ resource: "executions", condition: { specId: scenario.specId },
    target: { nodeId: "acceptance-review", includeDescendants: false, attemptId }, page: { limit: 100, after: null } });
  let captured;
  try {
    captured = await new CanonicalFlowVersionReader({ repositoryRoot: scenario.root }).read(request.specId, request.flowVersion, request);
  } catch (error) {
    const causes = [];
    for (let cause = error; cause; cause = cause.cause) causes.push({ code: cause.code ?? null, message: cause.message });
    process.stderr.write(`Acceptance query failure: ${JSON.stringify(causes)}\n`);
    throw error;
  }
  if (captured.version.projectionError) throw captured.version.projectionError;
  const response = JSON.parse(serializeQueryResponse(captured.version.response));
  assert.deepEqual(validateFlowQueryResponse(response), []);
  return response;
}
function observeMap(prompt, options, active, characters = 8_000) {
  const observations = options.jsonSchema?.properties?.observations?.items?.properties;
  if (!observations) return undefined;
  const ranges = String(prompt).split("## Canonical evidence ranges\n")[1].split("\n").filter(Boolean).map((line) => JSON.parse(line));
  ranges.forEach((range) => active.acceptanceEvidenceRanges.set(range.sourceRef, range));
  const refs = observations.sourceRef.enum;
  const fact = "The canonical evidence retains the required behavior. ".repeat(Math.ceil(characters / refs.length / 53));
  return JSON.stringify({ observations: refs.map((sourceRef) => ({ sourceRef, facts: [fact] })) });
}
function assertAccepted(response, captured) {
  assert.equal(captured.length, 1);
  const { adoption, activity } = captured[0];
  assert.equal(adoption.selection.publicationLogicalKey, "acceptance.review");
  assert.ok(adoption.selection.contributions.length > 0);
  const selected = new Set(adoption.selection.receivedResponses.map((reference) => reference.logicalInvocationId));
  const accepted = response.items.filter((item) => item.kind === "agent-invocation" && item.response.acceptedAt !== null);
  assert.deepEqual(new Set(accepted.map((item) => item.logicalInvocationId)), selected);
  for (const item of accepted) {
    assert.equal(item.response.acceptedAt, activity.result.confirmedAt);
    assert.ok(item.response.receivedAt !== null);
    assert.ok(response.relations.some((relation) => relation.kind === "accepted-by" && relation.from.id === item.id));
  }
  return adoption.selection;
}

const requirements = ["R1", "R2"].map((id) => ({ id, desc: `Preserve independently verified behavior ${id}.`,
  task_ids: ["T1"], preimplementation_test_expectation: "fail" }));

// Authenticated runtime identities retain the original directory and inode.
// A copied canonical seed cannot stand in for that execution authority at query readback.
describe("Acceptance response publication provenance", { concurrency: false }, () => {
  test("a direct passing response retains its selected completion through actual publication and query reload", async (t) => {
    const scenario = AcceptancePhaseScenario.create(t, { requirements });
    await scenario.advanceTo("acceptance-review");
    const attempt = scenario.state().attempt;
    const result = await scenario.runRegistered("acceptance-review");
    assert.equal(result.result, "ok", JSON.stringify(result));
    assert.equal(result.verdict, "pass");
    const selected = assertAccepted(await executions(scenario, attempt.id), adoptions(scenario, attempt.id));
    assert.deepEqual(selected.contributions.map((contribution) => contribution.receivedResponses[0].scope.stage), ["direct"]);
    assert.equal(selected.receivedResponses[0].binding.attemptId, attempt.id);
  });

  test("direct and reduced repair publications retain selected contributors while a later partial map failure adopts none", async (t) => {
    let phase = "direct";
    let failedCalls = 0;
    let scenario;
    scenario = AcceptancePhaseScenario.create(t, { requirements,
      providerOptions: { promptCharacterLimit: () => phase !== "direct" && scenario?.current() === "acceptance-review" ? 16_000 : null },
      acceptanceResponse: (_ordinal, active) => acceptanceProviderResponse(active, { status: "notMet" }),
      acceptanceProvider: (prompt, options, active) => {
        if (phase === "direct") return undefined;
        if (phase === "failure" && ++failedCalls === 2) throw new UnknownProviderFailure({ message: "The second response was lost." });
        const mapped = observeMap(prompt, options, active, phase === "failure" ? 200 : 8_000);
        if (mapped !== undefined) return mapped;
        const refs = options.jsonSchema?.properties?.sourceRefs?.items?.enum;
        return refs ? JSON.stringify({ sourceRefs: [...refs], summary: "Bound canonical evidence." }) : undefined;
      },
    });
    await scenario.advanceTo("acceptance-review");
    const directAttempt = scenario.state().attempt;
    const direct = await scenario.runRegistered("acceptance-review");
    assert.equal(direct.result, "ok", JSON.stringify(direct));
    assert.equal(direct.verdict, "repair_required");
    const directSelected = assertAccepted(await executions(scenario, directAttempt.id), adoptions(scenario, directAttempt.id));
    assert.deepEqual(directSelected.receivedResponses.map((reference) => reference.scope.stage), ["direct"]);

    phase = "reduction";
    fs.appendFileSync(path.join(scenario.root, "src/implementation.js"), `\n${"// Required behavior retains its independently verified branch.\n".repeat(1_000)}`);
    await scenario.advanceTo("acceptance-review");
    const reducedAttempt = scenario.state().attempt;
    const beforeReduced = scenario.acceptanceProviderCalls.length;
    const reduced = await scenario.runRegistered("acceptance-review");
    assert.equal(reduced.result, "ok", JSON.stringify(reduced));
    assert.equal(reduced.verdict, "repair_required");
    const selected = assertAccepted(await executions(scenario, reducedAttempt.id), adoptions(scenario, reducedAttempt.id));
    const stages = new Set(selected.receivedResponses.map((reference) => reference.scope.stage));
    assert.ok(stages.has("map"));
    assert.ok(stages.has("reduction"));
    assert.ok(stages.has("scoped-final"));
    assert.ok(selected.contributions.some((contribution) => contribution.completionDigest !== contribution.receivedResponses[0].responseDigest),
      "transformed completion evidence retains its own digest instead of pretending it is the raw provider reply");
    assert.equal(selected.receivedResponses.length, scenario.acceptanceProviderCalls.length - beforeReduced);
    assert.equal(new Set(selected.receivedResponses.map((reference) => reference.logicalInvocationId)).size, selected.receivedResponses.length);
    assert.notEqual(reducedAttempt.id, directAttempt.id);

    phase = "failure";
    await scenario.advanceTo("acceptance-review");
    const failedAttempt = scenario.state().attempt;
    const failed = await scenario.runRegistered("acceptance-review");
    assert.equal(failed.ok, false);
    assert.equal(failedCalls, 2);
    assert.equal(adoptions(scenario, failedAttempt.id).length, 0);
    const response = await executions(scenario, failedAttempt.id);
    assert.ok(response.items.some((item) => item.kind === "agent-invocation" && item.response.receivedAt !== null));
    assert.equal(response.relations.some((relation) => relation.kind === "accepted-by"), false);
    assert.equal(adoptions(scenario, directAttempt.id).length, 1);
    assert.equal(adoptions(scenario, reducedAttempt.id).length, 1);
  });
});
