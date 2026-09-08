const TASK_CONTEXT_KINDS = Object.freeze({
  "task-impl": Object.freeze(["task_spec", "requirements", "overview"]),
  "task-review": Object.freeze(["task_spec", "requirements", "source"]),
  "task-triage": Object.freeze(["task_spec", "requirements", "source"]),
  "task-repair": Object.freeze(["task_spec", "requirements", "source"]),
  "task-gate": Object.freeze(["task_spec", "requirements", "overview", "source", "guardrail"]),
});

/** The definition-level worker resource contract for a canonical Task Step. */
export function canonicalTaskContextKinds(stepId) {
  if (typeof stepId !== "string" || stepId.trim() === "") {
    throw new Error("canonical Task Step id is required");
  }
  const kinds = TASK_CONTEXT_KINDS[stepId.trim()];
  if (kinds === undefined) throw new Error(`canonical Task context does not support Step: ${stepId}`);
  return kinds;
}
