import assert from "node:assert/strict";
import { test } from "node:test";
import { Step } from "../../src/flow/engine/step.js";
import { SyntheticStructureSeed } from "../fixtures/structure/synthetic.js";
import { workerStepExecutionContract } from "../fixtures/structure/execution.js";
import { StructureChecker, StructureScope } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

class Input {}
class Writer {}
class ServiceClass { static argumentTypes = [Input, Writer]; }
class FixtureStep extends Step { static dependencies = [ServiceClass]; }
function prepareServiceArguments() { return []; }

class ServiceFixture {
  constructor(phase = "alpha") {
    this.phase = phase;
    this.files = new SyntheticStructureSeed(phase, "FixtureStep").files();
    this.files.set(`src/flow/engine/composition/${phase}.js`, [
      `import { FixtureStep } from '../../steps/${phase}/step.js';`,
      "import { ServiceClass } from '../../services/service.js';",
      "import { Input } from '../../services/input.js';",
      "import { Writer } from '../../services/alpha-settlement-writer.js';",
      "import { workerStepExecutionContract } from '../../lib/worker-execution-admission.js';",
      "function prepareServiceArguments() { return [new Input(), new Writer()]; }",
      "export const registrations = [new StepRegistration({ stepId: 'entry', StepClass: FixtureStep, ServiceClass, prepareServiceArguments, executionContract: workerStepExecutionContract })];",
    ].join("\n"));
    this.registration = { stepId: "entry", StepClass: FixtureStep, ServiceClass, prepareServiceArguments,
      executionContract: workerStepExecutionContract };
  }

  put(file, source) { this.files.set(file, source); return this; }

  service(body, prefix = "") {
    return this.put("src/flow/services/service.js", [
      prefix,
      "import { Input } from './input.js';",
      "import { Writer } from './alpha-settlement-writer.js';",
      `export class ServiceClass { static argumentTypes = [Input, Writer]; constructor(input, writer) { if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); } ${body} }`,
    ].join("\n"));
  }

  check() {
    const scope = new StructureScope(".", `src/flow/steps/${this.phase}`,
      Array.isArray(this.registration) ? this.registration : [this.registration]);
    return new StructureChecker(scope, new MemorySourceRepository(this.files)).check();
  }
}

function has(report, rule, file) {
  const diagnostic = report.diagnostics.find((entry) => entry.rule === rule && entry.file === file && entry.line > 0);
  assert.ok(diagnostic,
    report.diagnostics.map((entry) => entry.toString()).join("\n"));
  return diagnostic;
}

function serviceSuccess(report) {
  assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
}

function serviceClosureViolation(report, file) {
  const diagnostic = has(report, "A08", file);
  assert.equal(diagnostic.column > 0, true);
  assert.equal(diagnostic.trace.includes("src/flow/services/service.js"), true);
  assert.equal(diagnostic.trace.includes(file), true);
  return diagnostic;
}

test("registered Service and its imported input closure reject IO and broad dependencies", () => {
  for (const phase of ["alpha", "beta"]) {
    const sample = new ServiceFixture(phase);
    assert.equal(sample.check().ok, true);
    sample.service("read() { return fs.readFileSync('x'); }", "import fs from 'node:fs';");
    has(sample.check(), "A08", "src/flow/services/service.js");
    sample.service("value() { return new Input(1); }");
    sample.put("src/flow/services/input.js", "export class Input { constructor(manager) { this.#manager = manager; } #manager; }\n");
    has(sample.check(), "A08", "src/flow/services/input.js");
    sample.put("src/flow/services/input.js", "export class Input { #source; constructor(source) { this.#source = source; } }\n");
    has(sample.check(), "A08", "src/flow/services/input.js");
    sample.put("src/flow/services/input.js", "export class Input { constructor(value) { if (value !== undefined && typeof value !== 'number') throw new TypeError(); this.value = value; } }\n");
    assert.equal(sample.check().ok, true);
  }
});

test("Service helper and writer read routes fail, then pass after removal", () => {
  const sample = new ServiceFixture();
  sample.service("value() { return helper(); }", "import { helper } from '../lib/helper.js';");
  sample.put("src/flow/lib/helper.js", "import fs from 'node:fs'; export function helper() { return fs.readFileSync('x'); }\n");
  has(sample.check(), "A08", "src/flow/lib/helper.js");
  sample.put("src/flow/lib/helper.js", "export function helper() { return 1; }\n");
  assert.equal(sample.check().ok, true);
  sample.service("settle() { return this.writer; }");
  sample.put("src/flow/services/alpha-settlement-writer.js", "export class Writer { loadReadOnly() { return 1; } }\n");
  has(sample.check(), "A08", "src/flow/services/alpha-settlement-writer.js");
  sample.put("src/flow/services/alpha-settlement-writer.js", "import { obtain } from '../lib/obtain.js'; export class Writer { settle() { return obtain(); } }\n");
  sample.put("src/flow/lib/obtain.js", "import fs from 'node:fs'; export function obtain() { return fs.readFileSync('x'); }\n");
  has(sample.check(), "A08", "src/flow/lib/obtain.js");
  sample.put("src/flow/services/alpha-settlement-writer.js", "export class Writer { settle(value) { return value; } }\n");
  assert.equal(sample.check().ok, true);
});

