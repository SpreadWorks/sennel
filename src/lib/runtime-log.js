import fs from "fs";
import path from "path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const TRUNCATED_MARKER = "[runtime-log] truncated: size limit reached\n";

function sanitizeFlowId(value) {
  return String(value || "no-flow")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "no-flow";
}

function isoNow() {
  return new Date().toISOString();
}

function shellCommand({ envelopeType, envelopeKey }) {
  if (envelopeType === "flow") return ["flow", envelopeKey].filter(Boolean).join(" ");
  if (envelopeType === "run" && envelopeKey === "prepare-spec") return "flow prepare";
  if (envelopeType === "run" && envelopeKey === "resume") return "flow resume";
  return ["flow", envelopeType, envelopeKey].filter(Boolean).join(" ");
}

export class RuntimeLogMetadata {
  constructor({ runId, sequence, attempt = 1, command, startedAt, endedAt = null, exitCode = null }) {
    if (!runId) throw new Error("runtime log runId is required");
    if (!Number.isInteger(sequence) || sequence < 1) throw new Error(`invalid runtime log sequence: ${sequence}`);
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`invalid runtime log attempt: ${attempt}`);
    if (!command) throw new Error("runtime log command is required");
    this.runId = String(runId);
    this.sequence = sequence;
    this.attempt = attempt;
    this.command = String(command);
    this.startedAt = startedAt || isoNow();
    this.endedAt = endedAt;
    this.exitCode = exitCode;
  }

  finish(exitCode, endedAt = isoNow()) {
    return new RuntimeLogMetadata({
      runId: this.runId,
      sequence: this.sequence,
      attempt: this.attempt,
      command: this.command,
      startedAt: this.startedAt,
      endedAt,
      exitCode,
    });
  }

  toStepMetadata() {
    return {
      runId: this.runId,
      sequence: this.sequence,
      attempt: this.attempt,
      command: this.command,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      exitCode: this.exitCode,
    };
  }
}

class RuntimeLogMarker {
  constructor(match) {
    this.kind = match[1];
    this.offset = match.index;
    this.limit = match.index + match[0].length;
    this.runId = match[2];
    this.sequence = Number(match[3]);
    this.attempt = Number(match[4]);
    this.command = match[5];
    this.startedAt = match[6];
    this.exitCode = match[7] === '""' ? null : Number(match[7]);
    this.endedAt = match[8] || null;
    this.binding = JSON.stringify([
      this.runId, this.sequence, this.attempt, this.command, this.startedAt,
    ]);
  }
}

class RuntimeLogInterval {
  constructor(source, start) {
    this.source = source;
    this.start = start;
    this.end = null;
  }

  toText() {
    // This is an observed interval, including nested or overlapping writes;
    // stdout/stderr lines do not carry enough information to assign ownership.
    return this.source.slice(this.start.offset, this.end?.limit ?? this.source.length).trimEnd();
  }
}

function parseRuntimeLogIntervals(text) {
  const markers = [...text.matchAll(/^===== (start|end) runId=([^ \r\n\u2028\u2029]+) sequence=([1-9]\d*) attempt=([1-9]\d*) command="([^"\r\n\u2028\u2029]+)" startedAt="([^"\r\n\u2028\u2029]+)" exitCode=(""|-?\d+) endedAt="([^"\r\n\u2028\u2029]*)" =====\r?$/gm)]
    .map((match) => new RuntimeLogMarker(match));
  const intervals = [];
  const byBinding = new Map();
  for (const marker of markers) {
    if (marker.kind !== "start" || marker.exitCode !== null || marker.endedAt !== null) continue;
    const interval = new RuntimeLogInterval(text, marker);
    intervals.push(interval);
    const group = byBinding.get(marker.binding) || [];
    group.push(interval);
    byBinding.set(marker.binding, group);
  }
  for (const marker of markers) {
    if (marker.kind !== "end" || marker.exitCode == null || marker.endedAt == null) continue;
    const group = byBinding.get(marker.binding);
    // Even a later duplicate start makes the invocation indistinguishable.
    // Do not choose a start by nesting, order, or the apparent end of a slice.
    if (group?.length !== 1) continue;
    const interval = group[0];
    if (marker.offset > interval.start.offset && interval.end == null) interval.end = marker;
  }
  return intervals;
}

export class RuntimeLogBlock {
  constructor(text) {
    const interval = text instanceof RuntimeLogInterval
      ? text
      : parseRuntimeLogIntervals(String(text || ""))[0];
    this.text = interval ? interval.toText() : String(text || "");
    this.runId = interval?.start.runId ?? null;
    this.sequence = interval?.start.sequence ?? 0;
    this.attempt = interval?.start.attempt ?? 0;
    this.command = interval?.start.command ?? "";
    this.startedAt = interval?.start.startedAt ?? null;
    this.complete = interval?.end != null;
    this.endedAt = interval?.end?.endedAt ?? null;
    this.exitCode = interval?.end?.exitCode ?? null;
  }

  toJSON() {
    return {
      text: this.text,
      runId: this.runId,
      sequence: this.sequence,
      command: this.command,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      exitCode: this.exitCode,
      complete: this.complete,
    };
  }
}

