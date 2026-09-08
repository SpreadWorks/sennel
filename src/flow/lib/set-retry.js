/** Version-1 entry point for an explicit retry Attempt transition. */

import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import {
  CanonicalRetryRecovery,
  captureRetryRecoveryBaseline,
  readRetryBaseline,
  RetryRecoveryInput,
} from "./retry-recovery.js";

export default class SetRetryCommand extends FlowCommand {
  execute(ctx) {
    const explicitTarget = {
      runId: ctx.targetExpectation?.effectiveRunId ?? ctx.flowState?.runId,
      specId: ctx.targetExpectation?.effectiveSpecId ?? ctx.flowState?.specId,
      issue: ctx.targetExpectation?.effectiveIssue ?? ctx.flowState?.issue ?? null,
    };
    let request;
    try {
      request = new RetryRecoveryInput({
        ...ctx,
        changedEvidence: null,
        target: explicitTarget,
      });
      const nodeId = ctx.flowState?.current?.at(-1) ?? ctx.flowState?.currentNodeId ?? null;
      const activeNodeId = ctx.flowState?.attempt?.nodeId ?? nodeId;
      const canonicalState = activeNodeId === null ? null : ctx.flowManager.canonicalState(ctx.flowState.specId);
      const exhausted = canonicalState?.attempt?.failure !== null
        && canonicalState.failureDisposition()?.operation !== "retry"
        && (canonicalState.attempt.failure.retryKind === "tooling"
          || ["tooling", "provider"].includes(canonicalState.attempt.failure.category));
      if (activeNodeId !== null && exhausted) {
        const derived = deriveCurrentEvidence(ctx, request.kind, request.phase, activeNodeId);
        const previous = readRetryBaseline(ctx.flowManager, canonicalState, derived.baseline.route);
        if (exhausted && previous === null) throw new Error("exhausted retry recovery requires a durable parent-derived baseline");
        request = new RetryRecoveryInput({
          ...ctx,
          changedEvidence: {
            digest: derived.digest,
            projectDigest: derived.projectDigest,
            runtimeDigest: derived.runtimeDigest,
            targetDigest: derived.targetDigest,
            previousDigest: previous.digest,
          },
          target: explicitTarget,
        });
      }
    } catch (error) {
      return Envelope.fail("set", "retry", "INVALID_RECOVERY_INPUT", error.message);
    }

    try {
      const grant = new CanonicalRetryRecovery({
        flowManager: ctx.flowManager,
        state: ctx.flowState,
        request,
        executionRoot: ctx.executionRoot || ctx.root,
      }).apply();
      return {
        action: request.action,
        kind: request.kind,
        phase: request.phase,
        reset: true,
        grants: [grant.toJSON()],
      };
    } catch (error) {
      return Envelope.fail("set", "retry", "RETRY_NOT_AVAILABLE", error.message);
    }
  }
}

function deriveCurrentEvidence(ctx, kind, phase, nodeId) {
  const canonical = ctx.flowManager.canonicalState(ctx.flowState.specId);
  const baseline = captureRetryRecoveryBaseline({
    flowState: ctx.flowState,
    flowManager: ctx.flowManager,
    executionRoot: ctx.executionRoot || ctx.root,
    artifactRoot: ctx.mainRoot || ctx.root,
    nodeId,
    attempt: canonical?.attempt,
  });
  if (baseline === null) throw new Error("recovery is supported only for review or gate Attempts");
  return {
    digest: baseline.digest,
    projectDigest: baseline.projectDigest,
    runtimeDigest: baseline.runtimeDigest,
    targetDigest: baseline.targetDigest,
    baseline,
  };
}
