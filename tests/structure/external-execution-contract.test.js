import assert from "node:assert/strict";
import { test } from "node:test";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { StructureChecker, StructureReport, StructureScope } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { ExecutionCaller, ExecutionLoader, NamedExecutionShape, StructureLeaf, StructureScopeContract } from "../support/structure/production-registrations.js";

function inspect(seed, files = seed.files()) {
  return new StructureChecker(seed.scope(), new MemorySourceRepository(files)).check();
}
function success(report) { assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n")); }
function violation(report, rule, file, message) {
  const diagnostic = report.diagnostics.find((entry) => entry.rule === rule && entry.file === file && entry.message.includes(message));
  assert.ok(diagnostic, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.equal(diagnostic.line > 0 && diagnostic.column > 0, true);
  assert.equal(diagnostic.trace.includes(file), true);
  return diagnostic;
}

function adoptionFiles(seed) {
  const files = seed.files();
  files.set(seed.adapter, `import { BlockedDirective } from './next-action-directive.js';
    class AdmissionSelection {
      constructor({ state, stepId, registration, binding, preparation, receipt }) {
        if (registration?.stepId !== stepId || registration.executionContract !== commandStepExecutionContract) {
          throw new StepAdmissionRefusal('registration identity');
        }
        this.runId = state.runId; this.specId = state.specId; this.stepId = stepId;
        this.registration = registration; this.binding = binding;
        this.preparation = preparation; this.receipt = receipt; Object.freeze(this);
      }
    }
    export function selectCommand(input) { return new AdmissionSelection(input); }
    export function projectCommand(selection) {
      if (!(selection instanceof AdmissionSelection)) { throw new TypeError('selection'); }
      return new BlockedDirective({ code: 'PREPARATION_REQUIRED', reason: 'external evidence required', resumeInstruction: 'resume', });
    }
    export async function executeCommand(selection, input) {
      if (!(selection instanceof AdmissionSelection) || selection.registration !== input.registration
        || selection.stepId !== input.registration.stepId) { throw new StepAdmissionRefusal('registration'); }
      if (selection.receipt !== null) return selection.receipt;
      if (selection.binding === null || selection.preparation === null) { throw new StepAdmissionRefusal('evidence'); }
      selection.binding.assertCurrent();
      const prepared = await input.registration.create({ flowManager: input.flowManager, binding: selection.binding,
        preparation: selection.preparation, commandResult: input.commandResult, });
      await prepared.step.execute();
      return prepared.dependency(input.registration.ServiceClass).settledOutcome;
    }
    export const commandStepExecutionContract = new StepExecutionContract({
      select: selectCommand, project: projectCommand, execute: executeCommand, });`);
  files.set("src/flow/lib/next-action-directive.js", "export class BlockedDirective {}");
  const serviceFile = "src/flow/services/service.js";
  files.set(serviceFile, files.get(serviceFile).replace("throw new TypeError(); } }",
    "throw new TypeError(); } get settledOutcome() { return null; } }"));
  for (const caller of seed.callers) {
    const selection = caller.selectionMode === "select"
      ? "const selection = registration.executionContract.select({ ...input, registration });"
      : "const selection = input.selection;";
    const replay = caller.receiptReplayName === null ? ""
      : `if (selection.registration !== registration) throw new TypeError('registration');
         if (selection.receipt !== null) return ${caller.receiptReplayName}(selection.receipt);`;
    files.set(caller.module, `import { commandRegistration } from '../engine/composition/${seed.phase}.js';
      ${caller.receiptReplayName === null ? "" : "function replayReceipt(receipt) { return receipt; }"}
      export function ${caller.declarationName}(input) {
        const registration = commandRegistration(input.stepId);
        if (registration === null) throw new TypeError('registration'); ${selection} ${replay}
        return registration.executionContract.${caller.operation}(selection, { ...input, registration });
      }`);
  }
  return files;
}

test("registered adoption preserves exact registration, executes its prepared Step, and returns the declared Service outcome", () => {
  const seed = new StagedExecutionSeed("renamed-adoption", ["first", "second"], null, "prepare-adoption");
  success(inspect(seed, adoptionFiles(seed)));
});

for (const [name, before, after] of [
  ["missing registration identity", "selection.registration !== input.registration", "selection.stepId !== input.registration.stepId"],
  ["early execution", "if (!(selection instanceof AdmissionSelection) || selection.registration", "if (input.fast) return input.command.execute(input); if (!(selection instanceof AdmissionSelection) || selection.registration"],
  ["selection overwrite", "selection.binding.assertCurrent();", "selection = input.selection; selection.binding.assertCurrent();"],
  ["unselected binding", "binding: selection.binding", "binding: input.binding"],
  ["unselected evidence", "preparation: selection.preparation", "preparation: input.preparation"],
  ["different registration execution", "await prepared.step.execute();", "await input.otherStep.execute();"],
  ["execution omission", "await prepared.step.execute();", ""],
  ["fabricated completion", ".settledOutcome;", ".fabricatedOutcome;"],
  ["single Step exclusion", "if (selection.receipt !== null)", "if (selection.stepId === 'second') return null; if (selection.receipt !== null)"],
]) {
  test(`registered adoption rejects ${name} and accepts restoration`, () => {
    const seed = new StagedExecutionSeed("renamed-adoption", ["first", "second"], null, "prepare-adoption");
    const files = adoptionFiles(seed);
    const original = files.get(seed.adapter);
    assert.equal(original.includes(before), true);
    files.set(seed.adapter, original.replace(before, after));
    violation(inspect(seed, files), "A10", seed.adapter, "named adapter executeCommand does not preserve its supplied selection");
    files.set(seed.adapter, original);
    success(inspect(seed, files));
  });
}

test("a registered post acknowledges its exact saved receipt without executing the Step again", () => {
  const seed = new StagedExecutionSeed();
  const files = adoptionFiles(seed);
  const caller = seed.callers.find((entry) => entry.declarationName === "post");
  const original = files.get(caller.module).replace("const selection = input.selection;",
    `const selection = input.selection;
     if (selection.registration !== registration) throw new TypeError('registration');
     if (selection.receipt !== null) return selection.receipt;`);
  files.set(caller.module, original);
  success(inspect(seed, files));
  files.set(caller.module, original.replace("selection.registration !== registration", "input.finished"));
  violation(inspect(seed, files), "A10", caller.module, "does not preserve registered lookup and selection");
  files.set(caller.module, original);
  success(inspect(seed, files));
});

test("registered adoption callers cannot reuse or escape their acquired capabilities after consumption", () => {
  const seed = new StagedExecutionSeed("renamed-adoption", ["first", "second"], null, "prepare-adoption");
  const files = adoptionFiles(seed);
  const caller = seed.callers.find((entry) => entry.declarationName === "post");
  const base = files.get(caller.module);
  const owner = (terminal) => `${base}
    export async function owner(input) {
      const registration = commandRegistration(input.stepId);
      const selection = registration.executionContract.select({ ...input, registration });
      await post({ ...input, selection });
      ${terminal}
    }`;
  files.set(caller.module, owner("return true;"));
  success(inspect(seed, files));
  for (const terminal of [
    "return registration.executionContract.execute(null, { ...input, registration });",
    "return registration;",
    "selection = null; return true;",
    "return otherHelper(selection);",
    "const escaped = registration; return escaped;",
  ]) {
    files.set(caller.module, owner(terminal));
    violation(inspect(seed, files), "A11", caller.module,
      "unregistered execution lookup caller or capability escape");
    files.set(caller.module, owner("return true;"));
    success(inspect(seed, files));
  }
});

test("registered adoption fragments must call their checked module consumer rather than a lexical shadow", () => {
  const seed = new StagedExecutionSeed("renamed-adoption", ["first", "second"], null, "prepare-adoption");
  const files = adoptionFiles(seed);
  const caller = seed.callers.find((entry) => entry.declarationName === "post");
  const base = files.get(caller.module);
  const owner = (parameters, prefix) => `${base}
    export async function owner(${parameters}) {
      ${prefix}
      const registration = commandRegistration(input.stepId);
      const selection = registration.executionContract.select({ ...input, registration });
      await post({ ...input, selection });
      return true;
    }`;
  files.set(caller.module, owner("input", ""));
  success(inspect(seed, files));
  for (const [parameters, prefix] of [["input, post", ""], ["input", "const post = input.callback;"]]) {
    files.set(caller.module, owner(parameters, prefix));
    violation(inspect(seed, files), "A11", caller.module,
      "unregistered execution lookup caller or capability escape");
    files.set(caller.module, owner("input", ""));
    success(inspect(seed, files));
  }
});

test("all declared execution forms use named adapters rather than Step suffix inference", () => {
  for (const form of ["worker", "command", "user-decision", "prepare-adoption", "host-one-shot", "deterministic", "aggregate"]) {
    const seed = new StagedExecutionSeed("without-role-suffix", ["first", "second"], null, form);
    success(inspect(seed));
    const files = seed.files();
    files.set(seed.adapter, files.get(seed.adapter).replace("project: projectCommand", "project: executeCommand"));
    violation(inspect(seed, files), "A10", seed.adapter, "does not bind its named adapters");
  }
});

for (const [name, callerName, before, after] of [
  ["selection discard", "direct", "execute(selection, input)", "execute(null, input)"],
  ["selection overwrite", "direct", "return registration.executionContract.execute", "selection = null; return registration.executionContract.execute"],
  ["a single Step exclusion", "display", "const registration =", "if (input.stepId === 'second') return null; const registration ="],
  ["early execution branch", "run", "const registration =", "if (input.fast) return input.command.execute(input); const registration ="],
  ["post judgment recomputation", "post", "const selection = input.selection;", "const selection = registration.executionContract.select(input);"],
  ["recovery selection discard", "recover", "execute(selection, input)", "execute(input.otherSelection, input)"],
]) {
  test(`named execution routes reject ${name} and accept restoration`, () => {
    const seed = new StagedExecutionSeed();
    const caller = seed.callers.find((entry) => entry.declarationName === callerName);
    const files = seed.files();
    const source = files.get(caller.module);
    assert.equal(source.includes(before), true);
    files.set(caller.module, source.replace(before, after));
    violation(inspect(seed, files), "A10", caller.module, "does not preserve registered lookup and selection");
    success(inspect(seed));
  });
}

test("explicit receipt replay is accepted while an arbitrary early return is rejected", () => {
  const seed = new StagedExecutionSeed();
  success(inspect(seed));
  const caller = seed.callers.find((entry) => entry.declarationName === "run");
  const files = seed.files();
  files.set(caller.module, files.get(caller.module).replace("input.receiptReplay !== null", "input.finished"));
  violation(inspect(seed, files), "A10", caller.module, "does not preserve registered lookup and selection");
  success(inspect(seed));
});

test("receipt replay helper cannot hide fresh judgment or execution", () => {
  const seed = new StagedExecutionSeed();
  const caller = seed.callers.find((entry) => entry.declarationName === "run");
  const files = seed.files();
  files.set(caller.module, files.get(caller.module).replace("return receipt;", "return run(receipt);"));
  violation(inspect(seed, files), "A10", caller.module, "receipt replay must consume the acquired receipt");
  success(inspect(seed));
});

test("registration lookup cannot filter an individual Step from its full selection", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set(seed.composition, files.get(seed.composition).replace("registrations.map(", "registrations.filter((registration) => registration.stepId !== 'second').map("));
  violation(inspect(seed, files), "A10", seed.composition, "does not cover its full registration selection");
  success(inspect(seed));
});

test("registration lookup cannot build its map from a subset alias", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set(seed.composition, files.get(seed.composition).replace("const byId = new Map(registrations.map(",
    "const selected = [registrations[0]]; const byId = new Map(selected.map("));
  violation(inspect(seed, files), "A10", seed.composition, "does not cover its full registration selection");
  success(inspect(seed));
});

