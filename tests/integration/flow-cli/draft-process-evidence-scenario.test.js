import { after, before, test } from "node:test";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { PhaseProcessEvidenceScenario } from "../../support/infrastructure/phase-process-evidence-scenario.js";

let seed;
before(() => { seed = PhaseProcessEvidenceScenario.seed(); });
after(() => { if (seed) removeTmpDir(seed); });
for (const unknown of [false, true]) {
  test(`Draft ${unknown ? "unconfirmed worker stop" : "missing required worker output"} survives reload and refuses downstream execution`,
    { timeout: 600000 }, async t => {
      await new PhaseProcessEvidenceScenario(seed, { test: t, phase: "draft" }).verify({ unknown });
    });
}
