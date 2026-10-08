import assert from "node:assert/strict";
import { test } from "node:test";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { StructureChecker } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

function fixture(phase) {
  const seed = new StagedExecutionSeed(phase, ["first", "second"], null, "acquired-adoption");
  const files = seed.files();
  const Replay = `${phase}Receipt`;
  const Authority = `${phase}Authority`;
  files.set("src/flow/lib/episode-authority.js", `export class ${Authority} { toJSON() { return {}; } }`);
  files.set("src/flow/lib/draft-step-settlement-receipt.js", "export class DraftStepSettlementReceiptValue {}");
  files.set("src/flow/lib/step-admission-refusal.js", "export class StepAdmissionRefusal extends Error {}");
  files.set(seed.adapter, `
    import { isDeepStrictEqual } from 'node:util';
    import { ${Authority} } from './episode-authority.js';
    import { DraftStepSettlementReceiptValue } from './draft-step-settlement-receipt.js';
    import { StepAdmissionRefusal } from './step-admission-refusal.js';
    class AdmissionSelection {
      constructor({ state, stepId, registration, binding, preparation, receipt }) {
        if (registration?.stepId !== stepId || registration.executionContract !== commandStepExecutionContract) {
          throw new StepAdmissionRefusal('registration identity');
        }
        this.runId = state.runId; this.specId = state.specId; this.stepId = stepId;
        this.registration = registration; this.binding = binding;
        this.preparation = preparation; this.receipt = receipt; Object.freeze(this);
      }
      get authority() { return this.preparation.authority; }
    }
    export class ${Replay} {
      #flowManager; #specId; #registration; #authority;
      constructor({ flowManager, specId, registration, authority, receipt }) {
        if (!(authority instanceof ${Authority}) || !(receipt instanceof DraftStepSettlementReceiptValue)
          || registration?.stepId !== authority.stepId
          || registration.executionContract !== commandStepExecutionContract) {
          throw new StepAdmissionRefusal('original authority');
        }
        this.#flowManager = flowManager; this.#specId = specId; this.#registration = registration;
        this.#authority = authority; this.receipt = receipt; Object.freeze(this);
      }
      assertCurrent() {
        try {
          const current = selectCommand({ flowManager: this.#flowManager, specId: this.#specId,
            stepId: this.#registration.stepId, registration: this.#registration });
          if (current.receipt === null || !isDeepStrictEqual(current.authority.toJSON(), this.#authority.toJSON())
            || !isDeepStrictEqual(current.receipt.receipt.toJSON(), this.receipt.toJSON())) {
            throw new StepAdmissionRefusal('stale receipt');
          }
        } catch (error) {
          if (error instanceof StepAdmissionRefusal) throw error;
          throw new StepAdmissionRefusal('current episode unavailable', error);
        }
      }
    }
    export function selectCommand(input) {
      const { flowManager, specId } = input;
      const identity = { definitionId: input.stepId };
      const publication = null;
      const authority = new ${Authority}(input);
      const saved = publication === null ? flowManager.readCurrentStepSettlement({ specId, stepId: identity.definitionId }) : null;
      const receipt = saved?.result.kind === 'episode-await'
        && saved.result.evidence.binding.matches(authority.binding)
        && saved.result.evidence.attempt.id === authority.attempt.id
        && saved.result.evidence.attempt.sequence === authority.attempt.sequence
        ? new ${Replay}({ flowManager, specId, registration: input.registration, authority, receipt: saved.receipt }) : null;
      return new AdmissionSelection({ ...input, preparation: { authority }, receipt });
    }
    export function projectCommand(selection) { return selection; }
    export function executeCommand(selection, input) {
      if (!(selection instanceof AdmissionSelection) || selection.registration !== input.registration
        || selection.stepId !== input.registration.stepId) { throw new StepAdmissionRefusal('registration'); }
      if (selection.receipt !== null) { selection.receipt.assertCurrent(); return selection.receipt.receipt; }
      if (selection.binding === null || selection.preparation === null) { throw new StepAdmissionRefusal('evidence'); }
      selection.binding.assertCurrent();
      const prepared = input.registration.create({ flowManager: input.flowManager, binding: selection.binding,
        preparation: selection.preparation, commandResult: input.commandResult, });
      prepared.step.execute();
      return prepared.dependency(input.registration.ServiceClass).settledOutcome;
    }
    export const commandStepExecutionContract = new StepExecutionContract({
      select: selectCommand, project: projectCommand, execute: executeCommand });
  `);
  const service = "src/flow/services/service.js";
  files.set(service, files.get(service).replace("throw new TypeError(); } }",
    "throw new TypeError(); } get settledOutcome() { return null; } }"));
  const caller = seed.callers.find((entry) => entry.receiptReplayName !== null);
  files.set(caller.module, `import { ${Replay} } from './command-execution.js';\n`
    + files.get(caller.module).replace("function replayReceipt(receipt) { return receipt; }", `function replayReceipt(receipt) {
      if (!(receipt instanceof ${Replay})) throw new TypeError('receipt');
      receipt.assertCurrent();
      return receipt.receipt;
    }`));
  const inspect = () => new StructureChecker(seed.scope(), new MemorySourceRepository(files)).check();
  const clean = () => { const report = inspect(); assert.equal(report.ok, true, report.diagnostics.map(String).join("\n")); };
  return { seed, files, caller, inspect, clean };
}

