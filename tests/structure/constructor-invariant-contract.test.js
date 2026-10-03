import assert from "node:assert/strict";
import { test } from "node:test";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { StructureChecker } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

const serviceFile = "src/flow/services/service.js";
const typeCondition = "!(input instanceof Input) || !(writer instanceof Writer)";
const rejection = "throw new TypeError('typed inputs required');";

function inspect(seed, body, parameters = "input, writer", moduleSuffix = "") {
  const files = seed.files();
  files.set(serviceFile, `import { Input } from './input.js';
import { Writer } from './alpha-settlement-writer.js';
export class ServiceClass {
  static argumentTypes = [Input, Writer];
  constructor(${parameters}) { ${body} }
}
${moduleSuffix}`);
  return new StructureChecker(seed.scope(), new MemorySourceRepository(files)).check();
}

function success(report) {
  assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
}

function violation(report, message = "constructor must validate typed input and settlement writer") {
  assert.equal(report.ok, false);
  const diagnostics = report.diagnostics.filter((entry) => entry.rule === "A12"
    && entry.file === serviceFile && entry.message.includes(message));
  assert.equal(diagnostics.length > 0, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.file, serviceFile);
    assert.equal(diagnostic.message.includes(message), true, diagnostic.toString());
    assert.deepEqual([diagnostic.line, diagnostic.column], [3, 8]);
    assert.deepEqual(diagnostic.trace, [serviceFile]);
  }
}

for (const [name, condition] of [
  ["ternary masking the whole disjunction", `${typeCondition} || true ? false : false`],
  ["ternary masking one required operand", "!(input instanceof Input) || (true ? false : !(writer instanceof Writer))"],
  ["AND requiring both invalid operands", "!(input instanceof Input) && !(writer instanceof Writer)"],
  ["an AND branch disabling the writer rejection", "!(input instanceof Input) || !(writer instanceof Writer) && false"],
  ["an outer AND disabling both rejections", `(${typeCondition}) && false`],
  ["a comma discarding the type checks", `${typeCondition}, false`],
  ["equality changing the whole condition", `(${typeCondition}) === false`],
  ["an OR operand with an unresolved call", `${typeCondition} || acceptsAnything()`],
  ["a parameter assignment in the condition", `${typeCondition} || (writer = new Writer())`],
  ["a type binding assignment in the condition", `${typeCondition} || (Input = Writer)`],
  ["a member assignment before a required rejection", "!(input instanceof Input) || (input.ready = true) || !(writer instanceof Writer)"],
  ["a string resembling a type operand", "!('input' instanceof Input) || !(writer instanceof Writer)"],
  ["a literal negation operator", "'!'(input instanceof Input) || !(writer instanceof Writer)"],
]) {
  test(`A12 rejects ${name} and accepts restored constructor guards`, () => {
    const seed = new StagedExecutionSeed();
    violation(inspect(seed, `if (${condition}) ${rejection}`));
    success(inspect(seed, `if (${typeCondition}) ${rejection}`));
  });
}

