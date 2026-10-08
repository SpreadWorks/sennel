export function cursorQueryResourceInput() {
  return { source: { id: "source:owner", origin: "src/owner.js", revision: "captured", required: false,
    content: "needle\n".repeat(20) + "z".repeat(131072) + "\n" },
  query: { origin: "src/owner.js", literal: "needle", beforeLines: 0, afterLines: 0, maxMatches: 1, cursor: null },
  binding: { unitId: "selected", baseRevision: `sha256:${"a".repeat(64)}` }, pages: 16 };
}

export function overflowQueryResourceInput() {
  return { source: { id: "source:owner", origin: "owner", revision: "capture", required: false, content: "X\n".repeat(20000) },
    query: { origin: "owner", literal: "X", beforeLines: 0, afterLines: 0, maxMatches: Number.MAX_SAFE_INTEGER, cursor: null },
    binding: { unitId: "unit", baseRevision: `sha256:${"a".repeat(64)}` } };
}

/** Observe work and retained output through existing public range/index interfaces. */
export function observeQueryResources(values, prompt, sourceId, operation) {
  const originalAssert = values.SpecGateRepairSourceTextIndex.prototype.assertSource;
  const originalWindow = values.SpecGateRepairSourceTextIndex.prototype.lineWindow;
  const originalRange = prompt.RangedTextPromptElement.prototype.createRange;
  const originalPush = Array.prototype.push;
  const originalSet = Map.prototype.set;
  const indexes = new Set(); const retainedRanges = new Set();
  let windows = 0; let ranges = 0; let matches = 0;
  const retain = (entry) => {
    if (entry?.value?.snapshotId === sourceId && entry.id?.startsWith(`${sourceId}@bytes:`)) retainedRanges.add(entry.id);
  };
  values.SpecGateRepairSourceTextIndex.prototype.assertSource = function (...args) {
    indexes.add(this); return originalAssert.apply(this, args);
  };
  values.SpecGateRepairSourceTextIndex.prototype.lineWindow = function (...args) {
    windows += 1; return originalWindow.apply(this, args);
  };
  prompt.RangedTextPromptElement.prototype.createRange = function (...args) {
    ranges += 1; return originalRange.apply(this, args);
  };
  Array.prototype.push = function (...entries) {
    for (const entry of entries) {
      if (typeof entry?.rangeId === "string" && entry.rangeId.startsWith(`${sourceId}@bytes:`)) matches += 1;
      retain(entry);
    }
    return originalPush.apply(this, entries);
  };
  Map.prototype.set = function (key, value) { retain(value); return originalSet.call(this, key, value); };
  let result; let error;
  try { result = operation(); } catch (failure) { error = failure; }
  finally {
    values.SpecGateRepairSourceTextIndex.prototype.assertSource = originalAssert;
    values.SpecGateRepairSourceTextIndex.prototype.lineWindow = originalWindow;
    prompt.RangedTextPromptElement.prototype.createRange = originalRange;
    Array.prototype.push = originalPush;
    Map.prototype.set = originalSet;
  }
  return { result, error, counts: { indexInstances: indexes.size, examinedWindows: windows,
    constructedRanges: ranges, retainedRanges: retainedRanges.size, retainedMatches: matches } };
}
