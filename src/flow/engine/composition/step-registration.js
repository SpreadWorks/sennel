import { StepFactory } from "../step-factory.js";
import { Step } from "../step.js";

export class PreparedStep {
  constructor(step, dependencies) {
    if (!(step instanceof Step) || !(dependencies instanceof Map)) {
      throw new TypeError("PreparedStep requires a Step and its dependencies");
    }
    this.step = step;
    this.dependencies = dependencies;
    Object.freeze(this);
  }

  dependency(Dependency) {
    return this.dependencies.get(Dependency);
  }
}

/** One production Step identity and its dependency preparation contract. */
export class StepRegistration {
  constructor({ stepId, StepClass, prepareDependencies }) {
    if (typeof stepId !== "string" || stepId.length === 0 || !(StepClass?.prototype instanceof Step)
      || typeof prepareDependencies !== "function") {
      throw new TypeError("StepRegistration requires a Step id, class, and dependency preparation");
    }
    this.stepId = stepId;
    this.StepClass = StepClass;
    this.prepareDependencies = prepareDependencies;
    Object.freeze(this);
  }

  async create(input) {
    const dependencies = await this.prepareDependencies(input);
    const declared = this.StepClass.dependencies;
    if (!(dependencies instanceof Map) || dependencies.size !== declared.length
      || declared.some((Dependency) => !dependencies.has(Dependency))) {
      throw new TypeError(`StepRegistration ${this.stepId} requires exactly its declared dependencies`);
    }
    const factory = new StepFactory();
    for (const [Dependency, instance] of dependencies) factory.provide(Dependency, instance);
    return new PreparedStep(factory.create(this.StepClass), dependencies);
  }
}
