import { isUtf8 } from "node:buffer";
import { runGit } from "./git-command-execution.js";
import { GitRepositoryPolicy } from "./git-repository-environment.js";
import { assertOk } from "./process.js";
import { RegularFileSnapshot } from "./regular-file-snapshot.js";

/** Git's origin/key/value protocol, retaining the last value like --get. */
export class GitConfigurationObservation {
  #values = new Map();

  constructor(bytes, { origins = true } = {}) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Git configuration requires raw output");
    const fields = bytes.toString("utf8").split("\0");
    const width = origins ? 2 : 1;
    if (fields.pop() !== "" || fields.length % width !== 0) throw new Error("invalid Git configuration records");
    for (let index = width - 1; index < fields.length; index += width) {
      const record = fields[index];
      const separator = record.indexOf("\n");
      this.#values.set(separator === -1 ? record : record.slice(0, separator), separator === -1 ? null : record.slice(separator + 1));
    }
    Object.freeze(this);
  }

  static fromRecords(bytes) { return new this(bytes, { origins: false }); }

  boolean(name, defaultValue, normalize) {
    if (!this.#values.has(name)) return defaultValue;
    const value = this.#values.get(name);
    if (value === null) return true;
    if (["true", "yes", "on", "1"].includes(value.toLowerCase())) return true;
    if (["false", "no", "off", "0", ""].includes(value.toLowerCase())) return false;
    // Git also accepts numeric forms. Its own parser owns those semantics and
    // invalid-value errors; do not substitute JavaScript numeric conversion.
    return normalize();
  }
}

/** The HEAD identity and complete ref bytes from one show-ref --head read. */
export class GitReferenceObservation {
  constructor(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Git references require raw output");
    const heads = bytes.toString("utf8").split("\n").filter((record) => record.endsWith(" HEAD"));
    if (heads.length !== 1 || !/^([a-f0-9]{40}|[a-f0-9]{64}) HEAD$/.test(heads[0])) throw new Error("Git HEAD reference is invalid");
    this.head = heads[0].slice(0, -5);
    Object.freeze(this);
  }
}

