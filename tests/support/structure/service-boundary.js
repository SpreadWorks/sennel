export class ServiceBoundaryViolation extends Error {
  constructor(service, property) {
    super(`A07 ${service.constructor.name} exposes public own data property ${String(property)}`);
    this.rule = "A07";
    this.service = service;
    this.property = property;
  }
}

/** Inspect descriptors, including non-enumerable and Symbol keys. Private fields are absent. */
export function assertServiceBoundary(service) {
  for (const key of Reflect.ownKeys(service)) {
    if (Object.hasOwn(Object.getOwnPropertyDescriptor(service, key), "value")) {
      throw new ServiceBoundaryViolation(service, key);
    }
  }
  return service;
}

/** Match live inspections to the Service types declared by production Steps. */
export class ServiceBoundaryCoverage {
  #required;
  #checked = new Set();

  constructor(registrations) {
    this.#required = new Set(registrations.flatMap((registration) => registration.StepClass.dependencies));
  }

  inspect(Dependency, instance) {
    if (!this.#required.has(Dependency) || !(instance instanceof Dependency)) {
      throw new TypeError(`A07 requires a registered ${Dependency.name} instance`);
    }
    assertServiceBoundary(instance);
    this.#checked.add(Dependency);
    return instance;
  }

  inspectPrepared(registration, prepared) {
    if (!(registration instanceof StepRegistration) || !(prepared instanceof PreparedStep)
      || prepared.step.constructor !== registration.StepClass) {
      throw new TypeError("A07 requires the registered production Step preparation");
    }
    const { ServiceClass } = registration;
    const types = ServiceClass.argumentTypes;
    const args = prepared.serviceArguments;
    if (!Array.isArray(types) || args.length !== types.length
      || args.some((value, index) => !(value instanceof types[index]))) {
      throw new TypeError(`A07 ${registration.stepId} did not inject its declared Service arguments`);
    }
    if (prepared.dependencies.size !== 1 || prepared.dependency(ServiceClass) === undefined) {
      throw new TypeError(`A07 ${registration.stepId} did not inject its declared Service`);
    }
    return this.inspect(ServiceClass, prepared.dependency(ServiceClass));
  }

  assertComplete() {
    const missing = [...this.#required].filter((Dependency) => !this.#checked.has(Dependency));
    if (missing.length > 0) {
      throw new Error(`A07 has no inspected instance for ${missing.map((Dependency) => Dependency.name).join(", ")}`);
    }
    return this.#checked.size;
  }
}
import { PreparedStep, StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
