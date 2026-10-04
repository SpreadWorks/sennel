import { SpecGateRepairSource } from "../../src/flow/lib/spec-gate-repair-values.js";

/** Uses only pre-change public inputs so the same scenario can detect the original defect. */
export function specGateRepairInflationFixture() {
  const baseRevision = `sha256:${"a".repeat(64)}`;
  const rule = { id: "planned-check", title: "Planned checks", body: "State a check and its passing condition. Exception: a justified non-testable item needs no executable check." };
  const spec = { goal: "A small planned change", background: "UNRELATED_BACKGROUND",
    scope: { in: [], out: [] }, constraints: [], design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [{ text: "Keep planned checks separate from executed evidence." }] },
    requirements: Array.from({ length: 4 }, (_, i) => ({ id: `R${i}`, desc: `Target ${i}`,
      task_ids: ["T1"], testable: true })),
    tasks: [{ id: "T1", title: "One", goal: "Implement one" }, { id: "T2", title: "Two", goal: "UNRELATED_TASK" }],
    acceptance_criteria: [], clarifications: [], alternatives_considered: [], open_questions: [], keywords: [], implementationTargets: [] };
  const canonical = ["request", "issue.snapshot", "draft", "project-rules"].map((id) =>
    new SpecGateRepairSource({ id, origin: id, revision: `revision:${id}`, content: `CANONICAL:${id}` }));
  const code = Array.from({ length: 20 }, (_, i) => new SpecGateRepairSource({
    id: `source:src/file${i}.js`, origin: `src/file${i}.js`, revision: `revision:${i}`,
    content: `UNSELECTED_CODE_${i}:` + "漢🧭".repeat(10000),
  }));
  const findings = Array.from({ length: 6 }, (_, i) => {
    const target = { entity: "requirement", id: `R${i % 4}`, field: "desc" };
    const id = `F${i}`;
    return { identity: { sourceArtifact: "gate/result.json", sourceStep: "spec-gate", sourceFindingId: id,
      fingerprint: id.charCodeAt(0).toString(16).padEnd(64, "0") }, requirementRef: rule.id,
      observed: `Missing planned passing condition ${id}`, targets: [target],
      allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] };
  });
  return { spec, baseRevision, findings, sources: [...canonical, ...code], guardrails: [rule],
    acknowledgedRationale: "Existing exception rationale" };
}
