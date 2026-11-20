import { FlowProcessEventWriter } from "./flow-process-event.js";
import { ProcessExecutionBindingSelection } from "../../lib/process-execution-finalization.js";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { FlowProcessStopEvidence } from "./process-runtime-evidence.js";
import { ProcessExecutionRuntime, ProcessExecutionCallAdmission, PROCESS_EXECUTION_SCOPE_ENV } from "../../lib/process-execution-runtime.js";
import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { taskIdForResolvedStep, findActiveNode } from "../definition.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
import { FlowProcessExecutionBinding } from "./flow-process-execution-binding.js";
export { FlowProcessExecutionBinding } from "./flow-process-execution-binding.js";
import { ProcessExecutionControlFailure } from "../../lib/process-execution-values.js";
import { FlowDispatchLease } from "./flow-dispatch-lease.js";
import { FlowDispatchSession, FlowDispatchTarget } from "./dispatch-invocation.js";
import { FlowProcessPhysicalAuthority } from "./flow-process-physical-authority.js";
import { withRuntimeRecordMigrationPreview } from "../../lib/process-runtime-migration-guidance.js";

const admissions = new AsyncLocalStorage();

export function captureFlowProcessExecutionBinding(ctx, { executionContract = null, dispatchInvocationId = null,
  workUnitId = null, requestDigest = null, commandId = null } = {}) {
  const specId = ctx.specId ?? ctx.flowState?.specId ?? null;
  const state = specId === null ? null : ctx.flowManager.canonicalState(specId);
  const flowState = state === null ? ctx.flowState : ctx.flowManager.loadReadOnly(specId);
  const active = flowState ? findActiveNode(flowState) : null;
  const attempt = state?.attempt ?? null;
  const outboxBinding = ctx.flowOutboxEntry?.executionBinding ?? null;
  if (outboxBinding !== null && ["runId", "specId", "flowVersionId"].some((field) => outboxBinding[field] !== state?.[field])) {
    throw new ProcessExecutionControlFailure("binding-changed", "Outbox execution reference belongs to another Flow Version");
  }
  return new FlowProcessExecutionBinding({
    runId: state?.runId ?? ctx.preparingFlowState?.runId ?? null,
    specId: state?.specId ?? specId,
    flowVersionId: state?.flowVersionId ?? null,
    nodeId: attempt?.nodeId ?? active?.stepId ?? null,
    taskId: active === null ? null : taskIdForResolvedStep(active, active.stepId),
    attemptId: attempt?.id ?? null,
    attemptSequence: attempt?.sequence ?? null,
    executionContractId: executionContract?.id ?? null,
    executionGeneration: executionContract?.generation ?? null,
    dispatchInvocationId,
    workUnitId,
    requestDigest,
    commandId,
    outboxAttemptId: outboxBinding?.outboxAttemptId ?? null,
  });
}

function roots(ctx, authority = null) {
  return {
    mainRoot: fs.realpathSync(ctx.mainRoot || ctx.root),
    executionRoot: contextExecutionRoot(ctx.executionRoot || ctx.root, authority),
  };
}

function contextExecutionRoot(root, authority) {
  try { return fs.realpathSync(root); }
  catch (error) {
    if (error.code === "ENOENT" && authority?.sourceRemoval !== null
      && authority?.sourceRemoval !== undefined && root === authority.sourceRoot) return authority.contextRoot;
    throw error;
  }
}

function processOwnedFlow(ctx) {
  return ctx?.flowManager != null && ctx?.root != null
    && (ctx.flowState?.schemaRevision === CURRENT_FLOW_SCHEMA_REVISION
      || ctx.preparingFlowState != null
      || process.env[PROCESS_EXECUTION_SCOPE_ENV] != null);
}

export function flowProcessRuntimeRequired({ ctx, envelopeType, envelopeKey, input, readOnly }) {
  if (readOnly === true || (envelopeType === "get" && readOnly !== false)
    || envelopeKey === "resume" || input?.dryRun === true) return false;
  return processOwnedFlow(ctx)
    || ctx?.flowManager != null && ctx?.root != null
      && ["init", "prepare-spec"].includes(envelopeKey);
}

async function assertRetainedPhysicalAuthority(ctx, authority, factory) {
  withRuntimeRecordMigrationPreview({ mainRoot: authority.mainRoot, executionRoot: authority.sourceRoot }, () =>
    ProcessExecutionRuntime.inspectRetainedClosedCheckout({ mainRoot: authority.mainRoot,
      executionRoot: authority.sourceRoot, runId: authority.runId, specId: authority.specId }));
  const fresh = await factory(ctx);
  if (!authority.matches(fresh)) throw new ProcessExecutionControlFailure("binding-changed",
    "Cleanup physical authority changed after retained checkout proof");
}

