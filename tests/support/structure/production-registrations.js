import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { TaskStepIdentity } from "../../../src/flow/lib/task-step-identity.js";

/** A fixed Definition identity; Task roles and concrete node identities are distinct. */
export class StructureLeaf {
  constructor(stepId, scope = "flow", nodeId = stepId, executionForm = null, taskIdentity = null) {
    if (typeof stepId !== "string" || !stepId || !["flow", "task"].includes(scope)
      || typeof nodeId !== "string" || !nodeId || executionForm !== null && (typeof executionForm !== "string" || !executionForm)
      || taskIdentity !== null && (!(taskIdentity instanceof TaskStepIdentity) || scope !== "task")) {
      throw new TypeError("StructureLeaf requires fixed Step, scope, node, and execution identities");
    }
    this.stepId = stepId;
    this.scope = scope;
    this.nodeId = nodeId;
    this.executionForm = executionForm;
    this.taskIdentity = taskIdentity;
    Object.freeze(this);
  }
}

export class TaskStructureLeaf extends StructureLeaf {
  constructor(identity, executionForm = null) {
    if (!(identity instanceof TaskStepIdentity)) throw new TypeError("TaskStructureLeaf requires TaskStepIdentity");
    super(identity.definitionId, "task", identity.nodeId, executionForm, identity);
  }
}

export class DefinitionLeafScope {
  constructor(module, declarationName, leaves) {
    if (typeof module !== "string" || !module || typeof declarationName !== "string" || !declarationName
      || !Array.isArray(leaves) || !leaves.length || leaves.some((leaf) => !(leaf instanceof StructureLeaf))
      || new Set(leaves.map((leaf) => leaf.stepId)).size !== leaves.length) {
      throw new TypeError("DefinitionLeafScope requires a nonempty fixed leaf set");
    }
    this.module = module;
    this.declarationName = declarationName;
    this.leaves = Object.freeze([...leaves]);
    Object.freeze(this);
  }
}

/** One named route, with a closed selection/consumption shape and optional receipt replay. */
export class ExecutionCaller {
  constructor(module, declarationName, lookupName, operation, receiptReplayName = null, selectionMode = "select", registrationAware = false) {
    if ([module, declarationName, lookupName].some((value) => typeof value !== "string" || !value)
      || !["project", "execute"].includes(operation) || !["select", "consume"].includes(selectionMode)
      || typeof registrationAware !== "boolean"
      || receiptReplayName !== null && (typeof receiptReplayName !== "string" || !receiptReplayName)) {
      throw new TypeError("ExecutionCaller requires a named lookup and selection consumer");
    }
    Object.assign(this, { module, declarationName, lookupName, operation, receiptReplayName, selectionMode, registrationAware });
    Object.freeze(this);
  }

  body() {
    const replay = this.receiptReplayName === null ? ""
      : `if (input.receiptReplay !== null) return ${this.receiptReplayName}(input.receiptReplay);`;
    const suppliedInput = this.registrationAware ? "{ ...input, registration }" : "input";
    const selection = this.selectionMode === "select"
      ? `const selection = registration.executionContract.select(${suppliedInput});`
      : "const selection = input.selection;";
    const executedInput = this.registrationAware ? "{ ...input, registration }" : "input";
    return `${replay} const registration = ${this.lookupName}(input.stepId);
      if (registration === null) throw new TypeError($STRING_LITERAL);
      ${selection} return registration.executionContract.${this.operation}(selection, ${executedInput});`;
  }
}

export class NamedExecutionShape {
  constructor(form, adapterModule, contractName, selectorName, projectorName, executorName, callers, loaders = []) {
    if ([form, adapterModule, contractName, selectorName, projectorName, executorName].some((value) => typeof value !== "string" || !value)
      || !Array.isArray(callers) || !callers.length || callers.some((caller) => !(caller instanceof ExecutionCaller))
      || !callers.some((caller) => caller.operation === "project") || !callers.some((caller) => caller.operation === "execute")
      || new Set(callers.map((caller) => `${caller.module}#${caller.declarationName}`)).size !== callers.length
      || !Array.isArray(loaders) || loaders.some((loader) => !(loader instanceof ExecutionLoader))
      || new Set(loaders.map((loader) => `${loader.module}#${loader.declarationName}`)).size !== loaders.length) {
      throw new TypeError("NamedExecutionShape requires named adapters and closed display/execution callers");
    }
    Object.assign(this, { form, adapterModule, contractName, selectorName, projectorName, executorName });
    this.callers = Object.freeze([...callers]);
    this.loaders = Object.freeze([...loaders]);
    Object.freeze(this);
  }

