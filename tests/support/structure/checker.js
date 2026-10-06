import path from "node:path";
import { StepExecutionContract } from "../../../src/flow/engine/composition/step-execution-contract.js";
import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { TaskStepIdentity } from "../../../src/flow/lib/task-step-identity.js";
import { SourceModule, SourceDeclarationHeader, SourceInitializer, SourceReadError, SourceOriginUsage, readParameters, readTypeInvariants, readClassMember, readInvocations, readMemberAccess, readTokens } from "./source-reader.js";
import { FlowStructureRules } from "./flow-rules.js";
import { SourceRepository } from "./source-repository.js";
import { ExecutionCaller, ProductionRegistrations, StructureScopeContract } from "./production-registrations.js";

const nativeClassBases = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError", "Array", "Map", "Set"]);

class SharedExecutionAdapter {
  constructor(kind, selector, projector, executor, command) {
    Object.assign(this, { kind, selector, projector, executor, command });
    Object.freeze(this);
  }
  get contractName() { return `${this.kind}StepExecutionContract`; }
  get module() { return this.kind === "worker" ? "src/flow/lib/worker-execution-admission.js" : "src/flow/lib/execution-admission.js"; }
}

const sharedExecutionAdapters = new Map([
  new SharedExecutionAdapter("gate", "selectGateExecutionAdmission", "projectGateExecutionAdmission", "executeGateSelection", "src/flow/lib/run-gate.js"),
  new SharedExecutionAdapter("review", "selectReviewExecutionAdmission", "projectReviewExecutionAdmission", "executeReviewSelection", "src/flow/lib/run-review.js"),
  new SharedExecutionAdapter("worker", "selectWorkerExecutionAdmission", "projectWorkerExecutionAdmission", "executeWorkerExecutionAdmission", "src/flow/lib/run-dispatch.js"),
].map((adapter) => [adapter.kind, adapter]));

export class StructureScope {
  constructor(root, entry, registrations, registrationModule = `src/flow/engine/composition/${entry.split("/").at(-1)}.js`, contract = null) {
    if (typeof root !== "string" || typeof entry !== "string" || !Array.isArray(registrations)
      || contract !== null && !(contract instanceof StructureScopeContract)) throw new TypeError("invalid structure scope");
    this.root = path.resolve(root);
    this.entry = entry.replace(/\\/g, "/").replace(/\/$/, "");
    this.registrations = registrations;
    this.registrationModule = registrationModule;
    this.contract = contract;
  }
}

export class StructureDiagnostic {
  constructor(rule, file, token, trace, message) {
    this.rule = rule;
    this.file = file;
    this.line = token?.line ?? 1;
    this.column = token?.column ?? 1;
    this.trace = [...trace];
    this.message = message;
  }
  toString() {
    return `${this.rule} ${this.file}:${this.line}:${this.column} ${this.message} [${this.trace.join(" -> ")}]`;
  }
}

export class StructureReport {
  constructor(scope) {
    this.scope = scope;
    this.diagnostics = [];
    this.visited = new Set();
    this.serviceBoundaries = new Set();
    this.reverseIndexed = new Set();
  }
  get ok() { return this.diagnostics.length === 0; }
  assert() {
    if (!this.ok) throw new Error(this.diagnostics.map((entry) => entry.toString()).join("\n"));
    return this;
  }
  describe() {
    return `entry=${this.scope.entry}; visited=${[...this.visited].sort().join(", ")}; services=${[...this.serviceBoundaries].sort().join(", ")}; reverse-index=${this.reverseIndexed.size} files`;
  }
}

class ResolvedSourceClass {
  constructor(file, module, classEntry) {
    this.file = file;
    this.module = module;
    this.classEntry = classEntry;
  }
  get key() { return `${this.file}#${this.classEntry.name}`; }
}

class ServiceClassReceiver {
  constructor(value, isStatic) {
    if (!(value instanceof ResolvedSourceClass) || typeof isStatic !== "boolean") throw new TypeError("class receiver required");
    this.value = value;
    this.isStatic = isStatic;
  }
  get key() { return `${this.value.key}:${this.isStatic ? "static" : "instance"}`; }
}

class ResolvedSourceBinding {
  constructor(file, module, header, route = [file]) {
    if (!(module instanceof SourceModule) || !(header instanceof SourceDeclarationHeader)) throw new TypeError("resolved source declaration header required");
    this.file = file;
    this.module = module;
    this.header = header;
    this.name = header.name;
    this.route = route;
  }
  get key() { return `${this.file}#${this.name}`; }
  through(file) {
    return this.route[0] === file ? this : new ResolvedSourceBinding(this.file, this.module, this.header, [file, ...this.route]);
  }
}

class ResolvedSourceNamespace {
  constructor(file, route = [file]) {
    if (typeof file !== "string" || !file || !Array.isArray(route)) throw new TypeError("source namespace required");
    this.file = file;
    this.route = route;
    this.name = "*";
  }
  get key() { return `${this.file}#*`; }
  through(file) { return this.route[0] === file ? this : new ResolvedSourceNamespace(this.file, [file, ...this.route]); }
}

class ResolvedDependency {
  constructor(reference, target, sourceClass) {
    this.reference = reference;
    this.target = target;
    this.sourceClass = sourceClass;
  }
}

class ExecutionEntryBindings {
  constructor(module) {
    if (typeof module !== "string" || !module) throw new TypeError("execution entry module required");
    this.module = module;
    this.origins = new Set();
    this.accepted = new Map();
    this.publicNames = new Set();
  }
  add(name, declaration, isPublic = false) {
    this.origins.add(name);
    if (declaration) this.accepted.set(declaration.token.offset, declaration.tokens);
    if (isPublic) this.publicNames.add(name);
  }
}

export class StructureChecker {
  constructor(scope, repository = new SourceRepository(scope.root)) {
    if (!(scope instanceof StructureScope)) throw new TypeError("StructureScope required");
    this.scope = scope;
    this.repository = repository;
    this.report = new StructureReport(scope);
    this.modules = new Map();
    this.reverseModules = new Map();
    this.sources = new Map();
    this.resolvedPaths = new Map();
    this.exports = new Map();
    this.bindingExports = new Map();
    this.exportNames = new Map();
    this.unresolvedHeritage = new Set();
    this.ambiguousExports = new Set();
    this.allFiles = [];
    this.registeredServices = new Map();
    this.argumentTypeKeys = new Set();
    this.topLevelVisited = new Set();
    this.serviceBindings = new Map();
    this.rules = new FlowStructureRules();
  }

  check() {
    this.allFiles = this.#jsFiles(this.rules.sourceRoot);
    const entries = this.#jsFiles(this.scope.entry);
    if (entries.length === 0) this.#diagnose("A01", this.scope.entry, null, [this.scope.entry], "scope has no JavaScript entry files");
    const registered = this.#registrationIndex(entries);
    this.#fixedScopeContract();
    for (const entry of entries) this.#visit(entry, [entry], registered);
    this.#serviceDependencies();
    this.#serviceBindingWrites();
    const stepFiles = new Set(registered.keys());
    for (const entry of entries) {
      const module = this.#module(entry, [entry]);
      if (module && this.#role(entry, module) === "step") stepFiles.add(entry);
    }
    this.#reverseIndex(stepFiles);
    this.#reverseServiceIndex();
    this.#sharedExecutionSelections(this.scope.contract?.executionShapes ?? []);
    if (this.scope.contract?.executionShapes.length) this.#declaredExecutionRoutes();
    else this.#registeredExecutionRoute();
    return this.report;
  }

  #diagnose(rule, file, token, trace, message) {
    this.report.diagnostics.push(new StructureDiagnostic(rule, file, token, trace, message));
  }