for (const [name, body] of [
  ["conditional throw", `if (${typeCondition}) { if (input.reject) ${rejection} }`],
  ["throw inside an uncalled function", `if (${typeCondition}) { const reject = () => { ${rejection} }; }`],
  ["caught rejection", `try { if (${typeCondition}) ${rejection} } catch (error) {}`],
  ["guard inside an optional branch", `if (input.validate) { if (${typeCondition}) ${rejection} }`],
  ["early return", `if (input.fast) return; if (${typeCondition}) ${rejection}`],
  ["replaced input binding", `input = new Input(); if (${typeCondition}) ${rejection}`],
  ["compound binding replacement", `input ||= new Input(); if (${typeCondition}) ${rejection}`],
  ["destructured binding replacement", `[input, writer] = [new Input(), new Writer()]; if (${typeCondition}) ${rejection}`],
  ["shadowed type binding", `const Input = class {}; if (${typeCondition}) ${rejection}`],
  ["unresolved prefix invocation", `normalize(); if (${typeCondition}) ${rejection}`],
  ["binding replacement between separate guards", `if (!(input instanceof Input)) ${rejection} writer = new Writer(); if (!(writer instanceof Writer)) ${rejection}`],
  ["unknown condition between separate guards", `if (!(input instanceof Input)) ${rejection} if (input.fast) return; if (!(writer instanceof Writer)) ${rejection}`],
  ["unresolved throw expression", `if (${typeCondition}) throw rejectionFor(input);`],
  ["parameter replacement in the throw expression", `if (${typeCondition}) throw new TypeError(input = new Input());`],
  ["type binding replacement in the throw expression", `if (${typeCondition}) throw new TypeError(Input = Writer);`],
  ["a literal throw keyword followed by a new expression", `if (${typeCondition}) 'throw'\nnew TypeError();`],
  ["literal throw and new keywords separated by ASI", `if (${typeCondition}) 'throw'\n'new'\nTypeError();`],
  ["a literal semicolon prefix", `';'\nif (${typeCondition}) ${rejection}`],
]) {
  test(`A12 refuses to prove constructor invariants through ${name} and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    violation(inspect(seed, body));
    success(inspect(seed, `if (${typeCondition}) ${rejection}`));
  });
}

for (const [name, body] of [
  ["the existing unbraced OR guard", `if (${typeCondition}) ${rejection}`],
  ["the existing braced OR guard", `if (${typeCondition}) { ${rejection} } this.input = input;`],
  ["two separate unconditional guards", `if (!(input instanceof Input)) ${rejection} if (!(writer instanceof Writer)) { ${rejection} }`],
  ["parenthesized OR groups", `if (((!(input instanceof Input)) || (!(writer instanceof Writer)))) { ${rejection} }`],
  ["additional production member predicates", `if (!(input instanceof Input) || input.stepId !== 'worker' || !(input.facts instanceof Input) || !(writer instanceof Writer)) { ${rejection} }`],
  ["production equality predicate", `if (!(input instanceof Input) || input.stepId === 'review' || !(writer instanceof Writer)) { ${rejection} }`],
  ["a literal disjunct preserving rejection", `if (${typeCondition} || false) ${rejection}`],
  ["a return after both parameters have been rejected when invalid", `if (${typeCondition}) ${rejection} return;`],
  ["literal prose containing syntax", `if (${typeCondition}) throw new TypeError('return || ? false : throw');`],
  ["literal error arguments containing separators", `if (${typeCondition}) throw new TypeError(',', '(');`],
]) {
  test(`A12 proves original parameter rejection with ${name}`, () => {
    success(inspect(new StagedExecutionSeed(), body));
  });
}

test("A12 preserves renamed argument positions across rejection and restoration", () => {
  const seed = new StagedExecutionSeed();
  const body = `if (!(candidate instanceof Input) || !(settlement instanceof Writer)) ${rejection}`;
  success(inspect(seed, body, "candidate, settlement"));
  violation(inspect(seed, body, "settlement, candidate"), "argumentTypes differs from constructor Writer, Input");
  success(inspect(seed, body, "candidate, settlement"));
});

for (const [name, binding] of [
  ["a hoisted input function", "function Input() {}"],
  ["a hoisted writer function", "function Writer() {}"],
  ["an input class", "class Input {}"],
  ["a writer class", "class Writer {}"],
  ["an input let binding", "let Input;"],
  ["a writer const binding", "const Writer = class {};"],
  ["a destructured input binding", "const { Input } = {};"],
  ["a destructured writer binding", "const [Writer] = [];"],
]) {
  test(`A12 rejects constructor-local type shadowing from ${name} after the guard and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    violation(inspect(seed, `if (${typeCondition}) ${rejection} ${binding}`));
    success(inspect(seed, `if (${typeCondition}) ${rejection}`));
  });
}

test("A12 module-level named class expressions do not shadow imported guard types", () => {
  success(inspect(new StagedExecutionSeed(), `if (${typeCondition}) ${rejection}`, "input, writer",
    "const first = class Input {}; const second = class Writer {};"));
});

for (const [name, binding] of [
  ["block-local types", "{ function Input() {} class Writer {} }"],
  ["block-local lexical bindings", "{ let Input; const Writer = class {}; }"],
  ["function parameters", "function helper(Input, Writer) {}"],
  ["arrow parameters", "const helper = (Input, Writer) => Input;"],
  ["named function expressions", "const first = function Input() {}; const second = function Writer() {};"],
  ["named class expressions", "const first = class Input {}; const second = class Writer {};"],
]) {
  test(`A12 keeps outer guard type bindings when unrelated nested scopes declare ${name}`, () => {
    success(inspect(new StagedExecutionSeed(), `if (${typeCondition}) ${rejection} ${binding}`));
  });
}