  matches(contract) {
    return contract?.selectorName === this.selectorName && contract?.projectorName === this.projectorName
      && contract?.executorName === this.executorName;
  }
}

export class ExecutionLoader {
  constructor(module, declarationName, commandModule) {
    if ([module, declarationName, commandModule].some((value) => typeof value !== "string" || !value)) {
      throw new TypeError("ExecutionLoader requires a named command module loader");
    }
    Object.assign(this, { module, declarationName, commandModule });
    Object.freeze(this);
  }
}

export class StructureScopeContract {
  constructor(definition, executionShapes = [], registry = null) {
    if (!(definition instanceof DefinitionLeafScope) || !Array.isArray(executionShapes)
      || executionShapes.some((shape) => !(shape instanceof NamedExecutionShape))
      || new Set(executionShapes.map((shape) => shape.form)).size !== executionShapes.length
      || registry !== null && !Array.isArray(registry)) throw new TypeError("invalid StructureScopeContract");
    this.definition = definition;
    this.executionShapes = Object.freeze([...executionShapes]);
    this.registry = registry === null ? null : Object.freeze([...registry]);
    Object.freeze(this);
  }
}

export class ProductionRegistrationIssue {
  constructor(stepId = null) {
    const requiresIdentity = new.target !== InvalidRegistrationIssue;
    if (new.target === ProductionRegistrationIssue || requiresIdentity && (typeof stepId !== "string" || !stepId)
      || !requiresIdentity && stepId !== null) {
      throw new TypeError("a concrete registration issue and valid identity are required");
    }
    this.stepId = stepId;
    Object.freeze(this);
  }
}

export class InvalidRegistrationIssue extends ProductionRegistrationIssue {
  toRegistryMessage() { return "single production registry contains an invalid registration type"; }
  toLoadError(moduleUrl, exportName) {
    return new TypeError(`${moduleUrl} must export a nonempty ${exportName} array of StepRegistration instances`);
  }
}

export class DuplicateRegistrationIssue extends ProductionRegistrationIssue {
  toRegistryMessage() { return `single production registry duplicates ${this.stepId}`; }
  toLoadError(moduleUrl) { return new TypeError(`${moduleUrl} has duplicate registration identity ${this.stepId}`); }
}

export class DependencyRegistrationIssue extends ProductionRegistrationIssue {
  toRegistryMessage() { return `single production registry dependency mismatch ${this.stepId}`; }
  toLoadError(moduleUrl) { return new TypeError(`${moduleUrl} has inconsistent registration dependency ${this.stepId}`); }
}

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

  static inspect(registrations) {
    if (!Array.isArray(registrations)) throw new TypeError("registration inspection requires an array");
    const issues = [];
    const ids = new Set();
    const classes = new Set();
    for (const registration of registrations) {
      if (!(registration instanceof StepRegistration)) {
        issues.push(new InvalidRegistrationIssue());
        continue;
      }
      if (ids.has(registration.stepId) || classes.has(registration.StepClass)) issues.push(new DuplicateRegistrationIssue(registration.stepId));
      ids.add(registration.stepId);
      classes.add(registration.StepClass);
      if (registration.StepClass.dependencies?.length !== 1 || registration.StepClass.dependencies[0] !== registration.ServiceClass) {
        issues.push(new DependencyRegistrationIssue(registration.stepId));
      }
    }
    return Object.freeze(issues);
  }

  async load() {
    let module;
    try {
      module = await import(this.moduleUrl);
    } catch (cause) {
      throw new Error(`Cannot load production registrations from ${this.moduleUrl}: ${cause.code ?? cause.name}: ${cause.message}`, { cause });
    }
    const registrations = module[this.exportName];
    if (!Array.isArray(registrations) || registrations.length === 0) {
      throw new TypeError(`${this.moduleUrl} must export a nonempty ${this.exportName} array of StepRegistration instances`);
    }
    const issue = ProductionRegistrations.inspect(registrations)[0];
    if (issue) throw issue.toLoadError(this.moduleUrl, this.exportName);
    return registrations;
  }
}
