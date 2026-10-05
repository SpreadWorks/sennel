import crypto from "node:crypto";

import {
  WorkerArtifactHandoffCoordinator,
  materializeSourceWorkerEffect,
  sealParentMaterializedSourceWorkerEffect,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowHandoffAuthorityLease } from "../../../src/lib/flow-handoff-authority-lease.js";

function sourceContext({ root, mainRoot = root, manager, specId }) {
  return {
    root, executionRoot: root, mainRoot, specId, flowManager: manager,
    flowState: manager.loadReadOnly(specId), config: {},
  };
}

export function withSourceHandoffLease({ root, mainRoot = root }, callback) {
  const lease = new FlowHandoffAuthorityLease({ mainRoot, executionRoot: root });
  lease.acquire();
  try {
    return callback();
  } finally {
    lease.release();
  }
}

/**
 * Complete one source Attempt through the same durable coordinator protocol as
 * run-dispatch, while keeping the external worker boundary deterministic.
 */
export function completeCanonicalSourceHandoff({
  root, mainRoot = root, manager, specId, stepId, taskId = null,
  mutate = () => {}, effect, invocationId = null, now = () => new Date("2026-09-09T00:00:00.000Z"),
} = {}) {
  if (typeof mutate !== "function") throw new TypeError("source handoff scenario mutate must be a function");
  const coordinator = new WorkerArtifactHandoffCoordinator({ now });
  const ctx = sourceContext({ root, mainRoot, manager, specId });
  const attempt = manager.canonicalState(specId).attempt;
  const id = invocationId ?? `source-scenario-${stepId}-${attempt.id}`;
  const invocation = {
    id,
    target: { digest: crypto.createHash("sha256").update(`${id}:target`).digest("hex") },
    action: {
      digest: crypto.createHash("sha256").update(`${id}:action`).digest("hex"),
      nextAction: { step: stepId, ...(taskId === null ? {} : { taskId }) },
    },
  };
  return withSourceHandoffLease({ root, mainRoot }, () => {
    const request = coordinator.createRequest({ ctx, state: manager.loadReadOnly(specId), invocation });
    coordinator.startSourceWorker({ ctx, request, invocation });
    mutate(request);
    const document = typeof effect === "function" ? effect(request) : effect;
    materializeSourceWorkerEffect({ request, responseText: JSON.stringify(document) });
    sealParentMaterializedSourceWorkerEffect({ request });
    coordinator.finishSourceWorker({ ctx, request });
    const reconciliation = coordinator.reconcile({
      ctx, request, mutationAuthority: coordinator.sourceMutationAuthority({ ctx, request }),
    });
    return Object.freeze({ coordinator, ctx, invocation, request, reconciliation });
  });
}