test("Service instance helper methods cannot hide an IO read", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/lib/input-reader.js";
  sample.service("inspect() { const reader = new InputReader(); const alias = reader; return alias.obtain(); }",
    "import { InputReader } from '../lib/input-reader.js';");
  sample.put(file, "import fs from 'node:fs'; export class InputReader { constructor() {} obtain() { return fs.readFileSync('x'); } }\n");
  has(sample.check(), "A08", file);
  sample.service("#reader = new InputReader(); inspect() { return this.#reader.payload; }",
    "import { InputReader } from '../lib/input-reader.js';");
  sample.put(file, "import fs from 'node:fs'; export class InputReader { constructor() {} get payload() { return fs.readFileSync('x'); } }\n");
  has(sample.check(), "A08", file);
  sample.service("inspect() { const ReaderAlias = InputReader; return new ReaderAlias().obtain(); }",
    "import { InputReader } from '../lib/input-reader.js';");
  sample.put(file, "import fs from 'node:fs'; export class InputReader { constructor() {} obtain() { return fs.readFileSync('x'); } }\n");
  has(sample.check(), "A08", file);
  sample.service("inspect() { const reader = new InputReader(); const alias = reader; return alias.obtain(); }",
    "import { InputReader } from '../lib/input-reader.js';");
  sample.put(file, "export class InputReader { constructor() {} obtain() { return 1; } }\n");
  assert.equal(sample.check().ok, true);
});

test("settlement writer cannot hide manager reads behind a private field or alias", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/services/alpha-settlement-writer.js";
  sample.put(file, "export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { const alias = this.#flowManager; return alias.artifactCatalog('x'); } }\n");
  has(sample.check(), "A08", file);
  sample.put(file, "export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { return this.#flowManager.commitSpecStepResult({}); } }\n");
  assert.equal(sample.check().ok, true);
});

test("settlement writer passes manager origins through local and imported helpers", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/services/alpha-settlement-writer.js";
  const helper = "src/flow/lib/obtain.js";
  sample.put(file, "import { obtain } from '../lib/obtain.js'; export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { return obtain(this.#flowManager); } }\n");
  sample.put(helper, "export function obtain(source) { return source.artifactCatalog('x'); }\n");
  has(sample.check(), "A08", helper);
  sample.put(file, "function obtain(source) { return source.artifactCatalog('x'); } export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { return obtain(this.#flowManager); } }\n");
  has(sample.check(), "A08", file);
  sample.put(file, "import { obtain } from '../lib/obtain.js'; export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { return obtain(this.#flowManager); } }\n");
  sample.put(helper, "export function obtain(source) { return source.commitSpecStepResult({}); }\n");
  sample.put(file, "import { Reader } from '../lib/obtain.js'; export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { const reader = new Reader(this.#flowManager); return reader.obtain(); } }\n");
  sample.put(helper, "export class Reader { #source; constructor(source) { this.#source = source; } obtain() { return this.#source.artifactCatalog('x'); } }\n");
  has(sample.check(), "A08", helper);
  sample.put(helper, "export class Reader { #source; constructor(source) { this.#source = source; } obtain() { return this.#source.commitSpecStepResult({}); } }\n");
  assert.equal(sample.check().ok, true);
});

test("reverse index rejects direct registered Service construction through a reexport", () => {
  const sample = new ServiceFixture();
  assert.equal(sample.check().ok, true);
  sample.put("src/flow/lib/service-alias.js", "export { ServiceClass as RuntimeService } from '../services/service.js';\n");
  sample.put("src/flow/lib/entry.js", "import { RuntimeService as Alias } from './service-alias.js'; export function run() { return new Alias(); }\n");
  has(sample.check(), "A09", "src/flow/lib/entry.js");
  sample.put("src/flow/lib/entry.js", "import { RuntimeService } from './service-alias.js'; const Alias = RuntimeService; export function run() { return new Alias(); }\n");
  has(sample.check(), "A09", "src/flow/lib/entry.js");
  sample.put("src/flow/lib/entry.js", "import * as Services from './service-alias.js'; export function run() { return new Services.RuntimeService(); }\n");
  has(sample.check(), "A09", "src/flow/lib/entry.js");
  sample.put("src/flow/lib/entry.js", "export function run() { return 1; }\n");
  assert.equal(sample.check().ok, true);
});

test("typed input cannot hide a broad source or a conditional constructor", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/engine/composition/alpha.js";
  const clean = sample.files.get(file);
  sample.put(file, clean.replace("new Input()", "new Input({ source: ctx })"));
  has(sample.check(), "A12", file);
  sample.put(file, clean.replace("return [new Input(), new Writer()]", "const source = ctx; return [new Input({ source }), new Writer()]"));
  has(sample.check(), "A12", file);
  sample.put(file, clean.replace("new Input()", "bad || new Input()"));
  has(sample.check(), "A12", file);
  sample.put(file, clean);
  assert.equal(sample.check().ok, true);
});

