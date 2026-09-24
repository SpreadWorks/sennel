import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * src/flow/lib/resolve-auto-check-input.js
 *
 * Phase-aware input resolution for `flow run auto-check` and `flow set auto on`
 * (spec 220). Prepared Flow input is read only through FlowManager's artifact
 * catalog; pre-creation input is a separate in-memory record value.
 *
 * Phase mapping (completion markers read from canonical `steps[]`):
 *   - approval done            → skip AI evaluation (spec-approved)
 *   - draft-gate done + draft  → issue + request + draft body
 *   - otherwise                → issue + request
 *
 * The two callers (run-auto-check, set-auto) must go through this module so
 * that the same flow state always yields the same verdict input (split-brain
 * prevention).
 */

import { getFlowNode } from "../definition.js";
import { findStepById } from "./step-tree.js";

function isStepDone(state, stepId) {
  const steps = state?.steps;
  if (!Array.isArray(steps)) return false;
  const isNested = steps.some((s) => s.children);
  if (isNested) {
    const step = findStepById(steps, stepId);
    return step?.status === "done";
  }
  return steps.some((s) => s && s.id === stepId && s.status === "done");
}

export function isSpecApproved(state) {
  const node = getFlowNode("approval");
  return node ? isStepDone(state, node.id) : false;
}

function isDraftGateDone(state) {
  const node = getFlowNode("draft-gate");
  return node ? isStepDone(state, node.id) : false;
}

function parseDraftGoal(text) {
  try {
    const draft = JSON.parse(text);
    return typeof draft?.goal === "string" ? draft.goal.trim() : "";
  } catch {
    return "";
  }
}

/** A catalog-read failure that callers can expose without weakening input authority. */
export class CanonicalAutoCheckInputError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message, cause === null ? undefined : { cause });
    this.name = "CanonicalAutoCheckInputError";
    this.code = code;
    Object.freeze(this);
  }
}

function canonicalState(state) {
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof state.specId !== "string" || state.specId === "") {
    throw new CanonicalAutoCheckInputError(
      "AUTO_CHECK_INPUT_INVALID",
      "canonical auto-check input requires a Version-1 Flow state",
    );
  }
  return state;
}

/**
 * Deep Version-1 input adapter.  It preserves the historical input order and
 * text format while resolving every durable input through the artifact catalog
 * rather than rebuilding a spec-relative path.
 */
export class CanonicalAutoCheckInputResolver {
  constructor({ flowManager, state } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function") {
      throw new CanonicalAutoCheckInputError(
        "AUTO_CHECK_INPUT_INVALID",
        "canonical auto-check input requires the FlowManager catalog reader",
      );
    }
    this.flowManager = flowManager;
    this.state = canonicalState(state);
    Object.freeze(this);
  }

  resolve() {
    if (isSpecApproved(this.state)) return { skip: true, reason: "spec approved" };

    const draftGateDone = isDraftGateDone(this.state);
    // The command consumes exactly the next-step input authority. Before the
    // draft gate this is the draft context; after it, Spec is the authorized
    // draft consumer. This does not invent a separate auto-check artifact role.
    const consumerNodeId = draftGateDone ? "spec" : "draft";
    const base = this.#baseInput(consumerNodeId);
    if (!draftGateDone) return { skip: false, text: base };

    const draft = this.#artifactText({
      logicalKey: "draft",
      consumerNodeId,
      required: true,
      label: "draft",
    });
    if (!parseDraftGoal(draft)) {
      return { fail: true, verdict: buildGoalMissingVerdict() };
    }
    return {
      skip: false,
      text: base ? `${base}\n\n${draft}` : draft,
      goalGate: { checked: true, passed: true },
    };
  }

  #baseInput(consumerNodeId) {
    const parts = [];
    if (this.state.request) parts.push(String(this.state.request));
    if (this.state.issue === null || this.state.issue === undefined) return parts.join("\n").trim();
    const snapshot = this.#artifactText({
      logicalKey: "issue.snapshot",
      consumerNodeId,
      required: true,
      label: "Issue snapshot",
    });
    parts.push(snapshot);
    return parts.join("\n").trim();
  }

  #artifactText({ logicalKey, consumerNodeId, required, label }) {
    let resolved;
    try {
      resolved = this.flowManager.readArtifact({
        specId: this.state.specId,
        logicalKey,
        consumerNodeId,
        optional: !required,
      });
    } catch (cause) {
      throw new CanonicalAutoCheckInputError(
        "AUTO_CHECK_INPUT_ARTIFACT_INVALID",
        `canonical ${label} artifact cannot be resolved: ${cause.message}`,
        { cause },
      );
    }
    if (resolved === null) {
      throw new CanonicalAutoCheckInputError(
        "AUTO_CHECK_INPUT_ARTIFACT_MISSING",
        `canonical ${label} artifact is required but absent from the catalog`,
      );
    }
    const text = resolved.bytes.toString("utf8").trim();
    if (text === "") {
      throw new CanonicalAutoCheckInputError(
        "AUTO_CHECK_INPUT_ARTIFACT_INVALID",
        `canonical ${label} artifact must not be empty`,
      );
    }
    if (logicalKey === "draft") {
      try {
        JSON.parse(text);
      } catch (cause) {
        throw new CanonicalAutoCheckInputError(
          "AUTO_CHECK_INPUT_ARTIFACT_INVALID",
          `canonical draft artifact must be JSON: ${cause.message}`,
          { cause },
        );
      }
    }
    return text;
  }
}