for (const [form, imported, called] of [["direct", "commandRegistration", "commandRegistration"], ["alias", "commandRegistration as unlisted", "unlisted"]]) {
  test(`unregistered ${form} loader caller fails closed`, () => {
    const seed = new StagedExecutionSeed();
    const file = "src/flow/lib/command-unregistered.js";
    const files = seed.files();
    files.set(file, `import { ${imported} } from '../engine/composition/${seed.phase}.js';
      export function unregistered(input) { return ${called}(input.stepId); }`);
    violation(inspect(seed, files), "A11", file, "unregistered execution lookup caller");
    success(inspect(seed));
  });
}

for (const [form, imported, body] of [
  ["namespace", "* as registry", "return registry.commandRegistration(input.stepId);"],
  ["optional namespace", "* as registry", "return registry?.commandRegistration?.(input.stepId);"],
  ["local alias", "{ commandRegistration }", "const lookup = commandRegistration; return lookup(input.stepId);"],
  ["alias chain", "{ commandRegistration }", "const first = commandRegistration; const lookup = first; return lookup(input.stepId);"],
  ["namespace member escape", "* as registry", "const lookup = registry.commandRegistration; return lookup;"],
  ["destructured namespace", "* as registry", "const { commandRegistration: lookup } = registry; return lookup(input.stepId);"],
]) {
  test(`unregistered ${form} lookup use is rejected and restoration succeeds`, () => {
    const seed = new StagedExecutionSeed();
    const file = "src/flow/lib/command-unregistered.js";
    const files = seed.files();
    files.set(file, `import ${imported} from '../engine/composition/${seed.phase}.js'; export function unknown(input) { ${body} }`);
    violation(inspect(seed, files), "A11", file, "unregistered execution lookup caller or capability escape");
    success(inspect(seed));
  });
}