test("typed input getter and static method cannot read global state", () => {
  const sample = new ServiceFixture();
  sample.put("src/flow/services/input.js", "export class Input { get value() { return process.env.X; } }\n");
  has(sample.check(), "A08", "src/flow/services/input.js");
  sample.put("src/flow/services/input.js", "export class Input { static inspect() { return globalThis.value; } }\n");
  has(sample.check(), "A08", "src/flow/services/input.js");
  sample.put("src/flow/services/input.js", "export class Input {}\n");
  assert.equal(sample.check().ok, true);
});

test("imported helper initialization cannot hide IO outside its selected export", () => {
  const sample = new ServiceFixture();
  sample.service("value() { return helper(); }", "import { helper } from '../lib/helper.js';");
  sample.put("src/flow/lib/helper.js", "import fs from 'node:fs'; const loaded = fs.readFileSync('x'); export function helper() { return 1; }\n");
  has(sample.check(), "A08", "src/flow/lib/helper.js");
  sample.put("src/flow/lib/helper.js", "import fs from 'node:fs'; fs.readFileSync('x'); export function helper() { return 1; }\n");
  has(sample.check(), "A08", "src/flow/lib/helper.js");
  sample.put("src/flow/lib/helper.js", "export function helper() { return 1; }\n");
  assert.equal(sample.check().ok, true);
});

test("execution entry cannot discard, overwrite, or replace a registered selection", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/lib/run-dispatch.js";
  const clean = sample.files.get(file);
  for (const invalid of [
    "export function run(registration, input) { registration.executionContract.select(input); return registration.executionContract.execute(input, input); }\n",
    clean.replace("execute(selection, input)", "execute(other, input)"),
    clean.replace("registration.executionContract.execute(selection, input)",
      "otherRegistration.executionContract.execute(selection, input)"),
    clean.replace("const selection =", "let selection =").replace("return registration", "selection = allowed; return registration"),
    "export function run(registration, input) { const selection = registration.executionContract.select(input); log(selection); return 1; }\n",
  ]) {
    sample.put(file, invalid);
    has(sample.check(), "A10", file);
  }
  sample.put(file, clean);
  assert.equal(sample.check().ok, true);
});

test("direct execution adapter bypass is found through the full source index", () => {
  const sample = new ServiceFixture();
  sample.put("src/flow/lib/entry.js", "export function run(command, selection) { return command.executeSelectedWorker(selection); }\n");
  has(sample.check(), "A11", "src/flow/lib/entry.js");
  sample.put("src/flow/lib/entry.js", "export function run(command, selection) { const invoke = command.executeSelectedWorker; return invoke(selection); }\n");
  has(sample.check(), "A11", "src/flow/lib/entry.js");
  sample.put("src/flow/lib/entry.js", "export function run(command, selection) { return command['executeSelectedWorker'](selection); }\n");
  has(sample.check(), "A11", "src/flow/lib/entry.js");
  sample.put("src/flow/lib/entry.js", "export function run() { return null; }\n");
  assert.equal(sample.check().ok, true);
});

test("registration must reference the named shared execution contract", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/engine/composition/alpha.js";
  const clean = sample.files.get(file);
  sample.put(file, clean.replace("executionContract: workerStepExecutionContract", "executionContract: localContract"));
  has(sample.check(), "A10", file);
  sample.put(file, clean);
  assert.equal(sample.check().ok, true);
});

test("shared adapter must consume the exact registered selection", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/lib/worker-execution-admission.js";
  const clean = sample.files.get(file);
  sample.put(file, clean.replace("executeSelectedWorker(selection, input)", "executeSelectedWorker(other, input)"));
  has(sample.check(), "A10", file);
  sample.put(file, clean.replace("execute: executeWorkerExecutionAdmission", "execute: unsafeExecute"));
  has(sample.check(), "A10", file);
  sample.put(file, clean);
  assert.equal(sample.check().ok, true);
});

