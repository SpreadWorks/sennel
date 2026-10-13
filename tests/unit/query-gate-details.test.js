import assert from "node:assert/strict";
import { test } from "node:test";
import { Observation, Diagnosis, NextAction } from "../../src/flow/lib/observation.js";
import { canonicalSourceFindings, findSourceFinding } from "../../src/flow/lib/flow-finding-source.js";
import { canonicalGateFindingObservations, GateFindingSpecific, GateFindingObservation,
  validateRecordedGateObservation, FLOW_QUERY_GATE_FINDING_SPECIFIC_SCHEMA } from "../../src/flow/query-gate-details.js";
import { validateSchema } from "../../src/lib/schema-validate.js";

function observation({ advisory = false, requirementRef = "G-1", observed = "The guardrail requirement is missing.", spec = false } = {}) {
  return new Observation({ kind: "violation", failureMode: advisory ? "process-evidence-missing" : "guardrail-violation",
    requirementRef, where: { file: "spec.json", locator: "goal" }, observed,
    severity: advisory ? "advisory" : "blocking", refs: [requirementRef],
    ...(spec ? { specRevision: `sha256:${"a".repeat(64)}`, targets: [{ entity: "spec", field: "goal" }],
      allowedTargets: [{ target: { entity: "spec", field: "goal" }, operationKinds: ["replace-field"] }] } : {}) }).toJSON();
}

function artifact(observations) {
  return { result: observations.some((value) => value.severity === "blocking") ? "fail" : "pass",
    changed: [], artifacts: { phase: "spec", evaluations: observations.map((value) => ({ guardrail_id: value.requirementRef,
      result: value.severity === "blocking" ? "fail" : "pass", reason: value.observed, observations: [value] })),
    nextAction: new NextAction({ diagnosis: new Diagnosis({ summary: "Saved Gate observations.", observations }),
      prescription: "Use the saved Gate result." }).toJSON() } };
}

const source = { sourceStep: "spec-gate", sourceArtifact: "steps/spec-gate/result.json" };

test("Gate findings preserve blocking consumer identities and original pointers when advisory rows precede them", () => {
  const values = [observation({ advisory: true, requirementRef: "P-1", observed: "Prior process approval was unavailable." }),
    observation({ spec: true }), observation({ requirementRef: "G-2", observed: "The second required rule is missing." })];
  const stored = artifact(values);
  const before = structuredClone(stored);
  const canonical = canonicalSourceFindings({ artifact: stored, ...source });
  const findings = canonicalGateFindingObservations({ artifact: stored, ...source });
  assert.equal(findings.length, 3);
  assert.ok(findings.every((value) => value instanceof GateFindingObservation));
  assert.deepEqual(findings.slice(1).map((value) => value.identity.toJSON()), canonical.map((value) => value.identity.toJSON()));
  assert.deepEqual(findings.map((value) => value.jsonPointer), [0, 1, 2].map((index) => `/artifacts/nextAction/diagnosis/observations/${index}`));
  assert.deepEqual(findings.map((value) => value.identity.sourceArtifact), Array(3).fill(source.sourceArtifact));
  assert.deepEqual(findings.map((value) => findSourceFinding(stored, value.identity)), values);
  assert.deepEqual(stored, before);
});

test("duplicate criterion and top-level mirrors validate without adding extra public findings", () => {
  const value = observation();
  const stored = artifact([value]);
  stored.artifacts.observations = [value];
  stored.artifacts.evaluations.push(structuredClone(stored.artifacts.evaluations[0]));
  assert.equal(canonicalGateFindingObservations({ artifact: stored, ...source }).length, 1);
});

