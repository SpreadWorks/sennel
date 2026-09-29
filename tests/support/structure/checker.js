import path from "node:path";
import { StepExecutionContract } from "../../../src/flow/engine/composition/step-execution-contract.js";
import { SourceModule, SourceReadError, SourceOriginUsage, readParameters, readClassMember, readInvocations, readMemberAccess, readTokens } from "./source-reader.js";
import { FlowStructureRules } from "./flow-rules.js";
import { SourceRepository } from "./source-repository.js";

const nativeClassBases = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError", "Array", "Map", "Set"]);

export class StructureScope {
  constructor(root, entry, registrations, registrationModule = `src/flow/engine/composition/${entry.split("/").at(-1)}.js`) {
    if (typeof root !== "string" || typeof entry !== "string" || !Array.isArray(registrations)) throw new TypeError("invalid structure scope");
    this.root = path.resolve(root);
    this.entry = entry.replace(/\\/g, "/").replace(/\/$/, "");
    this.registrations = registrations;
    this.registrationModule = registrationModule;
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

class ResolvedDependency {
  constructor(reference, target, sourceClass) {
    this.reference = reference;
    this.target = target;
    this.sourceClass = sourceClass;
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
    this.exports = new Map();
    this.unresolvedHeritage = new Set();
    this.ambiguousExports = new Set();
    this.allFiles = [];
    this.registeredServices = new Map();
    this.argumentTypeKeys = new Set();
    this.topLevelVisited = new Set();
    this.rules = new FlowStructureRules();
  }

  check() {
    this.allFiles = this.#jsFiles(this.rules.sourceRoot);
    const entries = this.#jsFiles(this.scope.entry);
    if (entries.length === 0) this.#diagnose("A01", this.scope.entry, null, [this.scope.entry], "scope has no JavaScript entry files");
    const registered = this.#registrationIndex(entries);
    for (const entry of entries) this.#visit(entry, [entry], registered);
    this.#serviceDependencies();
    const stepFiles = new Set(registered.keys());
    for (const entry of entries) {
      const module = this.#module(entry, [entry]);
      if (module && this.#role(entry, module) === "step") stepFiles.add(entry);
    }
    this.#reverseIndex(stepFiles);
    this.#reverseServiceIndex();
    this.#sharedExecutionSelections();
    this.#registeredExecutionRoute();
    return this.report;
  }

  #diagnose(rule, file, token, trace, message) {
    this.report.diagnostics.push(new StructureDiagnostic(rule, file, token, trace, message));
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
    try { return { file: this.repository.resolve(from, specifier) }; }
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
    const local = module.classes.find((entry) => entry.name === name);
    if (local) return new ResolvedSourceClass(file, module, local);
    const reference = module.references.find((entry) => entry.kind === "import" && entry.bindings.has(name));
    if (!reference) return null;
    const target = this.#resolve(file, reference, [file], rule, true);
    return target?.file ? this.#resolveExport(target.file, reference.bindings.get(name), seen, rule) : null;
  }

  #resolveExport(file, name, seen, rule) {
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    if (this.exports.has(key)) return this.exports.get(key);
    seen.add(key);
    const module = this.#module(file, [file], rule);
    if (!module) return null;
    const matches = [];
    const explicit = module.exports.filter((entry) => entry.name === name);
    const candidates = explicit.length ? explicit : module.exports.filter((entry) => entry.name === "*" && name !== "default");
    for (const binding of candidates) {
      if (binding.reference) {
        const target = this.#resolve(file, binding.reference, [file], rule, true);
        if (target?.file && binding.local !== "*") {
          const resolved = this.#resolveExport(target.file, binding.local, seen, rule);
          if (resolved) matches.push(resolved);
        } else if (target?.file && binding.name === "*") {
          const resolved = this.#resolveExport(target.file, name, seen, rule);
          if (resolved) matches.push(resolved);
        }
      } else if (binding.local !== "*") {
        const resolved = this.#resolveLocal(file, module, binding.local, seen, rule);
        if (resolved) matches.push(resolved);
      }
    }
    seen.delete(key);
    const unique = new Map(matches.map((entry) => [entry.key, entry]));
    const resolved = unique.size === 1 ? unique.values().next().value : null;
    if (unique.size > 1 && !this.ambiguousExports.has(`${rule}:${key}`)) {
      this.ambiguousExports.add(`${rule}:${key}`);
      this.#diagnose(rule, file, null, [file], `ambiguous export ${name}`);
    }
    if (resolved) this.exports.set(key, resolved);
    return resolved;
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
            const local = service.module.classes.find((entry) => entry.name === typeName);
            if (local) this.argumentTypeKeys.add(`${service.file}#${typeName}`);
            else {
              const imported = this.#dependencySource(service.module, typeName, true)?.sourceClass;
              if (imported) this.argumentTypeKeys.add(imported.key);
            }
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
    const kind = registration.stepId.endsWith("-gate") ? "gate"
      : registration.stepId.endsWith("-review") ? "review" : "worker";
    const contractName = `${kind}StepExecutionContract`;
    const contractSource = kind === "worker" ? "src/flow/lib/worker-execution-admission.js"
      : "src/flow/lib/execution-admission.js";
    const contractReference = module.references.find((reference) => reference.bindings.get(contractName) === contractName);
    const contractTarget = contractReference && this.#resolve(file, contractReference, [file], "A10");
    if (contractTarget?.file !== contractSource) {
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
    const serviceTokens = service.module.declaration(service.classEntry.name)?.tokens ?? [];
    const expected = [];
    for (const parameter of ["input", "writer"]) {
      const index = serviceTokens.findIndex((token, offset) => token.value === parameter
        && serviceTokens[offset + 1]?.value === "instanceof" && serviceTokens[offset + 2]?.kind === "identifier");
      expected.push(index >= 0 ? serviceTokens[index + 2].value : null);
    }
    if (expected.some((name) => name === null)) {
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
      if (tokens[index].value !== "new" || tokens[index + 1]?.value !== expected[0] || tokens[index + 2]?.value !== "(") continue;
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
      if (actual.length !== 2 || actual.some((name, offset) => name !== expected[offset])) {
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

  #serviceDependencies() {
    for (const service of this.registeredServices.values()) {
      this.#inspectService(service.file, service.classEntry.name, [service.file], new Set());
    }
  }

  #inspectService(file, name, trace, seen, member = null) {
    const key = `${file}#${name}${member === null ? "" : `.${member}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    const module = this.#module(file, trace, "A08");
    if (!module) return;
    this.#inspectTopLevelEffects(file, module, trace);
    const alias = module.exports.find((entry) => entry.name === name && entry.reference);
    if (alias) {
      const target = this.#resolve(file, alias.reference, trace, "A08");
      if (target?.file) this.#inspectService(target.file, alias.local, [...trace, target.file], seen);
      return;
    }
    const declaration = member === null ? module.declaration(name) : readClassMember(module, name, member);
    if (!declaration) {
      if (member !== null) return;
      const reference = module.references.find((entry) => entry.kind === "import" && entry.bindings.has(name));
      if (reference) {
        const target = this.#resolve(file, reference, trace, "A08");
        if (target?.file) this.#inspectService(target.file, reference.bindings.get(name), [...trace, target.file], seen);
      } else this.#diagnose("A08", file, null, trace, `cannot resolve Service dependency ${name}`);
      return;
    }
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
    if (member !== null) {
      for (let index = 0; index < declaration.tokens.length - 3; index++) {
        if (declaration.tokens[index].value !== "this" || declaration.tokens[index + 1]?.value !== "."
          || declaration.tokens[index + 3]?.value !== "(") continue;
        const next = declaration.tokens[index + 2].value;
        if (next !== member) this.#inspectService(file, name, trace, seen, next);
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
            this.#inspectReferencedClass(value, local, declaration, [...trace, value.file], seen);
          } else this.#diagnose("A08", file, reference.token, [...trace, target.file], `Service reaches ${role}`);
        }
      } else if (role === "helper" || role === "service" || role === "contract") {
        for (const [local, imported] of used) {
          const value = this.#resolveExport(target.file, imported, new Set(), "A08");
          if (value && !this.argumentTypeKeys.has(value.key)) {
            this.#inspectReferencedClass(value, local, declaration, [...trace, value.file], seen);
          } else this.#inspectService(target.file, imported, [...trace, target.file], seen);
        }
      }
    }
  }

  #inspectReferencedClass(value, local, caller, trace, seen) {
    const tokens = caller.tokens;
    const instances = new Set();
    const classAliases = new Set([local]);
    let changed;
    do {
      changed = false;
      for (let index = 0; index < tokens.length - 3; index++) {
        if (!["const", "let"].includes(tokens[index].value) || tokens[index + 2]?.value !== "="
          || !classAliases.has(tokens[index + 3]?.value) || classAliases.has(tokens[index + 1]?.value)) continue;
        classAliases.add(tokens[index + 1].value);
        changed = true;
      }
    } while (changed);
    for (let index = 0; index < tokens.length - 2; index++) {
      if (tokens[index].value !== "new" || !classAliases.has(tokens[index + 1]?.value)
        || tokens[index + 2]?.value !== "(") continue;
      this.#inspectService(value.file, value.classEntry.name, trace, seen, "constructor");
      let depth = 0;
      for (let end = index + 2; end < tokens.length; end++) {
        if (tokens[end].value === "(") depth++;
        if (tokens[end].value === ")" && --depth === 0) {
          if (tokens[end + 1]?.value === ".") {
            this.#inspectService(value.file, value.classEntry.name, trace, seen, tokens[end + 2]?.value);
          } else if (tokens[end + 1]?.value === "[") {
            this.#diagnose("A08", value.file, tokens[end + 1], trace,
              "Service helper uses unresolved computed instance member");
          }
          break;
        }
      }
      if (tokens[index - 1]?.value !== "=") continue;
      if (tokens[index - 2]?.kind === "identifier") instances.add(tokens[index - 2].value);
    }
    do {
      changed = false;
      for (let index = 0; index < tokens.length - 3; index++) {
        if (!["const", "let"].includes(tokens[index].value) || tokens[index + 2]?.value !== "="
          || !instances.has(tokens[index + 3]?.value) || instances.has(tokens[index + 1]?.value)) continue;
        instances.add(tokens[index + 1].value);
        changed = true;
      }
    } while (changed);
    for (let index = 0; index < tokens.length - 3; index++) {
      if ((classAliases.has(tokens[index].value) || instances.has(tokens[index].value))
        && tokens[index + 1]?.value === ".") {
        this.#inspectService(value.file, value.classEntry.name, trace, seen, tokens[index + 2].value);
      }
      if ((classAliases.has(tokens[index].value) || instances.has(tokens[index].value))
        && tokens[index + 1]?.value === "[") {
        this.#diagnose("A08", value.file, tokens[index + 1], trace,
          "Service helper uses unresolved computed member");
      }
      if (tokens[index].value === "this" && tokens[index + 1]?.value === "."
        && instances.has(tokens[index + 2]?.value) && tokens[index + 3]?.value === ".") {
        this.#inspectService(value.file, value.classEntry.name, trace, seen, tokens[index + 4].value);
      }
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
            this.#inspectReferencedClass(value, local, caller, [...trace, target.file], new Set());
          }
          else this.#inspectService(target.file, imported, [...trace, target.file], new Set());
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

  #sharedExecutionSelections() {
    const contracts = new Map([
      ["gate", ["selectGateExecutionAdmission", "projectGateExecutionAdmission", "executeGateSelection", "src/flow/lib/run-gate.js"]],
      ["review", ["selectReviewExecutionAdmission", "projectReviewExecutionAdmission", "executeReviewSelection", "src/flow/lib/run-review.js"]],
      ["worker", ["selectWorkerExecutionAdmission", "projectWorkerExecutionAdmission", "executeWorkerExecutionAdmission", "src/flow/lib/run-dispatch.js"]],
    ]);
    const required = new Set();
    for (const registration of this.scope.registrations) {
      if (!registration.ServiceClass) continue;
      const kind = registration.stepId.endsWith("-gate") ? "gate"
        : registration.stepId.endsWith("-review") ? "review" : "worker";
      const [selector, projector, executor] = contracts.get(kind);
      const contract = registration.executionContract;
      if (!(contract instanceof StepExecutionContract)
        || contract.selectorName !== selector || contract.projectorName !== projector
        || contract.executorName !== executor) {
        this.#diagnose("A10", this.scope.registrationModule, null, [this.scope.registrationModule],
          `registration ${registration.stepId} lacks its named ${kind} execution contract`);
      }
      required.add(kind);
    }
    for (const kind of required) {
      const [selector, projector, executor, command] = contracts.get(kind);
      this.#contractEntry("src/flow/lib/get-next-action.js", "project", kind);
      this.#contractEntry(command, "execute", kind);
      const adapterFile = kind === "worker" ? "src/flow/lib/worker-execution-admission.js"
        : "src/flow/lib/execution-admission.js";
      const adapter = this.#module(adapterFile, [adapterFile], "A10", true);
      if (!adapter) continue;
      const contractName = `${kind}StepExecutionContract`;
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
    this.#registeredDisplayRoutes(required);
    this.#canonicalDisplayCommandRoute(required);
    this.#registeredGateReviewExecutionRoutes(required);
    if (required.has("worker")) this.#registeredWorkerExecutionRoutes();
    if (required.has("worker") && this.allFiles.includes("src/flow/lib/worker-execution-admission.js")) {
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
    this.#restrictedExecutionMethods();
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
        'target.scope === "flow" ? draftWorkerStepRegistration(target.stepId) ?? specWorkerStepRegistration(target.stepId) : null',
        "worker");
      const selected = requireInitializer("workerSelection",
        'workerRegistration?.executionContract.select({ ctx, stepId: target.stepId })', "worker");
      const workerDirective = requireInitializer("workerDirective",
        'workerSelection === undefined ? null : workerRegistration.executionContract.project(workerSelection, { binding, recoveryCommand, retryRecoveryPlan: recoveryPlan, missingProducerArtifactRoute: missingRoute, })',
        "worker");
      if (selected && tokens.slice(0, selected.index).some((token) => token.value === "return")) {
        this.#diagnose("A10", file, build?.token, [file],
          "canonical worker display can return before registered selection");
      }
      const writes = tokens.filter((token, index) => token.value === "selectedDirective"
        && (tokens[index + 1]?.value === "=" || (tokens[index + 1]?.value === "?"
          && tokens[index + 2]?.value === "?" && tokens[index + 3]?.value === "="))).length;
      const initialDirective = build.topLevelInitializer("selectedDirective");
      const claimDirective = build.topLevelInitializer("claimDirective");
      const taskOverrides = build.containsBodySequence('target.stepId === "task-triage"')
        || build.containsBodySequence('target.stepId === "task-review"');
      if (workerDirective && !build.containsBodySequence(`
        selectedDirective ??= userDecisionDirective ?? (workerDirective instanceof ExecuteStepDirective ? null : workerDirective)
          ?? approvalDirective ?? activationDirective ?? outboxRecovery?.directive ?? gateDirective ?? lifecycleDirective;
      `) || (workerDirective && !build.containsBodySequence(
        "const claimRequired = selectedDirective instanceof ExecuteStepDirective"
      )) || (workerDirective && !build.containsBodySequence("directive: claimDirective.toJSON()"))
        || !initialDirective?.matches(`specPostFailure === null ? null : new BlockedDirective({
          code: specPostFailure.code, reason: specPostFailure.reason,
          resumeInstruction: specPostFailure.resumeInstruction,
        })`)
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
        || this.scope.registrations.some((registration) => registration.stepId.endsWith("-review")
          && !members.has(registration.stepId))) {
        this.#diagnose("A10", file, reviewStep?.token ?? build?.token, [file],
          "registered Review Step is absent from display routing");
      }
      requireInitializer("reviewRegistration",
        'target.scope === "flow" ? draftStepRegistration(target.stepId) ?? specStepRegistration(target.stepId) : null',
        "review");
      requireInitializer("reviewSelection",
        'reviewStep && ["resume", "retry", "record", "blocked"].includes(descriptor.operation) ? reviewRegistration === null ? resolveCurrentReviewTransition(reviewInput) : reviewRegistration.executionContract.select(reviewInput) : { facts: null, disposition: null }',
        "review");
      const projected = requireInitializer("reviewDisposition",
        'reviewStep && reviewRegistration !== null && ["resume", "retry", "record", "blocked"].includes(descriptor.operation) ? reviewRegistration.executionContract.project(reviewSelection) : reviewSelection.disposition',
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
      const gateTokens = gate?.bodyTokens() ?? null;
      const phase = gate?.topLevelInitializer("phase");
      const registration = gate?.topLevelInitializer("registration");
      for (const candidate of this.scope.registrations.filter((entry) => entry.stepId.endsWith("-gate"))) {
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
      const gateBody = `
        const phase = target.stepId === "draft-gate" ? "draft" : target.stepId === "spec-gate"
          ? "spec" : target.scope === "task" && target.stepId === "task-gate"
            ? "task-impl" : target.scope === "flow" && target.stepId === "impl-gate"
              ? "integration" : null;
        if (phase === null) return null;
        if (phase === "spec") {
          const saved = ctx.flowManager.readCurrentStepSettlement({ specId: state.specId, stepId: "spec-gate", });
          if (saved !== null) return new SavedSpecGateSelection(saved);
        }
        const registration = gateStepExecutionRegistration(phase);
        if (registration !== null) {
          const selection = registration.executionContract.select({
            flowManager: ctx.flowManager, flowState: state, phase,
            typedState: ctx.flowManager.canonicalState(state.specId),
          });
          if (phase === "spec" && selection.admission.facts !== null) {
            throw new Error("Spec Gate publication lacks its atomic Step Result and Settlement");
          }
          return registration.executionContract.project(selection);
        }
        return resolveGateNextAction({ flowManager: ctx.flowManager, flowState: state, phase, });
      `;
      if (!gate?.matchesBody(gateBody)) {
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
      const registration = draftWorkerStepRegistration(stepId) ?? specWorkerStepRegistration(stepId);
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
    if (!run?.matchesBody(`
      const stepId = invocation.action.nextAction.step;
      const registration = workerStepExecutionRegistration(stepId);
      if (registration === null) return this.#executeSelectedWorker(ctx, invocation, retryFeedback, agentOverride);
      const selection = registration.executionContract.select({ ctx, stepId });
      return registration.executionContract.execute(selection, {
        command: this, ctx, invocation, retryFeedback, agentOverride,
      });
    `)) {
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
    if (!flow?.matchesBody(`
      const registration = draftStepRegistration(stepId) ?? specStepRegistration(stepId);
      if (registration === null && registeredPhaseSteps.has(stepId)) {
        throw new Error(\`Definition leaf \${stepId} has no registered execution contract\`);
      }
      return registration;
    `)) this.#diagnose("A10", file, flow?.token, [file],
      "Gate/Review registration resolver can bypass a registered Step");
    this.#closedRegistrationLookups([
      ["draft", "draftStepRegistration", "draftById", "registrations"],
      ["spec", "specStepRegistration", "byId", "specStepRegistrations"],
    ], "Gate/Review");
    if (required.has("gate")) {
      const resolver = module?.declaration("gateStepExecutionRegistration");
      if (!resolver?.matchesBody(`
        if (phase === "draft") return flowStepExecutionRegistration("draft-gate");
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
        if (["draft-questions", "draft-coverage", "spec"].includes(persistedPhase)
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
        return registration.executionContract.execute(selection, { command: this, ctx });
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
    for (const compositionFile of this.allFiles.filter((candidate) =>
      /^src\/flow\/engine\/composition\/[^/]+\.js$/.test(candidate) && candidate !== file)) {
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
    const first = workerIds[0];
    const last = workerIds.at(-1);
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

export function checkStructure({ root, entry, registrations, registrationModule }) {
  return new StructureChecker(new StructureScope(root, entry, registrations, registrationModule)).check();
}
