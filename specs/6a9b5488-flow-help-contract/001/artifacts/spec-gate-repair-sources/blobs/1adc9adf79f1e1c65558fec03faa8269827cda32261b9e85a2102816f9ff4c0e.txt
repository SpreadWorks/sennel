function requireCode(value) {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{2,199}$/.test(value)) {
    throw new Error("fatal post-hook error code is invalid");
  }
  return value;
}

function requireMessage(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("fatal post-hook error message is required");
  }
  return value;
}

/** A post-hook failure that invalidates the command's successful envelope. */
export class FatalPostHookError extends Error {
  constructor(code, message, { cause = null, data = null } = {}) {
    super(requireMessage(message), cause == null ? undefined : { cause });
    this.name = "FatalPostHookError";
    this.code = requireCode(code);
    this.data = data == null ? null : structuredClone(data);
  }
}
