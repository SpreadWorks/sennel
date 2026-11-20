import { fileURLToPath } from "node:url";
import { managedMonotonicNow } from "../../../src/lib/managed-stop-operation.js";
import { currentRuntimePackage, readRuntimeResource } from "../../../src/lib/runtime-package.js";

const phases = ["ready", "start", "before", "stage", "after", "done", "abort"];

/** Test-only scheduling; none of these flags is runtime authority or evidence. */
export class InitialInventoryObservationGate {
  constructor(buffer = new SharedArrayBuffer(phases.length * Int32Array.BYTES_PER_ELEMENT)) {
    this.buffer = buffer;
    this.state = new Int32Array(buffer);
    if (this.state.length !== phases.length) throw new TypeError("Initial inventory gate has an invalid shared layout");
  }
  marked(phase) { return Atomics.load(this.state, phases.indexOf(phase)) === 1; }
  mark(phase) {
    const index = phases.indexOf(phase);
    Atomics.store(this.state, index, 1);
    Atomics.notify(this.state, index);
  }
  wait(phase, timeoutMs = 20_000) {
    const index = phases.indexOf(phase), deadline = managedMonotonicNow() + timeoutMs;
    while (!this.marked(phase) && !this.marked("abort")) {
      const remaining = deadline - managedMonotonicNow();
      if (remaining <= 0) return false;
      Atomics.wait(this.state, index, 0, remaining);
    }
    return !this.marked("abort") && this.marked(phase);
  }
  waitWithinObservation(phase, startedAt) {
    // A conservative fixture bound from before public inspect. The product's
    // own deadline and actual clock are never changed or restarted.
    const remaining = 1000 - (managedMonotonicNow() - startedAt);
    return remaining > 0 && this.wait(phase, remaining)
      && managedMonotonicNow() - startedAt < 1000;
  }
  abort() {
    this.mark("abort");
    for (const phase of phases) Atomics.notify(this.state, phases.indexOf(phase));
  }
}

/** Locate the actual catch callsite before any timed reader observation. */
export class InitialInventoryCatchCheckpoint {
  constructor({ url, line }) {
    this.url = new URL(url).href;
    if (!Number.isSafeInteger(line) || line < 1) throw new TypeError("Catch checkpoint needs an actual source line");
    this.line = line;
    Object.freeze(this);
  }
  static capture(runtimeUrl) {
    const sourceUrl = new URL(runtimeUrl);
    sourceUrl.searchParams.set("sennel-runtime", currentRuntimePackage().revision);
    const lines = readRuntimeResource(fileURLToPath(runtimeUrl), "utf8").split("\n");
    const start = lines.findIndex(line => line === "  readConsistentInventory() {");
    const end = lines.findIndex((line, index) => index > start && line.startsWith("  #assertInventory("));
    const catchLine = lines.findIndex((line, index) => index > start && index < end && line.trim() === "} catch (cause) {");
    const reads = lines.flatMap((line, index) => index > catchLine && index < end
      && line.trim() === "const after = this.file.readSnapshot();" ? [index + 1] : []);
    if (start < 0 || end < 0 || catchLine < 0 || reads.length !== 1) {
      throw new Error("The real inventory catch snapshot checkpoint is not unique");
    }
    return new this({ url: sourceUrl.href, line: reads[0] });
  }
  matches(stack) {
    return stack.split("\n").some(frame => {
      const location = /^\s*at ProcessRuntimeStore\.readConsistentInventory \((.+):(\d+):(\d+)\)$/.exec(frame);
      return location !== null && location[1] === this.url && Number(location[2]) === this.line;
    });
  }
  toJSON() { return { url: this.url, line: this.line }; }
}