test("two registered Services exported from one module are both inspected", () => {
  const sample = new ServiceFixture();
  class OtherService { static argumentTypes = [Input, Writer]; }
  class OtherStep extends Step { static dependencies = [OtherService]; }
  sample.registration = [sample.registration, { stepId: "other", StepClass: OtherStep,
    ServiceClass: OtherService, prepareServiceArguments, executionContract: workerStepExecutionContract }];
  sample.put("src/flow/services/service.js", [
    "import fs from 'node:fs'; import { Input } from './input.js'; import { Writer } from './alpha-settlement-writer.js';",
    "export class ServiceClass { static argumentTypes = [Input, Writer]; constructor(input, writer) { if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); } read() { return fs.readFileSync('x'); } }",
    "export class OtherService { static argumentTypes = [Input, Writer]; constructor(input, writer) { if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); } }",
  ].join("\n"));
  sample.put("src/flow/steps/alpha/other.js", "import { Step } from '../../engine/step.js'; import { OtherService } from '../../services/service.js'; export class OtherStep extends Step { static dependencies = [OtherService]; }\n");
  const composition = sample.files.get("src/flow/engine/composition/alpha.js");
  const file = "src/flow/engine/composition/alpha.js";
  sample.put(file, composition
    .replace("import { ServiceClass }", "import { ServiceClass, OtherService }")
    .replace("function prepareServiceArguments()", "import { OtherStep } from '../../steps/alpha/other.js';\nfunction prepareServiceArguments()")
    .replace("executionContract: workerStepExecutionContract })];",
      "executionContract: workerStepExecutionContract }), new StepRegistration({ stepId: 'other', StepClass: OtherStep, ServiceClass: OtherService, prepareServiceArguments, executionContract: workerStepExecutionContract })];"));
  sample.put("src/flow/definition.js", "const FLOW_DEFINITION = Object.freeze([new FlowNode({id:'entry'}), new FlowNode({id:'other'})]);\n");
  const routeFile = "src/flow/engine/composition/registered-step-execution.js";
  sample.put(routeFile, sample.files.get(routeFile)
    .replace("flowLeafIdsBetween('entry', 'entry')", "flowLeafIdsBetween('entry', 'other')"));
  has(sample.check(), "A08", "src/flow/services/service.js");
  sample.put("src/flow/services/service.js", sample.files.get("src/flow/services/service.js")
    .replace("return fs.readFileSync('x');", "return 1;"));
  assert.equal(sample.check().ok, true);
});

test("targeted execution route must cover its Definition endpoint and fail closed", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/engine/composition/registered-step-execution.js";
  const clean = sample.files.get(file);
  sample.put(file, clean);
  assert.equal(sample.check().ok, true);
  sample.put(file, clean.replace("flowLeafIdsBetween('entry', 'entry')", "flowLeafIdsBetween('other', 'other')"));
  has(sample.check(), "A11", file);
  sample.put(file, clean.replace("flowLeafIdsBetween('entry', 'entry')", "flowLeafIdsBetween('other', 'entry')"));
  has(sample.check(), "A11", file);
  sample.put(file, clean.replace("flowLeafIdsBetween('entry', 'entry')", "flowLeafIdsBetween('entry', 'other')"));
  has(sample.check(), "A11", file);
  sample.put(file, clean.replace("registeredPhaseSteps.has(stepId)", "false"));
  has(sample.check(), "A11", file);
  const extended = clean.replace("flowLeafIdsBetween('entry', 'entry')", "flowLeafIdsBetween('entry', 'end')");
  sample.put(file, extended);
  const compositionFile = "src/flow/engine/composition/alpha.js";
  const composition = sample.files.get(compositionFile);
  sample.put(compositionFile, composition.replace("executionContract: workerStepExecutionContract })];",
    "executionContract: workerStepExecutionContract }), new StepRegistration({ stepId: 'end', StepClass: EndStep, ServiceClass, prepareServiceArguments, executionContract: workerStepExecutionContract })];"));
  const definitionFile = "src/flow/definition.js";
  const definition = "const FLOW_DEFINITION = Object.freeze([new FlowNode({id:'entry'}), new FlowNode({id:'end'})]);\n";
  sample.put(definitionFile, definition);
  assert.equal(sample.check().ok, true);
  sample.put(definitionFile, definition.replace("new FlowNode({id:'end'})",
    "new FlowNode({id:'middle'}), new FlowNode({id:'end'})"));
  has(sample.check(), "A11", definitionFile);
  sample.put(definitionFile, definition);
  assert.equal(sample.check().ok, true);
  sample.put(compositionFile, composition);
  sample.put(file, clean);
  assert.equal(sample.check().ok, true);
});

test("Flow command registry must preserve one named display and execution route", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/registry.js";
  const clean = sample.files.get(file);
  sample.put(file, clean.replace("command: loadGateCommand", "command: loadReviewCommand"));
  has(sample.check(), "A11", file);
  sample.put(file, clean.replace("gate: { command: loadGateCommand },", ""));
  has(sample.check(), "A11", file);
  sample.put(file, clean.replace("command: loadGetNextActionCommand", "command: () => import('./lib/get-next-action.js')"));
  has(sample.check(), "A11", file);
  sample.put(file, clean);
  assert.equal(sample.check().ok, true);
});

test("settlement writer rejects computed manager access, including aliases and optional access", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/services/alpha-settlement-writer.js";
  const clean = "export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { return this.#flowManager.commitSpecStepResult({}); } }";
  for (const expression of [
    'this.#flowManager["artifactCatalog"]("x")',
    'this.#flowManager?.["artifactCatalog"]("x")',
    'this.#flowManager[operation]("x")',
    'alias["artifactCatalog"]("x")',
  ]) {
    sample.put(file, clean.replace('return this.#flowManager.commitSpecStepResult({});',
      `const alias = this.#flowManager; return ${expression};`));
    has(sample.check(), "A08", file);
    sample.put(file, clean);
    assert.equal(sample.check().ok, true);
  }
});

