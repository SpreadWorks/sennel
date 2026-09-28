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
