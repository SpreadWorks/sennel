function normalizeRelPath(relPath) {
  return relPath.replace(/\\/g, "/");
}

function trimOuterSlashes(value) {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

function trimLeadingSlashes(value) {
  return value.replace(/^\/+/, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasPathPrefix(relPath, prefix) {
  const normalized = normalizeRelPath(relPath);
  const target = trimLeadingSlashes(prefix);
  const pattern = new RegExp(`(^|/)${escapeRegExp(target)}`);
  return pattern.test(normalized);
}

export function hasSegmentPath(relPath, segmentPath) {
  const normalized = normalizeRelPath(relPath);
  const target = trimOuterSlashes(segmentPath);
  const pattern = new RegExp(`(^|/)${escapeRegExp(target)}($|/)`);
  return pattern.test(normalized);
}

export function hasAnyPathPrefix(relPath, prefixes) {
  for (const prefix of prefixes) {
    if (hasPathPrefix(relPath, prefix)) return true;
  }
  return false;
}
