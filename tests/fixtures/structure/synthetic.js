/** Immutable source seed. Tests copy these files into their own temporary roots. */
export class SyntheticStructureSeed {
  constructor(phase, stepName, helperName = "value") {
    this.phase = phase;
    this.stepName = stepName;
    this.helperName = helperName;
  }

  files() {
    const entry = `src/flow/steps/${this.phase}`;
    return new Map([
      ["src/flow/engine/step.js", "export class Step {}\n"],
      ["src/flow/engine/step-result.js", "export class StepResult {}\n"],
      ["src/flow/engine/flow-execution-error.js", "export class FlowExecutionError extends Error {}\n"],
      ["src/flow/services/service.js", "export class ServiceClass {}\n"],
      [`${entry}/step.js`, [
        "import { Step } from '../../engine/step.js';",
        "import { ServiceClass } from '../../services/service.js';",
        `import { Value } from './${this.helperName}.js';`,
        `export class ${this.stepName} extends Step { static dependencies = [ServiceClass]; value() { return Value; } }`,
      ].join("\n") + "\n"],
      [`${entry}/${this.helperName}.js`, "export const Value = 1;\n"],
      [`src/flow/engine/composition/${this.phase}.js`, `import { ${this.stepName} } from '../../steps/${this.phase}/step.js';\nexport const registrations = [${this.stepName}];\n`],
    ]);
  }
}
