import fs from "node:fs";
import path from "node:path";
import { AtomicFile } from "../../lib/atomic-file.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { FlowExecutionObservationFact, FlowExecutionSourceManifest } from "../../lib/flow-execution-observation.js";

class RegisteredSource extends Error {
  constructor(manifest) { super("Execution source was registered concurrently"); this.manifest = manifest; }
}

/** Writes only immutable observation artifacts through the existing catalog transaction. */
export class FlowExecutionObservationStore {
  constructor({ location, catalogStore, readState }) {
    if (typeof readState !== "function") throw new TypeError("Execution observation store requires its canonical state reader");
    this.location = location;
    this.catalogStore = catalogStore;
    this.readState = readState;
    Object.freeze(this);
  }
  ensureSource(manifest) {
    if (!(manifest instanceof FlowExecutionSourceManifest)) throw new TypeError("Typed execution source manifest is required");
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("execution.source.manifest", { sourceId: manifest.id });
    const existing = this.catalogStore.read({ read: (catalog) => {
      const descriptor = catalog.artifacts.find((entry) => entry.relativePath === artifact.relativePath);
      return descriptor ? FlowExecutionSourceManifest.fromJSON(JSON.parse(descriptor.readBytes(this.location))) : null;
    } });
    if (existing !== null) return existing.assertSameSource(manifest);
    try {
      this.#publish(artifact, manifest.toJSON(), (catalog) => {
        const registered = catalog.artifacts.find((entry) => entry.relativePath === artifact.relativePath);
        if (registered) throw new RegisteredSource(FlowExecutionSourceManifest.fromJSON(JSON.parse(registered.readBytes(this.location))));
        const state = this.#state(catalog);
        manifest.assertVersion(state);
        if (state.confirmationOrder !== manifest.boundary.confirmationOrder) throw new Error("Execution source registration boundary changed before publication");
      });
    } catch (error) {
      if (!(error instanceof RegisteredSource)) throw error;
      return error.manifest.assertSameSource(manifest);
    }
    return manifest;
  }
  append(fact) {
    if (!(fact instanceof FlowExecutionObservationFact)) throw new TypeError("Typed execution observation fact is required");
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("execution.observation", { observationId: fact.id });
    const source = FLOW_ARTIFACT_CONTRACTS.resolve("execution.source.manifest", { sourceId: fact.sourceId });
    this.#publish(artifact, fact.toJSON(), (catalog) => {
      const manifest = FlowExecutionSourceManifest.fromJSON(JSON.parse(catalog.resolve(source.relativePath).readBytes(this.location)));
      fact.binding.assertVersion(manifest);
      fact.binding.assertVersion(this.#state(catalog));
    });
    return fact;
  }
  #state(catalog) {
    return this.readState(catalog);
  }
  #publish(artifact, value, precondition = null) {
    this.catalogStore.publishSystem({ ...artifact.publication({ mediaType: "application/json" }), precondition,
      write: () => {
        const target = this.location.resolve(artifact.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        new AtomicFile(target).write(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
      } });
  }
}
