import path from "node:path";
import { SourceModule, SourceReadError } from "./source-reader.js";
import { FlowStructureRules } from "./flow-rules.js";
import { SourceRepository } from "./source-repository.js";

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
    this.rules = new FlowStructureRules();
  }

  check() {
    this.allFiles = this.#jsFiles(this.rules.sourceRoot);
    const entries = this.#jsFiles(this.scope.entry);
    if (entries.length === 0) this.#diagnose("A01", this.scope.entry, null, [this.scope.entry], "scope has no JavaScript entry files");
    const registered = this.#registrationIndex(entries);
    for (const entry of entries) this.#visit(entry, [entry], registered);
    const stepFiles = new Set(registered.keys());
    for (const entry of entries) {
      const module = this.#module(entry, [entry]);
      if (module && this.#role(entry, module) === "step") stepFiles.add(entry);
    }
    this.#reverseIndex(stepFiles);
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
      if (module.references.some((reference) => reference.kind === "import" && reference.bindings.has(entry.parent))
        && !this.unresolvedHeritage.has(key)) {
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
        }) || (reference.kind === "reexport" && (reference.bindings.size === 0 || [...reference.bindings.values()].includes("*"))
          && this.#exportsScopedStep(target.file, stepFiles, new Set()));
        if ((direct || indirect) && !this.rules.isComposition(file)) this.#diagnose("A06", file, reference.token, [file, target.file], "Step is referenced outside composition");
      }
    }
  }
}

export function checkStructure({ root, entry, registrations, registrationModule }) {
  return new StructureChecker(new StructureScope(root, entry, registrations, registrationModule)).check();
}
