import { ProcessExecutionEvent, PROCESS_EXECUTION_EVENT_TYPES, ProcessExecutionControlFailure,
  ProcessExecutionCanonicalAcknowledgement, ProcessExecutionRuntimeOnlyDisposition,
  ProcessExecutionAtomicEventWriter, ProcessExecutionEventGroup } from "../../lib/process-execution-values.js";
import { ProcessExecutionFinalizationBarrier } from "../../lib/process-execution-finalization.js";

export const PROCESS_EVENT_OPERATION = "record_process_event";
export const PROCESS_EVENT_ACTIVITY_TYPES = Object.freeze(PROCESS_EXECUTION_EVENT_TYPES.map((type) => `outbox_process_${type.replaceAll("-", "_")}`));

/** Canonical publication validates the captured origin without choosing a Flow route. */
export class FlowProcessEvent {
  constructor(event) {
    this.event = event instanceof ProcessExecutionEvent ? event : ProcessExecutionEvent.fromStored(event);
    Object.freeze(this);
  }
  get activityType() { return `outbox_process_${this.event.type.replaceAll("-", "_")}`; }
  get activityId() { return `process-event-${this.event.eventId}`; }
  get nodeId() { return this.event.binding.value.nodeId ?? "flow"; }

  publicJSON() {
    const { payload, ...identity } = this.event.toJSON();
    const fields = ["runId", "specId", "flowVersionId", "nodeId", "attemptId", "attemptSequence", "taskId", "executionContractId", "executionGeneration", "dispatchInvocationId", "workUnitId", "requestDigest", "commandId", "outboxAttemptId"];
    return { ...identity, binding: Object.fromEntries(fields.filter((field) => Object.hasOwn(identity.binding, field)).map((field) => [field, identity.binding[field]])) };
  }

  static assertFinalizable(priorActivities) {
    const calls = new Map();
    for (const activity of priorActivities) {
      const event = activity.processEvent;
      if (event) calls.set(`${event.executionId}/${event.callId}`, event);
    }
    if ([...calls.values()].some((event) => event.type !== "result-finalized")) {
      throw new ProcessExecutionControlFailure("observation-save-failed", "Flow finalization requires every reserved process result to be durably finalized");
    }
  }

  static assertFinalization(state, priorActivities, barrier) {
    this.assertFinalizable(priorActivities);
    const facts = priorActivities.map((activity) => activity.processEvent).filter(Boolean);
    const refuse = (message) => { throw new ProcessExecutionControlFailure("observation-save-failed", message); };
    if (barrier === null) {
      if (facts.length !== 0) refuse("Process observations require a durable admission fence and acknowledgement barrier before Flow finalization");
      return;
    }
    if (!(barrier instanceof ProcessExecutionFinalizationBarrier)) refuse("Flow finalization requires a typed process barrier");
    const selection = barrier.selection.value;
    if (Object.keys(selection).length !== 3 || ["runId", "specId", "flowVersionId"].some((field) => selection[field] !== state[field])) {
      refuse("Process finalization barrier differs from the exact canonical Flow identity");
    }
    const selected = facts.filter((event) => event.executionId === barrier.executionId);
    if (selected.length !== barrier.events.length || selected.some((event, index) => {
      const saved = barrier.events[index];
      return event.eventId !== saved.eventId || event.sequence !== saved.sequence || event.digest !== saved.eventDigest;
    })) refuse("Process finalization cutoff differs from the durable canonical event inventory");
    const finalized = selected.filter((event) => event.type === "result-finalized");
    if (finalized.length !== barrier.callClosures.length || finalized.some((event) =>
      !barrier.callClosures.some((entry) => entry.callId === event.callId && entry.closureKind === event.payload.closureKind
        && entry.closureDigest === event.payload.closureDigest))) {
      refuse("Process finalization barrier differs from its exact finalized call closures");
    }
  }

  assertFor(state, priorActivities) {
    const event = this.event;
    const binding = event.binding.value;
    const refuse = (message) => { throw new ProcessExecutionControlFailure("observation-save-failed", message); };
    if (state.lifecycle.state === "finalized") refuse("Finalized Flow history cannot accept new process events");
    for (const field of ["runId", "specId", "flowVersionId"]) {
      if (binding?.[field] !== state[field]) refuse(`Process event origin differs from canonical ${field}`);
    }
    const prior = priorActivities.map((activity) => activity.processEvent).filter((entry) => entry?.executionId === event.executionId);
    if (prior.some((entry) => entry.eventId === event.eventId || entry.sequence >= event.sequence)) {
      refuse("Process event sequence must advance its durable execution history");
    }
    const call = prior.filter((entry) => entry.callId === event.callId);
    if (call.length === 0) {
      if (event.type !== "reserved") refuse("Process call must begin with its reserved event");
      if (binding.attemptId !== null && binding.attemptId !== undefined) {
        const origin = priorActivities.map((activity) => activity.transition.attempt)
          .find((attempt) => attempt?.id === binding.attemptId) ?? state.attempt;
        if (origin?.id !== binding.attemptId || origin.sequence !== binding.attemptSequence
          || origin.nodeId !== binding.nodeId) refuse("Process reservation must bind its exact saved canonical Attempt");
      }
      if ((event.parentCallId === null) !== (event.rootCallId === event.callId)) refuse("Process reservation parent/root identity is inconsistent");
      const parent = prior.find((entry) => entry.callId === event.parentCallId);
      if (parent && parent.rootCallId !== event.rootCallId) refuse("Process reservation root differs from its recorded parent");
    } else {
      const origin = call[0];
      if (event.type === "reserved" || call.some((entry) => entry.type === "result-finalized")
        || JSON.stringify(origin.binding.toJSON()) !== JSON.stringify(binding)
        || origin.parentCallId !== event.parentCallId || origin.rootCallId !== event.rootCallId) {
        refuse("Process event changed its reserved origin or follows a finalized result");
      }
    }
    return this;
  }
}

/** The process runtime invokes this port; it never imports canonical Flow storage. */
export class FlowProcessEventWriter extends ProcessExecutionAtomicEventWriter {
  constructor(flowManager) { super(); this.flowManager = flowManager; }
  write(event) {
    return this.#publish(new ProcessExecutionEventGroup([event]), () => [this.flowManager.recordProcessEvent(event)])[0];
  }
  writeGroup(group) {
    if (!(group instanceof ProcessExecutionEventGroup)) throw new TypeError("Process event writer requires a typed event group");
    return this.#publish(group, () => this.flowManager.recordProcessEvents(group));
  }
  #publish(group, save) {
    const events = group.events;
    if (events[0].binding.value?.flowVersionId == null) return events.map((event) => ProcessExecutionRuntimeOnlyDisposition.fromEvent(event));
    const identities = save();
    if (identities.length !== events.length || identities.some((id, index) => id !== events[index].eventId)) {
      throw new ProcessExecutionControlFailure("observation-save-failed", "Canonical process publication did not confirm its exact event identities");
    }
    return events.map((event) => ProcessExecutionCanonicalAcknowledgement.fromEvent(event));
  }
}