test("unknown command loader cannot import a declared execution entry", () => {
  const seed = new StagedExecutionSeed();
  const file = "src/flow/unregistered-loader.js";
  const files = seed.files();
  files.set(file, "export function loadOther() { return import('./lib/command-direct.js'); }");
  violation(inspect(seed, files), "A11", file, "unregistered execution command loader");
  success(inspect(seed));
});

test("named command loader rejects a computed or exchanged module", () => {
  const seed = new StagedExecutionSeed();
  const file = seed.shape.loaders[0].module;
  const files = seed.files();
  files.set(file, "export function loadCommand() { return import(moduleName); }");
  violation(inspect(seed, files), "A11", file, "is not its named command loader");
  success(inspect(seed));
});

test("a direct named adapter alias cannot bypass production registration", () => {
  const seed = new StagedExecutionSeed();
  const file = "src/flow/lib/command-bypass.js";
  const files = seed.files();
  files.set(file, "import { commandStepExecutionContract as escaped } from './command-execution.js'; export function bypass(input) { return escaped.execute(input.selection, input); }");
  violation(inspect(seed, files), "A11", file, "shared execution adapter imported outside production registration");
  success(inspect(seed));
});

test("an exported lookup alias is a capability escape even without a local call", () => {
  const seed = new StagedExecutionSeed();
  const file = "src/flow/lib/command-exported-lookup.js";
  const files = seed.files();
  files.set(file, `import { commandRegistration } from '../engine/composition/${seed.phase}.js'; export const lookup = commandRegistration;`);
  violation(inspect(seed, files), "A11", file, "unregistered execution lookup caller or capability escape");
  success(inspect(seed));
});

test("named contract adapters cannot be silently exchanged", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set(seed.adapter, files.get(seed.adapter).replace("project: projectCommand", "project: executeCommand"));
  violation(inspect(seed, files), "A10", seed.adapter, "does not bind its named adapters");
  success(inspect(seed));
});

