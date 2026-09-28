import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Step } from "../../src/flow/engine/step.js";
import { StepRegistration } from "../../src/flow/engine/composition/step-registration.js";
import { SyntheticStructureSeed } from "../fixtures/structure/synthetic.js";
import { checkStructure } from "../support/structure/checker.js";

class ServiceClass {}
class AlphaStep extends Step { static dependencies = [ServiceClass]; }
class BetaStep extends Step { static dependencies = [ServiceClass]; }

class StructureFixture {
  constructor(t, phase = "alpha", StepClass = AlphaStep) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-structure-"));
    this.entry = `src/flow/steps/${phase}`;
    this.registration = new StepRegistration({ stepId: "entry", StepClass, prepareDependencies: () => new Map([[ServiceClass, new ServiceClass()]]) });
    t.after(() => fs.rmSync(this.root, { recursive: true, force: true }));
    const seed = new SyntheticStructureSeed(phase, StepClass.name, phase === "beta" ? "token" : "value");
    for (const [file, content] of seed.files()) this.write(file, content);
  }
  write(file, content) {
    const absolute = path.join(this.root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  check(registrations = [this.registration]) {
    return checkStructure({ root: this.root, entry: this.entry, registrations });
  }
}

function fixture(t, phase, StepClass) { return new StructureFixture(t, phase, StepClass); }

function has(report, rule, fragment) {
  assert.ok(report.diagnostics.some((entry) => entry.rule === rule && entry.toString().includes(fragment)),
    report.diagnostics.map((entry) => entry.toString()).join("\n"));
}

test("Step may use a value and its declared Service in either phase", (t) => {
  assert.equal(fixture(t).check().ok, true);
  assert.equal(fixture(t, "beta", BetaStep).check().ok, true);
});

test("Step may import facts separately from its declared Service module", (t) => {
  const sample = fixture(t);
  sample.write("src/flow/services/service.js", "export class ServiceClass {} export class Facts {}\n");
  sample.write("src/flow/steps/alpha/step.js", [
    "import { Step } from '../../engine/step.js';",
    "import { ServiceClass } from '../../services/service.js';",
    "import { Facts } from '../../services/service.js';",
    "import { Value } from './value.js';",
    "export class AlphaStep extends Step { static dependencies = [ServiceClass]; value() { return new Facts(Value); } }",
  ].join("\n"));
  assert.equal(sample.check().ok, true);
});

test("Step rejects Store and undeclared Service dependencies", (t) => {
  const sample = fixture(t);
  sample.write("src/flow/steps/alpha/step.js", "import { Step } from '../../engine/step.js'; import { Store } from '../../lib/issue-log-store.js'; export class AlphaStep extends Step { static dependencies = [ServiceClass]; }\n");
  sample.write("src/flow/lib/issue-log-store.js", "export class Store {}\n");
  has(sample.check(), "A02", "issue-log-store.js");
  sample.write("src/flow/steps/alpha/step.js", "import { Step } from '../../engine/step.js'; import { ServiceClass } from '../../services/service.js'; import { OtherService } from '../../services/other.js'; export class AlphaStep extends Step { static dependencies = [ServiceClass]; }\n");
  sample.write("src/flow/services/other.js", "export class OtherService {}\n");
  has(sample.check(), "A02", "other.js");
});

test("helper cannot reach a Service through a named import or reexport", (t) => {
  const sample = fixture(t);
  sample.write("src/flow/steps/alpha/value.js", "import { ServiceClass } from '../../services/service.js'; export const Value = ServiceClass;\n");
  has(sample.check(), "A04", "service.js");
  sample.write("src/flow/steps/alpha/value.js", "export { ServiceClass as Value } from '../../services/service.js';\n");
  has(sample.check(), "A04", "service.js");
});

test("module role rejects value-only imports from Service and Step modules", (t) => {
  const sample = fixture(t);
  sample.write("src/flow/services/service.js", "export class ServiceClass {} export const Fact = 1;\n");
  sample.write("src/flow/steps/alpha/value.js", "import { Fact } from '../../services/service.js'; export const Value = Fact;\n");
  has(sample.check(), "A04", "service.js");
  sample.write("src/flow/steps/alpha/step.js", fs.readFileSync(path.join(sample.root, "src/flow/steps/alpha/step.js"), "utf8") + "export const HelperValue = 1;\n");
  sample.write("src/flow/steps/alpha/value.js", "import { HelperValue } from './step.js'; export const Value = HelperValue;\n");
  has(sample.check(), "A03", "helper depends on step");
});

test("a value imported from a module containing IO is rejected until split", (t) => {
  const sample = fixture(t);
  sample.write("src/flow/steps/alpha/value.js", "import fs from 'node:fs'; export const Value = fs.existsSync;\n");
  has(sample.check(), "A03", "disallowed builtin fs");
  sample.write("src/flow/steps/alpha/value.js", "export const Value = 1;\n");
  assert.equal(sample.check().ok, true);
});

test("dynamic loading and direct globals fail in restricted closure", (t) => {
  const sample = fixture(t);
  sample.write("src/flow/steps/alpha/value.js", "export const Value = import('./late.js');\n");
  has(sample.check(), "A05", "dynamic import");
  sample.write("src/flow/steps/alpha/value.js", "export const Value = process;\n");
  has(sample.check(), "A05", "process");
  sample.write("src/flow/steps/alpha/value.js", "export const Value = globalThis['eval']('x');\n");
  has(sample.check(), "A05", "globalThis");
});

test("reverse index rejects external Step references and unreadable source", (t) => {
  const sample = fixture(t);
  sample.write("src/other.js", "export { AlphaStep } from './flow/steps/alpha/step.js';\n");
  has(sample.check(), "A06", "src/other.js");
  sample.write("src/other.js", "const bad = 'unterminated\n");
  has(sample.check(), "A06", "src/other.js:2:1");
});

test("entry, registration, and placement must agree", (t) => {
  const sample = fixture(t);
  has(sample.check([]), "A01", "no production registrations");
  sample.write("src/flow/steps/alpha/extra.js", "import { Step } from '../../engine/step.js'; export class ExtraStep extends Step {}\n");
  has(sample.check(), "A01", "extra.js");
  sample.write("src/other.js", "import { ExtraStep } from './flow/steps/alpha/extra.js';\n");
  has(sample.check(), "A06", "src/other.js");
  sample.write("src/other.js", "export const unrelated = 1;\n");
  sample.write("src/flow/steps/alpha/extra.js", "export const extra = 1;\n");
  const moved = fs.readFileSync(path.join(sample.root, "src/flow/steps/alpha/step.js"), "utf8");
  sample.write("src/lib/moved.js", moved.replace("../../engine/step.js", "../flow/engine/step.js").replace("../../services/service.js", "../flow/services/service.js").replace("./value.js", "../flow/steps/alpha/value.js"));
  fs.rmSync(path.join(sample.root, "src/flow/steps/alpha/step.js"));
  sample.write("src/flow/engine/composition/alpha.js", "import { AlphaStep } from '../../../lib/moved.js';\n");
  has(sample.check(), "A01", "outside scope entry");
  sample.write("src/flow/services/moved.js", moved.replace("../../engine/step.js", "../engine/step.js").replace("../../services/service.js", "./service.js").replace("./value.js", "../steps/alpha/value.js"));
  sample.write("src/flow/engine/composition/alpha.js", "import { AlphaStep } from '../../services/moved.js';\n");
  has(sample.check(), "A01", "outside scope entry");
});

test("renamed second phase receives the same helper and scope rules", (t) => {
  const sample = fixture(t, "beta", BetaStep);
  sample.write("src/flow/steps/beta/token.js", "import { ServiceClass } from '../../services/service.js'; export const Value = ServiceClass;\n");
  has(sample.check(), "A04", "service.js");
});

test("other phase violation is outside scope; used shared helper is inside", (t) => {
  const sample = fixture(t);
  sample.write("src/flow/steps/beta/value.js", "import fs from 'node:fs'; export const Value = fs.existsSync;\n");
  assert.equal(sample.check().ok, true);
  sample.write("src/flow/steps/alpha/value.js", "export { Value } from '../../lib/shared.js';\n");
  sample.write("src/flow/lib/shared.js", "import fs from 'node:fs'; export const Value = fs.existsSync;\n");
  has(sample.check(), "A03", "src/flow/lib/shared.js");
});

test("unrelated composition parse failures and same-name Step do not alter selected scope", (t) => {
  const sample = fixture(t);
  sample.write("src/flow/engine/composition/beta.js", "import './missing.js'; class Other { static dependencies = create(); }\n");
  assert.equal(sample.check().ok, true);
  sample.write("src/flow/steps/beta/step.js", "import { Step } from '../../engine/step.js'; export class AlphaStep extends Step {}\n");
  sample.write("src/flow/engine/composition/beta.js", "import { AlphaStep } from '../../steps/beta/step.js';\n");
  assert.equal(sample.check().ok, true);
});

test("empty scope, unknown module, and unresolved paths fail closed", (t) => {
  const sample = fixture(t);
  sample.entry = "src/flow/steps/empty";
  has(sample.check(), "A01", "no JavaScript entry files");
  sample.entry = "src/flow/steps/alpha";
  sample.write("src/flow/steps/alpha/value.js", "export { Value } from '../../../unknown.js';\n");
  has(sample.check(), "A03", "missing dependency");
  sample.write("src/unknown.js", "export const Value = 1;\n");
  has(sample.check(), "A03", "unknown");
  sample.write("src/flow/steps/alpha/value.js", "export { Value } from '../../../../../../outside.js';\n");
  has(sample.check(), "A03", "escapes repository");
});

test("duplicate registration and invalid Service class fail class contracts", (t) => {
  const sample = fixture(t);
  has(sample.check([sample.registration, sample.registration]), "A01", "duplicate registration");
  sample.write("src/flow/services/service.js", "export const ServiceClass = 1;\n");
  has(sample.check(), "A02", "not an exported non-Step Service class");
});

test("anonymous and qualified Step heritage cannot evade entry classification", (t) => {
  const sample = fixture(t);
  sample.write("src/flow/steps/alpha/hidden.js", "import { Step } from '../../engine/step.js'; export default class extends Step {}\n");
  has(sample.check(), "A01", "hidden.js");
  sample.write("src/flow/steps/alpha/hidden.js", "import * as engine from '../../engine/step.js'; export class Hidden extends engine.Step {}\n");
  has(sample.check(), "A03", "unsupported class heritage");
  sample.write("src/flow/steps/alpha/hidden.js", "import { Step } from '../../engine/step.js'; export class Hidden extends (Step) {}\n");
  has(sample.check(), "A03", "unsupported class heritage");
  sample.write("src/flow/steps/alpha/hidden.js", "import { Step } from '../../engine/step.js'; export class Hidden extends mixin(Step) {}\n");
  has(sample.check(), "A03", "unsupported class heritage");
});

test("literal dynamic import options still enter the Step reverse index", (t) => {
  const sample = fixture(t);
  sample.write("src/other.js", "await import('./flow/steps/alpha/step.js', { with: { type: 'javascript' } });\n");
  has(sample.check(), "A06", "src/other.js");
});

test("isolated copy of real Draft detects an injected Step", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-structure-real-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  fs.cpSync(path.join(sourceRoot, "src"), path.join(root, "src"), { recursive: true });
  const { draftStepRegistrations } = await import("../../src/flow/engine/composition/draft.js");
  const scope = { root, entry: "src/flow/steps/draft", registrations: draftStepRegistrations };
  const clean = checkStructure(scope);
  assert.equal(clean.ok, true, clean.diagnostics.map((entry) => entry.toString()).join("\n"));
  const injected = path.join(root, "src/flow/steps/draft/injected.js");
  fs.writeFileSync(injected, "import { Step } from '../../engine/step.js'; export class InjectedStep extends Step {}\n");
  const report = checkStructure(scope);
  has(report, "A01", "injected.js");
});