test("settlement manager members share one save-only contract across access forms", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/services/alpha-settlement-writer.js";
  const writer = (expression) => `export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { const alias = this.#flowManager; return ${expression}; } }`;
  for (const expression of [
    'this.#flowManager?.artifactCatalog("x")',
    'alias?.artifactCatalog?.("x")',
    '(this.#flowManager)?.artifactCatalog("x")',
    'this.#flowManager.commitSpecStepResult',
    'this.#flowManager.commitSpecStepResult.call(null, {})',
  ]) {
    sample.put(file, writer(expression));
    has(sample.check(), "A08", file);
    sample.put(file, writer('this.#flowManager.commitSpecStepResult({})'));
    assert.equal(sample.check().ok, true);
  }
  for (const expression of [
    'this.#flowManager?.commitSpecStepResult({})',
    'alias.commitSpecStepResult?.({})',
    '(this.#flowManager)?.commitSpecStepResult({})',
  ]) {
    sample.put(file, writer(expression));
    const report = sample.check();
    assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  }
});

for (const [route, body] of [
  ["destructured method", 'const { artifactCatalog } = this.#flowManager; artifactCatalog.call(this.#flowManager, "x");'],
  ["renamed destructuring", 'const { artifactCatalog: inspect } = this.#flowManager; inspect();'],
  ["return", 'return this.#flowManager;'],
  ["object capture", 'const box = { value: this.#flowManager }; return box;'],
  ["array capture", 'const box = [this.#flowManager]; return box;'],
  ["spread", 'return { ...this.#flowManager };'],
  ["assignment", 'let alias; alias = this.#flowManager; alias.artifactCatalog("x");'],
  ["public field", 'this.exposed = this.#flowManager;'],
  ["method argument", 'sink.accept(this.#flowManager);'],
  ["optional helper", 'obtain?.(this.#flowManager);'],
  ["save argument", 'this.#flowManager.commitSpecStepResult({ manager: this.#flowManager });'],
  ["wrapped helper argument", 'obtain({ value: this.#flowManager });'],
  ["parenthesized alias", 'const alias = (this.#flowManager); alias.artifactCatalog("x");'],
]) {
  test(`settlement manager rejects unclassified use: ${route}`, () => {
    const sample = new ServiceFixture();
    const file = "src/flow/services/alpha-settlement-writer.js";
    const clean = 'export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { return this.#flowManager.commitSpecStepResult({}); } }';
    sample.put(file, clean.replace('return this.#flowManager.commitSpecStepResult({});', body));
    has(sample.check(), "A08", file);
    sample.put(file, clean);
    assert.equal(sample.check().ok, true);
  });
}

test("manager delegation must inspect the callee even behind a Store filename", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/services/alpha-settlement-writer.js";
  const helper = "src/flow/lib/fixture-store.js";
  sample.put(file, "import { obtain } from '../lib/fixture-store.js'; export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { return obtain(this.#flowManager); } }");
  for (const body of [
    'return source;',
    'const { artifactCatalog } = source; return artifactCatalog();',
    'return { source };',
    'return source?.artifactCatalog("x");',
  ]) {
    sample.put(helper, `export function obtain(source) { ${body} }`);
    has(sample.check(), "A08", helper);
    sample.put(helper, 'export function obtain(source) { return source.commitSpecStepResult({}); }');
    const report = sample.check();
    assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  }
});

for (const [form, body, member] of [
  ["ordinary method", "const observer = new Observer(); return observer.value();", "value() { return 1; }"],
  ["optional method", "const observer = new Observer(); return observer?.value();", "value() { return 1; }"],
  ["optional getter", "const observer = new Observer(); return observer?.value;", "get value() { return 1; }"],
  ["optional static method", "return Observer?.value();", "static value() { return 1; }"],
  ["optional constructed method", "return new Observer()?.value();", "value() { return 1; }"],
  ["optional instance alias", "const observer = new Observer(); const alias = observer; return alias?.value();", "value() { return 1; }"],
]) {
  test(`reaudit Service member follows ${form} into IO and accepts a pure restoration`, () => {
    const sample = new ServiceFixture();
    const file = "src/flow/lib/observe.js";
    const pure = `export class Observer { constructor() {} ${member} }\n`;
    sample.service(`inspect() { ${body} }`, "import { Observer } from '../lib/observe.js';");
    sample.put(file, pure);
    serviceSuccess(sample.check());
    sample.put(file, "import fs from 'node:fs';\n" + pure.replace("return 1;", "return fs.existsSync('x');"));
    const diagnostic = serviceClosureViolation(sample.check(), file);
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.column, 1);
    sample.put(file, pure);
    serviceSuccess(sample.check());
  });
}

test("reaudit Service member refuses an unresolved optional computed member and accepts a named pure member", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/services/service.js";
  sample.put("src/flow/lib/observe.js", "export class Observer { constructor() {} value() { return 1; } }");
  const pureBody = "inspect(operation) { const observer = new Observer(); return observer?.value(); }";
  sample.service(pureBody, "import { Observer } from '../lib/observe.js';");
  serviceSuccess(sample.check());
  const clean = sample.files.get(file);
  const invalid = clean.replace("observer?.value()", "observer?.[operation]()");
  sample.put(file, invalid);
  const diagnostic = serviceClosureViolation(sample.check(), file);
  assert.equal(diagnostic.message.includes("unresolved"), true);
  assert.equal(diagnostic.line, invalid.split("\n").findIndex((line) => line.includes("[operation]")) + 1);
  assert.equal(diagnostic.column, invalid.split("\n")[diagnostic.line - 1].indexOf("[operation]") + 1);
  sample.put(file, clean);
  serviceSuccess(sample.check());
});