for (const [name, body, helper = ""] of [
  ["selection discard", "return input.command.execute(input);"],
  ["selection recomputation", "const replacement = selectCommand(input); return replacement;"],
  ["selection overwrite", "selection = input.selection; return selection;"],
  ["early bypass", "if (input.fast) return input; return selection;"],
  ["unknown conditional shape", "return input.fast ? selection : input;"],
  ["computed selection access", "return selection[input.operation](input);"],
  ["alias overwrite", "const selected = selection; selected = input; return selected;"],
  ["delegate selection discard", "return consume(selection, input);", "function consume(selected, context) { return context; }"],
  ["delegate rejudgment", "return consume(selection, input);", "function consume(selected, context) { return selectCommand(context); }"],
  ["delegate argument replacement", "return consume(input.selection, input);", "function consume(selected, context) { return selected; }"],
  ["opaque delegate", "return consume(selection, input);"],
  ["recursive delegate", "return consume(selection, input);", "function consume(selected, context) { return consume(selected, context); }"],
  ["adapter role exchange", "return projectCommand(selection, input);"],
]) {
  test(`named adapter consumer rejects ${name} and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    for (const adapter of ["projectCommand", "executeCommand"]) {
      const files = seed.files();
      files.set(seed.adapter, files.get(seed.adapter).replace(
        `function ${adapter}(selection, input) { return selection; }`,
        `function ${adapter}(selection, input) { ${body} }`) + helper);
      violation(inspect(seed, files), "A10", seed.adapter, `named adapter ${adapter} does not preserve its supplied selection`);
      success(inspect(seed));
    }
  });
}

test("named adapter consumers preserve immutable aliases and inspected local delegation across all execution forms", () => {
  for (const form of ["worker", "command", "user-decision", "prepare-adoption", "host-one-shot", "deterministic", "aggregate"]) {
    const seed = new StagedExecutionSeed("without-role-suffix", ["first", "second"], null, form);
    const files = seed.files();
    files.set(seed.adapter, files.get(seed.adapter)
      .replace("function projectCommand(selection, input) { return selection; }",
        "function projectCommand(selected, context) { const first = selected; const final = first; return final; }")
      .replace("function executeCommand(selection, input) { return selection; }",
        "function executeCommand(selected, context) { const chosen = selected; const request = context; return consume(chosen, request); }")
      + "function consume(value, request) { const forwarded = value; return finish(forwarded); } function finish(value) { return value; }");
    success(inspect(seed, files));
    const post = seed.callers.find((caller) => caller.declarationName === "post");
    const invalid = new Map(files);
    invalid.set(post.module, files.get(post.module).replace("const selection = input.selection;",
      "const selection = registration.executionContract.select(input);"));
    violation(inspect(seed, invalid), "A10", post.module, "does not preserve registered lookup and selection");
    success(inspect(seed, files));
  }
});

for (const [name, mutation] of [
  ["helper reassignment", "consume = (selection, input) => selectCommand(input);"],
  ["helper alias escape", "const alias = consume; external(alias);"],
  ["helper private field escape", "class Holder { #handler; constructor() { this.#handler = consume; } }"],
  ["helper export escape", "export { consume };"],
]) {
  test(`named adapter bindings reject ${name} and accept restoration`, () => {
    const seed = new StagedExecutionSeed();
    const files = seed.files();
    files.set(seed.adapter, files.get(seed.adapter)
      .replace("function executeCommand(selection, input) { return selection; }",
        "function executeCommand(selection, input) { return consume(selection, input); }")
      + "function consume(selected, context) { return selected; }");
    success(inspect(seed, files));
    const invalid = new Map(files);
    invalid.set(seed.adapter, files.get(seed.adapter) + mutation);
    violation(inspect(seed, invalid), "A10", seed.adapter, "unresolved execution adapter binding");
    success(inspect(seed, files));
  });
}

test("named adapter bindings reject replacement before contract capture and accept restoration", () => {
  const seed = new StagedExecutionSeed();
  for (const name of ["projectCommand", "executeCommand"]) {
    const files = seed.files();
    files.set(seed.adapter, files.get(seed.adapter).replace("export const commandStepExecutionContract",
      `${name} = (selection, input) => selectCommand(input); export const commandStepExecutionContract`));
    violation(inspect(seed, files), "A10", seed.adapter, "unresolved execution adapter binding");
    success(inspect(seed));
  }
});

test("named adapter bindings reject direct helper exports and accept restoration", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set(seed.adapter, files.get(seed.adapter)
    .replace("function executeCommand(selection, input) { return selection; }",
      "function executeCommand(selection, input) { return consume(selection, input); }")
    + "function consume(selected, context) { return selected; }");
  success(inspect(seed, files));
  const invalid = new Map(files);
  invalid.set(seed.adapter, files.get(seed.adapter).replace("function consume(", "export function consume("));
  violation(inspect(seed, invalid), "A10", seed.adapter, "unresolved execution adapter binding: exported helper consume");
  success(inspect(seed, files));
});

test("named adapter bindings accept one inspected helper shared by project and execute", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set(seed.adapter, files.get(seed.adapter)
    .replaceAll("{ return selection; }", "{ return consume(selection, input); }")
    + "function consume(selected, context) { const alias = selected; return alias; }");
  success(inspect(seed, files));
});

test("typed-input subclass preparation preserves A12 ancestry and rejects unrelated types and broad inputs", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set("src/flow/services/input.js", "export class Input {} export class SpecializedInput extends Input {} export class OtherInput {}");
  files.set(seed.composition, files.get(seed.composition).replace("import { Input }", "import { Input, SpecializedInput, OtherInput }")
    .replace("return [new Input(),", "return [new SpecializedInput(),"));
  success(inspect(seed, files));
  const unrelated = new Map(files);
  unrelated.set(seed.composition, files.get(seed.composition).replace("new SpecializedInput()", "new OtherInput()"));
  violation(inspect(seed, unrelated), "A12", seed.composition, "preparation returns OtherInput");
  const broad = new Map(files);
  broad.set(seed.composition, files.get(seed.composition).replace("new SpecializedInput()", "new SpecializedInput(manager)"));
  violation(inspect(seed, broad), "A12", seed.composition, "typed input receives broad dependency manager");
  success(inspect(seed, files));
});

test("A12 requires constructor rejection and cannot use a sibling method's type checks as its invariant", () => {
  const seed = new StagedExecutionSeed();
  const file = "src/flow/services/service.js";
  for (const body of [
    "constructor(input, writer) {} validate(input, writer) { if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); }",
    "constructor(input, writer) { const inputValid = input instanceof Input; const writerValid = writer instanceof Writer; }",
    "constructor(input, writer) { if (!(input instanceof Input) && !(writer instanceof Writer)) throw new TypeError(); }",
    "constructor(input, writer) { if (input.fast) return; if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); }",
    "constructor(a, b) { const input = new Input(); const writer = new Writer(); if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); }",
    "constructor(input, writer) { input = new Input(); if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); }",
    "constructor(input, writer) { input ||= new Input(); if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); }",
    "constructor(input, writer) { [input, writer] = [new Input(), new Writer()]; if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); }",
    "constructor(input, writer) { ({ input, writer } = { input: new Input(), writer: new Writer() }); if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); }",
  ]) {
    const files = seed.files();
    files.set(file, `import { Input } from './input.js'; import { Writer } from './alpha-settlement-writer.js';
      export class ServiceClass { static argumentTypes = [Input, Writer]; ${body} }`);
    violation(inspect(seed, files), "A12", file, "constructor must validate typed input and settlement writer");
    success(inspect(seed));
  }
});

test("A12 ties renamed constructor guards to argument positions", () => {
  const seed = new StagedExecutionSeed();
  const file = "src/flow/services/service.js";
  const files = seed.files();
  files.set(file, `import { Input } from './input.js'; import { Writer } from './alpha-settlement-writer.js';
    export class ServiceClass { static argumentTypes = [Input, Writer]; constructor(a, b) {
      if (!(a instanceof Input) || !(b instanceof Writer)) throw new TypeError(); } }`);
  success(inspect(seed, files));
  const reversed = new Map(files);
  reversed.set(file, files.get(file).replace("constructor(a, b)", "constructor(b, a)"));
  violation(inspect(seed, reversed), "A12", file, "argumentTypes differs from constructor Writer, Input");
  success(inspect(seed, files));
});

test("a missing declared caller source is an incomplete check rather than an accepted future route", () => {
  const seed = new StagedExecutionSeed();
  const caller = seed.callers[0];
  const files = seed.files();
  files.delete(caller.module);
  violation(inspect(seed, files), "A10", caller.module, "cannot read source");
  success(inspect(seed));
});

// Full registration coverage requires the selected collection, captured map,
// and named lookup capability to remain closed until declared callers use it.
for (const [name, before, after] of [
  ["map deletion", "", "byId.delete('second');"],
  ["map reassignment", "", "byId = new Map();"],
  ["map mutation through an alias", "", "const index = byId; index.clear();"],
  ["map capability escape", "", "external(byId);"],
  ["lookup reassignment", "", "commandRegistration = () => null;"],
  ["lookup capability escape through an alias", "", "const lookup = commandRegistration; external(lookup);"],
  ["registration selection mutation before map capture", "const byId =", "registrations.splice(1, 1); const byId ="],
  ["registration selection alias mutation before map capture", "const byId =", "const selected = registrations; selected.splice(1, 1); const byId ="],
]) {
  test(`named lookup binding integrity rejects ${name} and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    const files = seed.files();
    const source = files.get(seed.composition);
    assert.equal(source.includes(before), true);
    files.set(seed.composition, before === "" ? `${source}\n${after}` : source.replace(before, after));
    violation(inspect(seed, files), "A10", seed.composition, "unresolved execution lookup binding");
    success(inspect(seed));
  });
}

