/**
 * src/flow/lib/req-map.js
 *
 * Shared diff reconciliation for the typed canonical file-map.
 *
 * spec 249: legacy test-map.json related exports were removed; spec
 * verification test coverage is now declared via file headers
 * (`// spec: R1 R2 ...`) — see src/flow/lib/test-headers.js.
 *
 * spec 251: TAP-output parsing helpers (parseTapOutput / extractReqResults /
 * evaluateReqByResults) were removed when retro switched to consuming
 * test-execute-result.json directly. No consumer remains.
 */

export function reconcileFileMap(fileMap, diffFiles) {
  const recorded = new Set();
  for (const paths of Object.values(fileMap)) {
    for (const p of paths) {
      recorded.add(p);
    }
  }
  return diffFiles.filter((f) => !recorded.has(f));
}
