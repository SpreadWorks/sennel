import { fileURLToPath } from "node:url";
import { materializeFrozenRuntimeSource, runFrozenRuntimeDriver } from "./frozen-runtime-source.js";

export function materializeFrozenV9Package(destination) {
  return materializeFrozenRuntimeSource(destination, fileURLToPath(new URL("../../fixtures/process-runtime-record-v9/", import.meta.url)), "producer-package-v9.provenance.json");
}

export function produceFrozenV9ClosedState({ bindingPaddingBytes = 0, refusalMessageExtra = 0, ...options }) {
  return runFrozenRuntimeDriver({ ...options, driverName: "populated-v9-driver.mjs", driverArgs: [String(bindingPaddingBytes), String(refusalMessageExtra)] });
}


/** Pure sizing from an already normally closed calibration producer. The next
 * producer owns a fresh, equal-length sibling path; no runtime is copied. */
export async function calibrateFrozenV9BlockRetirement(packageRoot, facts, paddingBytes) {
  const { pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  const blocksApi = await import(pathToFileURL(path.join(packageRoot, "src/lib/process-execution-request-block.js")));
  const blocks = facts.records.filter(record => record.relativePath.includes("/blocks/"))
    .map(record => JSON.parse(Buffer.from(record.bytesBase64, "base64")).payload).filter(block => block.kind === "completion");
  const byId = new Map(blocks.map(block => [block.blockId, block]));
  const tail = blocks.find(block => !blocks.some(next => next.sections[0].previous?.[0] === block.blockId));
  const ordered = [];
  for (let block = tail; block !== undefined; block = byId.get(block.sections[0].previous?.[0])) ordered.unshift(block);
  if (ordered.length !== blocks.length) throw new Error("Calibration lacks its complete original completion chain");
  let combined = null, previous = null;
  for (const source of ordered.flatMap(block => blocksApi.RuntimeRequestBlock.fromStored(block).sections)) {
    const section = new blocksApi.RuntimeRequestCompletionSection({ ...source.toJSON(), previous: previous?.toJSON() ?? null });
    combined = combined === null ? new blocksApi.RuntimeRequestCompletionBlock({ version: 9, executionId: section.executionId,
      blockId: blocksApi.runtimeRequestBlockIdentity(section, "completion"), kind: "completion", sections: [section] }) : combined.append(section);
    previous = section.reference(combined.blockId);
  }
  const wire = combined.encodedRecord();
  const count = wire.split("x".repeat(paddingBytes)).length - 1;
  if (count < 1) throw new Error("Calibration lacks its declared opaque padding");
  // Native duration numbers can serialize with different widths in the
  // calibration and acceptance runs. Keep the original two-block input clear
  // of that variation; the migrated encoding of this fixture is over6KiB smaller.
  const desired = blocksApi.RUNTIME_REQUEST_BLOCK_SOFT_BYTES + 1024;
  const reduction = Math.ceil((Buffer.byteLength(wire) - desired) / count);
  const bindingPaddingBytes = paddingBytes - reduction;
  const refusalMessageExtra = desired - (Buffer.byteLength(wire) - reduction * count);
  if (bindingPaddingBytes < 0 || refusalMessageExtra < 0 || refusalMessageExtra >= count) throw new Error("Calibration is outside its declared byte boundary");
  return { bindingPaddingBytes, refusalMessageExtra };
}