class FlowProcessRuntimeAdmission {
  constructor({ runtime, contextRoots, dispatchLease = null, authority = null, ownsRuntime = true }) {
    if (runtime.mainRoot !== contextRoots.mainRoot
      || runtime.executionRoot !== (authority?.sourceRemoval ? authority.executionRoot : authority?.sourceRoot ?? contextRoots.executionRoot)) {
      throw new ProcessExecutionControlFailure("binding-changed", "Flow runtime admission belongs to another checkout");
    }
    this.runtime = runtime;
    this.mainRoot = contextRoots.mainRoot;
    this.executionRoot = contextRoots.executionRoot;
    this.dispatchLease = dispatchLease;
    this.ownsRuntime = ownsRuntime;
    this.reservations = [];
    this.retainedAuthority = authority?.sourceRemoval ? authority : null;
  }

  assertContext(ctx) {
    const actual = roots(ctx, this.retainedAuthority);
    if (actual.mainRoot !== this.mainRoot || actual.executionRoot !== this.executionRoot) {
      throw new ProcessExecutionControlFailure("binding-changed", "Flow runtime admission belongs to another checkout");
    }
    const runId = ctx.flowState?.runId ?? ctx.preparingFlowState?.runId ?? null;
    const specId = ctx.specId ?? ctx.flowState?.specId ?? null;
    if (runId !== null && this.runtime.runId !== null && runId !== this.runtime.runId
      || specId !== null && this.runtime.specId !== null && specId !== this.runtime.specId) {
      throw new ProcessExecutionControlFailure("binding-changed", "Flow runtime admission belongs to another Flow");
    }
  }

  async enter(ctx, callback, bindingOptions, authorityFactory = null, authority = null) {
    if (authorityFactory !== null) {
      authority ??= await authorityFactory(ctx);
      if (authority !== null) this.assertAuthority(authority);
      if (authority?.sourceRemoval && !this.retainedAuthority?.matches(authority)) {
        const reserved = this.reservations.some((reservation) => !reservation.released
          && reservation.checkoutIdentity.mainRoot === authority.mainRoot
          && reservation.checkoutIdentity.executionRoot === authority.sourceRoot);
        if (!reserved) await assertRetainedPhysicalAuthority(ctx, authority, authorityFactory);
        this.retainedAuthority = authority;
      }
    }
    this.assertContext(ctx);
    if (authority !== null && this.runtime.executionRoot !== authority.executionRoot) {
      if (!this.ownsRuntime || this.runtime.borrowed || this.runtime.executionRoot !== authority.sourceRoot) {
        throw new ProcessExecutionControlFailure("handoff-refused", "Only the owning checkout may transfer physical execution authority");
      }
      this.reservations.push(await this.runtime.sealForCheckoutHandoff());
      const current = await authorityFactory(ctx);
      this.assertAuthority(current);
      if (!authority.matches(current)) {
        throw new ProcessExecutionControlFailure("binding-changed", "Selected physical execution authority changed while stopping the source checkout");
      }
      this.runtime = await withRuntimeRecordMigrationPreview({ mainRoot: authority.mainRoot, executionRoot: authority.executionRoot }, () =>
        ProcessExecutionRuntime.acquire({ mainRoot: authority.mainRoot,
          executionRoot: authority.executionRoot, runId: authority.runId, specId: authority.specId, binding: null }));
    }
    const binding = this.runtime.borrowed ? this.runtime.binding : captureFlowProcessExecutionBinding(ctx, bindingOptions);
    const callAdmission = new ProcessExecutionCallAdmission({ admit: ({ binding: requested }) => {
      if (requested.value?.attemptId != null) {
        const session = ctx.flowManager.prepareExecutionObservationSession({ specId: requested.value.specId, binding: requested });
        if (session === null) throw new ProcessExecutionControlFailure("observation-save-failed",
          "Managed execution requires its exact saved observation source");
      }
    } });
    // Borrowed calls retain their binding; only the owner publishes process events.
    const writer = this.runtime.borrowed ? null : new FlowProcessEventWriter(ctx.flowManager);
    if (writer !== null && binding.value?.flowVersionId != null) {
      this.runtime.drainEventsSync(writer, new ProcessExecutionBindingSelection({
        runId: binding.value.runId, specId: binding.value.specId, flowVersionId: binding.value.flowVersionId,
      }));
    }
    return admissions.run(this, () => this.runtime.enter(() => this.runtime.withBinding(binding, callback, { callAdmission, eventWriter: writer })));
  }

  assertAuthority(authority) {
    if (!(authority instanceof FlowProcessPhysicalAuthority)
      || authority.mainRoot !== this.mainRoot || authority.contextRoot !== this.executionRoot
      || authority.runId !== this.runtime.runId || authority.specId !== this.runtime.specId) {
      throw new ProcessExecutionControlFailure("binding-changed", "Selected physical execution authority differs from its Flow admission");
    }
  }

