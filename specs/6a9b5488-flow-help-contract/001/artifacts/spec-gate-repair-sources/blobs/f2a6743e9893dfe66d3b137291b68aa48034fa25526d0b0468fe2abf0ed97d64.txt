/**
 * Shared helpers for flow mutation option bags.
 */

/**
 * @typedef {Object} FlowRouteOptions
 * @property {string|null} [taskId] entry scope override; null writes flow scope
 * @property {string|null} [specId] flow.json target override; per-call beats bound defaults
 */

/**
 * @typedef {Object} AgentMetricPayloadOptions
 * @property {object} [usage]
 * @property {number} [responseChars]
 * @property {string} [model]
 * @property {number} [durationMs]
 * @property {string} [provider]
 * @property {string} [profileKey]
 */

/**
 * @typedef {FlowRouteOptions & AgentMetricPayloadOptions} AgentMetricOptions
 */

export function hasExplicitOption(opts, key) {
  return Boolean(opts) && Object.hasOwn(opts, key);
}

export function withSpecIdDefault(opts, specId) {
  if (hasExplicitOption(opts, "specId")) return opts;
  if (!specId) return opts;
  return { ...(opts || {}), specId };
}

export function withSpecIdArgDefault(specId, defaultSpecId) {
  return specId === undefined ? defaultSpecId ?? undefined : specId;
}

export function resolveExplicitTaskOption(ctx) {
  if (!hasExplicitOption(ctx, "taskId")) return undefined;
  const raw = ctx.taskId;
  return { taskId: raw === "" || raw == null ? null : raw };
}

export function resolveCommandRouteOptions(ctx) {
  return withSpecIdDefault(resolveExplicitTaskOption(ctx), ctx?.specId);
}
