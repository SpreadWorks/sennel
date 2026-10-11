import { AtomicPromptElement } from "./prompt-batching.js";
import { CanonicalTaskRequirementMap } from "./canonical-task-requirement-map.js";
import { validateSchema } from "./schema-validate.js";
import { createHash } from "node:crypto";

class RequirementPromptElement extends AtomicPromptElement {
  constructor(requirement, index) {
    super({
      id: `requirements[${index}].desc`, sequence: index, text: requirement.desc,
      sourceRevision: createHash("sha256").update(requirement.desc).digest("hex"),
    });
    this.requirementId = requirement.id;
    Object.freeze(this);
  }
}

/** Pure validation against a schema loaded at the boundary. */
export class SpecJsonValidator {
  #schema;
  constructor(schema) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new TypeError("Spec validator requires its canonical schema");
    }
    this.#schema = structuredClone(schema);
    Object.freeze(this);
  }

  validate(spec) {
    if (Array.isArray(spec?.requirements)) {
      spec.requirements.forEach((requirement, index) => {
        if (typeof requirement?.desc === "string") new RequirementPromptElement(requirement, index).assertWithinHardLimit();
        if (requirement?.testable === false) {
          if (Object.hasOwn(requirement, "preimplementation_test_expectation")) {
            throw new Error(`spec.json failed schema validation: requirements[${index}].preimplementation_test_expectation is forbidden when testable is false`);
          }
        } else if (!Object.hasOwn(requirement ?? {}, "preimplementation_test_expectation")) {
          throw new Error(`spec.json failed schema validation: requirements[${index}].preimplementation_test_expectation is required when testable is not false`);
        }
      });
    }
    const errors = validateSchema(spec, this.#schema);
    if (errors.length > 0) throw new Error(`spec.json failed schema validation: ${errors.join("; ")}`);
    new CanonicalTaskRequirementMap(spec);
    return spec;
  }
}