  #executionKind(registration) {
    const selector = registration.executionContract?.selectorName;
    return [...sharedExecutionAdapters.values()].find((adapter) => adapter.selector === selector)?.kind ?? "unknown";
  }

  #fixedScopeContract() {
    const contract = this.scope.contract;
    if (contract === null) return;
    const definition = contract.definition;
    const file = definition.module;
    const module = this.#module(file, [this.scope.entry, file], "A11", true);
    const declaration = module?.declaration(definition.declarationName);
    const tokens = declaration?.tokens ?? [];
    if (!declaration) this.#diagnose("A11", file, null, [this.scope.entry, file], `missing Definition declaration ${definition.declarationName}`);
    const definitionIds = tokens.filter((token, index) => token.kind === "string"
      && tokens[index - 1]?.value === ":" && tokens[index - 2]?.value === "id");
    const expected = new Set(definition.leaves.map((leaf) => leaf.stepId));
    for (const leaf of definition.leaves) {
      const requiredDeclaration = leaf.scope === "task" ? "TASK_DEFINITION" : "FLOW_DEFINITION";
      if (definition.declarationName !== requiredDeclaration) this.#diagnose("A11", file, declaration?.token,
        [this.scope.entry, file], `${leaf.stepId} belongs to ${leaf.scope} scope, not ${definition.declarationName}`);
      const matches = definitionIds.filter((token) => token.value === leaf.stepId);
      // Draft review leaf producers are explicit Definition composition calls, inspected by A11 below.
      const routeGenerated = leaf.scope === "flow" && this.#draftDefinitionRouteLeaf(module, leaf.stepId);
      if (matches.length !== 1 && !routeGenerated) this.#diagnose("A11", file, matches[0] ?? declaration?.token,
        [this.scope.entry, file], `fixed Definition leaf ${leaf.stepId} has ${matches.length} declarations`);
      if (leaf.scope === "flow" && leaf.nodeId !== leaf.stepId) this.#diagnose("A11", file, matches[0],
        [this.scope.entry, file], `Flow leaf ${leaf.stepId} has inconsistent node identity ${leaf.nodeId}`);
      if (leaf.scope === "task") {
        const identity = leaf.taskIdentity;
        if (!(identity instanceof TaskStepIdentity) || identity.definitionId !== leaf.stepId || !identity.matchesNode(leaf.nodeId)) {
          this.#diagnose("A11", file, matches[0], [this.scope.entry, file], `Task role ${leaf.stepId} does not match node ${leaf.nodeId}`);
        }
      }
      const registrations = this.scope.registrations.filter((registration) => registration.stepId === leaf.stepId);
      if (registrations.length !== 1) this.#diagnose("A01", this.scope.registrationModule, null,
        [file, this.scope.registrationModule], `responsibility leaf ${leaf.stepId} has ${registrations.length} selected registrations`);
    }
    for (const registration of this.scope.registrations) if (!expected.has(registration.stepId)) {
      this.#diagnose("A01", this.scope.registrationModule, null, [file, this.scope.registrationModule],
        `selected registration ${registration.stepId} is outside fixed responsibility leaves`);
    }
    if (contract.registry !== null) {
      for (const issue of ProductionRegistrations.inspect(contract.registry)) {
        this.#diagnose("A01", this.scope.registrationModule, null, [this.scope.registrationModule], issue.toRegistryMessage());
      }
      for (const registration of this.scope.registrations) if (!contract.registry.includes(registration)) {
        this.#diagnose("A01", this.scope.registrationModule, null, [this.scope.registrationModule],
          `selection ${registration.stepId} does not belong to the single production registry`);
      }
      for (const registration of contract.registry) if (registration instanceof StepRegistration
        && expected.has(registration.stepId) && !this.scope.registrations.includes(registration)) {
        this.#diagnose("A01", this.scope.registrationModule, null, [this.scope.registrationModule],
          `single production registry leaf ${registration.stepId} was excluded from phase selection`);
      }
    }
  }

  #draftDefinitionRouteLeaf(definition, stepId) {
    const flow = definition?.declaration("FLOW_DEFINITION");
    if (!flow) return false;
    const routeFile = "src/flow/lib/draft-review-routes.js";
    if (!this.allFiles.includes(routeFile)) return false;
    const routes = this.#module(routeFile, [definition.file, routeFile], "A11", true);
    const tokens = routes?.declaration("DRAFT_REVIEW_ROUTES")?.tokens ?? [];
    for (let index = 0; index < flow.tokens.length; index++) {
      if (flow.tokens[index].value !== "createDraftReviewRouteNodes") continue;
      const route = definition.declaration(flow.tokens[index + 2]?.value ?? "");
      const keyIndex = route?.tokens.findIndex((token) => token.value === "draftReviewRouteForKey") ?? -1;
      const key = route?.tokens[keyIndex + 2]?.value;
      const start = tokens.findIndex((token, offset) => token.value === "key" && tokens[offset + 2]?.value === key);
      let end = tokens.findIndex((token, offset) => offset > start && token.value === "key");
      if (end < 0) end = tokens.length;
      if (start >= 0 && tokens.slice(start, end).some((token, offset, part) =>
        ["triageStepId", "repairStepId"].includes(token.value) && part[offset + 2]?.value === stepId)) return true;
    }
    return false;
  }

  #declaredExecutionRoutes() {
    const contract = this.scope.contract;
    const selectedCapabilities = this.#declaredLookups();
    const entryModules = new Set(contract.executionShapes.flatMap((shape) =>
      [...shape.callers, ...shape.loaders].map((entry) => entry.module)));
    const entries = new Map([...entryModules].map((file) => [file, new ExecutionEntryBindings(file)]));
    const allowed = new Map();
    const loaderTokens = new Map();
    for (const leaf of contract.definition.leaves) {
      if (leaf.executionForm === null) continue;
      const registration = this.scope.registrations.find((entry) => entry.stepId === leaf.stepId);
      if (!registration) continue;
      const shape = contract.executionShapes.find((entry) => entry.form === leaf.executionForm);
      if (!shape || !(registration.executionContract instanceof StepExecutionContract) || !shape.matches(registration.executionContract)) {
        this.#diagnose("A10", this.scope.registrationModule, null, [this.scope.registrationModule],
          `registration ${leaf.stepId} lacks named execution form ${leaf.executionForm}`);
      }
    }
    for (const shape of contract.executionShapes) {
      const file = shape.adapterModule;
      const module = this.#module(file, [this.scope.registrationModule, file], "A10", true);
      const declaration = module?.declaration(shape.contractName);
      if (!["", ","].some((trailing) => declaration?.matchesDeclaration(`const ${shape.contractName} = new StepExecutionContract({
        select: ${shape.selectorName}, project: ${shape.projectorName}, execute: ${shape.executorName}${trailing} });`))) {
        this.#diagnose("A10", file, declaration?.token, [this.scope.registrationModule, file],
          `${shape.contractName} does not bind its named adapters`);
      }
      for (const name of [shape.selectorName, shape.projectorName, shape.executorName]) if (!module?.declaration(name)?.bodyTokens()) {
        this.#diagnose("A10", file, declaration?.token, [this.scope.registrationModule, file], `named adapter ${name} cannot be resolved`);
      }
      if (module && shape.form === "approval" && !this.#declaredApprovalSelector(module, shape)) {
        this.#diagnose("A10", file, module.declaration(shape.selectorName)?.token,
          [this.scope.registrationModule, file], "Approval selection does not bind the registered leaf and acquired input");
      }
      const consumers = new Map();
      for (const name of [shape.projectorName, shape.executorName]) {
        if (module && !this.#declaredSelectionConsumer(module, name, shape, consumers)) this.#diagnose("A10", file,
          module.declaration(name)?.token, [this.scope.registrationModule, file],
          `named adapter ${name} does not preserve its supplied selection in a supported consumer shape`);
      }
      if (module) this.#declaredAdapterBindings(module, shape, declaration, consumers);
      for (const caller of shape.callers) {
        const source = this.#module(caller.module, [file, caller.module], "A10", true);
        const body = source?.declaration(caller.declarationName);
        const matched = this.#declaredCaller(body, caller);
        if (!matched) this.#diagnose("A10", caller.module, body?.token,
          [this.scope.registrationModule, file, caller.module], `${caller.declarationName} does not preserve registered lookup and selection`);
        entries.get(caller.module).add(caller.declarationName, matched ? body : null, true);
        if (caller.receiptReplayName !== null) {
          const replay = source?.declaration(caller.receiptReplayName);
          const matchedReplay = replay?.matchesFunction("receipt", "return receipt;");
          if (!matchedReplay) {
            this.#diagnose("A10", caller.module, replay?.token ?? body?.token,
              [this.scope.registrationModule, file, caller.module], "receipt replay must consume the acquired receipt without execution or judgment");
          }
          entries.get(caller.module).add(caller.receiptReplayName, matchedReplay ? replay : null);
        }
        const localLookup = caller.module === this.scope.registrationModule
          && source?.declaration(caller.lookupName) !== null;
        const lookup = localLookup ? null
          : source?.references.find((reference) => reference.bindings.get(caller.lookupName) === caller.lookupName);
        const target = lookup && this.#resolve(caller.module, lookup, [caller.module], "A11", true);
        if (!localLookup && target?.file !== this.scope.registrationModule) this.#diagnose("A11", caller.module, lookup?.token ?? body?.token,
          [caller.module, this.scope.registrationModule], `${caller.lookupName} is not the selected production lookup`);
        if (!allowed.has(caller.module)) allowed.set(caller.module, new Set());
        if (matched) for (const token of body.tokens) allowed.get(caller.module).add(token.offset);
      }
      for (const loader of shape.loaders) {
        const source = this.#module(loader.module, [file, loader.module], "A11", true);
        const declaration = source?.declaration(loader.declarationName);
        const specifier = path.posix.relative(path.posix.dirname(loader.module), loader.commandModule);
        const relative = specifier.startsWith(".") ? specifier : `./${specifier}`;
        const matched = declaration?.matchesFunction("", `return import('${relative}');`);
        if (!matched) this.#diagnose("A11", loader.module, declaration?.token,
          [loader.module, loader.commandModule], `${loader.declarationName} is not its named command loader`);
        entries.get(loader.module).add(loader.declarationName, matched ? declaration : null, true);
        if (!loaderTokens.has(loader.module)) loaderTokens.set(loader.module, new Set());
        if (matched) for (const token of declaration.tokens) loaderTokens.get(loader.module).add(token.offset);
      }
    }
    // Several shapes can share an entry module and receipt helper. Accept only
    // verified declarations, then check their complete binding closure once.
    for (const bindings of entries.values()) {
      const module = this.reverseModules.get(bindings.module);
      if (module) this.#declaredBindings(module, bindings.origins, bindings.accepted.values(), "execution entry", bindings.publicNames, true);
    }
    for (const shape of contract.executionShapes) {
      const file = shape.adapterModule;
      const lookupNames = new Set(contract.executionShapes.flatMap((entry) => entry.callers.map((caller) => caller.lookupName)));
      const commandModules = new Set(shape.callers.map((caller) => caller.module));
      for (const sourceFile of this.allFiles) {
        if (sourceFile === this.scope.registrationModule) continue;
        const source = this.#module(sourceFile, [sourceFile], "A11", true);
        const aliases = new Set();
        const namespaces = new Set();
        const routes = new Map();
        const adapterNames = new Set([shape.contractName, shape.selectorName, shape.projectorName, shape.executorName]);
        for (const reference of source?.references ?? []) {
          const target = this.#resolve(sourceFile, reference, [sourceFile], "A11", true)?.file;
          if (!target) continue;
          const exposed = reference.kind === "reexport"
            ? source.exports.filter((entry) => entry.reference === reference).map((entry) => [entry.name, entry.local])
            : reference.bindings;
          for (const [local, imported] of exposed) {
            const names = imported === "*" ? this.#exportedNames(target) : [imported];
            for (const exported of names) {
              // Explicit local exports win over wildcard exports in ESM. Resolve
              // the effective source slot before treating a re-export as escape.
              const binding = reference.kind === "reexport" && !(imported === "*" && local !== "*")
                ? this.#resolveExportBinding(sourceFile, local === "*" ? exported : local, new Set(), "A11")
                : this.#resolveExportBinding(target, exported, new Set(), "A11");
              if (!binding) continue;
              for (const exposedBinding of this.#namespaceBindings(binding)) {
                const lookup = exposedBinding.file === this.scope.registrationModule && lookupNames.has(exposedBinding.name);
                const collection = exposedBinding.file === this.scope.registrationModule
                  && selectedCapabilities.has(exposedBinding.name) && !lookup;
                const adapter = exposedBinding.file === file && adapterNames.has(exposedBinding.name);
                if (!lookup && !collection && !adapter) continue;
                const trace = [sourceFile, ...exposedBinding.route.filter((entry) => entry !== sourceFile)];
                if (adapter && !this.rules.isComposition(sourceFile)) {
                  this.#diagnose("A11", sourceFile, reference.token, trace,
                    "shared execution adapter imported outside production registration");
                }
                if (!lookup && !collection) continue;
                // Public registration selections may be forwarded without consumption.
                // Their actual consumers remain accountable through provenance.
                if (reference.kind === "reexport" && collection) continue;
                if (reference.kind === "reexport") {
                  this.#diagnose("A11", sourceFile, reference.token, trace,
                    "unregistered execution lookup caller or capability escape through re-export");
                } else {
                  if (imported === "*" || binding instanceof ResolvedSourceNamespace) {
                    namespaces.add(local);
                  } else aliases.add(local);
                  routes.set(local, trace);
                }
              }
            }
          }
        }
        if (source?.tokens.length && aliases.size + namespaces.size > 0) {
          let usage;
          try { usage = source.originUsage([...aliases, ...namespaces], { moduleBindings: true }); }
          catch (error) {
            if (!(error instanceof SourceReadError)) throw error;
            this.#diagnose("A11", sourceFile, error, [sourceFile, this.scope.registrationModule],
              `cannot inspect execution capability bindings: ${error.message}`);
          }
          if (usage) {
            for (const reference of source.references) if (reference.kind === "import") usage.accept(source.referenceTokens(reference));
            for (const token of source.tokens) if (allowed.get(sourceFile)?.has(token.offset)) usage.accept([token]);
            this.#declaredCapabilityConsumers(source, shape, lookupNames, usage);
            for (const token of usage.unresolved()) {
              this.#diagnose("A11", sourceFile, token, routes.get(token.value) ?? [sourceFile, this.scope.registrationModule],
                `unregistered execution lookup caller or capability escape ${token.value}`);
            }
          }
        }
        for (const reference of source?.references ?? []) {
          if (reference.kind !== "dynamic") continue;
          const target = this.#resolve(sourceFile, reference, [sourceFile], "A11", true);
          if (commandModules.has(target?.file) && !loaderTokens.get(sourceFile)?.has(reference.token.offset)) {
            this.#diagnose("A11", sourceFile, reference.token, [sourceFile, target.file], "unregistered execution command loader");
          }
        }
        // Lookup provenance above determines which registration is targeted.
        // A field name alone cannot distinguish another phase's legitimate
        // contract consumption in the same command module.
      }
    }
  }

  #namespaceBindings(binding, seen = new Set()) {
    if (!(binding instanceof ResolvedSourceNamespace)) return [binding];
    if (seen.has(binding.key)) return [];
    seen.add(binding.key);
    const values = [];
    for (const name of this.#exportedNames(binding.file)) {
      const exported = this.#resolveExportBinding(binding.file, name, new Set(), "A11");
      if (!exported) continue;
      for (let value of this.#namespaceBindings(exported, seen)) {
        for (const hop of [...binding.route].reverse()) value = value.through(hop);
        values.push(value);
      }
    }
    seen.delete(binding.key);
    return values;
  }

  // Named adapters currently support selection forwarding, immutable aliases,
  // and same-module helper delegation. Each helper must obey the same contract;
  // an opaque call is not evidence of consumption. Production Draft/Spec adapters
  // retain their existing concrete routing checks below. Additional execution
  // terminals need an explicit contract, not a method-name inference here.
  #declaredSelectionConsumer(module, name, shape, consumers, visited = new Set()) {
    if (visited.has(name)) return false;
    const declaration = module.declaration(name);
    if (declaration?.tokens[0]?.value !== "function") return false;
    if (shape.form === "approval") {
      const matched = name === shape.projectorName
        ? this.#declaredApprovalProjector(module, declaration, shape)
        : name === shape.executorName ? this.#declaredApprovalExecutor(module, declaration, shape) : false;
      if (matched) consumers.set(name, declaration);
      return matched;
    }
    const parameters = readParameters(declaration.tokens);
    if (parameters.length < 1 || parameters.length > 2
      || parameters.some((parameter) => parameter.length !== 1 || parameter[0].kind !== "identifier")) return false;
    const names = parameters.map((parameter) => parameter[0].value);
    if (new Set(names).size !== names.length) return false;
    const origins = new Map(names.map((parameter, index) => [parameter, index]));
    const body = declaration.bodyTokens();
    if (body === null) return false;
    if (this.#registeredAdoptionConsumer(module, declaration, name, shape, names)) {
      consumers.set(name, declaration);
      return true;
    }
    let prefix = "";
    let index = 0;
    // A closed straight-line prefix is essential: origin tracking alone cannot
    // establish that an alias is never overwritten or bypassed by an early return.
    while (body[index]?.value === "const") {
      const alias = body[index + 1];
      const initializer = alias && declaration.topLevelInitializer(alias.value);
      const source = initializer?.tokens;
      if (alias?.kind !== "identifier" || origins.has(alias.value)
        || source?.length !== 1 || !origins.has(source[0].value)
        || body[index + 2]?.value !== "=" || body[index + 4]?.value !== ";") return false;
      origins.set(alias.value, origins.get(source[0].value));
      prefix += `const ${alias.value} = ${source[0].value};`;
      index += 5;
    }
    for (const [alias, origin] of origins) {
      if (origin === 0 && declaration.matchesBody(`${prefix} return ${alias};`)) {
        consumers.set(name, declaration);
        return true;
      }
    }
    const calls = readInvocations({ tokens: body.slice(index) });
    if (calls.length !== 1) return false;
    const call = calls[0];
    if ([shape.selectorName, shape.projectorName, shape.executorName].includes(call.name)
      || origins.has(call.name) || call.arguments.length < 1 || call.arguments.length > 2
      || call.arguments.some((argument, position) => argument.length !== 1
        || argument[0].kind !== "identifier" || origins.get(argument[0].value) !== position)) return false;
    const target = module.declaration(call.name);
    if (!target || readParameters(target.tokens).length !== call.arguments.length
      || !declaration.matchesBody(`${prefix} return ${call.name}(${call.arguments.map((argument) => argument[0].value).join(",")});`)) return false;
    if (!this.#declaredSelectionConsumer(module, call.name, shape, consumers, new Set([...visited, name]))) return false;
    consumers.set(name, declaration);
    return true;
  }

  #declaredApprovalSelector(module, shape) {
    const selector = module.declaration(shape.selectorName);
    return selector?.matchesFunction("input", `
      if (input.stepId !== "approval" || !(input.registration instanceof StepRegistration)
        || input.registration.stepId !== input.stepId) throw new TypeError($STRING_LITERAL);
      if (input.observed instanceof ApprovalInput) {
        return new ApprovalExecutionSelection({ observed: input.observed, registration: input.registration, stepId: input.stepId });
      }
      if (input.action === undefined || input.action === null) {
        throw new TypeError($STRING_LITERAL);
      }
      return new ApprovalExecutionSelection({ registration: input.registration, stepId: input.stepId, action: input.action });
    `) === true;
  }

  #declaredApprovalProjector(module, declaration, shape) {
    const parameters = readParameters(declaration.tokens);
    return parameters.length === 2 && parameters[0].length === 1 && parameters[0][0].value === "selection"
      && parameters[1].length === 1 && parameters[1][0].value === "input"
      && declaration.matchesBody(`
      if (!(selection instanceof ApprovalExecutionSelection) || selection.stepId !== input.stepId
        || selection.registration !== input.registration
        || !(input.directive instanceof NextActionDirective)) throw new TypeError($STRING_LITERAL);
      return input.directive;
    `);
  }

  #declaredApprovalExecutor(module, declaration, shape) {
    const parameters = readParameters(declaration.tokens);
    const serviceNames = new Set(this.scope.registrations.filter((registration) => shape.matches(registration.executionContract))
      .map((registration) => registration.ServiceClass?.name).filter(Boolean));
    if (parameters.length !== 2 || parameters[0].length !== 1 || parameters[0][0].value !== "selection"
      || parameters[1].length !== 1 || parameters[1][0].value !== "input" || serviceNames.size !== 1) return false;
    const [serviceName] = serviceNames;
    return declaration.matchesBody(`
      if (!(selection instanceof ApprovalExecutionSelection) || !(selection.observed instanceof ApprovalInput)
        || selection.stepId !== input.stepId || selection.registration !== input.registration
        || input.registration?.stepId !== selection.stepId) {
        throw new TypeError($STRING_LITERAL);
      }
      const execute = (prepared) => {
        const execution = prepared.step.execute();
        const service = prepared.dependency(${serviceName});
        return service.settlementOutcome ?? execution.then(() => service.settlementOutcome);
      };
      const prepared = input.registration.create({ ...input, observed: selection.observed });
      return prepared instanceof Promise ? prepared.then(execute) : execute(prepared);
    `);
  }

  /** A closed adoption terminal must execute the Step built by the selected registration. */
  #registeredAdoptionConsumer(module, declaration, name, shape, parameters) {
    const [selection, input] = parameters;
    const body = declaration.bodyTokens();
    const typeIndex = body.findIndex((token) => token.value === "instanceof");
    const Selection = body[typeIndex + 1]?.value;
    if (typeIndex < 0 || module.declaration(Selection)?.token.value !== "class") return false;
    const selector = module.declaration(shape.selectorName);
    if (!selector?.returns().some((entry) => entry.tokens[0]?.value === "new"
      && entry.tokens[1]?.value === Selection)) return false;
    if (!this.#selectedRegistrationConstructor(module, Selection, shape)) return false;
    if (name === shape.projectorName && parameters.length === 1) {
      // A safe read-only refusal is a real projection. It may not run a worker,
      // adopt evidence, or evaluate another selection in its constructor.
      return declaration.matchesBody(`
        if (!(${selection} instanceof ${Selection})) {
          throw new TypeError($STRING_LITERAL);
        }
        return new BlockedDirective({ code: $STRING_LITERAL, reason: $STRING_LITERAL,
          resumeInstruction: $STRING_LITERAL, });
      `) && module.references.some((reference) => reference.bindings.get("BlockedDirective") === "BlockedDirective"
        && this.#resolve(module.file, reference, [module.file], "A10", true)?.file === "src/flow/lib/next-action-directive.js");
    }
    if (name !== shape.executorName || parameters.length !== 2) return false;
    const result = declaration.returns().at(-1)?.tokens ?? [];
    const outcome = result.at(-1)?.value;
    if (typeof outcome !== "string" || !this.scope.registrations.every((registration) => {
      const Service = registration.ServiceClass;
      const service = [...this.registeredServices.values()].find((entry) => entry.classEntry.name === Service.name);
      return typeof Object.getOwnPropertyDescriptor(Service.prototype, outcome)?.get === "function"
        && service !== undefined && readClassMember(service.module, Service.name, outcome) !== null;
    })) return false;
    return declaration.matchesBody(`
      if (!(${selection} instanceof ${Selection})
        || ${selection}.registration !== ${input}.registration
        || ${selection}.stepId !== ${input}.registration.stepId) {
        throw new StepAdmissionRefusal($STRING_LITERAL);
      }
      if (${selection}.receipt !== null) return ${selection}.receipt;
      if (${selection}.binding === null || ${selection}.preparation === null) {
        throw new StepAdmissionRefusal($STRING_LITERAL);
      }
      ${selection}.binding.assertCurrent();
      const prepared = await ${input}.registration.create({
        flowManager: ${input}.flowManager, binding: ${selection}.binding,
        preparation: ${selection}.preparation, commandResult: ${input}.commandResult,
      });
      await prepared.step.execute();
      return prepared.dependency(${input}.registration.ServiceClass).${outcome};
    `);
  }

  #selectedRegistrationConstructor(module, name, shape) {
    const constructor = readClassMember(module, name, "constructor");
    const parameters = readParameters(constructor?.tokens ?? []);
    if (parameters.length !== 1 || !["", ","].some((trailing) =>
      new SourceInitializer(parameters[0][0], 0, parameters[0]).matches(`{ state, stepId, registration, binding, preparation, receipt${trailing} }`))) return null;
    return constructor?.matchesBody(`
      if (registration?.stepId !== stepId
        || registration.executionContract !== ${shape.contractName}) {
        throw new StepAdmissionRefusal($STRING_LITERAL);
      }
      this.runId = state.runId;
      this.specId = state.specId;
      this.stepId = stepId;
      this.registration = registration;
      this.binding = binding;
      this.preparation = preparation;
      this.receipt = receipt;
      Object.freeze(this);
    `) ? constructor : null;
  }

  #declaredCaller(declaration, caller) {
    if (declaration?.matchesFunction("input", caller.body())) return true;
    const selection = caller.selectionMode === "select"
      ? "const selection = registration.executionContract.select({ ...input, registration });"
      : "const selection = input.selection;";
    const replay = caller.receiptReplayName === null ? ""
      : `if (selection.registration !== registration) throw new TypeError($STRING_LITERAL);
         if (selection.receipt !== null) return ${caller.receiptReplayName}(selection.receipt);`;
    const acknowledgement = caller.selectionMode === "consume" && caller.operation === "execute"
      ? `if (selection.registration !== registration) throw new TypeError($STRING_LITERAL);
         if (selection.receipt !== null) return selection.receipt;` : null;
    return [replay, acknowledgement].filter((branch) => branch !== null).some((branch) =>
      declaration?.matchesFunction("input", `
        const registration = ${caller.lookupName}(input.stepId);
        if (registration === null) throw new TypeError($STRING_LITERAL);
        ${selection} ${branch}
        return registration.executionContract.${caller.operation}(selection, { ...input, registration });
      `));
  }

  #declaredCapabilityConsumers(module, shape, lookupNames, usage) {
    const tokens = module.tokens;
    const source = this.#source(module.file);
    const matched = (start, pattern) => {
      const expected = readTokens(pattern);
      const actual = tokens.slice(start, start + expected.length);
      return actual.length === expected.length
        && new SourceInitializer(actual[0], start, actual).matches(pattern) ? actual : null;
    };
    for (const call of readInvocations(module)) {
      if (!lookupNames.has(call.name) || !usage.isOrigin(call.token) || call.arguments.length !== 1) continue;
      const index = tokens.findIndex((token) => token.offset === call.token.offset);
      if (tokens[index - 3]?.value !== "const" || tokens[index - 2]?.kind !== "identifier"
        || tokens[index - 1]?.value !== "=" || !SourceOriginUsage.isReference(call.arguments[0])) continue;
      const registration = tokens[index - 2].value;
      const argument = call.arguments[0];
      const arg = source.slice(argument[0].offset, argument.at(-1).offset + argument.at(-1).value.length);
      for (const caller of shape.callers.filter((entry) => entry.module === module.file && entry.selectionMode === "consume")) {
        const consumer = module.originUsage([caller.declarationName], { acceptBindings: false, moduleBindings: true });
        for (const terminal of ["return", "await"]) {
          const sequence = matched(index - 3, `
            const ${registration} = ${call.name}(${arg});
            const selection = ${registration}.executionContract.select({ ...input, registration: ${registration} });
            ${terminal} ${caller.declarationName}({ ...input, selection });
          `) ?? (registration === "registration" ? matched(index - 3, `
            const registration = ${call.name}(${arg});
            const selection = registration.executionContract.select({ ...input, registration });
            ${terminal} ${caller.declarationName}({ ...input, selection });
          `) : null);
          if (sequence !== null) {
            const consumed = readInvocations({ tokens: sequence }).at(-1);
            if (!consumed || !consumer.isOrigin(consumed.token)) continue;
            // A lookup result and its selected admission are capabilities too.
            // Resolve their exact lexical bindings, including alias transfers,
            // so a valid fragment cannot authorize later execution or escape.
            const selectionToken = sequence.find((token, index) => token.value === "selection"
              && sequence[index - 1]?.value === "const");
            const acquired = module.originUsage([], { acceptBindings: false, moduleBindings: true,
              originTokens: [tokens[index - 2], selectionToken] });
            acquired.accept(sequence);
            for (const token of acquired.unresolved()) {
              this.#diagnose("A11", module.file, token, [module.file, this.scope.registrationModule],
                `unregistered execution lookup caller or capability escape ${token.value}`);
            }
            usage.accept(sequence);
          }
        }
      }
    }
    for (const token of tokens) {
      if (token.value !== "function") continue;
      const offset = tokens.findIndex((entry) => entry.offset === token.offset);
      const declaration = module.declaration(tokens[offset + 1]?.value);
      if (!declaration || declaration.token.offset !== token.offset) continue;
      if (this.rules.isComposition(module.file)
        && this.#closedRegistrationResolver(module, declaration, [...lookupNames], null)) {
        usage.accept(declaration.tokens);
      }
      const projector = shape.callers.find((caller) => caller.module === module.file && caller.operation === "project");
      if (!projector) continue;
      for (const name of new Set(tokens.filter((entry, index) => entry.value === "const" && tokens[index + 1]?.kind === "identifier")
        .map((entry) => tokens[tokens.indexOf(entry) + 1].value))) {
        const initializer = declaration.topLevelInitializer(name);
        if (initializer?.matches(`target.scope === "flow" && ${projector.lookupName}(target.stepId) !== null
          ? ${projector.declarationName}({ ctx, stepId: target.stepId }) : null`)) usage.accept(initializer.tokens);
      }
    }
  }

  #closedRegistrationResolver(module, declaration, required, guardMessage) {
    const initializer = declaration?.topLevelInitializer("registration");
    const calls = initializer ? readInvocations({ tokens: initializer.tokens }) : [];
    if (calls.length === 0 || calls.some((call) => call.constructed || call.arguments.length !== 1
      || call.arguments[0].length !== 1 || call.arguments[0][0].value !== "stepId")) return false;
    const lookups = calls.map((call) => call.name);
    if (!required.every((name) => lookups.includes(name)) || new Set(lookups).size !== lookups.length) return false;
    for (const name of lookups) {
      const reference = module.references.find((entry) => entry.bindings.has(name));
      const target = reference && this.#resolve(module.file, reference, [module.file], "A10", true);
      if (!target?.file || !this.rules.isComposition(target.file)) return false;
      const exported = this.#resolveExportBinding(target.file, reference.bindings.get(name), new Set(), "A10");
      if (!exported) return false;
      const lookupModule = this.#module(exported.file, [module.file, exported.file], "A10", true);
      const lookup = lookupModule?.declaration(exported.name);
      const returned = lookup?.returns();
      const mapName = returned?.length === 1 ? returned[0].tokens[0]?.value : null;
      const map = mapName && lookupModule.declaration(mapName);
      const arrayName = map?.tokens[6]?.value;
      if (!mapName || !arrayName || !lookup.matchesFunction("stepId", `return ${mapName}.get(stepId) ?? null;`)
        || !map.matchesDeclaration(`const ${mapName} = new Map(${arrayName}.map((registration) => [registration.stepId, registration]));`)) return false;
    }
    const error = readInvocations({ tokens: declaration.tokens }).find((call) => call.name === "Error" && call.constructed);
    const argument = error?.arguments.length === 1 ? error.arguments[0] : null;
    if (!argument || !(argument.length === 1 && argument[0].kind === "string"
      || new SourceInitializer(argument[0], 0, argument).matches("`Definition leaf ${stepId}`"))) return false;
    const message = guardMessage ?? (argument.length === 1 ? "$STRING_LITERAL"
      : this.#source(module.file).slice(argument[0].offset, argument.at(-1).offset + 1));
    return declaration.matchesFunction("stepId", `
      const registration = ${lookups.map((name) => `${name}(stepId)`).join(" ?? ")};
      if (registration === null && registeredPhaseSteps.has(stepId)) {
        throw new Error(${message});
      }
      return registration;
    `);
  }

  #publicPhaseLookupNames(module) {
    const names = [];
    for (const reference of module.references) {
      const target = this.#resolve(module.file, reference, [module.file], "A10", true);
      if (!target?.file || !this.rules.isComposition(target.file)) continue;
      const source = this.#module(target.file, [module.file, target.file], "A10", true);
      for (const [local, imported] of reference.bindings) {
        const lookup = source?.declaration(imported);
        const mapName = lookup?.returns()[0]?.tokens[0]?.value;
        const map = mapName && source.declaration(mapName);
        const collection = map?.tokens[6]?.value;
        if (!collection || !lookup.matchesFunction("stepId", `return ${mapName}.get(stepId) ?? null;`)
          || !map.matchesDeclaration(`const ${mapName} = new Map(${collection}.map((registration) => [registration.stepId, registration]));`)) continue;
        if (source.exports.some((entry) => entry.reference === null && (entry.local === collection
          || source.declaration(entry.local)?.matchesDeclaration(`const ${entry.local} = Object.freeze(${collection});`)))) names.push(local);
      }
    }
    return names;
  }

  #registeredPhaseCallers(module, operation, selectionMode = "select") {
    const callers = [];
    const publicLookups = this.#publicPhaseLookupNames(module);
    for (let index = 0; index < module.tokens.length; index++) {
      if (module.tokens[index].value !== "function") continue;
      const helper = module.declaration(module.tokens[index + 1]?.value);
      const value = helper?.topLevelInitializer("registration");
      const lookup = value && readInvocations({ tokens: value.tokens })[0];
      if (!lookup || !publicLookups.includes(lookup.name)) continue;
      const caller = new ExecutionCaller(module.file, helper.name, lookup.name, operation, null, selectionMode);
      if (this.#declaredCaller(helper, caller)) callers.push(caller);
    }
    return callers;
  }

  #registeredAdditionalProjection(module, declaration, callers) {
    const bindings = module.originUsage(callers.flatMap((caller) => [caller.lookupName, caller.declarationName]),
      { acceptBindings: false, moduleBindings: true });
    for (const token of declaration?.bodyTokens() ?? []) {
      if (token.value !== "const") continue;
      const index = declaration.tokens.indexOf(token);
      const name = declaration.tokens[index + 1]?.value;
      const value = declaration.topLevelInitializer(name);
      const calls = value ? readInvocations({ tokens: value.tokens }) : [];
      if (calls.length !== 2) continue;
      const [lookup, project] = calls;
      if (!bindings.isOrigin(lookup.token) || !bindings.isOrigin(project.token)) continue;
      if (!callers.some((caller) => caller.lookupName === lookup.name && caller.declarationName === project.name)) continue;
      if (value.matches(`target.scope === "flow" && ${lookup.name}(target.stepId) !== null
        ? ${project.name}({ ctx, stepId: target.stepId }) : null`)) return value;
    }
    return null;
  }

  #lookupSelector(module, lookupName) {
    const reference = module.references.find((entry) => entry.bindings.has(lookupName));
    const target = reference && this.#resolve(module.file, reference, [module.file], "A10", true);
    const source = target?.file && this.#module(target.file, [module.file, target.file], "A10", true);
    const lookup = source?.declaration(reference?.bindings.get(lookupName));
    const mapName = lookup?.returns()[0]?.tokens[0]?.value;
    const map = mapName && source.declaration(mapName);
    const array = map?.tokens[6]?.value && source.declaration(map.tokens[6].value);
    if (!array) return null;
    const contracts = new Set(array.tokens.filter((token, index) => token.value === "executionContract"
      && array.tokens[index + 1]?.value === ":").map((token) => array.tokens[array.tokens.indexOf(token) + 2]?.value));
    if (contracts.size !== 1) return null;
    const [name] = contracts;
    const imported = source.references.find((entry) => entry.bindings.has(name));
    const adapterTarget = imported && this.#resolve(source.file, imported, [source.file], "A10", true);
    const adapter = adapterTarget?.file && this.#module(adapterTarget.file, [source.file, adapterTarget.file], "A10", true);
    const contract = adapter?.declaration(imported?.bindings.get(name));
    const select = contract?.tokens.findIndex((token, index) => token.value === "select" && contract.tokens[index + 1]?.value === ":") ?? -1;
    return select < 0 ? null : contract.tokens[select + 2]?.value ?? null;
  }

  #registeredPhaseDispatchPrefix(module, run) {
    const callers = this.#registeredPhaseCallers(module, "execute", "consume");
    if (callers.length === 0) return "";
    const bindings = module.originUsage(["flowStepExecutionRegistration", ...callers.map((caller) => caller.declarationName)],
      { acceptBindings: false, moduleBindings: true });
    const selected = run?.topLevelInitializer("selectedRegistration");
    const selectionLookup = selected && readInvocations({ tokens: selected.tokens })[0];
    if (!selected?.matches("flowStepExecutionRegistration(stepId)") || !bindings.isOrigin(selectionLookup.token)) return null;
    const invocations = readInvocations({ tokens: run.tokens });
    for (const caller of callers) {
      const terminal = invocations.find((call) => call.name === caller.declarationName);
      if (!terminal || !bindings.isOrigin(terminal.token)) continue;
      const lookup = caller.lookupName;
      const selector = this.#lookupSelector(module, lookup);
      if (selector === null) continue;
      return `
        const selectedRegistration = flowStepExecutionRegistration(stepId);
        if (selectedRegistration?.executionContract.selectorName === "${selector}") {
          const selection = selectedRegistration.executionContract.select({ ctx, stepId, registration: selectedRegistration });
          return ${caller.declarationName}({ ctx, stepId, selection });
        }
      `;
    }
    return null;
  }

  #declaredAdapterBindings(module, shape, contract, consumers) {
    const publicNames = new Set([shape.contractName, shape.projectorName, shape.executorName]);
    // Trace aliases using the shared capability reader, but accept only the
    // already inspected consumer closure and the named contract construction.
    // A transfer into a field or exported alias is not a trusted binding here.
    const accepted = [contract?.tokens ?? []];
    for (const declaration of consumers.values()) accepted.push(declaration.tokens);
    const lookup = module.declaration(shape.callers[0].lookupName);
    const mapName = lookup?.returns()[0]?.tokens[0]?.value;
    const map = mapName && module.declaration(mapName);
    const collectionName = map?.tokens[6]?.value;
    const collection = collectionName && module.declaration(collectionName);
    if (collection) accepted.push(collection.tokens);
    const classes = module.tokens.filter((token, index) => token.value === "class"
      && module.tokens[index + 1]?.kind === "identifier");
    for (const entry of classes) {
      const name = module.tokens[module.tokens.indexOf(entry) + 1].value;
      const constructor = this.#selectedRegistrationConstructor(module, name, shape);
      if (constructor !== null) accepted.push(constructor.tokens);
    }
    this.#declaredBindings(module, [...publicNames, ...consumers.keys()], accepted, "execution adapter", publicNames);
  }

  #declaredBindings(module, origins, accepted, description, publicNames, callableEntries = false) {
    let usage;
    try { usage = module.originUsage(origins, { acceptBindings: false, moduleBindings: true }); }
    catch (error) {
      if (!(error instanceof SourceReadError)) throw error;
      this.#diagnose("A10", module.file, error, [this.scope.registrationModule, module.file],
        `cannot inspect ${description} bindings: ${error.message}`);
      return;
    }
    for (const tokens of accepted) usage.accept(tokens);
    if (callableEntries) {
      // A checked entry is an immutable callable capability. Direct invocation
      // uses it; assignment, aliasing, exporting and capture remain unresolved.
      for (const call of readInvocations(module)) {
        if (origins.has(call.name)) usage.accept([call.token]);
      }
      const registry = module.declaration("FLOW_COMMANDS");
      for (let index = 2; index < (registry?.tokens.length ?? 0); index++) {
        const token = registry.tokens[index];
        const declaration = module.declaration(token.value);
        if (origins.has(token.value) && registry.tokens[index - 2].value === "command"
          && registry.tokens[index - 1].value === ":" && [",", "}"].includes(registry.tokens[index + 1]?.value)
          && declaration?.matchesFunction("", `return import($STRING_LITERAL);`)) usage.accept([token]);
      }
    }
    const explicitPublicNames = new Set();
    for (const name of origins) {
      const declaration = module.declaration(name);
      if (publicNames.has(name) && declaration?.exported && !declaration.defaultExport) explicitPublicNames.add(name);
      if (declaration?.exported && (!publicNames.has(name) || declaration.defaultExport)) {
        const exportKind = publicNames.has(name) ? "default export"
          : declaration.tokens[0].value === "function" ? "exported helper" : "private export";
        this.#diagnose("A10", module.file, declaration.token, [this.scope.registrationModule, module.file],
          `unresolved ${description} binding: ${exportKind} ${name}`);
      }
    }
    const wildcardExports = [];
    for (const exported of module.exports) {
      if (exported.name === "*") {
        wildcardExports.push(exported);
        continue;
      }
      if (!publicNames.has(exported.name)) continue;
      if (exported.reference !== null || exported.name !== exported.local) {
        this.#diagnose("A10", module.file, exported.token ?? exported.reference?.token,
          [this.scope.registrationModule, module.file],
          `unresolved ${description} binding: public export ${exported.name} does not expose its declared binding`);
      } else {
        explicitPublicNames.add(exported.name);
        if (exported.token) usage.accept([exported.token]);
      }
    }
    // ESM's explicit named exports take precedence over wildcard exports. A
    // wildcard cannot establish which binding an otherwise unresolved slot uses.
    for (const exported of wildcardExports) for (const name of publicNames) {
      if (explicitPublicNames.has(name)) continue;
      this.#diagnose("A10", module.file, exported.token ?? exported.reference?.token,
        [this.scope.registrationModule, module.file],
        `unresolved ${description} binding: wildcard export does not establish public binding ${name}`);
    }
    for (const token of usage.unresolved()) this.#diagnose("A10", module.file, token,
      [this.scope.registrationModule, module.file], `unresolved ${description} binding ${token.value}`);
  }

  #declaredLookups() {
    const file = this.scope.registrationModule;
    const module = this.#module(file, [file], "A10", true);
    if (!module) return new Set();
    // Callers and execution forms can share one lookup and selection. Inspect
    // each lookup once, then account for all composition bindings in one pass.
    const names = new Set(this.scope.contract.executionShapes.flatMap((shape) => shape.callers.map((caller) => caller.lookupName)));
    const origins = new Set(names);
    const publicNames = new Set(names);
    const accepted = new Map();
    for (const name of names) this.#declaredLookup(module, name, origins, accepted, publicNames);
    for (const shape of this.scope.contract.executionShapes) for (const caller of shape.callers) {
      if (caller.module !== file) continue;
      const declaration = module.declaration(caller.declarationName);
      if (declaration && this.#declaredCaller(declaration, caller)) accepted.set(declaration.token.offset, declaration.tokens);
    }
    const workerIds = this.scope.registrations.filter((registration) =>
      registration.executionContract?.selectorName === "selectWorkerExecutionAdmission").map((registration) => registration.stepId);
    if (workerIds.length > 0) for (const [name] of module.declarationHeaders) {
      const route = module.declaration(name);
      const call = readInvocations({ tokens: route?.bodyTokens() ?? [] }).find((entry) => names.has(entry.name));
      if (call && route.matchesFunction("stepId", `return [${workerIds.map((id) => `"${id}"`).join(",")}].includes(stepId) ? ${call.name}(stepId) : null;`)) {
        accepted.set(route.token.offset, route.tokens);
      }
    }
    this.#declaredBindings(module, origins, accepted.values(), "execution lookup", publicNames);
    return origins;
  }

  #declaredLookup(module, name, origins, accepted, publicNames) {
    const file = module.file;
    const lookup = module.declaration(name);
    const returned = lookup?.returns();
    const mapName = returned?.length === 1 ? returned[0].tokens[0]?.value : null;
    const map = mapName && module.declaration(mapName);
    const arrayName = map?.tokens[6]?.value;
    const array = arrayName && module.declaration(arrayName);
    const staticCalls = array ? readInvocations({ tokens: array.tokens }).filter((call) => call.name === "StepRegistration") : [];
    const selectedIds = staticCalls.map((call) => {
      const tokens = call.arguments.flat();
      const identity = tokens.findIndex((token, index) => token.value === "stepId" && tokens[index + 1]?.value === ":" && tokens[index + 2]?.kind === "string");
      return identity < 0 ? null : tokens[identity + 2].value;
    });
    const runtimeIds = this.scope.registrations.map((registration) => registration.stepId);
    const completeSelection = selectedIds.length === runtimeIds.length && selectedIds.every((id) => id !== null && runtimeIds.includes(id))
      && new Set(selectedIds).size === selectedIds.length;
    // Constructor arguments are inspected by the registration rules. Here the
    // complete array must contain those constructors directly, without a filter,
    // spread, wrapper, or any other expression changing the selected entries.
    const source = this.#source(file);
    const constructors = staticCalls.map((call) => {
      if (call.arguments.length !== 1) return null;
      const argument = call.arguments[0];
      if (argument[0]?.value !== "{" || argument.at(-1)?.value !== "}") return null;
      return `new StepRegistration(${source.slice(argument[0].offset, argument.at(-1).offset + 1)})`;
    });
    const values = `[${constructors.join(",")}]`;
    const directSelection = constructors.every((entry) => entry !== null) && (["", ","].some((trailing) =>
      array?.matchesDeclaration(`const ${arrayName} = ${values.slice(0, -1)}${trailing}];`))
      || ["", ","].some((trailing) =>
        array?.matchesDeclaration(`const ${arrayName} = Object.freeze(${values.slice(0, -1)}${trailing}]);`)));
    const connected = lookup?.matchesFunction("stepId", `return ${mapName}.get(stepId) ?? null;`)
      && map?.matchesDeclaration(`const ${mapName} = new Map(${arrayName}.map((registration) => [registration.stepId, registration]));`)
      && directSelection && completeSelection;
    if (!connected) {
      this.#diagnose("A10", file, lookup?.token, [file], `lookup ${name} does not cover its full registration selection`);
      return;
    }
    origins.add(mapName);
    origins.add(arrayName);
    // The verified registration selection is public; its lookup Map is private.
    publicNames.add(arrayName);
    accepted.set(lookup.token.offset, lookup.tokens);
    accepted.set(map.token.offset, map.tokens);
    // Only the array binding itself is a checked use: its constructor arguments
    // cannot capture, replace, or leak any of the tracked lookup capabilities.
    accepted.set(array.token.offset, [array.tokens[1]]);
  }

  #jsFiles(relative) {
    return this.repository.list(relative);
  }

  #module(file, trace, rule = "A03", lexicalOnly = false) {
    const cache = lexicalOnly ? this.reverseModules : this.modules;
    if (cache.has(file)) return cache.get(file);
    try {
      const source = this.#source(file);
      const module = new SourceModule(file, source, { lexicalOnly });
      cache.set(file, module);
      return module;
    } catch (error) {
      cache.set(file, null);
      const position = error instanceof SourceReadError ? error : null;
      this.#diagnose(rule, file, position, trace, error instanceof SourceReadError ? error.message : `cannot read source: ${error.message}`);
      return null;
    }
  }

  #source(file) {
    if (!this.sources.has(file)) this.sources.set(file, this.repository.read(file));
    return this.sources.get(file);
  }

  #resolve(from, reference, trace, rule, silent = false) {
    const specifier = reference.specifier;
    const builtin = this.rules.builtin(specifier);
    if (builtin) return { builtin };
    if (!specifier.startsWith(".")) {
      if (!silent) this.#diagnose(rule, from, reference.token, trace, `unresolved bare dependency ${specifier}`);
      return null;
    }
    try {
      const key = `${from}#${specifier}`;
      if (!this.resolvedPaths.has(key)) this.resolvedPaths.set(key, this.repository.resolve(from, specifier));
      return { file: this.resolvedPaths.get(key) };
    }
    catch (error) {
      if (!silent) this.#diagnose(rule, from, reference.token, trace, error.message);
      return null;
    }
  }

  #role(file, module) {
    return this.rules.role(file, module, (entry) => this.#isStepClass(file, module, entry, new Set()));
  }

  #isStepClass(file, module, entry, seen) {
    if (!entry.parent) return false;
    const key = `${file}#${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const parent = this.#resolveLocal(file, module, entry.parent, new Set(), "A01");
    if (!parent) {
      if (nativeClassBases.has(entry.parent) && module.isUnbound(entry.parent, entry.parentToken)) return false;
      if (!this.unresolvedHeritage.has(key)) {
        this.unresolvedHeritage.add(key);
        this.#diagnose("A01", file, entry.token, [file], `cannot resolve class heritage ${entry.parent}`);
      }
      return false;
    }
    return this.rules.isStepBase(parent.file, parent.classEntry.name)
      || this.#isStepClass(parent.file, parent.module, parent.classEntry, seen);
  }

  #resolveLocal(file, module, name, seen, rule) {
    // An import owns this module binding. A named class expression elsewhere
    // can reuse its name without replacing that binding.
    const reference = module.references.find((entry) => entry.kind === "import" && entry.bindings.has(name));
    if (reference) {
      const target = this.#resolve(file, reference, [file], rule, true);
      return target?.file ? this.#resolveExport(target.file, reference.bindings.get(name), seen, rule) : null;
    }
    // The class index also contains nested declarations and named expressions.
    // Only the module declaration can supply a local type binding here.
    const declaration = module.declaration(name);
    const local = module.classes.find((entry) => entry.name === name
      && entry.token.offset === declaration?.token.offset);
    return local ? new ResolvedSourceClass(file, module, local) : null;
  }

  #resolveExport(file, name, seen, rule) {
    const key = `${file}#${name}`;
    if (this.exports.has(key)) return this.exports.get(key);
    const binding = this.#resolveExportBinding(file, name, seen, rule);
    if (!(binding instanceof ResolvedSourceBinding) || binding.header.token.value !== "class") return null;
    const module = this.#module(binding.file, [file, binding.file], rule);
    const entry = module?.classes.find((candidate) => candidate.name === binding.name
      && candidate.token.offset === binding.header.token.offset);
    const resolved = entry ? new ResolvedSourceClass(binding.file, module, entry) : null;
    if (resolved) this.exports.set(key, resolved);
    return resolved;
  }

  #resolveLocalBinding(file, module, name, seen, rule) {
    const imported = module.references.find((entry) => entry.kind === "import" && entry.bindings.has(name));
    if (imported) {
      const target = this.#resolve(file, imported, [file], rule, true);
      return target?.file ? this.#resolveExportBinding(target.file, imported.bindings.get(name), seen, rule)?.through(file) ?? null : null;
    }
    const header = module.declarationHeader(name);
    return header ? new ResolvedSourceBinding(file, module, header) : null;
  }

  #resolveExportBinding(file, name, seen, rule) {
    const key = `${file}#${name}`;
    if (name === "*") return new ResolvedSourceNamespace(file);
    if (seen.has(key)) return null;
    if (this.bindingExports.has(key)) return this.bindingExports.get(key);
    const root = seen.size === 0;
    seen.add(key);
    // Export provenance does not require scope/global analysis. In particular,
    // unrelated reverse-index modules may contain lexical-only var declarations.
    const module = this.#module(file, [file], rule, true);
    if (!module) { seen.delete(key); return null; }
    const matches = [];
    const explicit = module.exports.filter((entry) => entry.name === name);
    const candidates = explicit.length ? explicit : module.exports.filter((entry) => entry.name === "*" && name !== "default");
    for (const binding of candidates) {
      if (binding.reference) {
        const target = this.#resolve(file, binding.reference, [file], rule, true);
        if (target?.file && binding.local !== "*") {
          const resolved = this.#resolveExportBinding(target.file, binding.local, seen, rule);
          if (resolved) matches.push(resolved);
        } else if (target?.file && binding.name !== "*") {
          matches.push(new ResolvedSourceNamespace(target.file));
        } else if (target?.file && binding.name === "*") {
          const resolved = this.#resolveExportBinding(target.file, name, seen, rule);
          if (resolved) matches.push(resolved);
        }
      } else if (binding.local !== "*") {
        const resolved = this.#resolveLocalBinding(file, module, binding.local, seen, rule);
        if (resolved) matches.push(resolved);
      }
    }
    seen.delete(key);
    const unique = new Map(matches.map((entry) => [entry.key, entry]));
    const resolved = unique.size === 1 ? unique.values().next().value.through(file) : null;
    if (unique.size > 1 && !this.ambiguousExports.has(`${rule}:${key}`)) {
      this.ambiguousExports.add(`${rule}:${key}`);
      this.#diagnose(rule, file, null, [file], `ambiguous export ${name}`);
    }
    // A recursive query can have a cycle-truncated view. Only completed root
    // queries are independent of that traversal path and safe to cache.
    if (root && resolved) this.bindingExports.set(key, resolved);
    return resolved;
  }

  #exportedNames(file, seen = new Set()) {
    if (this.exportNames.has(file)) return this.exportNames.get(file);
    if (seen.has(file)) return new Set();
    const root = seen.size === 0;
    seen.add(file);
    const module = this.#module(file, [file], "A11", true);
    const names = new Set();
    for (const binding of module?.exports ?? []) {
      if (binding.name !== "*") { names.add(binding.name); continue; }
      const target = this.#resolve(file, binding.reference, [file], "A11", true);
      if (target?.file) for (const name of this.#exportedNames(target.file, seen)) if (name !== "default") names.add(name);
    }
    seen.delete(file);
    if (root) this.exportNames.set(file, names);
    return names;
  }

  #registrationIndex(entries) {
    const index = new Map();
    const compositionImports = new Map();
    for (const file of [this.scope.registrationModule]) {
      const module = this.#module(file, [file], "A01");
      if (!module) continue;
      for (const reference of module.references.filter((entry) => entry.kind === "import")) {
        const target = this.#resolve(file, reference, [file], "A01");
        if (!target?.file) continue;
        for (const importedName of reference.bindings.values()) {
          const resolved = this.#resolveExport(target.file, importedName, new Set(), "A01");
          if (!resolved) continue;
          if (!compositionImports.has(resolved.classEntry.name)) compositionImports.set(resolved.classEntry.name, new Map());
          compositionImports.get(resolved.classEntry.name).set(resolved.key, resolved);
        }
      }
    }
    if (this.scope.registrations.length === 0) this.#diagnose("A01", this.scope.entry, null, [this.scope.entry], "scope has no production registrations");
    const ids = new Set();
    for (const registration of this.scope.registrations) {
      const name = registration.StepClass?.name;
      const matches = [...(compositionImports.get(name)?.values() ?? [])];
      if (ids.has(registration.stepId)) this.#diagnose("A01", this.scope.entry, null, [this.scope.entry], `duplicate registration ${registration.stepId}`);
      ids.add(registration.stepId);
      if (matches.length !== 1) {
        this.#diagnose("A01", this.scope.entry, null, [this.scope.entry], `registered class ${name} has ${matches.length} source declarations`);
        continue;
      }
      const match = matches[0];
      if (!index.has(match.file)) index.set(match.file, []);
      if (index.get(match.file).some((item) => item.StepClass === registration.StepClass)) this.#diagnose("A01", match.file, match.classEntry.token, [match.file], "duplicate Step class registration");
      index.get(match.file).push(registration);
      if (!this.rules.isWithinEntry(match.file, this.scope.entry)) this.#diagnose("A01", match.file, match.classEntry.token, [match.file], "registered Step is outside scope entry");
      if (!this.#isStepClass(match.file, match.module, match.classEntry, new Set())) this.#diagnose("A01", match.file, match.classEntry.token, [match.file], "registered class does not extend Step");
      if (!this.#isExportedClass(match)) this.#diagnose("A01", match.file, match.classEntry.token, [match.file], "registered Step class is not exported");
      const declared = match.classEntry.dependencies;
      const actual = registration.StepClass.dependencies.map((dependency) => dependency.name);
      const sources = declared.map((dependency) => this.#dependencySource(match.module, dependency));
      const declaredTypes = sources.map((source) => source?.sourceClass?.classEntry.name);
      if (declaredTypes.length !== actual.length || declaredTypes.some((value, i) => value !== actual[i])) this.#diagnose("A01", match.file, match.classEntry.token, [match.file], "runtime dependencies differ from static declaration");
      if (registration.ServiceClass) {
        if (declared.length !== 1 || registration.ServiceClass.name !== actual[0]) {
          this.#diagnose("A08", match.file, match.classEntry.token, [match.file], "registered Service differs from Step dependency");
        }
        const service = sources[0]?.sourceClass;
        if (service && service.classEntry.name === registration.ServiceClass.name) {
          this.registeredServices.set(service.key, service);
          const staticTypes = service.classEntry.argumentTypes;
          for (const typeName of staticTypes) {
            const type = this.#resolveLocal(service.file, service.module, typeName, new Set(), "A12");
            if (type) this.argumentTypeKeys.add(type.key);
          }
          const runtimeTypes = registration.ServiceClass.argumentTypes?.map((Type) => Type.name) ?? [];
          if (staticTypes.length !== runtimeTypes.length || staticTypes.some((name, index) => name !== runtimeTypes[index])) {
            this.#diagnose("A12", service.file, service.classEntry.token, [service.file], "runtime Service argumentTypes differ from static declaration");
          }
        }
        this.#registrationContract(registration, match, service);
      }
      for (let i = 0; i < declared.length; i++) {
        const dependency = declared[i];
        const source = sources[i];
        if (!source) { this.#diagnose("A02", match.file, match.classEntry.token, [match.file], `dependency ${dependency} is not imported`); continue; }
        if (source.target && (!this.rules.isService(source.target) || source.sourceClass?.file !== source.target
          || !source.sourceClass || !this.#isExportedClass(source.sourceClass)
          || this.#isStepClass(source.sourceClass.file, source.sourceClass.module, source.sourceClass.classEntry, new Set()))) {
          this.#diagnose("A02", match.file, source.reference.token, [match.file, source.target], `${dependency} is not an exported non-Step Service class`);
        }
      }
    }
    for (const file of entries) {
      const module = this.#module(file, [file]);
      if (!module) continue;
      const role = this.#role(file, module);
      if (role === "step") for (const classEntry of module.classes.filter((entry) => this.#isStepClass(file, module, entry, new Set()))) {
        if (!index.get(file)?.some((item) => item.StepClass.name === classEntry.name)) this.#diagnose("A01", file, classEntry.token, [file], "Step has no production registration");
      }
    }
    return index;
  }

  #registrationContract(registration, step, service) {
    const file = this.scope.registrationModule;
    const module = this.#module(file, [file], "A08");
    if (!module) return;
    const prepareName = registration.prepareServiceArguments?.name;
    if (!prepareName || !/^[A-Za-z_$][\w$]*$/.test(prepareName)) {
      this.#diagnose("A08", file, step.classEntry.token, [file], "Service preparation must be a named function");
      return;
    }
    const calls = readInvocations(module).filter((call) => call.identifiers().has(step.classEntry.name) && call.literals().has(registration.stepId));
    const matching = calls.filter((call) => {
      const names = call.identifiers();
      const helperNames = this.#registrationHelperNames(module, call.name);
      return (names.has(registration.ServiceClass.name) && names.has(prepareName)
        || helperNames.has(registration.ServiceClass.name) && helperNames.has(prepareName))
        && (!registration.ConnectorClass || names.has(registration.ConnectorClass.name)
          || helperNames.has(registration.ConnectorClass.name));
    });
    if (matching.length !== 1) {
      this.#diagnose("A08", file, calls[0]?.token, [file, step.file], `registration has ${matching.length} static Service/prepare/Connector matches for ${registration.stepId}`);
    }
    const shape = this.scope.contract?.executionShapes.find((entry) => entry.matches(registration.executionContract));
    const kind = this.#executionKind(registration);
    const adapter = sharedExecutionAdapters.get(kind);
    const contractName = shape?.contractName ?? adapter?.contractName;
    const contractSource = shape?.adapterModule ?? adapter?.module;
    const contractReference = module.references.find((reference) => reference.bindings.get(contractName) === contractName);
    const contractTarget = contractReference && this.#resolve(file, contractReference, [file], "A10");
    const localContract = contractSource === file && module.declaration(contractName) !== null;
    if (!localContract && contractTarget?.file !== contractSource) {
      this.#diagnose("A10", file, matching[0]?.token, [file], `registration must import named ${contractName}`);
    }
    const contractDeclaration = module.declaration(matching[0]?.name ?? "");
    const contractTokens = [...(matching[0]?.arguments.flat() ?? []), ...(contractDeclaration?.tokens ?? [])];
    if (!contractTokens.some((token, index) => token.value === "executionContract"
      && contractTokens[index + 1]?.value === ":" && contractTokens[index + 2]?.value === contractName)) {
      this.#diagnose("A10", file, matching[0]?.token, [file], `registration does not use named ${contractName}`);
    }
    const preparation = module.references.find((reference) => reference.bindings.has(prepareName));
    if (preparation) {
      const target = this.#resolve(file, preparation, [file], "A08");
      if (target?.file) this.#inspectPreparation(target.file, prepareName, [file, target.file], service);
    } else if (!module.tokens.some((token, index) => token.value === "function" && module.tokens[index + 1]?.value === prepareName)) {
      this.#diagnose("A08", file, null, [file], `cannot resolve Service preparation ${prepareName}`);
    } else this.#inspectPreparation(file, prepareName, [file], service);
  }

  #registrationHelperNames(module, name) {
    const tokens = module.tokens;
    const start = tokens.findIndex((token, index) => token.value === "function" && tokens[index + 1]?.value === name);
    if (start < 0) return new Set();
    let open = start + 2;
    while (open < tokens.length && tokens[open].value !== "{") open++;
    if (open === tokens.length) return new Set();
    let depth = 1;
    let end = open + 1;
    while (end < tokens.length && depth > 0) {
      if (tokens[end].value === "{") depth++;
      if (tokens[end].value === "}") depth--;
      end++;
    }
    const body = tokens.slice(open + 1, end - 1);
    if (!body.some((token, index) => token.value === "new" && body[index + 1]?.value === "StepRegistration")) return new Set();
    return new Set(body.filter((token) => token.kind === "identifier").map((token) => token.value));
  }

  #inspectPreparation(file, name, trace, service) {
    const module = this.#module(file, trace, "A08");
    if (!module) return;
    this.#inspectTopLevelEffects(file, module, trace);
    const tokens = module.tokens;
    const declaration = tokens.findIndex((token, index) => token.value === "function" && tokens[index + 1]?.value === name);
    if (declaration < 0) {
      this.#diagnose("A08", file, null, trace, `cannot resolve named preparation ${name}`);
      return;
    }
    const forbidden = new Set(["ctx", "manager", "flowManager", "container", "callback"]);
    for (let index = declaration + 2; index < tokens.length && tokens[index].value !== "{"; index++) {
      if (forbidden.has(tokens[index].value)) this.#diagnose("A08", file, tokens[index], trace, `preparation accepts broad dependency ${tokens[index].value}`);
    }
    if (service) this.#inspectServiceArguments(service, module, name, trace);
  }

  #inspectServiceArguments(service, preparationModule, preparationName, trace, seen = new Set()) {
    if (seen.has(preparationName)) return false;
    seen.add(preparationName);
    const constructor = readClassMember(service.module, service.classEntry.name, "constructor");
    const invariants = readTypeInvariants(constructor);
    const parameters = readParameters(constructor?.tokens ?? []);
    const expected = parameters.map((parameter) => parameter.length === 1
      ? invariants.find((entry) => entry.parameter === parameter[0].value)?.typeName ?? null : null);
    if (expected.length !== 2 || expected.some((name) => name === null)) {
      this.#diagnose("A12", service.file, service.classEntry.token, [service.file], "Service constructor must validate typed input and settlement writer");
      return false;
    }
    if (service.classEntry.argumentTypes.length !== 2
      || service.classEntry.argumentTypes.some((name, index) => name !== expected[index])) {
      this.#diagnose("A12", service.file, service.classEntry.token, [service.file],
        `Service argumentTypes differs from constructor ${expected.join(", ")}`);
    }
    const declaration = preparationModule.declaration(preparationName);
    if (!declaration) return false;
    const tokens = declaration.tokens;
    const allocations = new Map();
    const tainted = new Set(["ctx", "manager", "flowManager", "container"]);
    for (let index = 0; index < tokens.length - 3; index++) {
      if (!["const", "let"].includes(tokens[index].value) || tokens[index + 2]?.value !== "=") continue;
      const next = tokens[index + 3]?.value === "await" ? index + 4 : index + 3;
      if (tokens[next]?.value === "new" && tokens[next + 1]?.kind === "identifier") allocations.set(tokens[index + 1].value, tokens[next + 1].value);
      let end = index + 3;
      while (end < tokens.length && tokens[end].value !== ";") end++;
      const value = tokens.slice(index + 3, end);
      if (value.some((token) => tainted.has(token.value)) && !value.some((token) => token.value === "(")) {
        tainted.add(tokens[index + 1].value);
      }
    }
    for (let index = 0; index < tokens.length - 2; index++) {
      if (tokens[index].value !== "new" || tokens[index + 2]?.value !== "("
        || !this.#argumentSubtype(preparationModule, tokens[index + 1]?.value, service, expected[0])) continue;
      let depth = 0;
      let end = index + 2;
      for (; end < tokens.length; end++) {
        if (tokens[end].value === "(") depth++;
        if (tokens[end].value === ")" && --depth === 0) break;
      }
      const argument = tokens.slice(index + 3, end);
      const leak = argument.find((token, offset) => token.kind === "identifier" && tainted.has(token.value)
        && argument[offset + 1]?.value !== ":");
      if (leak) this.#diagnose("A12", preparationModule.file, leak, trace, `typed input receives broad dependency ${leak.value}`);
    }
    let arrays = 0;
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index].value !== "return" || tokens[index + 1].value !== "[") continue;
      arrays++;
      const elements = [];
      const stack = [];
      let start = index + 2;
      let arrayEnd = -1;
      for (let cursor = start; cursor < tokens.length; cursor++) {
        const value = tokens[cursor].value;
        if (value === "]" && stack.length === 0) {
          elements.push(tokens.slice(start, cursor));
          arrayEnd = cursor;
          break;
        }
        if (["(", "[", "{"].includes(value)) stack.push(value);
        else if ([")", "]", "}"].includes(value)) stack.pop();
        else if (value === "," && stack.length === 0) {
          elements.push(tokens.slice(start, cursor));
          start = cursor + 1;
        }
      }
      const actual = elements.map((element) => {
        if (element.length === 1 && element[0].kind === "identifier") return allocations.get(element[0].value);
        if (element[0]?.value !== "new" || element[1]?.kind !== "identifier" || element[2]?.value !== "(") return undefined;
        let depth = 0;
        let end = 2;
        for (; end < element.length; end++) {
          if (element[end].value === "(") depth++;
          if (element[end].value === ")" && --depth === 0) break;
        }
        return end === element.length - 1 ? element[1].value : undefined;
      });
      if (actual.length !== 2 || actual.some((name, offset) => !this.#argumentSubtype(preparationModule, name, service, expected[offset]))) {
        this.#diagnose("A12", preparationModule.file, tokens[index], trace,
          `preparation returns ${actual.join(", ")} instead of ${expected.join(", ")}`);
      }
      if (arrayEnd < 0 || ![";", "}"].includes(tokens[arrayEnd + 1]?.value)) {
        this.#diagnose("A12", preparationModule.file, tokens[index], trace,
          "preparation return uses an unresolved expression around typed arguments");
      }
    }
    let found = arrays > 0;
    for (let index = 0; index < tokens.length - 2; index++) {
      if (tokens[index].value !== "return" || tokens[index + 1]?.kind !== "identifier"
        || tokens[index + 2]?.value !== "(") continue;
      const delegated = tokens[index + 1].value;
      if (preparationModule.declaration(delegated)) {
        found = this.#inspectServiceArguments(service, preparationModule, delegated, trace, seen) || found;
      }
    }
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index].value !== "return" || tokens[index + 1]?.value === "[") continue;
      if (tokens[index + 1]?.value === "null" && [";", "}"].includes(tokens[index + 2]?.value)) continue;
      if (tokens[index + 1]?.value === "new" && tokens[index + 2]?.value === "PreparedStepReplay") {
        const replayImport = preparationModule.references.find((entry) =>
          entry.bindings.get("PreparedStepReplay") === "PreparedStepReplay");
        if (replayImport && this.#resolve(preparationModule.file, replayImport, trace, "A12")?.file
          === "src/flow/engine/composition/step-registration.js") continue;
      }
      if (tokens[index + 1]?.kind === "identifier" && tokens[index + 2]?.value === "("
        && preparationModule.declaration(tokens[index + 1].value)) continue;
      this.#diagnose("A12", preparationModule.file, tokens[index], trace,
        "preparation return cannot be statically resolved to typed arguments");
    }
    if (!found) this.#diagnose("A12", preparationModule.file, declaration.token, trace, "preparation has no static typed Service argument pair");
    return found;
  }

  #argumentSubtype(preparation, actualName, service, expectedName) {
    if (!actualName || !expectedName) return false;
    const expected = this.#resolveLocal(service.file, service.module, expectedName, new Set(), "A12");
    let actual = this.#resolveLocal(preparation.file, preparation, actualName, new Set(), "A12");
    const seen = new Set();
    while (actual && !seen.has(actual.key)) {
      if (actual.key === expected?.key) return true;
      seen.add(actual.key);
      actual = this.#resolveLocal(actual.file, actual.module, actual.classEntry.parent, new Set(), "A12");
    }
    return false;
  }

  #serviceDependencies() {
    for (const service of this.registeredServices.values()) {
      this.#inspectService(service.file, service.classEntry.name, [service.file], new Set());
    }
  }

  #trackServiceBinding(file, module, name, trace, seen = new Set()) {
    const key = `${file}#${name}`;
    if (this.registeredServices.has(key) || this.argumentTypeKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    const declaration = module.declaration(name);
    if (!declaration) return false;
    let callable = declaration.callable;
    const alias = declaration.referenceInitializer();
    if (!callable && alias) {
      const target = this.#resolveLocalBinding(file, module, alias, new Set(), "A08");
      callable = target !== null && this.#trackServiceBinding(target.file, target.module, target.name,
        [...trace, ...target.route.filter((entry) => entry !== file)], seen);
    }
    if (!callable) return false;
    if (!this.serviceBindings.has(file)) this.serviceBindings.set(file, new Map());
    const bindings = this.serviceBindings.get(file);
    if (!bindings.has(name)) bindings.set(name, trace);
    return true;
  }

  #serviceBindingWrites() {
    for (const [file, bindings] of this.serviceBindings) {
      const module = this.#module(file, [file], "A08");
      if (!module) continue;
      for (const write of module.bindingWrites(bindings.keys())) {
        this.#diagnose("A08", file, write.token, bindings.get(write.binding.name),
          `Service dependency binding ${write.binding.name} may be replaced after its declaration`);
      }
    }
  }

  #serviceParent(owner, trace, ancestry = new Set()) {
    const entry = owner.classEntry;
    if (!entry.parent) return null;
    const parent = this.#resolveLocal(owner.file, owner.module, entry.parent, new Set(), "A08");
    if (!parent) {
      if (!nativeClassBases.has(entry.parent) || !owner.module.isUnbound(entry.parent, entry.parentToken)) {
        this.#diagnose("A08", owner.file, entry.parentToken, trace,
          `cannot resolve Service helper heritage ${entry.parent}`);
      }
      return null;
    }
    if (ancestry.has(parent.key)) {
      this.#diagnose("A08", owner.file, entry.parentToken, trace, "cyclic Service helper heritage");
      return null;
    }
    this.#trackServiceBinding(parent.file, parent.module, parent.classEntry.name,
      parent.file === owner.file ? trace : [...trace, parent.file]);
    return parent;
  }

  #serviceMember(module, name, member, trace, receiver) {
    const members = module.classMembers(name);
    const unresolved = members?.unresolvedMember(receiver.isStatic);
    if ((member !== "constructor" || receiver.isStatic) && unresolved) {
      this.#diagnose("A08", module.file, unresolved, trace, "Service helper has an unresolved computed member declaration");
    }
    return members?.member(member, { isStatic: receiver.isStatic }) ?? null;
  }

  #inspectInstanceInitializers(owner, receiver, trace, seen) {
    for (const initializer of owner.module.classMembers(owner.classEntry.name)?.instanceInitializers ?? []) {
      this.#inspectServiceDeclaration(owner.file, owner.module, owner.classEntry.name, initializer, trace, seen, null, receiver);
    }
  }

  #inspectService(file, name, trace, seen, member = null, exported = false, receiver = null) {
    if (exported) {
      const binding = this.#resolveExportBinding(file, name, new Set(), "A08");
      if (!binding) {
        this.#diagnose("A08", file, null, trace, `cannot resolve exported Service dependency ${name}`);
        return;
      }
      trace = [...trace, ...binding.route.filter((entry) => entry !== file)];
      file = binding.file;
      name = binding.name;
    }
    let module = this.#module(file, trace, "A08");
    if (!module) return;
    const ownerClass = member === null ? null : this.#resolveLocal(file, module, name, new Set(), "A08");
    if (receiver === null && ownerClass) receiver = new ServiceClassReceiver(ownerClass, false);
    const key = `${file}#${name}${member === null ? "" : `.${member}@${receiver?.key ?? ""}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    this.#inspectTopLevelEffects(file, module, trace);
    if (member === "constructor" && !receiver?.isStatic && ownerClass) this.#inspectInstanceInitializers(ownerClass, receiver, trace, seen);
    let declaration = member === null ? module.declaration(name) : this.#serviceMember(module, name, member, trace, receiver);
    if (member !== null && !declaration) {
      let owner = ownerClass;
      const ancestry = new Set();
      while (owner && !declaration) {
        ancestry.add(owner.key);
        const parent = this.#serviceParent(owner, trace, ancestry);
        if (!parent) return;
        owner = parent;
        if (file !== owner.file) trace = [...trace, owner.file];
        file = owner.file;
        name = owner.classEntry.name;
        module = owner.module;
        this.#inspectTopLevelEffects(file, module, trace);
        if (member === "constructor" && !receiver.isStatic) this.#inspectInstanceInitializers(owner, receiver, trace, seen);
        declaration = this.#serviceMember(module, name, member, trace, receiver);
      }
    }
    if (!declaration) {
      if (member !== null) return;
      const reference = module.references.find((entry) => entry.kind === "import" && entry.bindings.has(name));
      if (reference) {
        const target = this.#resolve(file, reference, trace, "A08");
        if (target?.file) this.#inspectService(target.file, reference.bindings.get(name), [...trace, target.file], seen, null, true);
      } else this.#diagnose("A08", file, null, trace, `cannot resolve Service dependency ${name}`);
      return;
    }
    if (member === null) this.#trackServiceBinding(file, module, name, trace);
    if (member === null && this.argumentTypeKeys.has(`${file}#${name}`)) {
      const tokens = readClassMember(module, name, "constructor")?.tokens ?? [];
      for (let index = 0; index < tokens.length - 3; index++) {
        if (tokens[index].value !== "this" || tokens[index + 1]?.value !== ".") continue;
        const assignment = tokens[index + 2]?.value === "#" ? index + 3 : index + 2;
        if (tokens[assignment + 1]?.value !== "=" || tokens[assignment + 2]?.kind !== "identifier") continue;
        const source = tokens[assignment + 2].value;
        const checked = tokens.some((token, offset) => token.value === source
          && (["instanceof", ">", "<"].includes(tokens[offset + 1]?.value)
            || ["instanceof", ">", "<"].includes(tokens[offset - 1]?.value)
            || (tokens[offset + 1]?.value === "!" && tokens[offset + 2]?.value === "=" && tokens[offset + 3]?.value === "=")
            || (tokens[offset + 1]?.value === "=" && tokens[offset + 2]?.value === "=")
            || (tokens[offset - 1]?.value === "=" && tokens[offset - 2]?.value === "=")
            || tokens[offset - 1]?.value === "typeof"
            || (tokens[offset - 1]?.value === "(" && ["includes", "isInteger"].includes(tokens[offset - 2]?.value))));
        if (!checked) this.#diagnose("A08", file, tokens[assignment + 2], trace,
          `typed input retains unvalidated constructor value ${source}`);
      }
    }
    this.#inspectServiceDeclaration(file, module, name, declaration, trace, seen, member, receiver);
  }

  #inspectServiceDeclaration(file, module, name, declaration, trace, seen, member = null, receiver = null) {
    const broadDependencies = new Set(["ctx", "manager", "flowManager", "container"]);
    const broad = declaration.tokens.find((token) => token.kind === "identifier" && broadDependencies.has(token.value));
    if (broad) this.#diagnose("A08", file, broad, trace, `Service or input retains broad dependency ${broad.value}`);
    const selectedOffsets = new Set(declaration.tokens.map((token) => token.offset));
    const dynamic = [...module.dynamic, ...module.globals].find((token) => selectedOffsets.has(token.offset));
    if (dynamic) {
      const token = dynamic;
      this.#diagnose("A08", file, token, trace, `Service reads or dynamically loads external state through ${token.value}`);
    }
    if (broad || dynamic) return;
    for (const token of declaration.tokens) {
      if (token.kind !== "identifier" || token.value === name || !module.declaration(token.value)) continue;
      this.#inspectService(file, token.value, trace, seen);
    }
    if (receiver !== null) {
      for (let index = 0; index < declaration.tokens.length; index++) {
        const token = declaration.tokens[index];
        if (!["this", "super"].includes(token.value)) continue;
        const constructor = token.value === "super" && declaration.tokens[index + 1]?.value === "(";
        const access = constructor ? null : readMemberAccess(declaration.tokens, index);
        if (access?.name === null) {
          this.#diagnose("A08", file, access.token, trace, "Service helper uses unresolved computed member or invocation");
          continue;
        }
        const next = constructor ? "constructor" : access?.name;
        if (!next) continue;
        if (token.value === "super") {
          const owner = this.#resolveLocal(file, module, name, new Set(), "A08");
          const parent = owner && this.#serviceParent(owner, trace, new Set([owner.key]));
          if (parent) this.#inspectService(parent.file, parent.classEntry.name,
            parent.file === file ? trace : [...trace, parent.file], seen, next, false, receiver);
        } else if (next !== member) {
          const targetFile = next.startsWith("#") ? file : receiver.value.file;
          const targetName = next.startsWith("#") ? name : receiver.value.classEntry.name;
          this.#inspectService(targetFile, targetName, trace, seen, next, false, receiver);
        }
      }
    }
    for (const reference of module.references) {
      if (reference.kind === "dynamic") continue;
      if (reference.bindings.size === 0) {
        this.#diagnose("A08", file, reference.token, trace, "Service dependency has side-effect-only import");
        continue;
      }
      const used = [...reference.bindings].filter(([local]) => declaration.uses(local));
      if (used.length === 0) continue;
      const target = this.#resolve(file, reference, trace, "A08");
      if (!target) continue;
      if (target.builtin) {
        if (!this.rules.allowsBuiltin(target.builtin)) this.#diagnose("A08", file, reference.token, trace, `Service reaches IO builtin ${target.builtin}`);
        continue;
      }
      const nextModule = this.#module(target.file, [...trace, target.file], "A08");
      if (!nextModule) continue;
      if (this.rules.isDefinitionBoundary(target.file)) continue;
      if (this.rules.isSettlementWriter(target.file)) {
        this.#inspectSettlementWriter(target.file, [...trace, target.file]);
        continue;
      }
      const role = this.#role(target.file, nextModule);
      if (role === "forbidden" || role === "composition" || role === "step") {
        for (const [local, imported] of used) {
          const value = this.#resolveExport(target.file, imported, new Set(), "A08");
          if (role === "forbidden" && value && !/(?:Store|Manager|Registry|Dispatcher|Command)$/.test(value.classEntry.name)) {
            this.#inspectReferencedClass(value, local, declaration, file, [...trace, value.file], seen);
          } else this.#diagnose("A08", file, reference.token, [...trace, target.file], `Service reaches ${role}`);
        }
      } else if (role === "helper" || role === "service" || role === "contract") {
        for (const [local, imported] of used) {
          const value = this.#resolveExport(target.file, imported, new Set(), "A08");
          if (value && !this.argumentTypeKeys.has(value.key)) {
            this.#inspectReferencedClass(value, local, declaration, file, [...trace, value.file], seen);
          } else this.#inspectService(target.file, imported, [...trace, target.file], seen, null, true);
        }
      }
    }
  }

  #inspectReferencedClass(value, local, caller, callerFile, trace, seen) {
    this.#trackServiceBinding(value.file, value.module, value.classEntry.name, trace);
    const tokens = caller.tokens;
    const classUsage = new SourceOriginUsage(caller, [local], { mutableAliases: true });
    const instances = new Set();
    const indexes = new Map(tokens.map((token, index) => [token.offset, index]));
    const inspect = (access, isStatic) => {
      if (!access) return;
      if (access.name === null) this.#diagnose("A08", callerFile, access.token, trace,
        "Service helper uses unresolved computed member or invocation");
      else this.#inspectService(value.file, value.classEntry.name, trace, seen, access.name, false, new ServiceClassReceiver(value, isStatic));
    };
    for (const invocation of readInvocations(caller)) {
      if (!invocation.constructed || !classUsage.isOrigin(invocation.token)) continue;
      this.#inspectService(value.file, value.classEntry.name, trace, seen, "constructor");
      const start = indexes.get(invocation.token.offset) - 1;
      inspect(readMemberAccess(tokens, indexes.get(invocation.endToken.offset), start), false);
      if (tokens[start - 1]?.value === "=" && tokens[start - 2]?.kind === "identifier") instances.add(tokens[start - 2].value);
    }
    const instanceUsage = new SourceOriginUsage(caller, instances, { mutableAliases: true });
    for (let index = 0; index < tokens.length; index++) {
      if (!classUsage.isOrigin(tokens[index]) && !instanceUsage.isOrigin(tokens[index])) continue;
      // Construction was inspected above; its argument list is not a member.
      if (tokens[index - 1]?.value === "new") continue;
      const access = readMemberAccess(tokens, index);
      if (classUsage.isOrigin(tokens[index])) inspect(access, true);
      if (instanceUsage.isOrigin(tokens[index])) inspect(access, false);
    }
  }

  #inspectSettlementWriter(file, trace) {
    const module = this.#module(file, trace, "A08");
    if (!module) return;
    this.#inspectTopLevelEffects(file, module, trace);
    const forbidden = new Set(["read", "load", "get", "find", "query", "canonicalState", "loadReadOnly", "assertCurrent"]);
    for (let index = 0; index < module.tokens.length - 1; index++) {
      const token = module.tokens[index];
      if (token.kind !== "identifier" || module.tokens[index + 1]?.value !== "(") continue;
      if (forbidden.has(token.value) || [...forbidden].some((prefix) => token.value.startsWith(prefix) && /^[A-Z]/.test(token.value[prefix.length] ?? ""))) {
        this.#diagnose("A08", file, token, trace, `settlement writer exposes or calls read operation ${token.value}`);
      }
    }
    for (const token of [...module.dynamic, ...module.globals]) {
      this.#diagnose("A08", file, token, trace, `settlement writer dynamically reads external state through ${token.value}`);
    }
    const writerDeclarations = module.classes.map((entry) => module.declaration(entry.name)).filter(Boolean);
    for (const entry of module.classes) this.#inspectWriterOrigin(file, entry.name, trace, new Set(), new Set());
    for (const reference of module.references.filter((entry) => entry.kind === "import")) {
      const used = [...reference.bindings].filter(([local]) => writerDeclarations.some((entry) => entry.uses(local)));
      if (used.length === 0) continue;
      const target = this.#resolve(file, reference, trace, "A08");
      if (!target) continue;
      if (target.builtin) {
        if (!this.rules.allowsBuiltin(target.builtin)) this.#diagnose("A08", file, reference.token, trace,
          `settlement writer reaches IO builtin ${target.builtin}`);
        continue;
      }
      const next = this.#module(target.file, [...trace, target.file], "A08");
      if (!next) continue;
      const role = this.#role(target.file, next);
      if (role === "helper" || role === "contract") {
        for (const [local, imported] of used) {
          const value = this.#resolveExport(target.file, imported, new Set(), "A08");
          if (value) for (const caller of writerDeclarations.filter((entry) => entry.uses(local))) {
            this.#inspectReferencedClass(value, local, caller, file, [...trace, target.file], new Set());
          }
          else this.#inspectService(target.file, imported, [...trace, target.file], new Set(), null, true);
        }
      }
    }
  }

  #inspectWriterOrigin(file, name, trace, inherited, seen) {
    const key = `${file}#${name}:${[...inherited].sort().join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    const module = this.#module(file, trace, "A08");
    if (!module) return;
    const declaration = module.declaration(name);
    if (!declaration) {
      this.#diagnose("A08", file, null, trace, `cannot resolve writer helper ${name}`);
      return;
    }
    const tokens = declaration.tokens;
    const usage = new SourceOriginUsage(declaration,
      ["flowManager", "#flowManager", "manager", "#manager", ...inherited]);
    const saveMethods = new Set([
      "commitDraftStepCheckpoint", "commitDraftStepResult", "commitSpecStepResult",
      "completeSpecGateRepairProgress", "commitDraftWorker", "commitDraftWorkerError",
      "completePublishedDraftWorker",
    ]);
    for (let index = 0; index < tokens.length; index++) {
      if (!usage.isOrigin(tokens[index])) continue;
      const access = readMemberAccess(tokens, index);
      if (access === null) continue;
      if (access.isCallTo(saveMethods)) { usage.accept([tokens[index]]); continue; }
      this.#diagnose("A08", file, access.token, trace,
        `settlement writer reads or escapes manager through ${access.name ?? "unresolved member"}`);
    }
    const offsets = new Set(tokens.map((token) => token.offset));
    for (const call of readInvocations(module).filter((entry) => offsets.has(entry.token.offset))) {
      if (["return", "if", "while", "switch", "catch", "throw", "await"].includes(call.name)) continue;
      const tainted = call.arguments.map((argument, index) => argument.some((token) => usage.isOrigin(token)) ? index : -1)
        .filter((index) => index >= 0);
      if (tainted.length === 0) continue;
      let targetFile = file;
      let targetName = call.name;
      if (!module.declaration(call.name)) {
        const reference = module.references.find((entry) => entry.kind === "import" && entry.bindings.has(call.name));
        const resolved = reference && this.#resolve(file, reference, trace, "A08");
        if (!resolved?.file) {
          this.#diagnose("A08", file, call.token, trace,
            `writer passes manager to unresolved helper ${call.name}`);
          continue;
        }
        targetFile = resolved.file;
        targetName = reference.bindings.get(call.name);
      }
      const targetModule = this.#module(targetFile, [...trace, targetFile], "A08");
      const target = targetModule?.declaration(targetName);
      if (!target) {
        this.#diagnose("A08", file, call.token, trace,
          `writer passes manager to unresolved helper ${call.name}`);
        continue;
      }
      const constructor = target.tokens.findIndex((token) => token.value === "constructor");
      const parameters = readParameters(constructor < 0 ? target.tokens : target.tokens.slice(constructor));
      const passed = new Set();
      for (const index of tainted) {
        if (usage.isReference(call.arguments[index])
          && parameters[index]?.length === 1 && parameters[index][0].kind === "identifier") {
          passed.add(parameters[index][0].value);
          usage.accept(call.arguments[index]);
        } else this.#diagnose("A08", targetFile, target.token, [...trace, targetFile],
          `writer manager argument has unresolved helper parameter ${index}`);
      }
      if (passed.size > 0) this.#inspectWriterOrigin(targetFile, targetName,
        [...trace, targetFile], passed, seen);
    }
    for (const token of usage.unresolved()) this.#diagnose("A08", file, token, trace,
      "settlement writer uses manager outside a checked save call, binding, or delegation");
  }

  #inspectTopLevelEffects(file, module, trace) {
    if (this.topLevelVisited.has(file)) return;
    this.topLevelVisited.add(file);
    for (const entry of module.classes) {
      if (module.declarationHeader(entry.name)?.token.offset !== entry.token.offset) continue;
      const owner = this.#resolveLocal(file, module, entry.name, new Set(), "A08");
      for (const initializer of module.classMembers(entry.name)?.moduleInitializers ?? []) {
        this.#inspectServiceDeclaration(file, module, entry.name, initializer, trace, new Set(), null,
          owner ? new ServiceClassReceiver(owner, true) : null);
      }
    }
    const tokens = module.tokens;
    let depth = 0;
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index].value === "{") depth++;
      if (tokens[index].value === "}") depth--;
      if (depth === 0) {
        const global = [...module.dynamic, ...module.globals].find((token) => token.offset === tokens[index].offset);
        if (global) this.#diagnose("A08", file, global, trace, `module initialization reads global ${global.value}`);
        for (const reference of module.references.filter((entry) => entry.kind === "import")) {
          const target = this.#resolve(file, reference, trace, "A08", true);
          if (!target?.builtin || this.rules.allowsBuiltin(target.builtin)) continue;
          if ([...reference.bindings.keys()].includes(tokens[index].value)
            && (tokens[index + 1]?.value === "("
              || (tokens[index + 1]?.value === "." && tokens[index + 3]?.value === "("))) {
            this.#diagnose("A08", file, tokens[index], trace, `module initialization calls IO builtin ${target.builtin}`);
          }
        }
      }
      if (depth !== 0 || !["const", "let"].includes(tokens[index].value)
        || tokens[index + 1]?.kind !== "identifier") continue;
      const declaration = module.declaration(tokens[index + 1].value);
      if (!declaration) continue;
      const offsets = new Set(declaration.tokens.map((token) => token.offset));
      const global = [...module.dynamic, ...module.globals].find((token) => offsets.has(token.offset));
      if (global) this.#diagnose("A08", file, global, trace, `module initialization reads global ${global.value}`);
      for (const reference of module.references.filter((entry) => entry.kind === "import")) {
        const target = this.#resolve(file, reference, trace, "A08", true);
        if (!target?.builtin || this.rules.allowsBuiltin(target.builtin)) continue;
        const used = [...reference.bindings.keys()].some((name) => declaration.uses(name));
        if (used) this.#diagnose("A08", file, declaration.token, trace,
          `module initialization reaches IO builtin ${target.builtin}`);
      }
    }
  }

  #isExportedClass(resolved) {
    return resolved.module.exports.some((binding) => {
      if (binding.name === "*") return false;
      const candidate = this.#resolveExport(resolved.file, binding.name, new Set(), "A01");
      return candidate?.key === resolved.key;
    });
  }

  #dependencySource(module, name, silent = false) {
    const reference = module.references.find((entry) => entry.kind === "import" && entry.bindings.has(name));
    if (!reference) return null;
    const target = this.#resolve(module.file, reference, [module.file], "A02", silent);
    if (!target?.file) return new ResolvedDependency(reference, null, null);
    const sourceClass = this.#resolveExport(target.file, reference.bindings.get(name), new Set(), "A02");
    return new ResolvedDependency(reference, target.file, sourceClass);
  }

  #visit(file, trace, registrations) {
    if (this.report.visited.has(file)) return;
    this.report.visited.add(file);
    const module = this.#module(file, trace);
    if (!module) return;
    const role = this.#role(file, module);
    if (!this.rules.isClosureRole(role)) this.#diagnose("A03", file, null, trace, `unclassified closure module (${role})`);
    for (const token of module.dynamic) this.#diagnose("A05", file, token, trace, "dynamic import in restricted closure");
    for (const token of module.globals) this.#diagnose("A05", file, token, trace, `dynamic loader or global ${token.value} in restricted closure`);
    for (const reference of module.references) {
      if (reference.kind === "dynamic") continue;
      const target = this.#resolve(file, reference, trace, role === "step" ? "A02" : "A03");
      if (!target) continue;
      if (target.builtin) {
        if (!this.rules.allowsBuiltin(target.builtin)) this.#diagnose(role === "step" ? "A02" : "A03", file, reference.token, trace, `disallowed builtin ${target.builtin}`);
        continue;
      }
      const nextTrace = [...trace, target.file];
      const nextModule = this.#module(target.file, nextTrace);
      if (!nextModule) continue;
      const nextRole = this.#role(target.file, nextModule);
      if (this.rules.isServiceBoundary(nextRole)) {
        this.report.serviceBoundaries.add(target.file);
        if (role !== "step" || !this.#declaresService(module, registrations.get(file), target.file)) {
          this.#diagnose(this.rules.violationRule(role, nextRole), file, reference.token, nextTrace, "Service reached outside declared Step dependency");
        }
        continue;
      }
      if (!this.rules.canTraverse(role, nextRole)) {
        const rule = this.rules.violationRule(role, nextRole);
        this.#diagnose(rule, file, reference.token, nextTrace, `${role} depends on ${nextRole}`);
        continue;
      }
      this.#visit(target.file, nextTrace, registrations);
    }
  }

  #declaresService(module, registrations, target) {
    if (!registrations) return false;
    return registrations.some((registration) => module.classes.some((entry) => entry.name === registration.StepClass.name
      && entry.dependencies.some((dependency) => this.#dependencySource(module, dependency, true)?.target === target)))
      && this.rules.isService(target);
  }

  #exportsScopedStep(file, stepFiles, seen) {
    if (seen.has(file)) return false;
    seen.add(file);
    const module = this.#module(file, [file], "A06");
    if (!module) return false;
    for (const binding of module.exports) {
      if (binding.local === "*" && binding.reference) {
        const target = this.#resolve(file, binding.reference, [file], "A06", true);
        if (target?.file && this.#exportsScopedStep(target.file, stepFiles, seen)) return true;
        continue;
      }
      const resolved = this.#resolveExport(file, binding.name, new Set(), "A06");
      if (resolved && stepFiles.has(resolved.file)
        && this.#isStepClass(resolved.file, resolved.module, resolved.classEntry, new Set())) return true;
    }
    return false;
  }

  #reverseIndex(stepFiles) {
    const references = new Map();
    for (const file of this.allFiles) {
      const module = this.#module(file, [file], "A06", true);
      if (!module) continue;
      this.report.reverseIndexed.add(file);
      references.set(file, module.references.map((reference) => [
        reference,
        this.#resolve(file, reference, [file], "A06", true)?.file,
        reference.kind === "reexport" || module.exports.some((binding) => !binding.reference
          && [...reference.bindings.keys()].includes(binding.local)),
      ]));
    }
    const reachable = new Set(stepFiles);
    let changed;
    do {
      changed = false;
      for (const [file, edges] of references) {
        if (reachable.has(file) || !edges.some(([, target, exported]) => exported && reachable.has(target))) continue;
        reachable.add(file);
        changed = true;
      }
    } while (changed);
    for (const [file, edges] of references) {
      for (const [reference, candidate] of edges) {
        if (!reachable.has(candidate)) continue;
        const target = this.#resolve(file, reference, [file], "A06", true);
        if (!target?.file) continue;
        const direct = stepFiles.has(target.file);
        const indirect = [...reference.bindings.values()].some((name) => {
          const resolved = this.#resolveExport(target.file, name, new Set(), "A06");
          return resolved && stepFiles.has(resolved.file) && this.#isStepClass(resolved.file, resolved.module, resolved.classEntry, new Set());
        }) || ((reference.kind === "dynamic" || (reference.kind === "reexport" && reference.bindings.size === 0)
          || [...reference.bindings.values()].includes("*"))
          && this.#exportsScopedStep(target.file, stepFiles, new Set()));
        if ((direct || indirect) && !this.rules.isComposition(file)) this.#diagnose("A06", file, reference.token, [file, target.file], "Step is referenced outside composition");
      }
    }
  }

  #reverseServiceIndex() {
    if (this.registeredServices.size === 0) return;
    for (const file of this.allFiles) {
      const module = this.#module(file, [file], "A09", true);
      if (!module) continue;
      const aliases = new Map();
      for (const reference of module.references.filter((entry) => entry.kind === "import" || entry.kind === "reexport")) {
        const target = this.#resolve(file, reference, [file], "A09", true);
        if (!target?.file) continue;
        for (const [local, imported] of reference.bindings) {
          if (imported === "*") {
            const targetModule = this.#module(target.file, [file, target.file], "A09", true);
            for (const binding of targetModule?.exports ?? []) {
              const candidate = this.#resolveExport(target.file, binding.name, new Set(), "A09");
              if (candidate && this.registeredServices.has(candidate.key)) {
                aliases.set(`${local}.${binding.name}`, candidate);
              }
            }
            continue;
          }
          const resolved = this.#resolveExport(target.file, imported, new Set(), "A09");
          if (!resolved || !this.registeredServices.has(resolved.key)) continue;
          aliases.set(local, resolved);
        }
      }
      let changed;
      do {
        changed = false;
        for (let index = 0; index < module.tokens.length - 3; index++) {
          if (!["const", "let"].includes(module.tokens[index].value) || module.tokens[index + 2]?.value !== "=") continue;
          const name = module.tokens[index + 1].value;
          const original = module.tokens[index + 3].value;
          if (aliases.has(original) && !aliases.has(name)) {
            aliases.set(name, aliases.get(original));
            changed = true;
          }
        }
      } while (changed);
      for (let index = 0; index < module.tokens.length - 2; index++) {
        const token = module.tokens[index];
        if (aliases.has(token.value) && module.tokens[index + 1]?.value === "."
          && module.tokens[index + 2]?.value === "prepare") {
          this.#diagnose("A09", file, token, [file, aliases.get(token.value).file], "registered Service uses static preparation");
        }
        if (token.value !== "new") continue;
        const direct = aliases.get(module.tokens[index + 1]?.value);
        const namespace = module.tokens[index + 2]?.value === "."
          ? aliases.get(`${module.tokens[index + 1]?.value}.${module.tokens[index + 3]?.value}`) : null;
        const resolved = direct ?? namespace;
        if (resolved && module.tokens[index + (direct ? 2 : 4)]?.value === "(") {
          this.#diagnose("A09", file, token, [file, resolved.file], `registered Service constructed outside StepRegistration`);
        }
      }
    }
  }

  #sharedExecutionSelections(coveredShapes = []) {
    const contracts = sharedExecutionAdapters;
    const required = new Set();
    for (const registration of this.scope.registrations) {
      if (!registration.ServiceClass) continue;
      if (coveredShapes.some((shape) => shape.matches(registration.executionContract))) continue;
      const kind = this.#executionKind(registration);
      const { selector, projector, executor } = contracts.get(kind) ?? {};
      const contract = registration.executionContract;
      if (!(contract instanceof StepExecutionContract)
        || contract.selectorName !== selector || contract.projectorName !== projector
        || contract.executorName !== executor) {
        this.#diagnose("A10", this.scope.registrationModule, null, [this.scope.registrationModule],
          `registration ${registration.stepId} lacks its named ${kind} execution contract`);
      }
      if (contracts.has(kind)) required.add(kind);
    }
    for (const kind of required) {
      const { selector, projector, executor, command, module: adapterFile, contractName } = contracts.get(kind);
      this.#contractEntry("src/flow/lib/get-next-action.js", "project", kind);
      this.#contractEntry(command, "execute", kind);
      const adapter = this.#module(adapterFile, [adapterFile], "A10", true);
      if (!adapter) continue;
      const declaration = adapter.declaration(contractName);
      const tokens = declaration?.tokens ?? [];
      const pairs = [["select", selector], ["project", projector], ["execute", executor]];
      const complete = tokens.some((token, index) => token.value === "new"
        && tokens[index + 1]?.value === "StepExecutionContract")
        && pairs.every(([property, name]) => tokens.some((token, index) => token.value === property
          && tokens[index + 1]?.value === ":" && tokens[index + 2]?.value === name));
      if (!complete) this.#diagnose("A10", adapterFile, declaration?.token, [adapterFile],
        `${contractName} does not bind the named shared adapters`);
      const selectedMethod = `executeSelected${kind[0].toUpperCase()}${kind.slice(1)}`;
      const execution = adapter.declaration(executor);
      const executed = execution?.tokens.some((token, index) => token.value === selectedMethod
        && execution.tokens[index - 1]?.value === "." && execution.tokens[index + 1]?.value === "("
        && execution.tokens[index + 2]?.value === "selection" && execution.tokens[index + 3]?.value === ","
        && execution.tokens[index + 4]?.value === "input");
      if (!executed) this.#diagnose("A10", adapterFile, execution?.token, [adapterFile],
        `${executor} does not pass the selected judgment to ${selectedMethod}`);
    }
    const productRoutesAvailable = this.allFiles.includes("src/flow/lib/get-next-action.js")
      && this.allFiles.includes("src/flow/engine/composition/registered-step-execution.js")
      && this.allFiles.includes("src/flow/lib/run-review.js")
      && this.allFiles.includes("src/flow/lib/run-dispatch.js");
    if (required.size > 0 && productRoutesAvailable) {
      this.#registeredDisplayRoutes(required);
      this.#canonicalDisplayCommandRoute(required);
      this.#registeredGateReviewExecutionRoutes(required);
    }
    if (required.has("worker") && productRoutesAvailable) this.#registeredWorkerExecutionRoutes();
    if (required.has("worker") && productRoutesAvailable
      && this.allFiles.includes("src/flow/lib/worker-execution-admission.js")) {
      const file = "src/flow/lib/run-dispatch.js";
      const module = this.#module(file, [file], "A10");
      if (module && module.classes.some((entry) => entry.name === "RunDispatchCommand")) {
        const body = readClassMember(module, "RunDispatchCommand", "executeSelectedWorker");
        const expected = "assertCurrentWorkerExecutionSelection";
        const imported = module.references.some((reference) => reference.bindings.get(expected) === expected
          && this.#resolve(file, reference, [file], "A10", true)?.file === "src/flow/lib/worker-execution-admission.js");
        const matched = body?.tokens.some((token, index) => token.value === expected
          && body.tokens[index + 1]?.value === "(" && body.tokens[index + 2]?.value === "selection"
          && body.tokens[index + 3]?.value === "," && body.tokens[index + 4]?.value === "current");
        if (!imported || !matched) this.#diagnose("A10", file, body?.token, [file], "worker execution lacks current selection identity assertion");
      }
    }
    for (const [kind, file, className] of [
      ["gate", "src/flow/lib/run-gate.js", "RunGateCommand"],
      ["review", "src/flow/lib/run-review.js", "RunReviewCommand"],
    ]) {
      if (!required.has(kind) || !this.allFiles.includes(file)) continue;
      const module = this.#module(file, [file], "A11");
      const body = module && readClassMember(module, className, "executeCanonical");
      const tokens = body?.tokens ?? [];
      const delegates = tokens.some((token, index) => token.value === "this" && tokens[index + 1]?.value === "."
        && tokens[index + 2]?.value === "execute" && tokens[index + 3]?.value === "(");
      const admissionGuard = kind === "gate" || tokens.some((token, index) => token.value === "#admittedExecutionContexts"
        && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === "delete"
        && tokens[index + 3]?.value === "(" && tokens[index + 4]?.value === "ctx");
      if (!delegates || !admissionGuard) this.#diagnose("A11", file, body?.token, [file],
        `${className}.executeCanonical bypasses registered admission`);
    }
    if (required.size > 0) this.#restrictedExecutionMethods();
  }

  #registeredDisplayRoutes(required) {
    const file = "src/flow/lib/get-next-action.js";
    const module = this.#module(file, [file], "A10", true);
    if (!module) return;
    const build = module.declaration("buildCanonicalNextActionResult");
    const tokens = build?.bodyTokens() ?? null;
    if (tokens === null) {
      this.#diagnose("A10", file, build?.token, [file], "canonical display routing is not statically resolvable");
      return;
    }
    const requireInitializer = (name, source, kind) => {
      const initializer = build.topLevelInitializer(name);
      if (!initializer?.matches(source)) this.#diagnose("A10", file,
        initializer?.token ?? build?.token, [file], `${kind} display ${name} bypasses registered routing`);
      return initializer;
    };
    if (required.has("worker")) {
      requireInitializer("workerRegistration",
        'registeredFlowStep?.executionContract.selectorName === "selectWorkerExecutionAdmission" ? registeredFlowStep : target.scope === "flow" ? draftWorkerStepRegistration(target.stepId) ?? specWorkerStepRegistration(target.stepId) : null',
        "worker");
      const selected = requireInitializer("workerSelection",
        'workerRegistration?.executionContract.select({ ctx, stepId: target.stepId })', "worker");
      const workerDirective = requireInitializer("workerDirective",
        'workerSelection === undefined ? null : workerRegistration.executionContract.project(workerSelection, { stepId: workerRegistration.stepId, binding, recoveryCommand, retryRecoveryPlan: recoveryPlan, missingProducerArtifactRoute: missingRoute, })',
        "worker");
      if (selected && tokens.slice(0, selected.index).some((token) => token.value === "return")) {
        this.#diagnose("A10", file, build?.token, [file],
          "canonical worker display can return before registered selection");
      }
      const writes = tokens.filter((token, index) => token.value === "selectedDirective"
        && (tokens[index + 1]?.value === "=" || (tokens[index + 1]?.value === "?"
          && tokens[index + 2]?.value === "?" && tokens[index + 3]?.value === "="))).length;
      const initialDirective = build.topLevelInitializer("selectedDirective");
      const additionalCallers = this.#registeredPhaseCallers(module, "project");
      const additionalProjection = this.#registeredAdditionalProjection(module, build, additionalCallers);
      if (additionalCallers.length > 0 && additionalProjection === null) {
        this.#diagnose("A10", file, build.token, [file], "canonical registered phase display lacks its named projection");
      }
      const additionalName = additionalProjection === null ? null
        : tokens[additionalProjection.index + 1]?.value;
      const claimDirective = build.topLevelInitializer("claimDirective");
      const taskOverrides = build.containsBodySequence('target.stepId === "task-triage"')
        || build.containsBodySequence('target.stepId === "task-review"');
      if (workerDirective && !build.containsBodySequence(`
        selectedDirective ??= userDecisionDirective ?? (workerDirective instanceof ExecuteStepDirective ? null : workerDirective)
          ?? approvalDirective ?? activationDirective ?? outboxRecovery?.directive ?? gateDirective ?? lifecycleDirective;
      `) || (workerDirective && !build.containsBodySequence(
        "const claimRequired = selectedDirective instanceof ExecuteStepDirective"
      )) || (workerDirective && !build.containsBodySequence("directive: claimDirective.toJSON()"))
        || !(additionalName === null ? [""] : [`${additionalName} ?? (`]).some((prefix) => initialDirective?.matches(`${prefix}specPostFailure === null ? null : new BlockedDirective({
          code: specPostFailure.code, reason: specPostFailure.reason,
          resumeInstruction: specPostFailure.resumeInstruction,
        })${prefix === "" ? "" : ")"}`))
        || !claimDirective?.matches(`claimRequired ? new ExecuteCommandDirective({
          actionId: "CLAIM_NEXT_ACTION",
          nextAction: guardedCommand("sennel flow run claim-next-action", state, binding),
          instruction: $STRING_LITERAL,
          reason: $STRING_LITERAL,
        }) : selectedDirective`)
        || (workerDirective && writes !== (taskOverrides ? 4 : 2))
        || build.returns().length !== 1 || !build.returns()[0]?.matches("result")) {
        this.#diagnose("A10", file, build?.token, [file],
          "registered worker projection is not consumed by the final display directive");
      }
      if (taskOverrides && (!build.containsBodySequence(`
        if (target.scope === "task" && target.stepId === "task-triage" && typedState.attempt?.failure === null) {
          const filter = workerContext.taskReviewFilter;
          const quoted = (value) => \`'\${String(value).replaceAll("'", "'\\\"'\\\"'")}'\`;
          selectedDirective = new AwaitTaskReviewFilterDirective({
            command: guardedCommand([
              "sennel flow run filter-task-review --exclusions '<json-array>'",
              \`--expect-attempt-id \${quoted(filter.attemptId)}\`,
              \`--expect-review-digest \${quoted(filter.reviewDigest)}\`,
              \`--expect-source-fingerprint \${quoted(filter.sourceFingerprint)}\`,
              \`--expect-catalog-fingerprint \${quoted(filter.catalogFingerprint)}\`,
            ].join(" "), state, binding),
            binding: { attemptId: filter.attemptId, reviewDigest: filter.reviewDigest,
              sourceFingerprint: filter.sourceFingerprint, catalogFingerprint: filter.catalogFingerprint, },
            findings: filter.findings,
          });
        }
      `) || !build.containsBodySequence(`
        if (selectedDirective instanceof ExecuteStepDirective && target.scope === "task" && target.stepId === "task-review" && typedState.attempt?.failure === null) {
          try { assertReconciledTaskReviewInput({ flowManager: ctx.flowManager, state: typedState, taskId: target.taskId, root: ctx.executionRoot || ctx.root }); }
          catch (error) {
            selectedDirective = new BlockedDirective({ code: "TASK_REVIEW_RECONCILIATION_INPUT_CHANGED", reason: error.message,
              resumeInstruction: $STRING_LITERAL });
          }
        }
      `))) this.#diagnose("A10", file, build?.token, [file],
        "canonical display contains an unrecognized Step-specific directive override");
    }
    if (required.has("review")) {
      const reviewStep = build.topLevelInitializer("reviewStep");
      const members = new Set(reviewStep?.tokens.filter((token) => token.kind === "string")
        .map((token) => token.value) ?? []);
      const membership = readTokens(".has(target.stepId)");
      const actualMembership = reviewStep?.tokens.slice(-membership.length) ?? [];
      if (actualMembership.length !== membership.length
        || !actualMembership.every((token, index) => token.value === membership[index].value
          && token.kind === membership[index].kind)
        || this.scope.registrations.some((registration) => this.#executionKind(registration) === "review"
          && !members.has(registration.stepId))) {
        this.#diagnose("A10", file, reviewStep?.token ?? build?.token, [file],
          "registered Review Step is absent from display routing");
      }
      requireInitializer("reviewRegistration",
        'target.scope === "flow" ? target.stepId === "test-review" ? reviewStepExecutionRegistration("test") : draftStepRegistration(target.stepId) ?? specStepRegistration(target.stepId) : null',
        "review");
      requireInitializer("reviewSelection",
        'reviewStep && ["resume", "retry", "record", "blocked"].includes(descriptor.operation) ? reviewRegistration === null ? resolveCurrentReviewTransition(reviewInput) : reviewRegistration.executionContract.select(reviewInput) : { facts: null, disposition: null }',
        "review");
      const projected = requireInitializer("reviewDisposition",
        'reviewStep && reviewRegistration !== null && ["resume", "retry", "record", "blocked"].includes(descriptor.operation) ? reviewRegistration.executionContract.project(reviewSelection, { ctx, scope: "flow", stepId: reviewRegistration.stepId, }) : reviewSelection.disposition',
        "review");
      if (projected && tokens.slice(0, projected.index).some((token) => token.value === "return")) {
        this.#diagnose("A10", file, build?.token, [file],
          "canonical Review display can return before registered projection");
      }
      const descriptorProjection = build.topLevelInitializer("definitionDescriptor");
      const lifecycle = build.topLevelInitializer("lifecycleDirective");
      if (!descriptorProjection?.matches(`descriptor.withReviewDisposition(reviewDisposition)
        .withConditionalWorkerDisposition(conditionalWorkerDisposition)`)
        || !lifecycle?.matches(`selectedFinalRegressionAction?.directive ?? new NextActionDirectiveResolver({
          state, binding, action: derived.action, descriptor: definitionDescriptor,
          recoveryCommand, retryRecoveryPlan: recoveryPlan,
          missingProducerArtifactRoute: missingRoute,
          planGateRepairRoute: planGateRepair?.route ?? null,
          planGateRepairReason: planGateRepair?.reason ?? null,
        }).resolve()`)) {
        this.#diagnose("A10", file, descriptorProjection?.token ?? build?.token, [file],
          "registered Review projection is not consumed by canonical display routing");
      }
    }
    if (required.has("gate")) {
      const selection = build.topLevelInitializer("gateSelection");
      const directive = build.topLevelInitializer("gateDirective");
      if (!selection?.matches("specPostFailure === null ? definitionOwnedGateSelection(ctx, state, target) : null")
        || !directive?.matches("definitionOwnedGateDirective(gateSelection, { state, binding })")
        || !build.containsBodySequence("?? outboxRecovery?.directive ?? gateDirective ?? lifecycleDirective")) {
        this.#diagnose("A10", file, selection?.token ?? directive?.token ?? build?.token, [file],
          "registered Gate selection is not consumed by canonical display routing");
      }
      const gate = module.declaration("definitionOwnedGateSelection");
      const phase = gate?.topLevelInitializer("phase");
      const registration = gate?.topLevelInitializer("registration");
      for (const candidate of this.scope.registrations.filter((entry) => this.#executionKind(entry) === "gate")) {
        if (!phase?.tokens.some((token, index, all) => token.value === "target"
          && all[index + 1]?.value === "." && all[index + 2]?.value === "stepId"
          && all[index + 3]?.value === "=" && all[index + 4]?.value === "="
          && all[index + 5]?.value === "=" && all[index + 6]?.value === candidate.stepId)) {
          this.#diagnose("A10", file, phase?.token ?? gate?.token, [file],
            `registered Gate ${candidate.stepId} is absent from display phase routing`);
        }
      }
      if (!registration?.matches("gateStepExecutionRegistration(phase)")) {
        this.#diagnose("A10", file, registration?.token ?? gate?.token, [file],
          "Gate display bypasses registered routing");
      }
      const phaseRoute = phase?.matches(`target.stepId === "draft-gate" ? "draft" : target.stepId === "spec-gate"
        ? "spec" : target.stepId === "test-gate" ? "test" : target.scope === "task" && target.stepId === "task-gate"
          ? "task-impl" : target.scope === "flow" && target.stepId === "impl-gate" ? "integration" : null`);
      const returns = gate?.returns() ?? [];
      const selectedInput = `const selection = registration.executionContract.select({
        flowManager: ctx.flowManager, flowState: state, phase,
        scope: target.scope, stepId: registration.stepId,
        typedState: ctx.flowManager.canonicalState(state.specId),
      });`;
      const selectedProjection = "return registration.executionContract.project(selection, { scope: target.scope, stepId: registration.stepId });";
      const canonicalGateRoutes = registration?.matches("gateStepExecutionRegistration(phase)")
        && gate?.containsBodySequence(selectedInput)
        && gate?.containsBodySequence(selectedProjection)
        && gate?.containsBodySequence('if (phase === "spec" && selection.admission.facts !== null) {')
        && gate?.containsBodySequence('if (saved !== null) return new SavedSpecGateSelection(saved);')
        && returns.length === 4 && returns[0]?.matches("null")
        && returns[1]?.matches("new SavedSpecGateSelection(saved)")
        && returns[2]?.matches("registration.executionContract.project(selection, { scope: target.scope, stepId: registration.stepId })")
        && returns[3]?.matches("resolveGateNextAction({ flowManager: ctx.flowManager, flowState: state, phase, })");
      if (!phaseRoute || !canonicalGateRoutes) {
        this.#diagnose("A10", file, gate?.token, [file],
          "Gate display has an unrecognized route before registered selection and projection");
      }
    }
  }

  #registeredWorkerExecutionRoutes() {
    const file = "src/flow/engine/composition/registered-step-execution.js";
    const module = this.#module(file, [file], "A10", true);
    const declaration = module?.declaration("workerStepExecutionRegistration");
    if (!declaration?.matchesBody(`
      const registration = requirementTestWorkerStepRegistration(stepId) ?? draftWorkerStepRegistration(stepId)
        ?? specWorkerStepRegistration(stepId);
      if (registration === null && registeredPhaseSteps.has(stepId)) {
        throw new Error(\`Definition leaf \${stepId} has no registered worker execution contract\`);
      }
      return registration;
    `)) {
      this.#diagnose("A10", file, declaration?.token, [file],
        "worker registration resolver bypasses registered lookup");
    }
    this.#closedRegistrationLookups([
      ["draft", "draftWorkerStepRegistration", "draftWorkerById", "workerRegistrations"],
      ["spec", "specWorkerStepRegistration", "workerById", "workerRegistrations"],
    ], "worker");
    const dispatchFile = "src/flow/lib/run-dispatch.js";
    const dispatch = this.#module(dispatchFile, [dispatchFile], "A10");
    if (!dispatch?.classes.some((entry) => entry.name === "RunDispatchCommand")) return;
    const run = readClassMember(dispatch, "RunDispatchCommand", "runWorkerAttempt");
    const prepareCall = readInvocations({ tokens: run?.bodyTokens() ?? [] }).find((call) => {
      if (call.arguments.length !== 1) return false;
      const argument = call.arguments[0];
      if (!new SourceInitializer(argument[0], 0, argument).matches("{ ctx, stepId, selection }")) return false;
      if (readParameters(run.tokens).some((parameter) => parameter.some((token) => token.value === call.name))) return false;
      return dispatch.declaration(call.name)?.matchesFunction("input", `
        const registration = prepareStepRegistration(input.stepId);
        if (registration === null) throw new TypeError($STRING_LITERAL);
        const selection = input.selection;
        return registration.executionContract.execute(selection, { ...input, registration });
      `) === true;
    });
    const workerSelection = run?.topLevelInitializer("registration");
    const prepareSelection = run?.topLevelInitializer("selectedRegistration");
    const body = run?.bodyTokens() ?? [];
    const selectionOverwrite = body.some((token, index) => token.value === "selection"
      && ["=", "+=", "-=", "*=", "/=", "??="].includes(body[index + 1]?.value)
      && body[index - 1]?.value !== "const");
    const selectedPrepare = prepareSelection?.matches("flowStepExecutionRegistration(stepId)")
      && run.containsBodySequence('if (selectedRegistration?.executionContract.selectorName === "selectPrepareExecutionAdmission") {')
      && prepareCall !== undefined
      && run.containsBodySequence(`return ${prepareCall.name}({ ctx, stepId, selection });`)
      && !selectionOverwrite;
    const workerExecution = workerSelection?.matches("workerStepExecutionRegistration(stepId)")
      && run.containsBodySequence("if (registration === null) return this.#executeSelectedWorker(ctx, invocation, retryFeedback, agentOverride);")
      && run.containsBodySequence("const selection = registration.executionContract.select({ ctx, stepId });")
      && run.containsBodySequence(`return registration.executionContract.execute(selection, {
        command: this, ctx, stepId, invocation, retryFeedback, agentOverride,
      });`);
    if (!selectedPrepare || !workerExecution || run.returns().length !== 3) {
      this.#diagnose("A10", dispatchFile, run?.token, [dispatchFile],
        "worker execution entry bypasses registered selection");
    }
  }

  #canonicalDisplayCommandRoute(required) {
    if (required.size === 0) return;
    const file = "src/flow/lib/get-next-action.js";
    const module = this.#module(file, [file], "A10", true);
    if (!module) return;
    const execute = readClassMember(module, "GetNextActionCommand", "execute");
    const canonical = readClassMember(module, "GetNextActionCommand", "executeCanonical");
    const entryReturns = execute?.returns() ?? [];
    const canonicalReturns = canonical?.returns() ?? [];
    const canonicalEntry = `
      if (!ctx.flowState) {
        return { taskId: null, step: null, action: null, instructions: null,
          context: null, output_schema: null, requires_approval: false,
          directive: new IdleDirective().toJSON(), };
      }
      if (ctx.flowState.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof ctx.flowManager?.canonicalState !== "function") {
        throw new NextActionPlanError("NEXT_ACTION_TARGET_MISMATCH", "active Flow must be backed by the canonical Version Store",);
      }
      ctx.flowState = ctx.flowManager.loadReadOnly(ctx.specId ?? ctx.flowState.specId);
      return this.executeCanonical(ctx);
    `;
    const entryComplete = entryReturns.length >= 1 && entryReturns.length <= 2
      && entryReturns.at(-1).matches("this.executeCanonical(ctx)")
      && (execute?.matchesBody(canonicalEntry) || execute?.matchesBody("return this.executeCanonical(ctx);"));
    if (!entryComplete) this.#diagnose("A10", file, execute?.token, [file],
      "next-action public entry can bypass canonical registered routing");
    const finalReturn = canonicalReturns.at(-1);
    const realBody = canonical?.topLevelInitializer("typedState") !== null;
    const expectedReturns = realBody ? 6 : 1;
    const finalComplete = finalReturn?.tokens.slice(0, 2).map((token) => token.value).join(" ")
      === "buildCanonicalNextActionResult (";
    const priorComplete = canonicalReturns.slice(0, -1).every((entry) =>
      entry.matches("dormantHistoricalNextAction(binding)")
      || entry.matches("completedNextAction(binding)")
      || entry.tokens.some((token) => token.value === "abortedNextAction")
      || (entry.tokens[0]?.value === "{" && entry.tokens.some((token) => token.value === "result")));
    const canonicalPrefix = `
      const typedState = ctx.flowManager.canonicalState(ctx.specId);
      if (!typedState) {
        throw new NextActionPlanError("NEXT_ACTION_TARGET_MISMATCH", "canonical Flow state is unavailable");
      }
      const binding = captureNextActionBinding(ctx, ctx.flowState);
      if (typedState.lifecycle.state !== "active") {
        return typedState.lifecycle.state === "finalized" ? completedNextAction(binding) : abortedNextAction(binding);
      }
      const selectedFinalRegressionAction = finalRegressionNextAction(ctx, ctx.flowState, typedState, binding);
      const descriptor = typedState.nextAction();
      if (descriptor === null) {
        if (typedState.history?.execution === "dormant") return dormantHistoricalNextAction(binding);
        return completedNextAction(binding);
      }
    `;
    const closedPrefix = realBody ? canonical?.bodyStartsWith(canonicalPrefix)
      : canonical?.matchesBody("return buildCanonicalNextActionResult(ctx);");
    if (canonicalReturns.length !== expectedReturns || !finalComplete || !priorComplete || !closedPrefix) {
      this.#diagnose("A10", file, canonical?.token, [file],
        "next-action canonical entry can return before registered display routing");
    }
  }

  #registeredGateReviewExecutionRoutes(required) {
    if (!required.has("gate") && !required.has("review")) return;
    const file = "src/flow/engine/composition/registered-step-execution.js";
    const module = this.#module(file, [file], "A10", true);
    const flow = module?.declaration("flowStepExecutionRegistration");
    if (!this.#closedRegistrationResolver(module, flow, ["prepareStepRegistration", "draftStepRegistration", "specStepRegistration", ...this.#publicPhaseLookupNames(module)],
      "`Definition leaf ${stepId} has no registered execution contract`")) this.#diagnose("A10", file, flow?.token, [file],
      "Gate/Review registration resolver can bypass a registered Step");
    this.#closedRegistrationLookups([
      ["draft", "draftStepRegistration", "draftById", "registrations"],
      ["spec", "specStepRegistration", "byId", "specStepRegistrations"],
    ], "Gate/Review");
    if (required.has("gate")) {
      const resolver = module?.declaration("gateStepExecutionRegistration");
      if (!resolver?.matchesBody(`
        if (phase === "draft") return flowStepExecutionRegistration("draft-gate");
        if (phase === "test") return flowStepExecutionRegistration("test-gate");
        if (phase === "spec" || phase === "task-spec") return flowStepExecutionRegistration("spec-gate");
        return null;
      `)) this.#diagnose("A10", file, resolver?.token, [file],
        "Gate phase lookup can exclude a registered Step");
      const commandFile = "src/flow/lib/run-gate.js";
      const command = this.#module(commandFile, [commandFile], "A10");
      const entry = command && readClassMember(command, "RunGateCommand", "execute");
      const head = `
        const { root } = ctx;
        const executionRoot = ctx.executionRoot || root;
        if (typeof ctx.flowManager?.loadReadOnly === "function" && ctx.flowState?.specId) {
          ctx.flowState = ctx.flowManager.loadReadOnly(ctx.specId ?? ctx.flowState.specId);
        }
        const inferPhase = ctx.phase == null || ctx.phase === "";
        const resolution = inferPhase ? resolveGatePhaseFromState(ctx.flowState) : null;
        const phase = resolveEffectiveGatePhase(ctx, resolution);
        if (!phase) {
          if (!resolution) {
            return Envelope.fail("run", "gate", "NO_GATE_STEP_IN_PROGRESS",
              \`no gate-type step is in_progress; specify --phase explicitly. \` +
                \`valid phases: \${VALID_GATE_PHASES.join(", ")}\`,);
          }
        }
        if (!VALID_GATE_PHASES.includes(phase)) {
          throw new Error(
            \`invalid phase: \${phase} (valid: \${VALID_GATE_PHASES.join(", ")}). \` +
              \`legacy names pre/post/impl have been retired — use spec / task-spec / task-impl / integration.\`,);
        }
        const level = PHASE_TO_LEVEL[phase];
        if (!isCanonicalFlowState(ctx.flowState)) {
          throw new Error("gate requires an active canonical Flow state");
        }
        const input = { phase, level, skipGuardrail: ctx.skipGuardrail === true,
          executionRoot, flowManager: ctx.flowManager, flowState: ctx.flowState,
          typedState: ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId), };
      `;
      const tail = `
        const targeted = phase === "draft" || phase === "spec" || phase === "task-spec";
        const registration = gateStepExecutionRegistration(phase);
        const contract = registration?.executionContract ?? null;
        if (targeted && contract === null) throw new Error(\`Gate execution contract is missing for \${phase}\`);
        const selection = contract === null ? selectGateExecutionAdmission(input) : contract.select(input);
        const execution = { command: this, ctx, phase, level, skipGuardrail: input.skipGuardrail, executionRoot };
        const result = await (contract === null ? executeGateSelection(selection, execution) : contract.execute(selection, execution));
        return result;
      `;
      if (!entry?.bodyStartsWith(head) || !entry.bodyEndsWith(tail)
        || entry.returns().length !== 2) {
        this.#diagnose("A10", commandFile, entry?.token, [commandFile],
          "Gate command can bypass registered selection and execution");
      }
    }
    if (required.has("review")) {
      const resolver = module?.declaration("reviewStepExecutionRegistration");
      if (!resolver?.matchesBody(`
        if (phase === "test") return flowStepExecutionRegistration("test-review");
        if (phase === "draft-questions") return flowStepExecutionRegistration("draft-questions-review");
        if (phase === "draft-coverage") return flowStepExecutionRegistration("draft-coverage-review");
        if (phase === "spec") return flowStepExecutionRegistration("spec-review");
        return null;
      `)) this.#diagnose("A10", file, resolver?.token, [file],
        "Review phase lookup can exclude a registered Step");
      const commandFile = "src/flow/lib/run-review.js";
      const command = this.#module(commandFile, [commandFile], "A10");
      const entry = command && readClassMember(command, "RunReviewCommand", "execute");
      if (!entry?.matchesBody(`
        const phase = ctx.phase || null;
        const persistedPhase = reviewPhaseKeyForCtx(ctx, phase);
        const registration = reviewStepExecutionRegistration(persistedPhase);
        if (["draft-questions", "draft-coverage", "spec", "test"].includes(persistedPhase)
          && registration?.executionContract == null) {
          throw new Error(\`Review execution contract is missing for \${persistedPhase}\`);
        }
        if (registration === null || !isCanonicalFlowState(ctx.flowState)) {
          return this.#executeReviewCommand(ctx);
        }
        const typedState = ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId);
        const selection = registration.executionContract.select({
          flowManager: ctx.flowManager, flowState: ctx.flowState, typedState,
          scope: "flow", stepId: registration.stepId,
        });
        return registration.executionContract.execute(selection, { command: this, ctx,
          scope: "flow", stepId: registration.stepId });
      `)) this.#diagnose("A10", commandFile, entry?.token, [commandFile],
        "Review command can bypass registered selection and execution");
    }
  }

  #closedRegistrationLookups(routes, kind) {
    for (const [composition, lookup, map, collection] of routes) {
      const target = `src/flow/engine/composition/${composition}.js`;
      const source = this.#module(target, [target], "A10", true);
      const resolve = source?.declaration(lookup);
      const mapping = source?.declaration(map);
      if (!resolve?.matchesBody(`return ${map}.get(stepId) ?? null;`)
        || !mapping?.matchesDeclaration(`const ${map} = new Map(${collection}.map((registration) => [registration.stepId, registration]));`)) {
        this.#diagnose("A10", target, resolve?.token ?? mapping?.token, [target],
          `${composition} ${kind} lookup does not derive from its full registration collection`);
      }
    }
  }

  #registeredExecutionRoute() {
    if (this.scope.registrations.every((entry) => !entry.ServiceClass)) return;
    const file = "src/flow/engine/composition/registered-step-execution.js";
    if (!this.allFiles.includes(file)) {
      this.#diagnose("A11", file, null, [file], "targeted Definition execution route source is missing");
      return;
    }
    const module = this.#module(file, [file], "A11", true);
    if (!module) return;
    const range = readInvocations(module).find((call) => call.name === "flowLeafIdsBetween");
    const workerIds = [];
    const registrationIds = [];
    const directRegistrationIds = [];
    const compositionFiles = new Set([this.scope.registrationModule]);
    for (const reference of module.references) {
      const target = this.#resolve(file, reference, [file], "A11", true);
      if (target?.file && this.rules.isComposition(target.file)) compositionFiles.add(target.file);
    }
    for (const compositionFile of compositionFiles) {
      const composition = this.#module(compositionFile, [compositionFile], "A11", true);
      if (!composition) continue;
      for (const call of readInvocations(composition)) {
        if (call.name === "workerRegistration" && call.arguments[0]?.length === 1
          && call.arguments[0][0].kind === "string") {
          workerIds.push(call.arguments[0][0].value);
          registrationIds.push(call.arguments[0][0].value);
        }
        if (call.name === "reviewRegistration" && call.arguments[0]?.length === 1
          && call.arguments[0][0].kind === "string") registrationIds.push(call.arguments[0][0].value);
        if (call.name === "StepRegistration") {
          const tokens = call.arguments.flat();
          const index = tokens.findIndex((token, offset) => token.value === "stepId"
            && tokens[offset + 1]?.value === ":" && tokens[offset + 2]?.kind === "string");
          if (index >= 0) {
            registrationIds.push(tokens[index + 2].value);
            directRegistrationIds.push(tokens[index + 2].value);
          }
        }
      }
    }
    if (workerIds.length === 0) workerIds.push(...directRegistrationIds);
    const definitionFile = "src/flow/definition.js";
    if (!this.allFiles.includes(definitionFile)) {
      this.#diagnose("A11", definitionFile, null, [definitionFile], "targeted Definition source is missing");
      return;
    }
    const definition = this.#module(definitionFile, [definitionFile], "A11", true);
    const flowTokens = definition?.declaration("FLOW_DEFINITION")?.tokens ?? [];
    const directIds = [];
    for (let index = 0; index < flowTokens.length - 2; index++) {
      if (flowTokens[index].value === "id" && flowTokens[index + 1]?.value === ":"
        && flowTokens[index + 2]?.kind === "string") directIds.push(flowTokens[index + 2].value);
    }
    const positions = registrationIds.map((id) => directIds.indexOf(id)).filter((index) => index >= 0);
    const first = directIds[Math.min(...positions)];
    const last = directIds[Math.max(...positions)];
    const endpoints = range?.arguments.map((part) => part.length === 1 && part[0].kind === "string" ? part[0].value : null);
    if (!endpoints || endpoints[0] !== first || endpoints[1] !== last) {
      this.#diagnose("A11", file, range?.token, [file], "Definition target range omits this scope endpoint");
    }
    if (definition) {
      const start = directIds.indexOf(endpoints?.[0]);
      const end = directIds.indexOf(endpoints?.[1]);
      if (start < 0 || end < start) {
        this.#diagnose("A11", definitionFile, flowTokens[0], [definitionFile], "cannot resolve targeted Definition leaf range");
      } else {
        const expected = new Set(directIds.slice(start, end + 1));
        const routeFile = "src/flow/lib/draft-review-routes.js";
        const routeModule = this.allFiles.includes(routeFile)
          ? this.#module(routeFile, [routeFile], "A11", true) : null;
        const routeTokens = routeModule?.declaration("DRAFT_REVIEW_ROUTES")?.tokens ?? [];
        for (let index = 0; index < flowTokens.length - 3; index++) {
          if (flowTokens[index].value !== "createDraftReviewRouteNodes"
            || flowTokens[index + 1]?.value !== "(" || flowTokens[index + 2]?.kind !== "identifier") continue;
          const routeDeclaration = definition.declaration(flowTokens[index + 2].value);
          const key = routeDeclaration?.tokens.find((token, offset, tokens) => token.value === "draftReviewRouteForKey"
            && tokens[offset + 1]?.value === "(" && tokens[offset + 2]?.kind === "string");
          const routeKey = key && routeDeclaration.tokens[routeDeclaration.tokens.indexOf(key) + 2].value;
          const routeStart = routeTokens.findIndex((token, offset) => token.value === "key"
            && routeTokens[offset + 1]?.value === ":" && routeTokens[offset + 2]?.value === routeKey);
          if (routeStart < 0) {
            this.#diagnose("A11", definitionFile, flowTokens[index], [definitionFile, routeFile], "cannot resolve Definition review route leaves");
            continue;
          }
          for (const property of ["triageStepId", "repairStepId"]) {
            const target = routeTokens.findIndex((token, offset) => offset > routeStart && offset < routeStart + 50
              && token.value === property && routeTokens[offset + 1]?.value === ":"
              && routeTokens[offset + 2]?.kind === "string");
            if (target < 0) this.#diagnose("A11", routeFile, routeTokens[routeStart], [definitionFile, routeFile], `cannot resolve ${property}`);
            else expected.add(routeTokens[target + 2].value);
          }
        }
        const actual = new Set(registrationIds);
        if (actual.size !== registrationIds.length) this.#diagnose("A11", file, range?.token, [file], "duplicate static execution route registration");
        for (const id of expected) if (!actual.has(id)) {
          this.#diagnose("A11", definitionFile, flowTokens[0], [definitionFile, file], `Definition leaf ${id} has no static registration`);
        }
        for (const id of actual) if (!expected.has(id)) {
          this.#diagnose("A11", file, range?.token, [definitionFile, file], `static registration ${id} is outside targeted Definition leaves`);
        }
      }
    }
    for (const [name, left, right] of [
      ["workerStepExecutionRegistration", "draftWorkerStepRegistration", "specWorkerStepRegistration"],
      ["flowStepExecutionRegistration", "draftStepRegistration", "specStepRegistration"],
    ]) {
      const body = module.declaration(name);
      const tokens = body?.tokens ?? [];
      const names = new Set(tokens.map((token) => token.value));
      const guard = tokens.some((token, index) => token.value === "registeredPhaseSteps"
        && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === "has"
        && tokens[index + 3]?.value === "(" && tokens[index + 4]?.value === "stepId")
        && names.has("throw");
      if (!names.has(left) || !names.has(right) || !guard) {
        this.#diagnose("A11", file, body?.token, [file], `${name} must resolve both phase routes and reject missing targeted leaves`);
      }
    }
    this.#registryRoutes();
  }

  #registryRoutes() {
    const file = "src/flow/registry.js";
    if (!this.allFiles.includes(file)) {
      this.#diagnose("A11", file, null, [file], "Flow command registry source is missing");
      return;
    }
    const module = this.#module(file, [file], "A11", true);
    if (!module) return;
    const definition = module.declaration("FLOW_COMMANDS");
    if (!definition) {
      this.#diagnose("A11", file, null, [file], "FLOW_COMMANDS declaration is missing");
      return;
    }
    const child = (tokens, name) => {
      const open = tokens.findIndex((token) => token.value === "{");
      if (open < 0) return [];
      const found = [];
      let depth = 0;
      for (let index = open; index < tokens.length - 2; index++) {
        if (tokens[index].value === "{") depth++;
        if (tokens[index].value === "}") depth--;
        if (depth !== 1 || tokens[index].value !== name || tokens[index + 1]?.value !== ":") continue;
        const start = index + 2;
        if (tokens[start]?.value !== "{") { found.push(tokens.slice(start, start + 1)); continue; }
        let nested = 0;
        for (let end = start; end < tokens.length; end++) {
          if (tokens[end].value === "{") nested++;
          if (tokens[end].value === "}" && --nested === 0) { found.push(tokens.slice(start, end + 1)); break; }
        }
      }
      return found;
    };
    for (const [group, name, loader, target] of [
      ["get", "next-action", "loadGetNextActionCommand", "./lib/get-next-action.js"],
      ["run", "dispatch", "loadDispatchCommand", "./lib/run-dispatch.js"],
      ["run", "gate", "loadGateCommand", "./lib/run-gate.js"],
      ["run", "review", "loadReviewCommand", "./lib/run-review.js"],
    ]) {
      const routes = child(definition.tokens, group).flatMap((body) => child(body, name));
      const referenced = routes.length === 1 && child(routes[0], "command").length === 1
        && child(routes[0], "command")[0][0]?.value === loader;
      const loaderTokens = module.declaration(loader)?.tokens ?? [];
      const imported = loaderTokens.some((token, index) => token.value === "return"
        && loaderTokens[index + 1]?.value === "import" && loaderTokens[index + 2]?.value === "("
        && loaderTokens[index + 3]?.value === target && loaderTokens[index + 4]?.value === ")");
      if (!referenced || !imported) this.#diagnose("A11", file, definition.token, [file],
        `FLOW_COMMANDS ${group}.${name} must have one named ${loader} route to ${target}`);
    }
  }

  #contractEntry(file, operation, kind) {
    const module = this.#module(file, [file], "A10", true);
    if (!module) return;
    const tokens = module.tokens;
    const lookupKind = new Map([
      ["gateStepExecutionRegistration", "gate"], ["reviewStepExecutionRegistration", "review"],
      ["draftStepRegistration", "review"], ["specStepRegistration", "review"],
      ["workerStepExecutionRegistration", "worker"], ["draftWorkerStepRegistration", "worker"],
      ["specWorkerStepRegistration", "worker"],
      ["flowStepExecutionRegistration", "registered-phase"],
    ]);
    const receiverAt = (offset) => {
      if (tokens[offset - 2]?.value !== "executionContract") return tokens[offset - 2]?.value;
      if (tokens[offset - 3]?.value !== ".") return null;
      const owner = tokens[offset - 4]?.value === "?" ? tokens[offset - 5] : tokens[offset - 4];
      return owner?.kind === "identifier" ? `${owner.value}.executionContract` : null;
    };
    let connected = false;
    let foundSelection = false;
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index].value !== "select" || tokens[index - 1]?.value !== "." || tokens[index + 1]?.value !== "(") continue;
      if (!["executionContract", "contract"].includes(tokens[index - 2]?.value)) continue;
      let nearestKind = null;
      for (let cursor = index - 1; cursor >= 0; cursor--) {
        if (lookupKind.has(tokens[cursor].value)) { nearestKind = lookupKind.get(tokens[cursor].value); break; }
      }
      if (nearestKind !== kind) continue;
      foundSelection = true;
      let start = index - 1;
      while (start > 0 && tokens[start - 1].value !== ";" && tokens[start - 1].value !== "{") start--;
      const declaration = tokens.slice(start, index).findIndex((token, offset, slice) =>
        ["const", "let"].includes(token.value) && slice[offset + 1]?.kind === "identifier" && slice[offset + 2]?.value === "=");
      if (declaration < 0) {
        this.#diagnose("A10", file, tokens[index], [file], "registered execution selection is ignored");
        continue;
      }
      const variable = tokens[start + declaration + 1].value;
      const receiver = receiverAt(index);
      const block = [];
      for (let offset = 0; offset < index; offset++) {
        if (tokens[offset].value === "{") block.push(offset);
        if (tokens[offset].value === "}") block.pop();
      }
      let end = tokens.length;
      let depth = 1;
      for (let offset = index + 1; offset < tokens.length && block.length; offset++) {
        if (tokens[offset].value === "{") depth++;
        if (tokens[offset].value === "}" && --depth === 0) { end = offset; break; }
      }
      const use = tokens.findIndex((token, offset) => offset > index && offset < end
        && token.value === operation && tokens[offset - 1]?.value === "."
        && tokens[offset + 1]?.value === "(");
      if (use >= 0 && (tokens[use + 2]?.value !== variable || receiverAt(use) !== receiver)) {
        this.#diagnose("A10", file, tokens[use], [file], `registered selection ${variable} is not passed to ${operation}`);
      }
      if (use >= 0 && tokens[use + 2]?.value === variable && receiverAt(use) === receiver) connected = true;
      if (use < 0) {
        const assertions = ["assertWorkerExecutionAdmission", "assertCurrentGateExecutionSelection",
          "assertCurrentReviewExecutionSelection", "assertCurrentWorkerExecutionSelection",
          "assertGateProviderExecutionAdmission"];
        const verified = tokens.some((token, offset) => offset > index && offset < end
          && token.value === variable && assertions.some((name) => {
            if (!tokens.slice(Math.max(index, offset - 5), offset).some((previous) => previous.value === name)) return false;
            const reference = module.references.find((entry) => entry.bindings.get(name) === name);
            const target = reference && this.#resolve(file, reference, [file], "A10", true);
            return target?.file === (name.includes("Worker") ? "src/flow/lib/worker-execution-admission.js"
              : "src/flow/lib/execution-admission.js");
          }));
        if (!verified) this.#diagnose("A10", file, tokens[index], [file], `registered selection ${variable} is ignored`);
      }
      const overwritten = tokens.find((token, offset) => offset > index && offset < (use < 0 ? end : use) && token.value === variable
        && tokens[offset + 1]?.value === "=" && tokens[offset + 2]?.value !== "=");
      if (overwritten) this.#diagnose("A10", file, overwritten, [file], `registered selection ${variable} is overwritten`);
    }
    if (!foundSelection || !connected) this.#diagnose("A10", file, null, [file],
      `${kind} entry lacks connected registered select/${operation} path`);
    const bypass = tokens.find((token) => token.value === "admissionChecked");
    if (bypass) this.#diagnose("A10", file, bypass, [file], "entry accepts preapproved admission flag");
  }

  #restrictedExecutionMethods() {
    this.#privateWorkerExecutionReferences();
    for (const [method, adapter] of [
      ["executeSelectedGate", "src/flow/lib/execution-admission.js"],
      ["executeSelectedReview", "src/flow/lib/execution-admission.js"],
      ["executeSelectedWorker", "src/flow/lib/worker-execution-admission.js"],
    ]) {
      for (const file of this.allFiles) {
        if (file === adapter) continue;
        const module = this.#module(file, [file], "A11", true);
        if (!module) continue;
        for (let index = 1; index < module.tokens.length - 1; index++) {
          const token = module.tokens[index];
          if (token.value === method && (token.kind === "string"
            || module.tokens[index - 1]?.value === "."
            || module.tokens[index - 1]?.value === "?."
            || (module.tokens[index - 1]?.value === "[" && module.tokens[index + 1]?.value === "]"))) {
            this.#diagnose("A11", file, token, [file, adapter], `${method} bypasses registered execution adapter`);
          }
          if (method === "executeSelectedWorker" && token.value === "Reflect" && module.tokens[index + 1]?.value === "."
            && module.tokens[index + 2]?.value === "get" && module.tokens[index + 3]?.value === "(") {
            this.#diagnose("A11", file, token, [file, adapter], "computed command method lookup bypasses registered execution adapter");
          }
        }
      }
    }
  }

  #privateWorkerExecutionReferences() {
    const owner = "src/flow/lib/run-dispatch.js";
    const ownerModule = this.#module(owner, [owner], "A11", true);
    const selected = ownerModule && readClassMember(ownerModule, "RunDispatchCommand", "executeSelectedWorker");
    const run = ownerModule && readClassMember(ownerModule, "RunDispatchCommand", "runWorkerAttempt");
    const implementation = ownerModule && readClassMember(ownerModule, "RunDispatchCommand", "#executeSelectedWorker");
    const allowed = new Set();
    if (implementation) {
      allowed.add(implementation.token.offset);
      if (!selected?.matchesBody(`
        const { ctx, invocation, retryFeedback = null, agentOverride = null } = input;
        const stepId = invocation.action.nextAction.step;
        const registration = workerStepExecutionRegistration(stepId);
        if (registration === null) throw new TypeError("selected worker requires its production registration");
        const current = registration.executionContract.select({ ctx, stepId });
        assertCurrentWorkerExecutionSelection(selection, current);
        return this.#executeSelectedWorker(ctx, invocation, retryFeedback, agentOverride);
      `)) this.#diagnose("A11", owner, selected?.token, [owner],
        "private worker execution must follow current registered selection verification");
      // runWorkerAttempt has its own closed admission/fallback contract in A10.
      for (const declaration of [run, selected]) {
        for (const token of declaration?.tokens ?? []) {
          if (token.value === "#executeSelectedWorker") allowed.add(token.offset);
        }
      }
    }
    for (const file of this.allFiles) {
      const module = this.#module(file, [file], "A11", true);
      for (const token of module?.tokens ?? []) {
        if (token.value !== "#executeSelectedWorker") continue;
        if (file === owner && allowed.has(token.offset)) continue;
        this.#diagnose("A11", file, token, [file, owner],
          "private worker execution is referenced outside its registered admission entries");
      }
    }
  }
}

export function checkStructure({ root, entry, registrations, registrationModule, contract }) {
  return new StructureChecker(new StructureScope(root, entry, registrations, registrationModule, contract)).check();
}
