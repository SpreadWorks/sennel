import path from "node:path";

export class PortablePathError extends Error {
  constructor(message, code = "PORTABLE_PATH_INVALID") {
    super(message);
    this.name = "PortablePathError";
    this.code = code;
  }
}

const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i;
const INVALID_SEGMENT = /[<>:"\\|?*\u0000-\u001f\uD800-\uDFFF]/u;

/** Portable stored names. Validation never changes the saved spelling. */
export class LogicalRelativePath {
  constructor(value, label = "logical relative path") {
    if (typeof value !== "string" || value.length === 0 || value.startsWith("/")) {
      throw new PortablePathError(`${label} must be a non-empty logical relative path`);
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".."
      || INVALID_SEGMENT.test(segment) || /[. ]$/.test(segment) || RESERVED_NAME.test(segment))) {
      throw new PortablePathError(`${label} contains an unrepresentable logical path segment`);
    }
    this.value = value;
    this.segments = Object.freeze(segments);
    Object.freeze(this);
  }
  static from(value, label) { return value instanceof LogicalRelativePath ? value : new LogicalRelativePath(value, label); }
  toString() { return this.value; }
}

function portableSegmentKey(segment) { return segment.normalize("NFC").toUpperCase().normalize("NFC"); }

/** Validates a complete write set, including aliases in implicit directories. */
export class LogicalPathSet {
  #spellings;

  constructor(values, { allowDirectoryPrefixes = false } = {}) {
    if (!Array.isArray(values)) throw new PortablePathError("logical path set requires an array");
    this.paths = Object.freeze(values.map((value) => LogicalRelativePath.from(value)));
    const spellings = new Map();
    const terminals = new Set();
    for (const logical of this.paths) {
      let key = "";
      let spelling = "";
      for (const segment of logical.segments) {
        key = key ? `${key}/${portableSegmentKey(segment)}` : portableSegmentKey(segment);
        spelling = spelling ? `${spelling}/${segment}` : segment;
        const previous = spellings.get(key);
        if (previous !== undefined && previous !== spelling) {
          throw new PortablePathError(`logical paths collide: ${previous} / ${spelling}`, "PORTABLE_PATH_COLLISION");
        }
        spellings.set(key, spelling);
      }
      if (terminals.has(key)) throw new PortablePathError(`duplicate logical path: ${logical}`, "PORTABLE_PATH_COLLISION");
      terminals.add(key);
    }
    if (!allowDirectoryPrefixes) {
      for (const key of terminals) {
        const segments = key.split("/");
        segments.pop();
        while (segments.length > 0) {
          if (terminals.has(segments.join("/"))) throw new PortablePathError(`logical file path prefixes another target: ${key}`, "PORTABLE_PATH_COLLISION");
          segments.pop();
        }
      }
    }
    this.#spellings = spellings;
    Object.freeze(this);
  }
  spellingFor(value) {
    const logical = LogicalRelativePath.from(value);
    return this.#spellings.get(logical.segments.map(portableSegmentKey).join("/")) ?? null;
  }
  toStrings() { return this.paths.map(String); }
}

/** Classification of a relative native spelling; no filesystem authority. */
export function isContainedNativeRelativePath(relative, nativePath = path) {
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${nativePath.sep}`)
    && !nativePath.isAbsolute(relative));
}

/** Lexical native containment; callers retain authority over filesystem state. */
export function isNativePathWithin(root, target) {
  if (typeof root !== "string" || typeof target !== "string" || root.includes("\0") || target.includes("\0")
    || !path.isAbsolute(root) || !path.isAbsolute(target)) return false;
  const relative = path.relative(root, target);
  return isContainedNativeRelativePath(relative);
}

/**
 * Log text is not an I/O authority. Interpret drive/UNC spelling with win32
 * on every host; POSIX roots retain case sensitivity. No path is rewritten.
 */
export function isNativePathSpellingWithin(root, target) {
  if (typeof root !== "string" || typeof target !== "string" || root.includes("\0") || target.includes("\0")) return false;
  const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(root);
  if (windows !== /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(target)) return false;
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(root) || !api.isAbsolute(target) || (windows && /^[\\/]{2}[?.][\\/]/.test(target))) return false;
  const normalizedRoot = windows ? api.normalize(root).toUpperCase() : api.normalize(root);
  const normalizedTarget = windows ? api.normalize(target).toUpperCase() : api.normalize(target);
  const relative = api.relative(normalizedRoot, normalizedTarget);
  return isContainedNativeRelativePath(relative, api);
}
