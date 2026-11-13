/** Exact physical generation, independent of permissions and filesystem I/O. */
export class FileIdentity {
  constructor(stat) {
    if (typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint") {
      throw new TypeError("file identity requires exact bigint device and inode values");
    }
    this.dev = stat.dev;
    this.ino = stat.ino;
    Object.freeze(this);
  }

  static capture(stat) { return new this(stat); }

  static fromStored(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, "dev") || !Object.hasOwn(value, "ino")
      || ![value.dev, value.ino].every((entry) => typeof entry === "string" && /^(?:0|-?[1-9][0-9]*)(?![\s\S])/.test(entry))) {
      throw new TypeError("file identity requires exact stored decimal device and inode values");
    }
    return new this({ dev: BigInt(value.dev), ino: BigInt(value.ino) });
  }

  equals(other) { return other instanceof FileIdentity && sameFileIdentity(this, other); }
  toJSON() { return { dev: this.dev.toString(), ino: this.ino.toString() }; }
}

export function sameFileIdentity(left, right) {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

/** Observed metadata within one read interval; not a persisted version token. */
export function sameObservedFileMetadata(left, right) {
  return left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
