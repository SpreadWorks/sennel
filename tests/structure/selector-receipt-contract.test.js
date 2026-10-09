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

function targetInitializerFixture(phase) {
  const built = fixture(phase);
  const acquisition = `src/flow/engine/composition/${phase}-input.js`;
  built.files.set(acquisition, `
    import { Input } from '../../services/input.js';
    import { Writer } from '../../services/alpha-settlement-writer.js';
    export function acquirePreparation({ flowManager, state }) { return new Input(); }
    export function prepareServiceArguments(input) {
      const preparation = input.preparation ?? acquirePreparation(input);
      return [new Input(), new Writer()];
    }
    export function unrelatedPreparation(input) { return input; }
  `);
  const initializer = `
    export function initializeTarget(input) {
      const flowManager = input.flowManager ?? input.ctx?.flowManager;
      const state = flowManager.canonicalState(input.specId ?? input.ctx?.flowState?.specId);
      if (state.current?.at(-1) !== 'first') return null;
      const stepId = 'first';
      const registration = commandRegistration('first');
      const preparation = acquirePreparation({ flowManager, state });
      const selection = registration.executionContract.select({ ...input, flowManager, stepId, preparation, registration });
      return registration.executionContract.execute(selection, { ...input, flowManager, stepId, preparation, registration });
    }
  `;
  built.files.set(built.seed.composition, built.files.get(built.seed.composition)
    .replace('function prepareServiceArguments() { return [new Input(), new Writer()]; }',
      `import { prepareServiceArguments, acquirePreparation, unrelatedPreparation } from './${phase}-input.js';`)
    + initializer);
  return { ...built, acquisition, initializer };
}

const initializerMutations = [
  ["foreign target", "commandRegistration('first')", "commandRegistration('foreign')"],
  ["missing canonical guard", "if (state.current?.at(-1) !== 'first') return null;", ""],
  ["different canonical guard", "state.current?.at(-1) !== 'first'", "state.current?.at(-1) !== 'second'"],
  ["stale state", "flowManager.canonicalState(input.specId ?? input.ctx?.flowState?.specId)", "input.ctx.flowState"],
  ["different selection", "execute(selection,", "execute(input.selection,"],
  ["direct construction", "return registration.executionContract.execute(selection, { ...input, flowManager, stepId, preparation, registration });", "return registration.create(input);"],
  ["capability escape", "const preparation = acquirePreparation({ flowManager, state });", "input.proxy = registration; const preparation = acquirePreparation({ flowManager, state });"],
  ["different preparation", "const preparation = acquirePreparation({ flowManager, state });", "const preparation = unrelatedPreparation({ flowManager, state });"],
  ["shadowed preparation", "export function initializeTarget(input) {", "export function initializeTarget(input) { const acquirePreparation = input.prepare;"],
];

for (const phase of ["TargetMu", "TargetNu"]) {
  test(`fixed registered target initializer ${phase} uses the same canonical preparation and consumer`, () => {
    targetInitializerFixture(phase).clean();
  });
  for (const [name, before, after] of initializerMutations) {
    test(`fixed registered target initializer ${phase} rejects ${name} and accepts restoration`, () => {
      const built = targetInitializerFixture(phase);
      built.clean();
      const file = built.seed.composition;
      const original = built.files.get(file);
      assert.equal(original.split(before).length, 2);
      built.files.set(file, original.replace(before, after));
      const report = built.inspect();
      assert.ok(report.diagnostics.some((entry) => ["A10", "A11"].includes(entry.rule)),
        report.diagnostics.map(String).join("\n"));
      built.files.set(file, original);
      built.clean();
    });
  }
  test(`fixed registered target initializer ${phase} rejects an acquisition imported from another owner`, () => {
    const built = targetInitializerFixture(phase);
    built.clean();
    const file = built.seed.composition;
    const original = built.files.get(file);
    built.files.set(`src/flow/engine/composition/${phase}-foreign.js`, "export function acquirePreparation(input) { return input; }");
    built.files.set(file, original.replace("prepareServiceArguments, acquirePreparation, unrelatedPreparation", "prepareServiceArguments, unrelatedPreparation")
      + `\nimport { acquirePreparation } from './${phase}-foreign.js';`);
    assert.ok(built.inspect().diagnostics.some((entry) => entry.rule === "A10"));
    built.files.set(file, original);
    built.clean();
  });
  test(`fixed registered target initializer ${phase} rejects an equivalent caller outside composition`, () => {
    const built = targetInitializerFixture(phase);
    built.clean();
    const original = built.files.get(built.seed.composition);
    const file = "src/flow/lib/target-initializer.js";
    built.files.set(built.seed.composition, original.replace(built.initializer, ""));
    built.files.set(file, `import { commandRegistration } from '../engine/composition/${phase}.js';
      import { acquirePreparation } from '../engine/composition/${phase}-input.js'; ${built.initializer}`);
    assert.ok(built.inspect().diagnostics.some((entry) => ["A10", "A11"].includes(entry.rule)));
    built.files.delete(file);
    built.files.set(built.seed.composition, original);
    built.clean();
  });
}

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

