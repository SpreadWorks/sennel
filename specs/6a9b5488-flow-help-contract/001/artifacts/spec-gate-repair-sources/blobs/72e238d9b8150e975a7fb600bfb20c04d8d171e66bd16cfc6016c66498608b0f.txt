/**
 * src/flow/lib/check-tasks-monotonic.js
 *
 * REQ-3 (spec 215): spec gate の monotonic 検証。
 * 2 回目以降の approval では、Version Store が Activity から投影した既存 task の
 * id / origin / added_round は正本である spec.json.tasks[] と一致しなければならない。
 * title / description の差異は許可する。
 * 新規 task の added_round は既存の最大 added_round + 1 でなければならない。
 *
 * Part of spec 215-flow-task-decomposition (draft-return task flow).
 */

/**
 * @param {{ flowTasks: Array<object>, specTasks: Array<object> | undefined }} args
 * @returns {string[]} array of issue messages (empty = pass)
 */
export function checkTasksMonotonic({ flowTasks, specTasks }) {
  const issues = [];
  const flow = Array.isArray(flowTasks) ? flowTasks : [];
  const spec = Array.isArray(specTasks) ? specTasks : [];

  // First approval (no committed tasks yet) — nothing to compare.
  if (flow.length === 0) return issues;

  const specById = new Map(spec.map((t) => [t.id, t]));
  for (const ft of flow) {
    const st = specById.get(ft.id);
    if (!st) {
      issues.push(`tasks: existing task '${ft.id}' missing from spec.json (append-only)`);
      continue;
    }
    if (st.origin !== ft.origin) {
      issues.push(`tasks: '${ft.id}' origin changed (${ft.origin} → ${st.origin}, not allowed)`);
    }
    if ((st.added_round ?? 0) !== (ft.added_round ?? 0)) {
      issues.push(`tasks: '${ft.id}' added_round changed (${ft.added_round} → ${st.added_round}, not allowed)`);
    }
  }

  // New tasks must have added_round = max(existing) + 1.
  const maxExisting = flow.reduce((m, t) => Math.max(m, t.added_round ?? 0), 0);
  const flowIds = new Set(flow.map((t) => t.id));
  for (const st of spec) {
    if (flowIds.has(st.id)) continue;
    const expected = maxExisting + 1;
    if ((st.added_round ?? 0) !== expected) {
      issues.push(`tasks: new task '${st.id}' added_round must be ${expected}, got ${st.added_round}`);
    }
  }

  return issues;
}
