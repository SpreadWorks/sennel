import { PreparedStep, StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";

export class ServiceBoundaryViolation extends Error {
  constructor(service, property, registration = null) {
    super(`A07 ${service.constructor.name} exposes public own data property ${String(property)}`);
    this.rule = "A07";
    this.service = service;
    this.property = property;
    this.registration = registration;
  }
}

/** Inspect descriptors, including non-enumerable and Symbol keys. Private fields are absent. */
export function assertServiceBoundary(service, registration = null) {
  for (const key of Reflect.ownKeys(service)) {
    if (Object.hasOwn(Object.getOwnPropertyDescriptor(service, key), "value")) {
      throw new ServiceBoundaryViolation(service, key, registration);
    }
  }
  return service;
}

export class ServicePreparationViolation extends TypeError {
  constructor(registration, message, { argumentIndex = null, expectedType = null, actualValue = null } = {}) {
    super(`A07 ${registration.stepId} ${message}`);
    this.rule = "A07";
    this.registration = registration;
    this.service = registration.ServiceClass;
    this.argumentIndex = argumentIndex;
    this.expectedType = expectedType;
    this.actualValue = actualValue;
  }
}

/** Track type boundaries separately from each production registration's preparation. */
export class ServiceBoundaryCoverage {
  #required;
  #checked = new Set();
  #registrations;
  #prepared = new Set();

  constructor(registrations) {
    this.#registrations = new Set(registrations.filter((registration) => registration instanceof StepRegistration));
    this.#required = new Set(registrations.flatMap((registration) => registration.StepClass.dependencies));
  }

  inspect(Dependency, instance, registration = null) {
    if (!this.#required.has(Dependency) || !(instance instanceof Dependency)) {
      throw new TypeError(`A07 requires a registered ${Dependency.name} instance`);
    }
    assertServiceBoundary(instance, registration);
    this.#checked.add(Dependency);
    return instance;
  }

  inspectPrepared(registration, prepared) {
    if (!this.#registrations.has(registration)) {
      throw new TypeError("A07 requires a registered production StepRegistration");
    }
    if (!(prepared instanceof PreparedStep) || prepared.step.constructor !== registration.StepClass) {
      throw new ServicePreparationViolation(registration, "requires its registered production Step preparation");
    }
    const { ServiceClass } = registration;
    const types = ServiceClass.argumentTypes;
    const args = prepared.serviceArguments;
    if (!Array.isArray(types) || args.length !== types.length) {
      throw new ServicePreparationViolation(registration, "did not inject its declared Service arguments");
    }
    const wrongIndex = args.findIndex((value, index) => !(value instanceof types[index]));
    if (wrongIndex !== -1) {
      throw new ServicePreparationViolation(registration,
        `did not inject its declared Service argument ${wrongIndex} (${types[wrongIndex].name})`,
        { argumentIndex: wrongIndex, expectedType: types[wrongIndex], actualValue: args[wrongIndex] });
    }
    const instance = prepared.dependency(ServiceClass);
    if (prepared.dependencies.size !== 1 || !(instance instanceof ServiceClass)) {
      throw new ServicePreparationViolation(registration, "did not inject its declared Service");
    }
    const inspected = this.inspect(ServiceClass, instance, registration);
    this.#prepared.add(registration);
    return inspected;
  }

  assertComplete() {
    const missing = [...this.#required].filter((Dependency) => !this.#checked.has(Dependency));
    if (missing.length > 0) {
      const error = new Error(`A07 has no inspected instance for ${missing.map((Dependency) => Dependency.name).join(", ")}`);
      error.rule = "A07";
      error.services = missing;
      error.registrations = [...this.#registrations].filter((registration) => missing.includes(registration.ServiceClass));
      throw error;
    }
    const missingRegistrations = [...this.#registrations].filter((registration) => !this.#prepared.has(registration));
    if (missingRegistrations.length > 0) {
      const error = new Error(`A07 has no inspected preparation for ${missingRegistrations.map((registration) => registration.stepId).join(", ")}`);
      error.rule = "A07";
      error.registrations = missingRegistrations;
      throw error;
    }
    return this.#checked.size;
  }
}
