import { isBuiltin } from "node:module";
import { SourceModule } from "./source-reader.js";

export function sourceBuiltin(specifier) {
  const name = specifier.replace(/^node:/, "");
  return isBuiltin(specifier) ? name : null;
}

export class SourceBuiltinTarget {
  constructor(builtin) {
    if (typeof builtin !== "string" || !builtin) throw new TypeError("builtin identity required");
    this.builtin = builtin;
    Object.freeze(this);
  }
}

export class SourceFileTarget {
  constructor(file) {
    if (typeof file !== "string" || !file) throw new TypeError("source file identity required");
    this.file = file;
    Object.freeze(this);
  }
}

/** Shared source locations and dependency routes for static structure checks. */
export class StructureDiagnostic {
  constructor(rule, file, token, trace, message, classification = "violation") {
    this.rule = rule;
    this.file = file;
    this.line = token?.line ?? 1;
    this.column = token?.column ?? 1;
    this.trace = [...trace];
    this.message = message;
    this.classification = classification;
  }
  toString() {
    return `${this.rule} ${this.file}:${this.line}:${this.column} ${this.message} [${this.trace.join(" -> ")}]`;
  }
}

/** One non-executing reader and repository resolver, shared by structure policies. */
export class SourceGraph {
  constructor(repository) {
    this.repository = repository;
    this.sources = new Map();
    this.modules = new Map();
    this.lexicalModules = new Map();
    this.resolvedPaths = new Map();
  }
  source(file) {
    if (!this.sources.has(file)) this.sources.set(file, this.repository.read(file));
    return this.sources.get(file);
  }
  module(file, { lexicalOnly = false } = {}) {
    const cache = lexicalOnly ? this.lexicalModules : this.modules;
    if (!cache.has(file)) cache.set(file, new SourceModule(file, this.source(file), { lexicalOnly }));
    return cache.get(file);
  }
  resolve(from, reference) {
    const specifier = reference.specifier;
    const builtin = sourceBuiltin(specifier);
    if (builtin) return new SourceBuiltinTarget(builtin);
    if (!specifier.startsWith(".")) throw new Error(`unresolved bare dependency ${specifier}`);
    const key = `${from}#${reference.kind}#${specifier}`;
    if (!this.resolvedPaths.has(key)) this.resolvedPaths.set(key, this.repository.resolve(from, specifier, { kind: reference.kind }));
    return new SourceFileTarget(this.resolvedPaths.get(key));
  }
}
