import { Step } from "../../../src/flow/engine/step.js";
import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { StepExecutionContract } from "../../../src/flow/engine/composition/step-execution-contract.js";
import { SyntheticStructureSeed } from "./synthetic.js";
import { DefinitionLeafScope, ExecutionCaller, ExecutionLoader, NamedExecutionShape, StructureLeaf, StructureScopeContract } from "../../support/structure/production-registrations.js";
import { StructureScope } from "../../support/structure/checker.js";

class Input {}
class Writer {}
class ServiceClass {
  static argumentTypes = [Input, Writer];
  get settledOutcome() { return null; }
}
function prepareServiceArguments() { return [new Input(), new Writer()]; }
function selectCommand(input) { return input; }
function projectCommand(selection) { return selection; }
function executeCommand(selection) { return selection; }

/** Renamed phase fixture uses the real registration and execution value classes. */
export class StagedExecutionSeed {
  constructor(phase = "omega", ids = ["first", "second"], leaves = null, form = "command") {
    this.phase = phase;
    this.ids = Object.freeze([...ids]);
    this.entry = `src/flow/steps/${phase}`;
    this.composition = `src/flow/engine/composition/${phase}.js`;
    this.adapter = "src/flow/lib/command-execution.js";
    const executionContract = new StepExecutionContract({ select: selectCommand, project: projectCommand, execute: executeCommand });
    this.registrations = ids.map((stepId, index) => {
      const StepClass = class extends Step { static dependencies = [ServiceClass]; };
      Object.defineProperty(StepClass, "name", { value: `Entry${index}Step` });
      return new StepRegistration({ stepId, StepClass, ServiceClass, prepareServiceArguments, executionContract });
    });
    this.callers = Object.freeze([
      new ExecutionCaller("src/flow/lib/command-display.js", "display", "commandRegistration", "project"),
      new ExecutionCaller("src/flow/lib/command-run.js", "run", "commandRegistration", "execute", "replayReceipt"),
      new ExecutionCaller("src/flow/lib/command-direct.js", "direct", "commandRegistration", "execute"),
      new ExecutionCaller("src/flow/lib/command-post.js", "post", "commandRegistration", "execute", null, "consume"),
      new ExecutionCaller("src/flow/lib/command-recovery.js", "recover", "commandRegistration", "execute", null, "consume"),
    ]);
    this.shape = new NamedExecutionShape(form, this.adapter, "commandStepExecutionContract",
      "selectCommand", "projectCommand", "executeCommand", this.callers,
      [new ExecutionLoader("src/flow/command-registry.js", "loadCommand", "src/flow/lib/command-direct.js")]);
    this.definition = new DefinitionLeafScope("src/flow/definition.js", leaves?.[0]?.scope === "task" ? "TASK_DEFINITION" : "FLOW_DEFINITION",
      leaves ?? ids.map((id) => new StructureLeaf(id, "flow", id, form)));
  }

  scope(registrations = this.registrations, registry = this.registrations) {
    return new StructureScope("/virtual", this.entry, registrations, this.composition,
      new StructureScopeContract(this.definition, [this.shape], registry));
  }

  files() {
    const files = new SyntheticStructureSeed(this.phase, "Entry0Step", "value", this.ids[0]).files();
    const imports = [];
    const registrations = [];
    this.ids.forEach((id, index) => {
      const name = `Entry${index}Step`;
      files.set(`${this.entry}/step${index}.js`, `import { Step } from '../../engine/step.js';
        import { ServiceClass } from '../../services/service.js';
        export class ${name} extends Step { static dependencies = [ServiceClass]; }`);
      imports.push(`import { ${name} } from '../../steps/${this.phase}/step${index}.js';`);
      registrations.push(`new StepRegistration({ stepId: '${id}', StepClass: ${name}, ServiceClass,
        prepareServiceArguments, executionContract: commandStepExecutionContract })`);
    });
    files.delete(`${this.entry}/step.js`);
    files.set(this.composition, `${imports.join("\n")}
      import { ServiceClass } from '../../services/service.js';
      import { Input } from '../../services/input.js';
      import { Writer } from '../../services/alpha-settlement-writer.js';
      import { commandStepExecutionContract } from '../../lib/command-execution.js';
      function prepareServiceArguments() { return [new Input(), new Writer()]; }
      export const registrations = [${registrations.join(",")}];
      const byId = new Map(registrations.map((registration) => [registration.stepId, registration]));
      export function commandRegistration(stepId) { return byId.get(stepId) ?? null; }`);
    files.set(this.adapter, `export function selectCommand(input) { return input; }
      export function projectCommand(selection, input) { return selection; }
      export function executeCommand(selection, input) { return selection; }
      export const commandStepExecutionContract = new StepExecutionContract({
        select: selectCommand, project: projectCommand, execute: executeCommand });`);
    files.set(this.definition.module, `const ${this.definition.declarationName} = Object.freeze([
      ${this.ids.map((id) => `new FlowNode({ id: '${id}' })`).join(",")}]);`);
    for (const caller of this.callers) files.set(caller.module,
      `import { commandRegistration } from '../engine/composition/${this.phase}.js';
       ${caller.receiptReplayName === null ? "" : "function replayReceipt(receipt) { return receipt; }"}
       export function ${caller.declarationName}(input) { ${caller.body().replaceAll("$STRING_LITERAL", "'registration required'")} }`);
    files.set("src/flow/command-registry.js", "export function loadCommand() { return import('./lib/command-direct.js'); }");
    // This seed uses its named command routes; unrelated legacy execution consumers are absent.
    files.delete("src/flow/lib/get-next-action.js");
    files.delete("src/flow/lib/run-dispatch.js");
    return files;
  }
}