test("named lookup binding integrity rejects an unknown conditional registration selection and accepts restoration", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const source = files.get(seed.composition);
  const declaration = "export const registrations = [";
  const mapStart = "];\n      const byId =";
  assert.equal(source.includes(declaration), true);
  assert.equal(source.includes(mapStart), true);
  files.set(seed.composition, source.replace(declaration, "export const registrations = unknownSelection ? [").replace(mapStart, "] : [];\n      const byId ="));
  violation(inspect(seed, files), "A10", seed.composition, "does not cover its full registration selection");
  success(inspect(seed));
});

test("named lookup binding integrity rejects a lookup parameter default and accepts restoration", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const source = files.get(seed.composition);
  const declaration = "commandRegistration(stepId)";
  assert.equal(source.includes(declaration), true);
  files.set(seed.composition, source.replace(declaration, "commandRegistration(stepId = 'second')"));
  violation(inspect(seed, files), "A10", seed.composition, "does not cover its full registration selection");
  success(inspect(seed));
});

test("named lookup binding integrity accepts a renamed phase with unrelated map and function uses", () => {
  const seed = new StagedExecutionSeed("renamed-lookup-phase", ["alpha", "beta"]);
  const files = seed.files();
  files.set(seed.composition, files.get(seed.composition) + `
    const unrelated = new Map([['other', 1]]);
    unrelated.delete('other');
    function unrelatedLookup(stepId) { return unrelated.get(stepId) ?? null; }`);
  const caller = seed.callers.find((entry) => entry.declarationName === "direct");
  files.set(caller.module, files.get(caller.module) + `
    const unrelated = new Map();
    unrelated.set('other', 1);
    function unrelatedLookup(stepId) { return unrelated.get(stepId) ?? null; }`);
  success(inspect(seed, files));
});

for (const [name, addition] of [
  ["object property keys", "const metadata = { byId: 'index', registrations: 'entries' };"],
  ["independent function parameters", "function independent(byId) { return byId.get('other'); }"],
]) {
  test(`named lookup lexical identity accepts ${name} without treating them as outer bindings`, () => {
    const seed = new StagedExecutionSeed("independent-lookup-phase", ["alpha", "beta"]);
    const files = seed.files();
    files.set(seed.composition, `${files.get(seed.composition)}\n${addition}`);
    success(inspect(seed, files));
  });
}