for (const [form, imported, pureTail, assignment, beforeTail] of [
  ["direct function", "observe", "", "observe = function observe() { return fs.existsSync('x'); };", false],
  ["alias captured after replacement", "alias", "export const alias = observe;", "observe = function observe() { return fs.existsSync('x'); };", true],
  ["live delegation after replacement", "delegated", "export function delegated() { return observe(); }", "observe = function observe() { return fs.existsSync('x'); };", false],
  ["replacement of the alias binding", "delegated", "let alias = observe; export function delegated() { return alias(); }", "alias = function replacement() { return fs.existsSync('x'); };", false],
]) {
  test(`reaudit Service binding rejects ${form} reaching a replaced IO function and accepts restoration`, () => {
    const sample = new ServiceFixture();
    const file = "src/flow/lib/observe.js";
    const original = "import fs from 'node:fs';\nexport function observe() { return 1; }\n";
    const pure = original + pureTail;
    const invalid = beforeTail ? original + assignment + "\n" + pureTail : pure + "\n" + assignment;
    sample.service(`inspect() { return ${imported}(); }`, `import { ${imported} } from '../lib/observe.js';`);
    sample.put(file, pure);
    serviceSuccess(sample.check());
    sample.put(file, invalid);
    const diagnostic = serviceClosureViolation(sample.check(), file);
    assert.equal(diagnostic.line, invalid.split("\n").indexOf(assignment) + 1);
    assert.equal(diagnostic.column, 1);
    sample.put(file, pure);
    serviceSuccess(sample.check());
  });
}

test("reaudit Service binding accepts pure helpers with unrelated reassignment and distinct local shadows", () => {
  const sample = new ServiceFixture();
  sample.service("inspect() { return observe(); }", "import { observe } from '../lib/observe.js';");
  sample.put("src/flow/lib/observe.js", `import fs from 'node:fs';
    export function observe() {
      function independent(observe) { observe = () => 1; return observe(); }
      return independent(() => 1);
    }
    function unrelated() { return 1; }
    unrelated = function unrelated() { return fs.existsSync('x'); };`);
  sample.put("src/flow/lib/unrelated.js", `export function observe() { return 1; }
    observe = () => 2;`);
  serviceSuccess(sample.check());
});

test("reaudit Service binding destructuring rejects a reached IO replacement and accepts restoration", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/lib/observe.js";
  const pure = "import fs from 'node:fs';\nexport function observe() { return 1; }\n";
  const assignment = "({ observe } = { observe: () => fs.existsSync('x') });";
  sample.service("inspect() { return observe(); }", "import { observe } from '../lib/observe.js';");
  sample.put(file, pure);
  serviceSuccess(sample.check());
  sample.put(file, pure + assignment);
  const diagnostic = serviceClosureViolation(sample.check(), file);
  assert.equal(diagnostic.message, "Service dependency binding observe may be replaced after its declaration");
  assert.equal(diagnostic.line, 3);
  assert.equal(diagnostic.column, assignment.indexOf("observe") + 1);
  sample.put(file, pure);
  serviceSuccess(sample.check());
});

test("reaudit Service reexport follows the public helper instead of a private same-name declaration", () => {
  const sample = new ServiceFixture();
  const barrel = "src/flow/lib/observe.js";
  const file = "src/flow/lib/actual.js";
  const pure = "export function actual() { return 1; }\n";
  sample.service("inspect() { return observe(); }", "import { observe } from '../lib/observe.js';");
  sample.put(barrel, "function observe() { return 1; }\nexport { actual as observe } from './actual.js';\n");
  sample.put(file, pure);
  serviceSuccess(sample.check());
  sample.put(file, "import fs from 'node:fs';\n" + pure.replace("return 1;", "return fs.existsSync('x');"));
  const diagnostic = serviceClosureViolation(sample.check(), file);
  assert.equal(diagnostic.line, 1);
  assert.equal(diagnostic.column, 1);
  assert.equal(diagnostic.trace.includes(barrel), true);
  sample.put(file, pure);
  serviceSuccess(sample.check());
});

test("reaudit Service member delegation refuses computed this access and restores named pure calls", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/lib/observe.js";
  const pure = "export class Observer { constructor() {} value() { return this?.inner(); } inner() { return 1; } }\n";
  sample.service("inspect() { return new Observer().value(); }", "import { Observer } from '../lib/observe.js';");
  sample.put(file, pure);
  serviceSuccess(sample.check());
  const invalid = "import fs from 'node:fs';\n" + pure
    .replace("this?.inner()", "this?.['inner']()")
    .replace("return 1;", "return fs.existsSync('x');");
  sample.put(file, invalid);
  const diagnostic = serviceClosureViolation(sample.check(), file);
  assert.equal(diagnostic.message.includes("unresolved"), true);
  assert.equal(diagnostic.line, 2);
  assert.equal(diagnostic.column, invalid.split("\n")[1].indexOf("['inner']") + 1);
  sample.put(file, pure);
  serviceSuccess(sample.check());
  sample.put(file, pure.replace("this?.inner()", "this.inner()"));
  serviceSuccess(sample.check());
});