/** Exact ordered raw path records; attribute stdin is a separate wire view. */
class GitIndexPaths {
  #bytes;
  #count;
  constructor(records) {
    this.#bytes = Buffer.concat(records); this.#count = records.length;
    Object.freeze(this);
  }
  static fromIndex(bytes) {
    const paths = [];
    for (let offset = 0; offset < bytes.length;) {
      const end = bytes.indexOf(0, offset), separator = bytes.indexOf(9, offset);
      if (end < 0 || separator < offset || separator >= end) throw new Error("invalid Git index path record");
      paths.push(bytes.subarray(separator + 1, end + 1)); offset = end + 1;
    }
    return new this(paths);
  }
  get attributeInput() { return this.#count === 0 ? Buffer.from([0]) : Buffer.from(this.#bytes); }
  get utf8() { return isUtf8(this.#bytes); }
  matches(other) { return this.#bytes.equals(other.#bytes); }
}

/** Existing bounded v2/v3 layout proof, now retaining its exact native paths. */
class GitIndexLayout {
  constructor(objectIdLength, paths) {
    this.objectIdLength = objectIdLength; this.paths = new GitIndexPaths(paths);
    Object.freeze(this);
  }
  static capture(bytes, objectIdLength, maxBytes) {
    if (![40, 64].includes(objectIdLength) || bytes.length < 12 + objectIdLength / 2
      || bytes.toString("ascii", 0, 4) !== "DIRC") return null;
    const version = bytes.readUInt32BE(4);
    if (version !== 2 && version !== 3) return null;
    const count = bytes.readUInt32BE(8);
    // Each uncompressed entry already contains its full path. 256 additional
    // bytes per entry bound the tag, mode, object ID, stage and fixed Git EOL
    // presentation. This includes padding/stat bytes we do not subtract.
    if (bytes.length + count * 256 > maxBytes) return null;
    const end = bytes.length - objectIdLength / 2;
    let offset = 12;
    const paths = [];
    for (let entry = 0; entry < count; entry++) {
      const start = offset;
      const flagsAt = start + 40 + objectIdLength / 2;
      if (flagsAt + 2 > end || bytes.readUInt32BE(start + 24) === 0o40000) return null;
      const extended = (bytes.readUInt16BE(flagsAt) & 0x4000) !== 0;
      if (extended && version !== 3) return null;
      const pathAt = flagsAt + 2 + (extended ? 2 : 0);
      const nul = bytes.indexOf(0, pathAt);
      if (nul < pathAt || nul >= end) return null;
      paths.push(bytes.subarray(pathAt, nul + 1));
      offset = start + Math.ceil((nul + 1 - start) / 8) * 8;
      if (offset > end) return null;
    }
    while (offset < end) {
      if (offset + 8 > end) return null;
      // Git's mandatory extensions can supply additional/compressed entries.
      // Unknown mandatory signatures are equally ineligible for this bound.
      if (bytes[offset] < 65 || bytes[offset] > 90) return null;
      offset += 8 + bytes.readUInt32BE(offset + 4);
      if (offset > end) return null;
    }
    return offset === end ? new this(objectIdLength, paths) : null;
  }

}

/** One existing native query and its lossless three-stream decoder. */
class GitIndexCombinedQuery {
  get args() { return ["ls-files", "--stage", "-v", "--eol", "-z"]; }
  get label() { return "Git index, flags and materialization EOL"; }
  read(read) { return this.decode(read(this.args, this.label)); }
  decode(bytes) { return GitIndexObservation.fromCombined(bytes); }
}

/** Captured layout permits preparing independent reads before HEAD arrives.
 * Native HEAD width and exact native path order still have to match afterward.
 * The captured bytes are an input, never evidence of later filesystem stability.
 */
class PreparedGitIndexRead {
  #layout;
  #query;
  constructor(layout) {
    if (!(layout instanceof GitIndexLayout)) throw new TypeError("Prepared Git index requires its complete bounded layout");
    this.#layout = layout; this.#query = new GitIndexCombinedQuery(); Object.freeze(this);
  }
  get args() { return this.#query.args; }
  get label() { return this.#query.label; }
  get attributeInput() { return this.#layout.paths.attributeInput; }
  observe(bytes, objectIdLength) {
    if (objectIdLength !== this.#layout.objectIdLength) throw new Error("Captured Git index format differs from native HEAD");
    const observation = this.#query.decode(bytes);
    if (!this.#layout.paths.matches(GitIndexPaths.fromIndex(observation.index))) throw new Error("Captured Git index paths differ from the native index observation");
    return observation;
  }
}

/** Exact native index/flag/EOL streams, independent of filesystem path encoding. */
export class GitIndexObservation {
  #index;
  #flags;
  #materialization;

  constructor(index, flags, materialization) {
    if (![index, flags, materialization].every(Buffer.isBuffer)) throw new TypeError("Git index observation requires raw streams");
    this.#index = Buffer.from(index);
    this.#flags = Buffer.from(flags);
    this.#materialization = Buffer.from(materialization);
    Object.freeze(this);
  }

  get index() { return Buffer.from(this.#index); }
  get flags() { return Buffer.from(this.#flags); }
  get materialization() { return Buffer.from(this.#materialization); }

  get attributeInput() { return GitIndexPaths.fromIndex(this.#index).attributeInput; }

  static prepare({ snapshot, maxBytes }) {
    if (snapshot !== null && !(snapshot instanceof RegularFileSnapshot)) throw new TypeError("Git index requires its captured regular file");
    if (snapshot === null) return null;
    const bytes = snapshot.bytes;
    const candidates = [40, 64].map((width) => GitIndexLayout.capture(bytes, width, maxBytes)).filter((layout) => layout !== null);
    return candidates.length === 1 && candidates[0].paths.utf8 ? new PreparedGitIndexRead(candidates[0]) : null;
  }

  static read({ snapshot, objectIdLength, maxBytes, read }) {
    if (snapshot !== null && !(snapshot instanceof RegularFileSnapshot)) throw new TypeError("Git index requires its captured regular file");
    if (snapshot !== null && GitIndexLayout.capture(snapshot.bytes, objectIdLength, maxBytes) !== null) {
      return new GitIndexCombinedQuery().read(read);
    }
    // Choose before execution. Compressed/split/sparse indexes and large output
    // retain the same three bounded queries, without retry or a larger cap.
    return new this(read(["ls-files", "--stage", "-z"], "Git index"),
      read(["ls-files", "-v", "-z"], "Git index flags"),
      read(["ls-files", "--eol", "-z"], "Git materialization EOL"));
  }

  static fromCombined(bytes) {
    const index = [], flags = [], materialization = [];
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(0, offset);
      const headerEnd = bytes.indexOf(9, offset + 2);
      const eolEnd = bytes.indexOf(9, headerEnd + 1);
      if (end === -1 || headerEnd < offset + 2 || headerEnd >= end || eolEnd < headerEnd + 1 || eolEnd >= end
        || bytes[offset + 1] !== 32) throw new Error("invalid combined Git index record");
      const pathname = bytes.subarray(eolEnd + 1, end + 1);
      index.push(bytes.subarray(offset + 2, headerEnd + 1), pathname);
      flags.push(bytes.subarray(offset, offset + 2), pathname);
      materialization.push(bytes.subarray(headerEnd + 1, eolEnd + 1), pathname);
      offset = end + 1;
    }
    return new this(Buffer.concat(index), Buffer.concat(flags), Buffer.concat(materialization));
  }
}

/** Preserve Git's native uncommon-value parsing and missing-value semantics. */
export function readGitBoolean(root, name, defaultValue, { execute = runGit } = {}) {
  const result = execute(["config", "--bool", "--get", name], { cwd: root,
    gitPolicy: new GitRepositoryPolicy({ repositoryRoot: root, readOnly: true }) });
  if (result.status === 1) return defaultValue;
  assertOk(result, `failed to read ${name}`);
  const value = result.stdout.trim();
  if (value !== "true" && value !== "false") throw new Error(`invalid Git boolean ${name}`);
  return value === "true";
}
