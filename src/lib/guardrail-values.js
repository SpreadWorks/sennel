export const ACKNOWLEDGED_EXCEPTION_MARKER = "acknowledged-exception";

/** Whether canonical guardrail policy permits a spec-acknowledged exception. */
export function guardrailAllowsAcknowledgedException(guardrail) {
  return String(guardrail?.body || "").toLowerCase().includes(ACKNOWLEDGED_EXCEPTION_MARKER);
}
