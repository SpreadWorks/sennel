import { SeedCleanupScope } from "../../support/builders/seed-work-root.js";
import { after, describe, it } from "node:test";
import { SpecPhaseScenario } from "../../support/spec-phase-scenario.js";

const seedScope = new SeedCleanupScope(after);
let strictStopSeed;

describe("Spec artifact lifecycle and downstream consumption", { concurrency: false }, () => {
  it("resumes an unsealed stopped triage through archived process evidence and lets Spec repair consume the new generation", async () => {
    await SpecPhaseScenario.run({ interruptTriage: true });
  });
  it("migrates an old runtime's unsealed triage and lets Spec repair consume the authorized generation", async () => {
    await SpecPhaseScenario.run({ interruptTriage: true, migrateRuntime: true });
  });
  for (const { retainGateFindings, advisoryRepair, largeGateResponse = false, largeSpecFile = false, overlongAcceptance = false, largeRepairValues = false, reopenPlanning = false } of [
    { retainGateFindings: false, advisoryRepair: false, overlongAcceptance: true },
    { retainGateFindings: true, advisoryRepair: false },
    { retainGateFindings: true, advisoryRepair: false, reopenPlanning: true },
    { retainGateFindings: false, advisoryRepair: true },
    { retainGateFindings: false, advisoryRepair: false, largeGateResponse: true, largeSpecFile: false },
    { retainGateFindings: false, advisoryRepair: false, largeGateResponse: true, largeSpecFile: true },
    { retainGateFindings: false, advisoryRepair: false, largeRepairValues: true },
  ]) {
  it(largeRepairValues
    ? "persists 34,522-byte ordinary and Gate repairs through Review, reload and Acceptance"
    : reopenPlanning
    ? "starts a fresh bounded Spec Gate cycle after canonical Draft regeneration"
    : largeGateResponse
    ? `retains complete large ${largeSpecFile ? "file" : "inline"} Spec Gate findings through repair and reload`
    : advisoryRepair
    ? "saves an advisory Spec repair, runs its worker, then gates the changed Spec"
    : retainGateFindings
      ? "retains unresolved Spec Gate findings for Acceptance after a durable strict stop"
      : "publishes and repairs Spec, then reloads it for Approval, Test and Acceptance", async () => {
    const options = { retainGateFindings, advisoryRepair, largeGateResponse, largeSpecFile,
      overlongAcceptance, largeRepairValues, reopenPlanning };
    if (retainGateFindings) {
      strictStopSeed ??= SpecPhaseScenario.seed(seedScope);
      await SpecPhaseScenario.run(options, { seed: await strictStopSeed });
    } else await SpecPhaseScenario.run(options);

  });
  }
});
