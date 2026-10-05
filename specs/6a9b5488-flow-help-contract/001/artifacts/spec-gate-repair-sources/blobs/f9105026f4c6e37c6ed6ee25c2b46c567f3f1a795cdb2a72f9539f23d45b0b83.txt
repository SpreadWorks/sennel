const MAX_STEP_TREE_DEPTH = 10;

function assertDepth(depth) {
  if (depth > MAX_STEP_TREE_DEPTH) {
    throw new Error(`step tree depth exceeds maximum (${MAX_STEP_TREE_DEPTH})`);
  }
}

export function flattenSteps(steps) {
  const flat = [];
  function walk(nodes, depth) {
    assertDepth(depth);
    for (const step of nodes || []) {
      if (step.children) {
        walk(step.children, depth + 1);
      } else {
        flat.push(step);
      }
    }
  }
  walk(steps, 1);
  return flat;
}

/** Return the contiguous leaf effects required to move from one route node to another. */
export function contiguousLeafRouteEffects(leafIds, sourceId, targetId) {
  if (!Array.isArray(leafIds)) throw new TypeError("leafIds must be an array");
  const sourceIndex = leafIds.indexOf(sourceId);
  const targetIndex = leafIds.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) throw new TypeError("route source or target is absent");
  return targetIndex > sourceIndex
    ? { skipStepIds: leafIds.slice(sourceIndex + 1, targetIndex), resetStepIds: [] }
    : { skipStepIds: [], resetStepIds: leafIds.slice(targetIndex) };
}

export function findStepById(steps, id) {
  for (const step of steps || []) {
    if (step.id === id) return step;
    if (step.children) {
      const found = findStepById(step.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function findFirstPendingLeaf(steps) {
  for (const step of steps || []) {
    if (step.children) {
      const found = findFirstPendingLeaf(step.children);
      if (found) return found;
    } else if (step.status === "pending") {
      return step;
    }
  }
  return null;
}

export function findInProgressLeaf(steps, depth = 0) {
  assertDepth(depth);
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    if (step.children) {
      const found = findInProgressLeaf(step.children, depth + 1);
      if (found) return found;
    } else if (step.status === "in_progress") {
      return step;
    }
  }
  return null;
}

export function findInProgressLeaves(steps, depth = 0) {
  assertDepth(depth);
  if (!Array.isArray(steps)) return [];
  const leaves = [];
  for (const step of steps) {
    if (step.children) {
      leaves.push(...findInProgressLeaves(step.children, depth + 1));
    } else if (step.status === "in_progress") {
      leaves.push(step);
    }
  }
  return leaves;
}

export function promoteNextPendingLeaf(steps) {
  if (steps.some((step) => {
    if (step.children) return findInProgressLeaf(step.children) != null;
    return step.status === "in_progress";
  })) {
    return null;
  }
  return findFirstPendingLeaf(steps);
}