test("reaudit Service inherited members follow parent IO and preserve own override priority", () => {
  for (const [body, member] of [
    ["return new Observer()?.value();", "value() { return 1; }"],
    ["return new Observer().value();", "value() { return 1; }"],
    ["return new Observer()?.value;", "get value() { return 1; }"],
  ]) {
    const sample = new ServiceFixture();
    const file = "src/flow/lib/observe.js";
    const pure = `import fs from 'node:fs';\nclass Parent { constructor() {} ${member} }\nexport class Observer extends Parent {}\n`;
    sample.service(`inspect() { ${body} }`, "import { Observer } from '../lib/observe.js';");
    sample.put(file, pure);
    serviceSuccess(sample.check());
    const invalid = pure.replace("return 1;", "return fs.existsSync('x');");
    sample.put(file, invalid);
    const diagnostic = serviceClosureViolation(sample.check(), file);
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.column, 1);
    sample.put(file, pure);
    serviceSuccess(sample.check());
    sample.put(file, invalid.replace("extends Parent {}", `extends Parent { ${member} }`));
    serviceSuccess(sample.check());
  }
});

test("reaudit Service inherited constructor follows implicit parent initialization and accepts pure restoration", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/lib/observe.js";
  const pure = "import fs from 'node:fs';\nclass Parent { constructor() {} }\nexport class Observer extends Parent {}\n";
  sample.service("inspect() { return new Observer(); }", "import { Observer } from '../lib/observe.js';");
  sample.put(file, pure);
  serviceSuccess(sample.check());
  sample.put(file, pure.replace("constructor() {}", "constructor() { fs.existsSync('x'); }"));
  const diagnostic = serviceClosureViolation(sample.check(), file);
  assert.equal(diagnostic.line, 1);
  assert.equal(diagnostic.column, 1);
  sample.put(file, pure);
  serviceSuccess(sample.check());
});

test("reaudit Service ancestor binding rejects replacement reached through an inherited member", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/lib/observe.js";
  const parent = "import fs from 'node:fs';\nclass Parent { value() { return 1; } }\n";
  const child = "export class Observer extends Parent {}\n";
  const replacement = "Parent = class Replacement { value() { return fs.existsSync('x'); } };\n";
  const pure = parent + child;
  sample.service("inspect() { return new Observer()?.value(); }", "import { Observer } from '../lib/observe.js';");
  sample.put(file, pure);
  serviceSuccess(sample.check());
  sample.put(file, parent + replacement + child);
  const diagnostic = serviceClosureViolation(sample.check(), file);
  assert.equal(diagnostic.message, "Service dependency binding Parent may be replaced after its declaration");
  assert.equal(diagnostic.line, 3);
  assert.equal(diagnostic.column, 1);
  sample.put(file, pure);
  serviceSuccess(sample.check());
});

test("reaudit Service initialization inspects instance fields while leaving uncalled methods outside the closure", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/lib/observe.js";
  const pure = "import fs from 'node:fs';\nexport class Observer { #value = 1; value() { return this.#value; } unused() { return fs.existsSync('unused'); } }\n";
  sample.service("inspect() { return new Observer()?.value(); }", "import { Observer } from '../lib/observe.js';");
  sample.put(file, pure);
  serviceSuccess(sample.check());
  sample.put(file, pure.replace("#value = 1;", "#value = fs.existsSync('field');"));
  const diagnostic = serviceClosureViolation(sample.check(), file);
  assert.equal(diagnostic.line, 1);
  assert.equal(diagnostic.column, 1);
  sample.put(file, pure);
  serviceSuccess(sample.check());
});

test("reaudit Service initialization follows explicit super calls while leaving uncalled parent methods outside the closure", () => {
  const sample = new ServiceFixture();
  const file = "src/flow/lib/observe.js";
  const pure = "import fs from 'node:fs';\nclass Parent { constructor() {} unused() { return fs.existsSync('unused'); } }\nexport class Observer extends Parent { constructor() { super(); } value() { return 1; } }\n";
  sample.service("inspect() { return new Observer()?.value(); }", "import { Observer } from '../lib/observe.js';");
  sample.put(file, pure);
  serviceSuccess(sample.check());
  sample.put(file, pure.replace("constructor() {}", "constructor() { fs.existsSync('parent'); }"));
  const diagnostic = serviceClosureViolation(sample.check(), file);
  assert.equal(diagnostic.line, 1);
  assert.equal(diagnostic.column, 1);
  sample.put(file, pure);
  serviceSuccess(sample.check());
});