test("identity reuse cannot replace an advisory observation body with a blocking observation body", () => {
  const first = new Observation({ kind: "violation", failureMode: "process-evidence-missing", requirementRef: "P-1",
    where: null, observed: "Prior process evidence is absent.", severity: "advisory", refs: [] }).toJSON();
  const second = new Observation({ ...first, severity: "blocking", refs: ["process:diff-verifiable"] }).toJSON();
  const findings = canonicalGateFindingObservations({ artifact: artifact([first, second]), ...source });
  assert.equal(findings[0].identity.equals(findings[1].identity), true);
  assert.deepEqual(findings.map((value) => value.finding), [first, second]);
  assert.deepEqual(findings.map((value) => value.observation.severity), ["advisory", "blocking"]);
});

test("Gate mirrors cannot contradict the saved primary diagnosis or the criterion requirement", () => {
  for (const mutate of [
    (stored) => { stored.artifacts.observations = [observation({ observed: "A different saved observation." })]; },
    (stored) => { stored.artifacts.evaluations[0].observations[0].observed = "A different criterion observation."; },
    (stored) => { stored.artifacts.evaluations[0].guardrail_id = "G-other"; },
  ]) {
    const stored = artifact([observation()]);
    mutate(stored);
    assert.throws(() => canonicalGateFindingObservations({ artifact: stored, ...source }), TypeError);
  }
});

test("mechanical Gate evaluations and a verified zero-observation result retain zero findings", () => {
  const stored = artifact([]);
  stored.artifacts.evaluations = [{ guardrail_id: "mechanical", result: "pass", reason: "The saved mechanical check passed.", authority: "mechanical" }];
  assert.deepEqual(canonicalGateFindingObservations({ artifact: stored, ...source }), []);
  assert.deepEqual(stored.artifacts.evaluations[0].authority, "mechanical");
});

test("complete saved observations reject unknown kind, normalized failure mode, missing fields and hidden target authority", () => {
  for (const mutate of [
    (value) => { value.kind = "requirement-failure"; },
    (value) => { value.kind = "exception"; },
    (value) => { value.failureMode = "unsupported-future-mode"; },
    (value) => { value.runtimeSeal = "internal"; },
    (value) => { delete value.refs; },
    (value) => { value.observed = ` ${value.observed} `; },
    (value) => { value.allowedTargets[0].expectedDigest = "b".repeat(64); },
    (value) => { value.allowedTargets[0].operationKinds = ["arbitrary-operation"]; },
    (value) => { value.targets[0].internalAuthority = true; },
  ]) {
    const value = observation({ spec: true });
    mutate(value);
    assert.throws(() => validateRecordedGateObservation(value));
  }
});

test("closed Gate specific preserves the saved meaning and typed targets without internal receipts", () => {
  const value = observation({ spec: true });
  const projected = new GateFindingSpecific(value).toJSON();
  assert.deepEqual(projected, { schemaId: "gate-finding@1", kind: "violation", failureMode: value.failureMode,
    requirementRef: value.requirementRef, where: value.where, refs: value.refs, specRevision: value.specRevision,
    targets: value.targets, allowedTargets: value.allowedTargets });
  assert.deepEqual(validateSchema(projected, FLOW_QUERY_GATE_FINDING_SPECIFIC_SCHEMA), []);
  const unbound = new GateFindingSpecific(observation()).toJSON();
  assert.equal(unbound.specRevision, null);
  assert.equal(unbound.targets, null);
  assert.equal(unbound.allowedTargets, null);
  assert.deepEqual(validateSchema(unbound, FLOW_QUERY_GATE_FINDING_SPECIFIC_SCHEMA), []);
  for (const mutate of [
    (specific) => { specific.kind = "unknown"; },
    (specific) => { specific.failureMode = "unknown"; },
    (specific) => { specific.targets[0].runtimeSeal = "unknown"; },
    (specific) => { specific.allowedTargets[0].expectedDigest = "b".repeat(64); },
    (specific) => { specific.extraMeaning = true; },
    (specific) => { specific.targets = null; },
    (specific) => { specific.specRevision = null; },
  ]) {
    const invalid = structuredClone(projected);
    mutate(invalid);
    assert.ok(validateSchema(invalid, FLOW_QUERY_GATE_FINDING_SPECIFIC_SCHEMA).length > 0);
  }
});
