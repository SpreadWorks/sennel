import crypto from "node:crypto";
import fs from "node:fs";

export function workerArtifactJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function validWorkerHandoffSpec() {
  return {
    goal: "Validate worker handoff publication.",
    background: "The worker cannot write canonical Flow artifacts.",
    scope: { in: ["worker handoff"], out: [] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [{ id: "R1", desc: "Publish a validated artifact.", testable: false, task_ids: ["T1"] }],
    acceptance_criteria: ["The canonical artifact is published."],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
  };
}

export function validWorkerHandoffTaskSpec() {
  return {
    ...validWorkerHandoffSpec(),
    tasks: [{
      id: "T1",
      title: "Publish guarded Spec output",
      goal: "Keep the worker payload canonical.",
      origin: "plan",
      added_round: 0,
      status: "pending",
    }],
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(",")}}`;
  return JSON.stringify(value);
}

export function workerArtifactDigest(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function rewriteWorkerSubmission(request, mutate) {
  const document = JSON.parse(fs.readFileSync(request.submissionPath, "utf8"));
  mutate(document);
  const { handoffDigest, ...unsigned } = document;
  document.handoffDigest = workerArtifactDigest(unsigned);
  fs.writeFileSync(request.submissionPath, workerArtifactJson(document));
}

/** An untrusted producer may forge a transport seal; parent validation must still reject it. */
export function writeUncheckedWorkerSubmission(request, logicalName, payload) {
  const bytes = Buffer.from(workerArtifactJson(payload));
  fs.writeFileSync(request.payloadPath(logicalName), bytes);
  const unsigned = {
    version: request.version, requestDigest: request.requestDigest, runId: request.runId,
    specId: request.specId, issue: request.issue, stepId: request.stepId,
    actionDigest: request.actionDigest, dispatchInvocationId: request.dispatchInvocationId,
    targetAuthority: request.targetAuthority, inputDigest: request.inputDigest, inputRevision: request.inputRevision,
    payloadManifest: [{ logicalName, relativePath: logicalName, targetRelativePath: logicalName,
      digest: crypto.createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length }],
    sourceMutationManifest: null, generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(request.submissionPath, workerArtifactJson({ ...unsigned,
    handoffDigest: workerArtifactDigest(unsigned) }));
}
