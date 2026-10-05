/**
 * src/flow/lib/overview-merge.js
 *
 * Pure helpers for deterministic overview updates (spec 207).
 *
 * - `validateAdditions(additions)` returns an array of error messages; an
 *   empty array means the payload is an additions-only shape.
 * - `applyOverviewAdditions(spec, additions, taskId)` returns a new spec
 *   whose overview categories have had the validated additions appended with
 *   `added_by_task = taskId` stamped on each entry.
 * - `filterOverviewByTask(spec, taskId)` returns a new spec whose overview
 *   has every entry with a matching `added_by_task` removed (reverse apply).
 *
 * All functions are pure — the input `spec` is never mutated.
 */

const CATEGORIES = ["modules", "data_flow", "decisions"];
const MAX_ENTRIES_PER_CATEGORY = 50;
const MAX_ENTRY_TEXT_LENGTH = 500;

export function validateAdditions(additions) {
  const errors = [];
  if (additions === null || typeof additions !== "object" || Array.isArray(additions)) {
    errors.push("additions must be an object");
    return errors;
  }
  const keys = Object.keys(additions);
  for (const key of keys) {
    if (!CATEGORIES.includes(key)) {
      errors.push(`additions contains unknown field: ${key}`);
    }
  }
  for (const cat of CATEGORIES) {
    if (!(cat in additions)) {
      errors.push(`additions missing required category: ${cat}`);
      continue;
    }
    const arr = additions[cat];
    if (!Array.isArray(arr)) {
      errors.push(`additions.${cat} must be an array`);
      continue;
    }
    if (arr.length > MAX_ENTRIES_PER_CATEGORY) {
      errors.push(
        `additions.${cat} exceeds upper bound: ${arr.length} > ${MAX_ENTRIES_PER_CATEGORY}`,
      );
    }
    for (const [i, entry] of arr.entries()) {
      if (typeof entry !== "string") {
        errors.push(`additions.${cat}[${i}] must be a string`);
        continue;
      }
      if (entry.length > MAX_ENTRY_TEXT_LENGTH) {
        errors.push(
          `additions.${cat}[${i}] exceeds ${MAX_ENTRY_TEXT_LENGTH} chars (got ${entry.length})`,
        );
      }
    }
  }
  return errors;
}

function requireTaskId(taskId) {
  if (typeof taskId !== "string" || taskId.trim() === "") {
    throw new Error("taskId is required and must be a non-empty string");
  }
}

function normalizeOverview(overview) {
  const src = overview || {};
  const result = {};
  for (const cat of CATEGORIES) {
    result[cat] = Array.isArray(src[cat]) ? src[cat] : [];
  }
  return result;
}

export function applyOverviewAdditions(spec, additions, taskId) {
  requireTaskId(taskId);
  const errors = validateAdditions(additions);
  if (errors.length > 0) {
    throw new Error(`invalid additions: ${errors.join("; ")}`);
  }
  const existing = normalizeOverview(spec.overview);
  const nextOverview = {};
  for (const cat of CATEGORIES) {
    const appended = additions[cat].map((text) => ({ text, added_by_task: taskId }));
    nextOverview[cat] = [...existing[cat], ...appended];
  }
  return { ...spec, overview: nextOverview };
}

export function filterOverviewByTask(spec, taskId) {
  requireTaskId(taskId);
  const existing = normalizeOverview(spec.overview);
  const nextOverview = {};
  for (const cat of CATEGORIES) {
    nextOverview[cat] = existing[cat].filter((e) => e.added_by_task !== taskId);
  }
  return { ...spec, overview: nextOverview };
}