function canonicalReceiptFixture(phase, external, exact = false) {
  const built = fixture(phase);
  const Replay = `${phase}Receipt`;
  const owner = external ? "src/flow/lib/canonical-replay.js" : built.seed.adapter;
  const replaySource = `export class ${Replay} {
    #flowManager; #specId; #stepId;
    constructor({ flowManager, specId, stepId, receipt }) {
      const saved = flowManager.readCurrentStepSettlement({ specId, stepId, completed: true${exact ? ", exactReceipt: receipt" : ""} });
      if (saved === null || !isDeepStrictEqual(saved.receipt.toJSON(), ${exact ? "(receipt.toJSON?.() ?? receipt)" : "receipt.toJSON()"})) {
        throw new StepAdmissionRefusal('acquisition');
      }
      this.#flowManager = flowManager;
      this.#specId = specId;
      this.#stepId = stepId;
      this.receipt = saved.receipt;
      Object.freeze(this);
    }
    assertCurrent() {
      const saved = this.#flowManager.readCurrentStepSettlement({ specId: this.#specId,
        stepId: this.#stepId, completed: true${exact ? ", exactReceipt: this.receipt" : ""} });
      if (saved === null || !isDeepStrictEqual(saved.receipt.toJSON(), this.receipt.toJSON())) {
        throw new StepAdmissionRefusal('stale');
      }
    }
  }`;
  let adapter = built.files.get(built.seed.adapter);
  const start = adapter.indexOf(`export class ${Replay}`);
  const end = adapter.indexOf("export function selectCommand", start);
  assert.ok(start >= 0 && end > start);
  adapter = adapter.slice(0, start) + (external
    ? `import { ${Replay} } from './canonical-replay.js'; export { ${Replay} };\n`
    : `${replaySource}\n`) + adapter.slice(end);
  adapter = adapter.replace(`new ${Replay}({ flowManager, specId, registration: input.registration, authority, receipt: saved.receipt })`,
    `new ${Replay}({ flowManager, specId, stepId: input.stepId, receipt: saved.receipt })`);
  built.files.set(built.seed.adapter, adapter);
  if (external) built.files.set(owner, `import { isDeepStrictEqual } from 'node:util';
    import { StepAdmissionRefusal } from './step-admission-refusal.js';\n${replaySource}`);
  return { ...built, owner };
}

for (const external of [false, true]) {
  const placement = external ? "imported" : "local";
  test(`canonical receipt ${placement} preserves exact acquisition and rechecks consumption`, () => {
    canonicalReceiptFixture(`Canonical${placement}`, external).clean();
  });
  test(`canonical explicit receipt ${placement} authenticates the same input and member at both boundaries`, () => {
    canonicalReceiptFixture(`ExactCanonical${placement}`, external, true).clean();
  });
  for (const [name, before, after] of [
    ["missing acquired exact receipt", "completed: true, exactReceipt: receipt", "completed: true"],
    ["swapped acquired receipt", "exactReceipt: receipt", "exactReceipt: this.receipt"],
    ["foreign acquired receipt", "exactReceipt: receipt", "exactReceipt: otherReceipt"],
    ["unchecked acquired input", "(receipt.toJSON?.() ?? receipt)", "saved.receipt.toJSON()"],
    ["missing rechecked exact receipt", "completed: true, exactReceipt: this.receipt", "completed: true"],
    ["swapped rechecked receipt", "exactReceipt: this.receipt", "exactReceipt: receipt"],
    ["foreign rechecked receipt", "exactReceipt: this.receipt", "exactReceipt: this.otherReceipt"],
  ]) test(`canonical explicit receipt ${placement} rejects ${name} and accepts restoration`, () => {
    const built = canonicalReceiptFixture(`ExactCanonical${placement}`, external, true);
    built.clean();
    const original = built.files.get(built.owner);
    assert.equal(original.split(before).length, 2);
    built.files.set(built.owner, original.replace(before, after));
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A10");
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
      assert.ok(diagnostic.trace.includes(built.seed.adapter));
    } finally { built.files.set(built.owner, original); }
    built.clean();
  });
  for (const [name, before, after] of [
    ["wrong canonical reader", "this.#flowManager.readCurrentStepSettlement(", "this.#flowManager.readOtherSettlement("],
    ["different source Step", "stepId: this.#stepId", "stepId: this.otherStep"],
    ["lost completed proof", "stepId: this.#stepId, completed: true", "stepId: this.#stepId, completed: false"],
    ["self-comparison", "!isDeepStrictEqual(saved.receipt.toJSON(), this.receipt.toJSON())", "!isDeepStrictEqual(this.receipt.toJSON(), this.receipt.toJSON())"],
    ["unchecked early return", "assertCurrent() {", "assertCurrent() { return;"],
  ]) test(`canonical receipt ${placement} rejects ${name} and accepts exact restoration`, () => {
    const built = canonicalReceiptFixture(`Canonical${placement}`, external);
    built.clean();
    const original = built.files.get(built.owner);
    assert.equal(original.split(before).length, 2);
    built.files.set(built.owner, original.replace(before, after));
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A10");
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
      assert.ok(diagnostic.trace.includes(built.seed.adapter));
    } finally { built.files.set(built.owner, original); }
    built.clean();
  });
  for (const consumer of ["executor", "recovery"]) test(`canonical receipt ${placement} rejects ${consumer} without reauthentication`, () => {
    const built = canonicalReceiptFixture(`Canonical${placement}`, external);
    built.clean();
    const file = consumer === "executor" ? built.seed.adapter : built.caller.module;
    const original = built.files.get(file);
    const source = consumer === "executor" ? "selection.receipt.assertCurrent();" : "receipt.assertCurrent();";
    assert.equal(original.split(source).length, 2);
    built.files.set(file, original.replace(source, ""));
    try {
      const report = built.inspect();
      assert.ok(report.diagnostics.some((entry) => entry.rule === "A10" && entry.file === file),
        report.diagnostics.map(String).join("\n"));
    } finally { built.files.set(file, original); }
    built.clean();
  });
}
