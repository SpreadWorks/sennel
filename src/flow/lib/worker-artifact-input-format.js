/** The immutable worker input format shared by planning and handoff storage. */
export const MAX_WORKER_ARTIFACT_INPUT_BYTES = 2 * 1024 * 1024;

export function workerArtifactStableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(workerArtifactStableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${workerArtifactStableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
