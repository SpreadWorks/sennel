import fs from "node:fs";

/** Freshly resolve an absolute path without changing its accepted spelling. */
export function isCanonicalRealPath(filePath) {
  try {
    if (fs.realpathSync.native?.(filePath) === filePath) return true;
  } catch {
    // Native realpath has libc prerequisites and platform-specific limits.
    // The ordinary resolver retains its full validation and error contract.
  }
  return fs.realpathSync(filePath) === filePath;
}
