/**
 * Mechanical readiness checks shared by spec-gate and command-owned
 * spec-repair publication.  The repair boundary must never publish a spec
 * which the immediately following Gate would reject before semantic review.
 */

const UNRESOLVED_PATTERNS = Object.freeze([
  /\[NEEDS CLARIFICATION\]/i,
  /\bTBD\b/i,
  /\bTODO\b/i,
  /\bFIXME\b/i,
]);

function unresolved(value) {
  for (const pattern of UNRESOLVED_PATTERNS) {
    const match = value.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function walkStrings(node, fieldPath, visit) {
  if (typeof node === "string") {
    visit(node, fieldPath || "<root>");
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, index) => walkStrings(entry, `${fieldPath}[${index}]`, visit));
    return;
  }
  if (node && typeof node === "object") {
    Object.entries(node).forEach(([key, value]) => walkStrings(value, fieldPath ? `${fieldPath}.${key}` : key, visit));
  }
}

function forestDepth(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let maximum = 0;
  for (const task of tasks) {
    let depth = 0;
    let current = task;
    while (current && current.parent != null && byId.has(current.parent) && depth <= tasks.length) {
      current = byId.get(current.parent);
      depth += 1;
    }
    maximum = Math.max(maximum, depth);
  }
  return maximum;
}

function uniqueIds(entries, field, issues) {
  const seen = new Set();
  entries.forEach((entry, index) => {
    const id = entry?.id;
    if (typeof id !== "string" || id.trim() === "") {
      issues.push(`${field}[${index}].id: missing stable id`);
    } else if (seen.has(id)) {
      issues.push(`${field}[${index}].id: duplicate id ${id}`);
    } else {
      seen.add(id);
    }
  });
  return seen;
}

function taskGraphIssues(tasks, issues) {
  const taskIds = uniqueIds(tasks, "tasks", issues);
  tasks.forEach((task, index) => {
    if (task.parent == null) return;
    if (task.parent === task.id) issues.push(`tasks[${index}].parent: task cannot parent itself (${task.id})`);
    else if (!taskIds.has(task.parent)) issues.push(`tasks[${index}].parent: unknown parent ${task.parent}`);
  });
  const byId = new Map(tasks.filter((task) => typeof task?.id === "string").map((task) => [task.id, task]));
  for (const task of tasks) {
    const visited = new Set();
    let current = task;
    while (current?.parent != null && byId.has(current.parent)) {
      if (visited.has(current.parent)) {
        issues.push(`tasks.${task.id}.parent: parent cycle detected`);
        break;
      }
      visited.add(current.id);
      current = byId.get(current.parent);
    }
  }
}

export function checkSpecGateReadiness(spec) {
  const issues = [];
  walkStrings(spec, "", (value, fieldPath) => {
    const marker = unresolved(value);
    if (marker) issues.push(`${fieldPath}: unresolved marker "${marker}" in value (${value.trim()})`);
  });
  for (const [field, empty, message] of [
    ["goal", typeof spec.goal === "string" && spec.goal.trim() === "", "spec must have a non-empty goal"],
    ["requirements", Array.isArray(spec.requirements) && spec.requirements.length === 0, "spec must have at least one requirement"],
    ["acceptance_criteria", Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length === 0, "spec must have at least one acceptance criterion"],
  ]) {
    if (empty) issues.push(`${field}: empty (${message})`);
  }
  if (Array.isArray(spec.requirements) && spec.requirements.length > 3) {
    spec.requirements.forEach((requirement, index) => {
      if (!Object.hasOwn(requirement, "priority") || requirement.priority == null) {
        issues.push(`requirements[${index}].priority: missing priority for requirement ${requirement.id} (required when requirements length is greater than 3)`);
      }
    });
  }
  if (Array.isArray(spec.requirements)) uniqueIds(spec.requirements, "requirements", issues);
  if (spec.tasks === undefined) {
    issues.push("tasks: missing field (task decomposition required per spec 226)");
  } else if (Array.isArray(spec.tasks) && spec.tasks.length === 0) {
    issues.push("tasks: empty array (task decomposition required for all new specs per spec 226)");
  }
  if (Array.isArray(spec.tasks) && spec.tasks.length > 0) {
    taskGraphIssues(spec.tasks, issues);
    if (forestDepth(spec.tasks) > 10) issues.push("tasks: forest depth exceeds maximum of 10");
    spec.tasks.forEach((task, index) => {
      if (task.test_strategy == null || (typeof task.test_strategy === "string" && task.test_strategy.trim() === "")) {
        issues.push(`tasks[${index}].test_strategy: missing test strategy for task ${task.id}`);
      }
    });
  }
  return issues;
}
