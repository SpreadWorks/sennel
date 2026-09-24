import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/** Version-1 append-only Spec Task admission through the catalog and Store. */
import { FlowManager } from "../../lib/flow-manager.js";
import { TaskCollection } from "../../spec/lib/render-contract.js";

function canonicalState(state) {
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof state.specId !== "string" || state.specId === "") {
    throw new Error("Spec Task sync requires an active Version-1 Flow");
  }
  return state;
}

function taskDocument(task) {
  const { id, parent, ...document } = task;
  return Object.freeze({
    ...structuredClone(document),
    id: id.value,
    parent: parent === null ? null : parent.value,
  });
}

/** Reads the sole cataloged Spec record and admits only previously unseen Tasks. */
export class CanonicalSpecTaskSynchronizer {
  constructor({ flowManager, state } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function" || typeof flowManager.addTask !== "function") {
      throw new Error("canonical Spec Task sync requires FlowManager catalog and addTask APIs");
    }
    this.flowManager = flowManager;
    this.state = canonicalState(state);
    Object.freeze(this);
  }

  pending() {
    const source = this.flowManager.readArtifact({
      specId: this.state.specId,
      logicalKey: "spec.record",
      consumerNodeId: this.state.currentNodeId ?? "approval",
    });
    const document = JSON.parse(source.bytes.toString("utf8"));
    const existing = new Set(this.state.tasks.map((task) => task.id));
    return Object.freeze([...new TaskCollection(document.tasks ?? [])]
      .filter((task) => !existing.has(task.id.value))
      .map(taskDocument));
  }

  admit() {
    const added = [];
    for (const task of this.pending()) {
      this.flowManager.addTask(task, { specId: this.state.specId });
      added.push(task.id);
    }
    return Object.freeze({ added: Object.freeze(added) });
  }
}

/** Convenience command boundary; root is used only to locate FlowManager, never a Spec path. */
export function syncSpecTasksToFlow({ root = null, flowManager = null, state = null } = {}) {
  const manager = flowManager ?? (root === null ? null : new FlowManager({ root, mainRoot: root, inWorktree: false }));
  if (manager === null) throw new Error("canonical Spec Task sync requires FlowManager or root");
  const active = state ?? manager.load();
  if (active === null) return Object.freeze({ added: Object.freeze([]), skipped: true, reason: "no active flow" });
  return new CanonicalSpecTaskSynchronizer({ flowManager: manager, state: active }).admit();
}