test("named lookup lexical identity rejects a helper that captures the outer map and accepts restoration", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set(seed.composition, files.get(seed.composition) + "\nfunction capture() { return byId.get('second'); }");
  violation(inspect(seed, files), "A10", seed.composition, "unresolved execution lookup binding");
  success(inspect(seed));
});

test("named lookup inspection boundary rejects an outer map captured in a ternary arm and accepts restoration", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set(seed.composition, files.get(seed.composition) + "\nconst selected = flag ? byId : null;");
  violation(inspect(seed, files), "A10", seed.composition, "unresolved execution lookup binding");
  success(inspect(seed));
});

test("named lookup inspection boundary returns an incomplete report at unsupported source position and accepts restoration", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const source = files.get(seed.composition);
  files.set(seed.composition, source + "\n   var independent = 1;");
  const report = inspect(seed, files);
  assert.equal(report instanceof StructureReport, true);
  assert.equal(report.ok, false);
  const diagnostic = violation(report, "A10", seed.composition, "cannot inspect execution lookup bindings");
  assert.equal(diagnostic.message.includes("unsupported var declaration"), true);
  assert.equal(diagnostic.line, source.split("\n").length + 1);
  assert.equal(diagnostic.column, 4);
  assert.equal(diagnostic.trace[0], seed.composition);
  success(inspect(seed));
});

function declaredRouteBindings(seed) {
  const direct = seed.callers.find((caller) => caller.declarationName === "direct");
  const run = seed.callers.find((caller) => caller.declarationName === "run");
  const loader = seed.shape.loaders[0];
  return [
    ["caller", direct.module, direct.declarationName],
    ["receipt helper", run.module, run.receiptReplayName],
    ["loader", loader.module, loader.declarationName],
  ];
}

function combineCallerSources(sources) {
  const importEnd = sources[0].indexOf("\n");
  const lookupImport = sources[0].slice(0, importEnd);
  assert.equal(importEnd > 0, true);
  for (const source of sources) assert.equal(source.startsWith(lookupImport + "\n"), true);
  return lookupImport + sources.map((source) => source.slice(importEnd)).join("\n");
}

function localizeExport(files, file, name, kind) {
  const source = files.get(file);
  const declaration = `export ${kind} ${name}`;
  assert.equal(source.includes(declaration), true);
  files.set(file, source.replace(declaration, `${kind} ${name}`));
}

for (const role of ["caller", "receipt helper", "loader"]) {
  for (const [mutation, addition] of [
    ["reassignment", (name) => `${name} = () => null;`],
    ["alias escape", (name) => `const escaped = ${name}; external(escaped);`],
  ]) {
    test(`declared route binding rejects ${role} ${mutation} and accepts restoration`, () => {
      const seed = new StagedExecutionSeed();
      const [, file, name] = declaredRouteBindings(seed).find((binding) => binding[0] === role);
      const files = seed.files();
      files.set(file, `${files.get(file)}\n${addition(name)}`);
      violation(inspect(seed, files), "A10", file, "unresolved execution entry binding");
      success(inspect(seed));
    });
  }
}

test("declared route binding accepts canonical named exports, property keys, and independent parameters", () => {
  const seed = new StagedExecutionSeed("renamed-caller-phase", ["alpha", "beta"]);
  const files = seed.files();
  for (const [role, file, name] of declaredRouteBindings(seed)) {
    let source = files.get(file);
    if (role !== "receipt helper") {
      assert.equal(source.includes(`export function ${name}(`), true);
      source = source.replace(`export function ${name}(`, `function ${name}(`) + `\nexport { ${name} };`;
    }
    files.set(file, source + `\nconst metadata = { ${name}: 'label' };
      function independent(${name}) { return ${name}; }`);
  }
  success(inspect(seed, files));
});