export class RuntimeLogSelection {
  constructor({
    sequence = null,
    runId = null,
    ownerRunId = null,
    latestNonRuntimeLog = false,
  } = {}) {
    if (sequence != null && (!Number.isInteger(sequence) || sequence < 1)) {
      throw new Error(`invalid runtime log selection sequence: ${sequence}`);
    }
    this.sequence = sequence;
    this.runId = runId == null ? null : String(runId);
    this.ownerRunId = ownerRunId == null ? null : String(ownerRunId);
    this.latestNonRuntimeLog = Boolean(latestNonRuntimeLog);
    Object.freeze(this);
  }

  select(blocks) {
    const owned = this.ownerRunId == null
      ? blocks
      : blocks.filter((block) => block.runId === this.ownerRunId);
    if (this.sequence != null || this.runId != null) {
      return owned.find((block) => {
        if (this.sequence != null && block.sequence !== this.sequence) return false;
        if (this.runId != null && block.runId !== this.runId) return false;
        return true;
      }) || null;
    }
    const candidates = this.latestNonRuntimeLog
      ? owned.filter((block) => block.command !== "flow get runtime-log")
      : owned;
    return candidates.at(-1) || null;
  }
}

export class RuntimeLogFile {
  constructor(root, flowId) {
    this.root = root;
    this.flowId = sanitizeFlowId(flowId);
    this.filePath = path.join(root, ".tmp", "logs", `${this.flowId}.log`);
  }

  read() {
    if (!fs.existsSync(this.filePath)) return "";
    return fs.readFileSync(this.filePath, "utf8");
  }

  nextSequence() {
    return [...this.read().matchAll(/^===== start /gm)].length + 1;
  }

  append(text) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, text, "utf8");
  }

  blocks() {
    return parseRuntimeLogIntervals(this.read()).map((interval) => new RuntimeLogBlock(interval));
  }

  select(input = {}) {
    return new RuntimeLogSelection(input).select(this.blocks());
  }
}

export class RuntimeLogBlockWriter {
  constructor({ root, flowId, runId, command, maxBytes = DEFAULT_MAX_BYTES }) {
    this.file = new RuntimeLogFile(root, flowId);
    this.bytesWritten = 0;
    this.maxBytes = maxBytes;
    this.truncated = false;
    this.metadata = new RuntimeLogMetadata({
      runId,
      sequence: this.file.nextSequence(),
      attempt: 1,
      command,
      startedAt: isoNow(),
    });
    this.lineOpen = { stdout: false, stderr: false };
    this.file.append(this.startLine());
  }

  static forDispatch({ root, flowId, runId, envelopeType, envelopeKey }) {
    return new RuntimeLogBlockWriter({
      root,
      flowId,
      runId,
      command: shellCommand({ envelopeType, envelopeKey }),
    });
  }

  startLine() {
    const m = this.metadata;
    return `===== start runId=${m.runId} sequence=${m.sequence} attempt=${m.attempt} command="${m.command}" startedAt="${m.startedAt}" exitCode="" endedAt="" =====\n`;
  }

  capture(stream, chunk) {
    if (this.truncated) return;
    let text = String(chunk);
    const otherStream = stream === "stdout" ? "stderr" : "stdout";
    if (text.length > 0 && this.lineOpen[otherStream]) {
      this.writeBounded("\n");
      this.lineOpen[otherStream] = false;
    }
    while (text.length > 0) {
      if (!this.lineOpen[stream]) {
        this.writeBounded(`[${stream}] `);
        this.lineOpen[stream] = true;
      }
      const newlineIndex = text.indexOf("\n");
      if (newlineIndex === -1) {
        this.writeBounded(text);
        return;
      }
      this.writeBounded(text.slice(0, newlineIndex + 1));
      this.lineOpen[stream] = false;
      text = text.slice(newlineIndex + 1);
    }
  }

  writeBounded(text) {
    const remaining = this.maxBytes - this.bytesWritten;
    const bytes = Buffer.byteLength(text);
    if (bytes <= remaining) {
      this.file.append(text);
      this.bytesWritten += bytes;
      return;
    }
    const markerBytes = Buffer.byteLength(TRUNCATED_MARKER);
    const allowed = Math.max(0, remaining - markerBytes);
    if (allowed > 0) this.file.append(Buffer.from(text).subarray(0, allowed).toString());
    this.file.append(TRUNCATED_MARKER);
    this.bytesWritten = this.maxBytes;
    this.truncated = true;
  }

  close(exitCode) {
    for (const stream of Object.keys(this.lineOpen)) {
      if (this.lineOpen[stream]) {
        this.writeBounded("\n");
        this.lineOpen[stream] = false;
      }
    }
    this.metadata = this.metadata.finish(exitCode);
    const m = this.metadata;
    this.file.append(`===== end runId=${m.runId} sequence=${m.sequence} attempt=${m.attempt} command="${m.command}" startedAt="${m.startedAt}" exitCode=${m.exitCode} endedAt="${m.endedAt}" =====\n`);
    return m;
  }
}

export function runtimeLogFileForContext({ root, specId }) {
  return new RuntimeLogFile(root, specId || "no-flow");
}
