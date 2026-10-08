import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { cursorQueryResourceInput, overflowQueryResourceInput, observeQueryResources } from "../support/builders/spec-gate-repair-query-resource.js";

const root = path.resolve(process.argv[2]);
const mode = process.argv[3];
const instrumented = process.argv.includes("--counts");
const original = path.basename(root) === "original-flow-src";
const src = original ? root : path.join(root, "src");
const values = await import(pathToFileURL(path.join(src, "flow/lib/spec-gate-repair-values.js")));
const prompt = await import(pathToFileURL(path.join(src, "lib/prompt-batching.js")));
const { workerArtifactStableStringify, MAX_WORKER_ARTIFACT_INPUT_BYTES } = await import(pathToFileURL(path.join(src, "flow/lib/worker-artifact-input-format.js")));
const hash = (value) => createHash("sha256").update(workerArtifactStableStringify(value)).digest("hex");
const input = mode === "cursor" ? cursorQueryResourceInput() : overflowQueryResourceInput();
assert(["cursor", "overflow"].includes(mode));
const source = new values.SpecGateRepairSource(input.source);
const previous = []; const rows = []; const receipts = []; const semantic = [];
let cursor = null;
for (let page = 0; page < (input.pages ?? 1); page += 1) {
  if (global.gc) global.gc();
  const query = new values.SpecGateRepairSourceQuery({ ...input.query, cursor });
  const started = performance.now();
  let result; let error; let counts = null;
  if (instrumented) {
    const observed = observeQueryResources(values, prompt, source.id, () => source.query(query, input.binding, previous));
    ({ result, error, counts } = observed);
  } else {
    try { result = source.query(query, input.binding, previous); } catch (failure) { error = failure; }
  }
  const durationMs = performance.now() - started;
  if (mode === "cursor") {
    if (error) throw error;
    assert.deepEqual(result.matches.map((match) => [match.byteStart, match.byteEnd]), [[page * 7, page * 7 + 6]]);
    assert.equal(result.complete, false);
    const windows = result.ranges.map((range) => ({ content: range.value.content,
      byteStart: range.value.byteStart, byteEnd: range.value.byteEnd, snapshotDigest: range.value.snapshotDigest }));
    assert.deepEqual(windows.map((range) => range.content), ["needle\n"]);
    receipts.push(result.toJSON());
    semantic.push({ matches: result.matches, windows, complete: result.complete });
    previous.push(result); cursor = result.nextCursor;
  } else {
    assert.equal(error?.code, "FLOW_SPEC_GATE_REPAIR_INPUT_TOO_LARGE");
    assert.equal(error.data.maximumBytes, MAX_WORKER_ARTIFACT_INPUT_BYTES);
    assert(error.data.actualBytes > MAX_WORKER_ARTIFACT_INPUT_BYTES);
  }
  rows.push({ page: page + 1, durationMs, heapUsed: process.memoryUsage().heapUsed,
    maxRSSKiB: process.resourceUsage().maxRSS, counts,
    error: error ? { name: error.name, code: error.code, data: error.data } : null });
}
process.stdout.write(JSON.stringify({ mode, instrumented, node: process.version, platform: process.platform,
  sourceBytes: source.byteLength, inputDigest: hash(input), sourceDigest: source.digest,
  maximumBytes: MAX_WORKER_ARTIFACT_INPUT_BYTES,
  totalMs: rows.reduce((total, row) => total + row.durationMs, 0), maxRSSKiB: process.resourceUsage().maxRSS,
  receiptDigest: hash(receipts), semanticDigest: hash(semantic), rows, receipts }, null, 2) + "\n");