const mutations = [
  ["different selector", "const current = selectCommand(", "const current = projectCommand("],
  ["missing acquisition", "const current = selectCommand({ flowManager: this.#flowManager, specId: this.#specId,\n            stepId: this.#registration.stepId, registration: this.#registration });", "const current = this.#authority;"],
  ["wrong selected registration", "registration: this.#registration });", "registration: this.otherRegistration });"],
  ["dropped authority check", "!isDeepStrictEqual(current.authority.toJSON(), this.#authority.toJSON())", "!isDeepStrictEqual(this.#authority.toJSON(), this.#authority.toJSON())"],
  ["dropped receipt check", "!isDeepStrictEqual(current.receipt.receipt.toJSON(), this.receipt.toJSON())", "!isDeepStrictEqual(this.receipt.toJSON(), this.receipt.toJSON())"],
  ["early unchecked return", "assertCurrent() {", "assertCurrent() { return;"],
  ["changed canonical reader", "flowManager.readCurrentStepSettlement(", "flowManager.readSomethingElse("],
  ["unrelated saved receipt", "authority, receipt: saved.receipt })", "authority, receipt: input.receipt })"],
  ["missing Attempt sequence", "&& saved.result.evidence.attempt.sequence === authority.attempt.sequence", ""],
  ["unverified executor receipt", "selection.receipt.assertCurrent(); return selection.receipt.receipt;", "return selection.receipt.receipt;"],
  ["wrong shared nominal receipt owner", "from './draft-step-settlement-receipt.js'", "from './episode-authority.js'"],
];

for (const phase of ["Lambda", "Epsilon"]) {
  test(`registered selector receipt ${phase} preserves current authority and exact receipt`, () => fixture(phase).clean());
  for (const [name, before, after] of mutations) {
    test(`registered selector receipt ${phase} rejects ${name} and accepts exact restoration`, () => {
      const built = fixture(phase);
      built.clean();
      const file = built.seed.adapter;
      const original = built.files.get(file);
      assert.equal(original.split(before).length, 2, "mutation must have exactly one source anchor");
      built.files.set(file, original.replace(before, after));
      try {
        const report = built.inspect();
        const diagnostic = report.diagnostics.find((entry) => entry.rule === "A10" && entry.file === file);
        assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
        assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
        assert.ok(diagnostic.trace.includes(file));
      } finally { built.files.set(file, original); }
      built.clean();
    });
  }
  test(`registered selector receipt ${phase} rejects an unchecked recovery helper`, () => {
    const built = fixture(phase);
    built.clean();
    const file = built.caller.module;
    const original = built.files.get(file);
    built.files.set(file, original.replace("receipt.assertCurrent();", ""));
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A10" && entry.file === file);
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
      assert.ok(diagnostic.trace.includes(file));
    } finally { built.files.set(file, original); }
    built.clean();
  });
}
