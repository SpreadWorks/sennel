function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Requirement definitions with the retired implementation lifecycle removed. */
export class CanonicalRequirementDefinitions {
  constructor(requirements) {
    if (!Array.isArray(requirements)) {
      throw new Error("canonical Spec requirements must be an array");
    }
    let changed = false;
    this.definitions = Object.freeze(requirements.map((requirement, index) => {
      if (!isPlainObject(requirement)) {
        throw new Error(`canonical Spec requirements[${index}] must be an object`);
      }
      const definition = structuredClone(requirement);
      if (Object.hasOwn(definition, "status")) {
        delete definition.status;
        changed = true;
      }
      return Object.freeze(definition);
    }));
    this.changed = changed;
    Object.freeze(this);
  }

  applyTo(document) {
    if (!isPlainObject(document)) throw new Error("canonical Spec must be an object");
    return Object.freeze({
      document: this.changed
        ? { ...structuredClone(document), requirements: this.toJSON() }
        : structuredClone(document),
      changed: this.changed,
    });
  }

  toJSON() {
    return this.definitions.map((definition) => structuredClone(definition));
  }
}