for (const [role, declaration, replacement, rule, message] of [
  ["caller", "direct(input)", "direct(input = external())", "A10", "does not preserve registered lookup and selection"],
  ["loader", "loadCommand()", "loadCommand(input = external())", "A11", "is not its named command loader"],
]) {
  test(`declared route binding rejects an unverified ${role} parameter default and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    const [, file] = declaredRouteBindings(seed).find((binding) => binding[0] === role);
    const files = seed.files();
    const source = files.get(file);
    assert.equal(source.includes(declaration), true);
    files.set(file, source.replace(declaration, replacement));
    violation(inspect(seed, files), rule, file, message);
    success(inspect(seed));
  });
}

test("declared route binding preserves multiple callers and loaders sharing their modules", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const commandModule = "src/flow/lib/command-shared.js";
  const callerSources = seed.callers.map((caller) => files.get(caller.module));
  files.set(commandModule, combineCallerSources(callerSources));
  for (const caller of seed.callers) files.delete(caller.module);
  const callers = seed.callers.map((caller) => new ExecutionCaller(commandModule, caller.declarationName,
    caller.lookupName, caller.operation, caller.receiptReplayName, caller.selectionMode));
  const originalLoader = seed.shape.loaders[0];
  const loaderSource = files.get(originalLoader.module).replace("./lib/command-direct.js", "./lib/command-shared.js");
  assert.equal(loaderSource.includes("./lib/command-shared.js"), true);
  files.set(originalLoader.module, loaderSource + "\n" + loaderSource.replace("loadCommand", "loadOtherCommand"));
  const loaders = [
    new ExecutionLoader(originalLoader.module, originalLoader.declarationName, commandModule),
    new ExecutionLoader(originalLoader.module, "loadOtherCommand", commandModule),
  ];
  seed.shape = new NamedExecutionShape(seed.shape.form, seed.shape.adapterModule, seed.shape.contractName,
    seed.shape.selectorName, seed.shape.projectorName, seed.shape.executorName, callers, loaders);
  success(inspect(seed, files));
});

test("declared route binding preserves callers from two registered execution forms in one module", () => {
  const seed = new StagedExecutionSeed("shared-forms", ["first", "second"], [
    new StructureLeaf("first", "flow", "first", "command"),
    new StructureLeaf("second", "flow", "second", "worker"),
  ]);
  const files = seed.files();
  const commandModule = "src/flow/lib/command-shared-forms.js";
  const sharedCallers = seed.callers.filter((caller) => ["direct", "display"].includes(caller.declarationName));
  const secondCallers = sharedCallers.map((caller) => new ExecutionCaller(commandModule,
    `${caller.declarationName}Worker`, caller.lookupName, caller.operation));
  const sources = sharedCallers.map((caller) => files.get(caller.module));
  files.set(commandModule, combineCallerSources([
    ...sources,
    ...sources.map((source, index) => source.replace(`function ${sharedCallers[index].declarationName}(`,
      `function ${secondCallers[index].declarationName}(`)),
  ]));
  for (const caller of sharedCallers) files.delete(caller.module);
  const firstCallers = seed.callers.map((caller) => sharedCallers.includes(caller)
    ? new ExecutionCaller(commandModule, caller.declarationName, caller.lookupName, caller.operation)
    : caller);
  const originalLoader = seed.shape.loaders[0];
  files.set(originalLoader.module, files.get(originalLoader.module)
    .replace("./lib/command-direct.js", "./lib/command-shared-forms.js"));
  const firstShape = new NamedExecutionShape("command", seed.shape.adapterModule, seed.shape.contractName,
    seed.shape.selectorName, seed.shape.projectorName, seed.shape.executorName, firstCallers,
    [new ExecutionLoader(originalLoader.module, originalLoader.declarationName, commandModule)]);
  const secondShape = new NamedExecutionShape("worker", seed.shape.adapterModule, seed.shape.contractName,
    seed.shape.selectorName, seed.shape.projectorName, seed.shape.executorName, secondCallers);
  const scope = new StructureScope(seed.scope().root, seed.entry, seed.registrations, seed.composition,
    new StructureScopeContract(seed.definition, [firstShape, secondShape], seed.registrations));
  success(new StructureChecker(scope, new MemorySourceRepository(files)).check());
});

for (const [form, exportSource] of [
  ["local alias", (name) => `function replacement() { return null; } export { replacement as ${name} };`],
  ["reexport", (name) => `export { ${name} } from './replacement.js';`],
]) {
  test(`declared route binding rejects ${form} replacement of a canonical public caller export and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    const [, file, name] = declaredRouteBindings(seed).find((binding) => binding[0] === "caller");
    const files = seed.files();
    localizeExport(files, file, name, "function");
    files.set(file, files.get(file) + "\n" + exportSource(name));
    files.set("src/flow/lib/replacement.js", `export function ${name}() { return null; }`);
    violation(inspect(seed, files), "A10", file, "unresolved execution entry binding: public export");
    success(inspect(seed));
  });
}

for (const [form, exportSource] of [
  ["local alias", (name) => `function substitute() { return null; } export { substitute as ${name} };`],
  ["reexport", (name) => `export { ${name} } from './replacement.js';`],
]) {
  test(`declared route binding public lookup rejects ${form} slot replacement and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    const name = seed.callers[0].lookupName;
    const files = seed.files();
    localizeExport(files, seed.composition, name, "function");
    files.set(seed.composition, files.get(seed.composition) + "\n" + exportSource(name));
    files.set("src/flow/engine/composition/replacement.js", `export function ${name}() { return null; }`);
    violation(inspect(seed, files), "A10", seed.composition, "unresolved execution lookup binding: public export");
    success(inspect(seed));
  });
}

test("declared route binding public lookup accepts canonical local lookup and registration array exports", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const name = seed.callers[0].lookupName;
  localizeExport(files, seed.composition, name, "function");
  localizeExport(files, seed.composition, "registrations", "const");
  files.set(seed.composition, files.get(seed.composition) + `\nexport { ${name}, registrations };`);
  success(inspect(seed, files));
});

test("declared route binding public adapter contract rejects slot replacement and accepts restoration", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const name = seed.shape.contractName;
  localizeExport(files, seed.adapter, name, "const");
  files.set(seed.adapter, files.get(seed.adapter) + `\nconst substitute = null; export { substitute as ${name} };`);
  violation(inspect(seed, files), "A10", seed.adapter, "unresolved execution adapter binding: public export");
  success(inspect(seed));
});

test("declared route binding public adapter contract accepts a canonical local contract export", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const name = seed.shape.contractName;
  localizeExport(files, seed.adapter, name, "const");
  files.set(seed.adapter, files.get(seed.adapter) + `\nexport { ${name} };`);
  success(inspect(seed, files));
});

for (const [behavior, exportMode, accepted] of [
  ["rejects an unresolved public caller slot", "unresolved", false],
  ["accepts an explicit inline export over a foreign implementation", "inline", true],
  ["accepts an explicit local export over a foreign implementation", "local", true],
]) {
  test(`declared route binding wildcard ${behavior}`, () => {
    const seed = new StagedExecutionSeed();
    const [, file, name] = declaredRouteBindings(seed).find((binding) => binding[0] === "caller");
    const files = seed.files();
    if (exportMode !== "inline") localizeExport(files, file, name, "function");
    if (exportMode === "local") files.set(file, files.get(file) + `\nexport { ${name} };`);
    const source = files.get(file);
    files.set(file, source + "\nexport * from './replacement.js';");
    files.set("src/flow/lib/replacement.js", `export function ${name}() { return null; }`);
    const report = inspect(seed, files);
    if (accepted) success(report);
    else {
      const diagnostic = violation(report, "A10", file, "unresolved execution entry binding: wildcard export");
      assert.equal(diagnostic.line, source.split("\n").length + 1);
      assert.equal(diagnostic.column, 1);
    }
    success(inspect(seed));
  });
}

for (const [boundary, message] of [
  ["lookup", "unregistered execution lookup caller or capability escape"],
  ["adapter", "shared execution adapter imported outside production registration"],
]) {
  test(`reaudit indirect route rejects a wildcard ${boundary} capability escape and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    const files = seed.files();
    const file = "src/flow/lib/reaudit-barrel.js";
    const target = boundary === "lookup" ? seed.composition : seed.adapter;
    const specifier = boundary === "lookup" ? `../engine/composition/${seed.phase}.js` : "./command-execution.js";
    files.set(file, `export * from '${specifier}';`);
    const diagnostic = violation(inspect(seed, files), "A11", file, message);
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.column, 1);
    assert.equal(diagnostic.trace.includes(target), true);
    success(inspect(seed));
  });
}

