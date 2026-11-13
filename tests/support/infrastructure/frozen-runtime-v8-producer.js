import { fileURLToPath } from "node:url";
import { materializeFrozenRuntimeSource, runFrozenRuntimeDriver } from "./frozen-runtime-source.js";

/** Test-only source8 materialization; no state rebasing or ownership import. */
export function materializeFrozenV8Package(destination, fixtureDirectory = fileURLToPath(new URL("../../fixtures/process-runtime-record-v8/", import.meta.url))) {
  return materializeFrozenRuntimeSource(destination, fixtureDirectory, "producer-package-v8.provenance.json");
}

/** Source8 enters through its own bootstrap and normally releases its owner. */
export function produceFrozenV8HostDisconnectedState(options) {
  return runFrozenRuntimeDriver({ ...options, driverName: "host-disconnected-v8-driver.mjs" });
}

export function produceFrozenV8PopulatedState(options) {
  return runFrozenRuntimeDriver({ ...options, driverName: "populated-v8-driver.mjs" });
}
