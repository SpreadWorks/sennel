import fs from "node:fs";

/** Preserve the primary failure and mark an unconfirmed descriptor release. */
function closeResource(close, primaryError) {
  try { close(); }
  catch (cleanupError) {
    if (primaryError !== null) {
      const error = new AggregateError([primaryError, cleanupError], "file operation and descriptor cleanup both failed", { cause: primaryError });
      error.cleanupFailed = true;
      throw error;
    }
    cleanupError.cleanupFailed = true;
    throw cleanupError;
  }
}

export function closeFileDescriptor(descriptor, primaryError = null) {
  closeResource(() => fs.closeSync(descriptor), primaryError);
}

export function closeDirectoryHandle(handle, primaryError = null) {
  closeResource(() => handle.closeSync(), primaryError);
}
