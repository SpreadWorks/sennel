/** Canonical text order uses UTF-16 code units, independent of process locale. */
export function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