  async close() {
    let failure = null;
    const reservations = [...this.reservations].reverse();
    const attempted = new Set();
    const release = (reservation) => {
      attempted.add(reservation);
      try { reservation.release(); }
      catch (error) { failure ??= error; }
    };
    if (this.ownsRuntime && this.runtime.closed) {
      for (const reservation of reservations) {
        if (reservation.executionId === this.runtime.executionId
          && reservation.ownerEpoch === this.runtime.ownerEpoch && !reservation.released) release(reservation);
      }
    }
    try { if (this.ownsRuntime) await this.runtime.close(); }
    catch (error) { failure ??= error; }
    for (const reservation of reservations) {
      if (!attempted.has(reservation)) release(reservation);
    }
    if (failure !== null) throw failure;
  }
}

/** One admission spans registry hooks, command execution, publication and cleanup. */
export async function withFlowProcessRuntime(ctx, callback, {
  commandId = null,
  dispatchLeaseFactory = null,
  required = processOwnedFlow(ctx),
  bindingOptions = {},
  physicalAuthority = null,
} = {}) {
  if (!required) return callback();
  const existing = admissions.getStore();
  if (existing) return existing.enter(ctx, callback, { ...bindingOptions, commandId }, physicalAuthority);
  const authority = physicalAuthority === null ? null : await physicalAuthority(ctx);
  const contextRoots = roots(ctx, authority);
  if (authority !== null && !(authority instanceof FlowProcessPhysicalAuthority)) throw new TypeError("Physical authority supplier must return FlowProcessPhysicalAuthority");
  let dispatchLease = null;
  let runtime = null;
  let result;
  const failures = [];
  try {
    if (commandId === "dispatch") {
      let target;
      try {
        target = FlowDispatchTarget.captureContext({ ...ctx, flowCommandBoundary: true });
      } catch (cause) {
        const refusal = new StepAdmissionRefusal(
          "flow dispatch requires an exact --expect-binding or --expect-run-id target", cause);
        refusal.code = "FLOW_DISPATCH_TARGET_REQUIRED";
        throw refusal;
      }
      dispatchLease = (dispatchLeaseFactory ?? ((session) => new FlowDispatchLease(session)))(
        new FlowDispatchSession({ target }));
      dispatchLease.acquire();
    }
    const current = ProcessExecutionRuntime.current();
    const borrowed = current !== null;
    if (authority?.sourceRemoval) {
      await assertRetainedPhysicalAuthority(ctx, authority, physicalAuthority);
    }
    const runtimeRoots = {
      ...contextRoots,
      ...(authority === null ? {} : { executionRoot: authority.sourceRemoval ? authority.executionRoot : authority.sourceRoot }),
    };
    runtime = current ?? await withRuntimeRecordMigrationPreview(runtimeRoots, () => ProcessExecutionRuntime.acquire({
      ...runtimeRoots,
      runId: ctx.flowState?.runId ?? ctx.preparingFlowState?.runId ?? null,
      specId: ctx.specId ?? ctx.flowState?.specId ?? null,
      binding: null,
    }));
    let admission = null;
    try {
      admission = new FlowProcessRuntimeAdmission({ runtime, contextRoots, dispatchLease, authority, ownsRuntime: !borrowed });
      result = await admission.enter(ctx, callback, { ...bindingOptions, commandId }, physicalAuthority, authority);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (admission !== null) await admission.close();
        else if (!borrowed) await runtime.close();
      } catch (error) { failures.push(error); }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try { dispatchLease?.release(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const cause = new AggregateError(failures, "Flow execution boundary has multiple failures", { cause: failures[0] });
    const refusal = failures.slice().reverse().find((error) => error instanceof ProcessExecutionControlFailure);
    throw refusal ? refusal.withCause(cause) : cause;
  }
  return result;
}

/** The dispatch command borrows its lease prepared before registry pre. */
export function preparedFlowDispatchLease() { return admissions.getStore()?.dispatchLease ?? null; }

/** Synchronous persistence/recovery APIs never implicitly kill a process. */
export function assertFlowProcessRuntimeQuiescent(ctx) {
  if (!ctx?.root || !ctx?.flowManager) return;
  const selected = roots(ctx);
  withRuntimeRecordMigrationPreview(selected, () => ProcessExecutionRuntime.assertQuiescent({ ...selected,
    runId: ctx.flowState?.runId ?? ctx.preparingFlowState?.runId,
    specId: ctx.specId ?? ctx.flowState?.specId,
  }));
}

/** Read the requested canonical namespace, independently of an ambient inspection scope. */
export function readFlowProcessStops({ mainRoot, executionRoot }) {
  const registry = withRuntimeRecordMigrationPreview({ mainRoot, executionRoot }, () => ProcessExecutionRuntime.inspect({ mainRoot, executionRoot }));
  return (registry?.executions ?? [])
    .flatMap((execution) => execution.calls.filter((call) => call.receipt !== null).map((call) => FlowProcessStopEvidence.fromStored(call.receipt)));
}
