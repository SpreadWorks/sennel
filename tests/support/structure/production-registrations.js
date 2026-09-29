import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";

/** Load the selected production composition before running shared structure checks. */
export class ProductionRegistrations {
  constructor(moduleUrl, exportName) {
    if (!(moduleUrl instanceof URL) && (typeof moduleUrl !== "string" || moduleUrl.length === 0)) {
      throw new TypeError("ProductionRegistrations requires a module URL");
    }
    if (typeof exportName !== "string" || exportName.length === 0) {
      throw new TypeError("ProductionRegistrations requires an export name");
    }
    this.moduleUrl = moduleUrl;
    this.exportName = exportName;
    Object.freeze(this);
  }

  async load() {
    let module;
    try {
      module = await import(this.moduleUrl);
    } catch (cause) {
      throw new Error(`Cannot load production registrations from ${this.moduleUrl}: ${cause.code ?? cause.name}: ${cause.message}`, { cause });
    }
    const registrations = module[this.exportName];
    if (!Array.isArray(registrations) || registrations.length === 0
      || registrations.some((registration) => !(registration instanceof StepRegistration))) {
      throw new TypeError(`${this.moduleUrl} must export a nonempty ${this.exportName} array of StepRegistration instances`);
    }
    return registrations;
  }
}
