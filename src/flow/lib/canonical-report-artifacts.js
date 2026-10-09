import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * Catalog-backed inputs for the report producer.
 *
 * Report rendering predates Flow Version 1 and used to discover sibling
 * files below a mutable spec directory.  This adapter deliberately exposes
 * only typed, consumer-authorized reads.  It gives the report command a
 * small durable view without introducing another report-specific layout or
 * serializer.
 */

import { CanonicalCommandAttemptArtifactHistory, attachedCanonicalCommandResultPublications } from "./canonical-command-result.js";
import { isDeepStrictEqual } from "node:util";
import { ReportGeneratedResult } from "../engine/step-result.js";
import { ReportBinding } from "./report-binding.js";
import { assertReportFinalRegressionEvidence } from "./report-final-evidence.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";

function requiredObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}
function json(bytes, field) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${field} bytes must be a Buffer`);
  try {
    return requiredObject(JSON.parse(bytes.toString("utf8")), field);
  } catch (error) {
    throw new Error(`${field} must be JSON: ${error.message}`);
  }
}

function canonicalState(state) {
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof state.specId !== "string" || state.specId === "") {
    throw new Error("CanonicalReportArtifactStore requires a Version-1 Flow state");
  }
  return state;
}

/** One catalog-resolved JSON document, including its authoritative path. */
export class CanonicalReportDocument {
  constructor({ logicalKey, relativePath, value, descriptor } = {}) {
    if (typeof logicalKey !== "string" || logicalKey === "") {
      throw new Error("canonical report document logicalKey is required");
    }
    if (typeof relativePath !== "string" || relativePath === "") {
      throw new Error("canonical report document relativePath is required");
    }
    this.descriptor = descriptor;
    this.logicalKey = logicalKey;
    this.relativePath = relativePath;
    this.value = Object.freeze(structuredClone(requiredObject(value, `canonical ${logicalKey}`)));
    Object.freeze(this);
  }
}

/**
 * Deep report-facing adapter over FlowManager.  There is intentionally no
 * legacy branch: callers choose this object only after loading exact V1
 * state, and every returned path originated in the artifact catalog.
 */
export class CanonicalReportArtifactStore {
  constructor({ flowManager, state } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function") {
      throw new Error("CanonicalReportArtifactStore requires FlowManager.readArtifact");
    }
    this.flowManager = flowManager;
    this.state = canonicalState(state);
    this.specId = this.state.specId;
    Object.freeze(this);
  }

  readDocument({ logicalKey, consumerNodeId = "report", parameters = {}, optional = false } = {}) {
    const resolved = this.flowManager.readArtifact({
      specId: this.specId,
      logicalKey,
      parameters,
      consumerNodeId,
      optional,
    });
    if (resolved === null) return null;
    return new CanonicalReportDocument({
      logicalKey,
      relativePath: resolved.relativePath,
      value: json(resolved.bytes, `canonical ${logicalKey}`),
      descriptor: resolved.descriptor,
    });
  }

  readCurrentAttempt({ logicalKey, consumerNodeId = "report", parameters = {}, optional = false } = {}) {
    const document = this.readDocument({ logicalKey, consumerNodeId, parameters, optional });
    if (document === null) return null;
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey,
      bytes: Buffer.from(`${JSON.stringify(document.value)}\n`, "utf8"),
    });
    return Object.freeze({
      logicalKey,
      relativePath: document.relativePath,
      attempt: history.current.attempt,
      descriptor: document.descriptor,
      value: history.current.payload,
    });
  }
}

/** Authenticate both saved report inputs and the implementation tested by regression. */
export function assertCanonicalReportFinalEvidence({ flowManager, specId, report = null }) {
  const state = flowManager.canonicalState(specId);
  const root = flowManager.executionRoot();
  const location = flowManager.specLocation(specId);
  if (report !== null) ReportBinding.validate(report.data.binding, { root, artifactRoot: location.repositoryRoot });
  const current = new CanonicalReportArtifactStore({ flowManager, state }).readCurrentAttempt({ logicalKey: "final.regression" });
  const saved = flowManager.readCurrentStepSettlement({ specId, stepId: "final-regression", completed: true });
  const acceptedEvidence = saved?.result.evidence?.acceptedDecision == null ? null : saved.result.evidence;
  if (acceptedEvidence !== null && (acceptedEvidence.publication.producerActivityId !== current.descriptor.activityId
    || acceptedEvidence.publication.fingerprint !== current.descriptor.hash
    || acceptedEvidence.publication.artifactId !== current.relativePath)) {
    throw new StepAdmissionRefusal("Report final regression acceptance differs from its source publication");
  }
  assertReportFinalRegressionEvidence({ root, relativeSpecFile: location.relativeSpecFile, artifact: current.value, acceptedEvidence });
}

/** Recover a lost commit acknowledgement from the exact saved report producer. */
export function authenticateReportCommandReplay({ flowManager, specId, commandResult }) {
  const state = flowManager.canonicalState(specId);
  if (state.current?.at(-1) === "report") return null;
  const saved = flowManager.readCurrentStepSettlement({ specId, stepId: "report", completed: true });
  if (!(saved?.result instanceof ReportGeneratedResult) || saved.receipt.resultKind !== saved.result.kind
    || saved.receipt.binding.runId !== state.runId || saved.receipt.binding.specId !== state.specId
    || saved.receipt.targetStepId !== "finalize-commit") {
    throw new StepAdmissionRefusal("Report replay requires its exact completed Result and receipt");
  }
  const store = new CanonicalReportArtifactStore({ flowManager, state });
  const current = store.readDocument({ logicalKey: "report" });
  const evidence = saved.result.evidence;
  const publications = attachedCanonicalCommandResultPublications(commandResult);
  const supplied = publications.length === 1 && publications[0].logicalKey === "report" ? publications[0] : null;
  if (supplied === null || evidence.publication.producerActivityId !== saved.activityId
    || current.descriptor.activityId !== saved.activityId || current.descriptor.hash !== evidence.publication.fingerprint
    || current.relativePath !== evidence.publication.artifactId
    || !Buffer.from(`${JSON.stringify(current.value, null, 2)}\n`).equals(supplied.toArtifactWrite().bytes)) {
    throw new StepAdmissionRefusal("Report replay differs from its confirmed publication");
  }
  const outbox = flowManager.outboxStatus({ specId, id: evidence.outboxIdentity.idempotencyKey,
    operation: evidence.outboxIdentity.operation });
  if (outbox.status !== "done" || !isDeepStrictEqual(outbox.result?.issueComment, commandResult.issueComment)) {
    throw new StepAdmissionRefusal("Report replay differs from its confirmed delivery");
  }
  assertCanonicalReportFinalEvidence({ flowManager, specId, report: current.value });
  return saved.receipt;
}
