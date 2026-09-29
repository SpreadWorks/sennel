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
  assert.ok(report.diagnostics.some((entry) => entry.rule === rule && entry.file === file && entry.line > 0),
    report.diagnostics.map((entry) => entry.toString()).join("\n"));
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
