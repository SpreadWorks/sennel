import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { draftStructureManifest, specStructureManifest, futurePhaseManifests } from "./phase-manifest.js";
import { ProductionRegistrations } from "./production-registrations.js";

export const requirementTestManifest = futurePhaseManifests.find((manifest) => manifest.id === "02");
export const requirementTestScope = requirementTestManifest.entries[0];

/** Source/lookup admission precedes dynamic import; absent product contracts are assertion failures. */
export class RequirementTestProductionRegistrations extends ProductionRegistrations {
  #root;

  constructor(root) {
    super(pathToFileURL(path.join(root, requirementTestScope.composition)), requirementTestScope.exportName);
    this.#root = root;
  }

  async load() {
    assert.equal(fs.existsSync(path.join(this.#root, requirementTestScope.composition)), true,
      `A01 ${requirementTestScope.composition}: missing production ${requirementTestScope.exportName} for all five responsibility leaves`);
    const selected = requirementTestManifest.leaves.map((leaf) => flowStepExecutionRegistration(leaf.stepId));
    assert.deepEqual(requirementTestManifest.leaves.filter((leaf, index) => !(selected[index] instanceof StepRegistration))
      .map((leaf) => leaf.stepId), [], "A07/A10 production execution lookup must register all five responsibility leaves");
    const registrations = await super.load();
    assert.deepEqual(registrations.map((registration) => registration.stepId).sort(),
      requirementTestManifest.leaves.map((leaf) => leaf.stepId).sort(), "A01 fixed responsibility scope must be complete");
    for (const registration of registrations) {
      assert.equal(flowStepExecutionRegistration(registration.stepId), registration,
        `A10 ${registration.stepId}: execution lookup must consume the phase's actual production registration`);
    }
    return registrations;
  }

  async registry() {
    const selected = await this.load();
    // Present official phases form an inspection snapshot, never a second execution registry.
    const entries = [draftStructureManifest, specStructureManifest, ...futurePhaseManifests]
      .flatMap((manifest) => manifest.entries)
      .filter((entry) => entry.composition !== requirementTestScope.composition
        && fs.existsSync(path.join(this.#root, entry.composition)));
    const others = await Promise.all(entries.map((entry) => new ProductionRegistrations(
      pathToFileURL(path.join(this.#root, entry.composition)), entry.exportName).load()));
    return { selected, registry: [...selected, ...others.flat()] };
  }
}