for (const boundary of ["lookup", "adapter"]) {
  test(`reaudit indirect route rejects a multi-hop ${boundary} bypass that discards selection and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    const files = seed.files();
    const barrel = "src/flow/lib/reaudit-barrel.js";
    const forward = "src/flow/lib/reaudit-forward.js";
    const file = "src/flow/lib/reaudit-unlisted.js";
    const target = boundary === "lookup" ? seed.composition : seed.adapter;
    const specifier = boundary === "lookup" ? `../engine/composition/${seed.phase}.js` : "./command-execution.js";
    files.set(barrel, `export * from '${specifier}';`);
    files.set(forward, "export * from './reaudit-barrel.js';");
    const source = boundary === "lookup" ? [
      "import { commandRegistration } from './reaudit-forward.js';",
      "export function unlisted(input) {",
      "  const registration = commandRegistration(input.stepId);",
      "  const selection = registration.executionContract.select(input);",
      "  return registration.executionContract.execute(null, input);",
      "}",
    ].join("\n") : [
      "import { commandStepExecutionContract } from './reaudit-forward.js';",
      "export function unlisted(input) { return commandStepExecutionContract.execute(null, input); }",
    ].join("\n");
    files.set(file, source);
    const message = boundary === "lookup" ? "unregistered execution lookup caller or capability escape"
      : "shared execution adapter imported outside production registration";
    const diagnostic = violation(inspect(seed, files), "A11", file, message);
    assert.equal(diagnostic.line, boundary === "lookup" ? 3 : 1);
    assert.equal(diagnostic.column, boundary === "lookup" ? source.split("\n")[2].indexOf("commandRegistration") + 1 : 1);
    for (const hop of [file, forward, barrel, target]) assert.equal(diagnostic.trace.includes(hop), true);
    success(inspect(seed));
  });
}

test("reaudit indirect route accepts unrelated names, another phase, and lexical-only outside var", () => {
  const seed = new StagedExecutionSeed("watched-phase");
  const files = seed.files();
  files.set("src/flow/engine/composition/other-phase.js", "export function commandRegistration(stepId) { return stepId; }");
  files.set("src/flow/lib/other-phase.js", "export * from '../engine/composition/other-phase.js';");
  files.set("src/flow/lib/unrelated.js", "export const commandStepExecutionContract = null;");
  files.set("src/flow/lib/unrelated-barrel.js", "export * from './unrelated.js';");
  files.set("src/flow/lib/unlisted-other.js", `import { commandRegistration } from './other-phase.js';
    import { commandStepExecutionContract } from './unrelated-barrel.js';
    export function unrelated(input) { return [commandRegistration(input.stepId), commandStepExecutionContract]; }`);
  files.set("src/flow/lib/outside.js", "var outside = 1; export const untouched = outside;");
  success(inspect(seed, files));
});

test("reaudit indirect route accepts a semicolonless unrelated value export without parsing its body", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set("src/unrelated-values.js", "export const value = 1\n");
  files.set("src/unrelated-entry.js", "import { value } from './unrelated-values.js';\nexport function unrelated() { return value; }\n");
  success(inspect(seed, files));
});

test("reaudit indirect route accepts an explicit safe lookup export over a watched wildcard", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set("src/flow/lib/shadow-barrel.js", `export * from '../engine/composition/${seed.phase}.js';
    export function commandRegistration(stepId) { return stepId; }`);
  files.set("src/flow/lib/unlisted-safe.js", `import { commandRegistration } from './shadow-barrel.js';
    export function safe(input) { return commandRegistration(input.stepId); }`);
  success(inspect(seed, files));
});

test("reaudit indirect route accepts a pure same-binding diamond with a wildcard cycle", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set("src/flow/lib/safe.js", "export function commandRegistration(stepId) { return stepId; }");
  files.set("src/flow/lib/left.js", "export * from './safe.js'; export * from './right.js';");
  files.set("src/flow/lib/right.js", "export * from './safe.js'; export * from './left.js';");
  files.set("src/flow/lib/diamond.js", "export * from './left.js'; export * from './right.js';");
  files.set("src/flow/lib/unlisted-diamond.js", `import { commandRegistration } from './diamond.js';
    export function safe(input) { return commandRegistration(input.stepId); }`);
  success(inspect(seed, files));
});