test("reaudit Service initialization inspects class evaluation fragments while preserving uncalled methods", () => {
  for (const [initializer, invalidInitializer] of [
    ["static marker = 1;", "static marker = fs.existsSync('static');"],
    ["static { void 1; }", "static { fs.existsSync('block'); }"],
    ["[1] = 1;", "[fs.existsSync('key')] = 1;"],
  ]) {
    const sample = new ServiceFixture();
    const file = "src/flow/lib/observe.js";
    const pure = `import fs from 'node:fs';\nexport class Observer { ${initializer} value() { return 1; } unused() { return fs.existsSync('unused'); } }\n`;
    sample.service("inspect() { return new Observer()?.value(); }", "import { Observer } from '../lib/observe.js';");
    sample.put(file, pure);
    serviceSuccess(sample.check());
    sample.put(file, pure.replace(initializer, invalidInitializer));
    const diagnostic = serviceClosureViolation(sample.check(), file);
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.column, 1);
    sample.put(file, pure);
    serviceSuccess(sample.check());
  }
});

test("reaudit Service initialization keeps function field bodies deferred until the field is called", () => {
  for (const initializer of [
    "() => fs.existsSync('arrow')",
    "function observe() { return fs.existsSync('function'); }",
  ]) {
    const sample = new ServiceFixture();
    const file = "src/flow/lib/observe.js";
    sample.put(file, `import fs from 'node:fs';\nexport class Observer { observe = ${initializer}; }\n`);
    sample.service("inspect() { return new Observer(); }", "import { Observer } from '../lib/observe.js';");
    serviceSuccess(sample.check());
    const serviceFile = "src/flow/services/service.js";
    const pure = sample.files.get(serviceFile);
    sample.put(serviceFile, pure.replace("new Observer()", "new Observer().observe()"));
    const diagnostic = serviceClosureViolation(sample.check(), file);
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.column, 1);
    sample.put(serviceFile, pure);
    serviceSuccess(sample.check());
  }
});

test("reaudit Service member kind rejects static IO after inspecting an instance member in either declaration order", () => {
  for (const staticFirst of [false, true]) {
    const sample = new ServiceFixture();
    const file = "src/flow/lib/observe.js";
    const instance = "\n  value() { return 1; }";
    const member = "\n  static value() { return 1; }";
    const pure = `import fs from 'node:fs';\nexport class Observer {${staticFirst ? member + instance : instance + member}\n}\n`;
    sample.service("inspect() { return [new Observer().value(), Observer.value()]; }", "import { Observer } from '../lib/observe.js';");
    sample.put(file, pure);
    serviceSuccess(sample.check());
    sample.put(file, pure.replace(member, "\n  static value() { return fs.existsSync('static'); }"));
    const diagnostic = serviceClosureViolation(sample.check(), file);
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.column, 1);
    sample.put(file, pure);
    serviceSuccess(sample.check());
    sample.service("inspect() { return Observer.value(); }", "import { Observer } from '../lib/observe.js';");
    sample.put(file, pure.replace(instance, "\n  value() { return fs.existsSync('instance'); }"));
    serviceSuccess(sample.check());
  }
});

test("reaudit Service member kind keeps uncalled static IO outside an instance call in either declaration order", () => {
  for (const staticFirst of [true, false]) {
    const sample = new ServiceFixture();
    const file = "src/flow/lib/observe.js";
    const instance = "value() { return 1; }";
    const member = "static value() { return fs.existsSync('static'); }";
    const pure = `import fs from 'node:fs';\nexport class Observer { ${staticFirst ? `${member} ${instance}` : `${instance} ${member}`} }\n`;
    sample.service("inspect() { return new Observer().value(); }", "import { Observer } from '../lib/observe.js';");
    sample.put(file, pure);
    serviceSuccess(sample.check());
    sample.put(file, pure.replace(instance, "value() { return fs.existsSync('instance'); }"));
    const diagnostic = serviceClosureViolation(sample.check(), file);
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.column, 1);
    sample.put(file, pure);
    serviceSuccess(sample.check());
  }
});

test("reaudit Service member kind preserves receiver kind through inherited super and this delegation", () => {
  for (const isStatic of [true, false]) {
    const sample = new ServiceFixture();
    const file = "src/flow/lib/observe.js";
    const instance = "inner() { return 1; }";
    const member = "static inner() { return 1; }";
    const pure = `import fs from 'node:fs';\nclass Parent { ${instance} ${member} value() { return this.inner(); } static value() { return this.inner(); } }\nexport class Observer extends Parent { entry() { return super.value(); } static entry() { return super.value(); } }\n`;
    sample.service(`inspect() { return ${isStatic ? "Observer" : "new Observer()"}.entry(); }`, "import { Observer } from '../lib/observe.js';");
    sample.put(file, pure);
    serviceSuccess(sample.check());
    const selected = isStatic ? member : instance;
    const invalid = pure.replace(selected, `${isStatic ? "static " : ""}inner() { return fs.existsSync('selected'); }`);
    sample.put(file, invalid);
    const diagnostic = serviceClosureViolation(sample.check(), file);
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.column, 1);
    sample.put(file, pure);
    serviceSuccess(sample.check());
    sample.put(file, pure.replace(isStatic ? instance : member,
      `${isStatic ? "" : "static "}inner() { return fs.existsSync('uncalled'); }`));
    serviceSuccess(sample.check());
  }
});
