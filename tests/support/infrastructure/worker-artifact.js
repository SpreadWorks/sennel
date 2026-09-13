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