export function resolveCanonicalAutoCheckInput({ flowManager, state } = {}) {
  return new CanonicalAutoCheckInputResolver({ flowManager, state }).resolve();
}

/** Select the sole authoritative reader for active V1 or pre-creation input. */
export function resolveAutoCheckInputForFlow({ flowManager, state } = {}) {
  return resolveCanonicalAutoCheckInput({ flowManager, state });
}

export function buildGoalMissingVerdict() {
  return {
    eligible: false,
    score: 0,
    maxScore: 24,
    threshold: 16,
    breakdown: {},
    staticGates: { G: false, H: false, I: false },
    goalGate: { checked: true, passed: false },
    reason: "draft goal is missing",
  };
}

export function resolvePersistedAutoCheckTrust(state) {
  if (!state?.autoCheck) return null;
  if (state.autoCheck.goalGate?.passed !== true) {
    return {
      ...buildGoalMissingVerdict(),
      reason: "persisted auto-check is missing a passing goalGate marker",
    };
  }
  return null;
}

function buildPreparingBaseInput(state) {
  const parts = [];
  if (state?.request) parts.push(String(state.request));

  const preparingBody = typeof state?.issueBody === "string" && state.issueBody.length > 0
    ? state.issueBody
    : null;
  if (preparingBody) {
    parts.push(preparingBody);
    return parts.join("\n").trim();
  }

  if (state?.issue) parts.push(`Issue #${state.issue}`);
  return parts.join("\n").trim();
}

/**
 * Resolve the input payload for auto-check based on flow state phase.
 *
 * @param {object} state - flow state (active flow.json or preparing record)
 * @param {object} [paths] - { root: string }
 * @returns {{skip: true, reason: string} | {skip: false, text: string}}
 */
export function resolvePreparingAutoCheckInput(state) {
  if (state?.specId != null || state?.schemaRevision != null) {
    throw new CanonicalAutoCheckInputError(
      "AUTO_CHECK_INPUT_INVALID",
      "prepared Flow input must be resolved through the canonical artifact catalog",
    );
  }
  if (isSpecApproved(state)) {
    return { skip: true, reason: "spec approved" };
  }
  const base = buildPreparingBaseInput(state);
  return { skip: false, text: base };
}

/**
 * Envelope shape returned by the skip path. Shared with set-auto.js.
 */
export function buildSkipVerdict() {
  return {
    eligible: true,
    skipped: true,
    reason: "spec approved",
    goalGate: { checked: false, passed: true, skipped: "spec-approved" },
  };
}
