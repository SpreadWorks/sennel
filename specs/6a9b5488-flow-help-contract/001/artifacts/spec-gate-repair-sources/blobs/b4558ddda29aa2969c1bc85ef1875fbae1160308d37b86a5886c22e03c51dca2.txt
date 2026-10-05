/**
 * src/lib/agent-metrics.js
 *
 * Shared helpers for agent metric dimensions.
 */

export function normalizeAgentMetricDimension(value) {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}
