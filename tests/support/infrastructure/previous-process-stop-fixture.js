import assert from "node:assert/strict";
import fs from "node:fs";

function canonicalKeys(value) {
  return Array.isArray(value) ? value.map(canonicalKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalKeys(value[key])])) : value;
}

/** Immutable original wire data only; this fixture grants no runtime authority. */
export class PreviousProcessStopFixture {
  #receipt;
  constructor() {
    const archive = JSON.parse(fs.readFileSync(new URL(
      "../../fixtures/process-runtime-record-v8-canonical/archives/2e9ded1e-d0db-4fa7-ae6b-30b18c03756a.json", import.meta.url)));
    const receipt = archive.payload.execution.calls.find(call => call.receipt !== null).receipt;
    assert.equal(receipt.schemaVersion, 3);
    this.#receipt = JSON.stringify(receipt);
    Object.freeze(this);
  }
  get receipt() { return JSON.parse(this.#receipt); }
  get canonicalReceipt() { return canonicalKeys(this.receipt); }
}
