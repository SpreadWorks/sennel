import crypto from "node:crypto";

export const MAX_DURABLE_STREAM_EVIDENCE_BYTES = 8 * 1024;
export const DEFAULT_DURABLE_STREAM_EVIDENCE_BYTES = MAX_DURABLE_STREAM_EVIDENCE_BYTES;
// JSON can encode one raw UTF-8 byte as a six-byte \u0000 escape. The fixed
// envelope allowance covers the numeric metadata, digest, property names, and
// punctuation around bounded head/tail content.
export const MAX_DURABLE_STREAM_EVIDENCE_SERIALIZED_BYTES = (6 * MAX_DURABLE_STREAM_EVIDENCE_BYTES) + 1024;

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function utf8Prefix(text, byteLimit) {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > byteLimit) break;
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function utf8Suffix(text, byteLimit) {
  let bytes = 0;
  let start = text.length;
  for (let index = text.length; index > 0;) {
    const lastCodeUnit = text.charCodeAt(index - 1);
    const width = lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff
      && index > 1
      && text.charCodeAt(index - 2) >= 0xd800
      && text.charCodeAt(index - 2) <= 0xdbff
      ? 2
      : 1;
    const character = text.slice(index - width, index);
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > byteLimit) break;
    bytes += characterBytes;
    start = index - width;
    index -= width;
  }
  return text.slice(start);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Bounded durable evidence for a text process stream.
 *
 * Raw output belongs to transient diagnostics. This value carries an
 * UTF-8-safe preview and digest across durable marker and Activity boundaries.
 */
export class BoundedStreamEvidence {
  constructor(text, { captureLimitBytes = DEFAULT_DURABLE_STREAM_EVIDENCE_BYTES } = {}) {
    if (typeof text !== "string") throw new Error("stream evidence text must be a string");
    positiveSafeInteger(captureLimitBytes, "stream evidence capture limit");
    if (captureLimitBytes > MAX_DURABLE_STREAM_EVIDENCE_BYTES) {
      throw new Error("stream evidence capture limit exceeds the durable maximum");
    }
    this.captureLimitBytes = captureLimitBytes;
    this.originalByteLength = Buffer.byteLength(text, "utf8");
    this.truncated = this.originalByteLength > captureLimitBytes;
    if (this.truncated) {
      const headLimit = Math.floor(captureLimitBytes / 2);
      const tailLimit = captureLimitBytes - headLimit;
      this.head = utf8Prefix(text, headLimit);
      this.tail = utf8Suffix(text, tailLimit);
    } else {
      this.head = text;
      this.tail = "";
    }
    this.capturedByteLength = Buffer.byteLength(this.head, "utf8") + Buffer.byteLength(this.tail, "utf8");
    if (this.capturedByteLength > this.captureLimitBytes) {
      throw new Error("stream evidence capture exceeds its byte limit");
    }
    this.sha256 = sha256(text);
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof BoundedStreamEvidence ? value : BoundedStreamEvidence.fromJSON(value);
  }

  static fromJSON(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stream evidence must be an object");
    }
    const captureLimitBytes = positiveSafeInteger(value.captureLimitBytes, "stream evidence capture limit");
    if (captureLimitBytes > MAX_DURABLE_STREAM_EVIDENCE_BYTES) {
      throw new Error("stream evidence capture limit exceeds the durable maximum");
    }
    if (typeof value.head !== "string" || typeof value.tail !== "string") {
      throw new Error("stream evidence head and tail must be strings");
    }
    if (!Number.isSafeInteger(value.originalByteLength) || value.originalByteLength < 0) {
      throw new Error("stream evidence originalByteLength must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(value.capturedByteLength) || value.capturedByteLength < 0) {
      throw new Error("stream evidence capturedByteLength must be a non-negative safe integer");
    }
    if (typeof value.truncated !== "boolean") throw new Error("stream evidence truncated must be boolean");
    if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error("stream evidence sha256 must be a lowercase SHA-256 digest");
    }
    const capturedByteLength = Buffer.byteLength(value.head, "utf8") + Buffer.byteLength(value.tail, "utf8");
    if (capturedByteLength !== value.capturedByteLength) {
      throw new Error("stream evidence capturedByteLength does not match head and tail");
    }
    if (capturedByteLength > captureLimitBytes || capturedByteLength > value.originalByteLength) {
      throw new Error("stream evidence capture exceeds its declared bounds");
    }
    if (value.truncated !== (capturedByteLength < value.originalByteLength)) {
      throw new Error("stream evidence truncated flag does not match its byte lengths");
    }
    if (!value.truncated && value.tail !== "") {
      throw new Error("untruncated stream evidence cannot have a tail preview");
    }
    if (!value.truncated && value.sha256 !== sha256(value.head)) {
      throw new Error("untruncated stream evidence sha256 does not match its content");
    }
    const evidence = Object.create(BoundedStreamEvidence.prototype);
    evidence.captureLimitBytes = captureLimitBytes;
    evidence.originalByteLength = value.originalByteLength;
    evidence.capturedByteLength = capturedByteLength;
    evidence.truncated = value.truncated;
    evidence.head = value.head;
    evidence.tail = value.tail;
    evidence.sha256 = value.sha256;
    Object.freeze(evidence);
    return evidence;
  }

  preview(byteLimit = 384) {
    positiveSafeInteger(byteLimit, "stream evidence preview limit");
    if (this.capturedByteLength <= byteLimit) return this.head + this.tail;
    const separator = " … ";
    const separatorBytes = Buffer.byteLength(separator, "utf8");
    if (byteLimit <= separatorBytes) return utf8Prefix(this.head || this.tail, byteLimit);
    const headLimit = Math.floor((byteLimit - separatorBytes) / 2);
    const tailLimit = byteLimit - separatorBytes - headLimit;
    return `${utf8Prefix(this.head, headLimit)}${separator}${utf8Suffix(this.tail || this.head, tailLimit)}`;
  }

  toJSON() {
    return {
      captureLimitBytes: this.captureLimitBytes,
      originalByteLength: this.originalByteLength,
      capturedByteLength: this.capturedByteLength,
      truncated: this.truncated,
      head: this.head,
      tail: this.tail,
      sha256: this.sha256,
    };
  }
}
