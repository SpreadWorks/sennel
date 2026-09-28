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

  assertComplete() {
    const missing = [...this.#required].filter((Dependency) => !this.#checked.has(Dependency));
    if (missing.length > 0) {
      throw new Error(`A07 has no inspected instance for ${missing.map((Dependency) => Dependency.name).join(", ")}`);
    }
    return this.#checked.size;
  }
}
