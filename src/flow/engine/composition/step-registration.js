import { StepFactory } from "../step-factory.js";
import { Step } from "../step.js";
import { StepExecutionContract } from "./step-execution-contract.js";

export class PreparedStep {
  constructor(step, dependencies, serviceArguments) {
    if (!(step instanceof Step) || !(dependencies instanceof Map)
      || !Array.isArray(serviceArguments)) {
      throw new TypeError("PreparedStep requires a Step, dependencies, and Service arguments");
    }
    this.step = step;
    this.dependencies = dependencies;
    this.serviceArguments = Object.freeze([...serviceArguments]);
    Object.freeze(this);
  }

  dependency(Dependency) {
    return this.dependencies.get(Dependency);
  }
}

/** A canonical receipt already settled before Step construction. */
export class PreparedStepReplay {
  constructor(outcome) {
    if (outcome?.completed !== true || outcome.receipt === null || outcome.receipt === undefined) {
      throw new TypeError("PreparedStepReplay requires a completed durable handoff");
    }
    this.outcome = outcome;
    Object.freeze(this);
  }
}

/** One production Step identity and its dependency preparation contract. */
export class StepRegistration {
  constructor({ stepId, StepClass, ServiceClass, prepareServiceArguments, ConnectorClass = null, executionContract }) {
    if (typeof stepId !== "string" || stepId.length === 0 || !(StepClass?.prototype instanceof Step)
      || typeof ServiceClass !== "function" || typeof prepareServiceArguments !== "function"
      || StepClass.dependencies.length !== 1 || StepClass.dependencies[0] !== ServiceClass
      || !(executionContract instanceof StepExecutionContract)) {
      throw new TypeError("StepRegistration requires a Step, its declared Service, and argument preparation");
    }
    this.stepId = stepId;
    this.StepClass = StepClass;
    this.ServiceClass = ServiceClass;
    this.prepareServiceArguments = prepareServiceArguments;
    this.ConnectorClass = ConnectorClass;
    this.executionContract = executionContract;
    Object.freeze(this);
  }

  async create(input) {
    const args = await this.prepareServiceArguments(input, this.ConnectorClass, this.stepId);
    if (args instanceof PreparedStepReplay) return args.outcome;
    const types = this.ServiceClass.argumentTypes;
    if (!Array.isArray(args) || !Array.isArray(types) || args.length !== types.length
      || args.some((arg, index) => !(arg instanceof types[index]))) {
      throw new TypeError(`StepRegistration ${this.stepId} requires exactly its declared Service arguments`);
    }
    const dependencies = new Map([[this.ServiceClass, new this.ServiceClass(...args)]]);
    const factory = new StepFactory();
    for (const [Dependency, instance] of dependencies) factory.provide(Dependency, instance);
    return new PreparedStep(factory.create(this.StepClass), dependencies, args);
  }
}
