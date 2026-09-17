import { Step } from "./step.js";

/** Constructs Flow steps from their declared constructor dependencies. */
export class StepFactory {
  constructor() {
    this.provided = new Map();
  }

  /** Supplies an already-existing instance instead of constructing that type. */
  provide(Dependency, instance) {
    if (!(instance instanceof Dependency)) {
      throw new TypeError("StepFactory.provide() requires an instance of Dependency");
    }
    this.provided.set(Dependency, instance);
    return this;
  }

  create(stepClass) {
    const instances = new Map(this.provided);
    const dependencies = stepClass.dependencies.map((Dependency) => this.#resolve(Dependency, new Set([stepClass]), instances));
    const step = new stepClass(...dependencies);
    if (!(step instanceof Step)) {
      throw new TypeError("StepFactory.create() must construct a Step");
    }
    return step;
  }

  #resolve(Dependency, constructing, instances) {
    if (instances.has(Dependency)) {
      return instances.get(Dependency);
    }
    if (constructing.has(Dependency)) {
      throw new Error("StepFactory found a circular dependency");
    }
    constructing.add(Dependency);
    const dependencies = (Dependency.dependencies ?? []).map((Next) => this.#resolve(Next, constructing, instances));
    constructing.delete(Dependency);
    const instance = new Dependency(...dependencies);
    instances.set(Dependency, instance);
    return instance;
  }
}
