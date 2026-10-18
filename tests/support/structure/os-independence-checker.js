import { SourceGraph, StructureDiagnostic } from "./source-graph.js";
import { OsIndependenceRules } from "./os-independence-rules.js";

export class OsIndependenceDiagnostic extends StructureDiagnostic {}

export class OsIndependenceReport {
  constructor(scope) {
    this.scope = scope;
    this.diagnostics = [];
    this.visited = new Set();
    this.coverage = { declared: scope.files.length, discovered: 0, inspected: 0, incomplete: 0, rules: ["OS01", "OS02", "OS03", "OS04"] };
  }
  get complete() { return !this.diagnostics.some((entry) => entry.classification === "incomplete"); }
  get ok() { return this.complete && this.diagnostics.length === 0; }
  assert() {
    if (!this.ok) throw new Error(this.diagnostics.map((entry) => entry.toString()).join("\n"));
    return this;
  }
  describe() { return `inspected=${this.coverage.inspected}/${this.coverage.discovered}; complete=${this.complete}`; }
}

/** Whole explicit scope inspection. Every module is a root, including unreachable modules. */
export class OsIndependenceChecker {
  constructor(repository, scope) {
    if (!scope || !Array.isArray(scope.files)) throw new TypeError("an explicit discovered source scope is required");
    this.repository = repository;
    this.scope = scope;
    this.graph = new SourceGraph(repository);
    this.report = new OsIndependenceReport(scope);
    this.diagnosticKeys = new Map();
    this.rules = new OsIndependenceRules(this.graph, (...args) => this.diagnose(...args));
  }
  diagnose(rule, file, token, trace, message, classification = "violation") {
    const entry = new OsIndependenceDiagnostic(rule, file, token, [...new Set(trace)], message, classification);
    const key = `${rule}:${file}:${entry.line}:${entry.column}:${classification}:${message}`;
    const existing = this.diagnosticKeys.get(key);
    if (!existing) { this.report.diagnostics.push(entry); this.diagnosticKeys.set(key, entry); }
    else if (entry.trace.length > existing.trace.length) {
      // Keep one emitted route. A later caller can enrich an independently
      // inspected helper's route, but unrelated callers must not be stitched.
      let cursor = 0;
      for (const file of entry.trace) if (file === existing.trace[cursor]) cursor++;
      if (cursor === existing.trace.length) existing.trace = [...entry.trace];
    }
  }
  visit(file, trace) {
    if (this.report.visited.has(file)) return;
    this.report.visited.add(file);
    let module;
    try { module = this.graph.module(file, { lexicalOnly: true }); }
    catch (error) { this.diagnose("OS00", file, error, trace, `cannot read/parse source: ${error.message}`, "incomplete"); return; }
    for (const reference of module.references) {
      try {
        const target = this.graph.resolve(file, reference);
        if (target.file) this.visit(target.file, [...trace, target.file]);
      } catch (error) { this.diagnose("OS00", file, reference.token, trace, error.message, "incomplete"); }
    }
    try { this.rules.inspect(module); this.report.coverage.inspected++; }
    catch (error) { this.diagnose("OS00", file, error, trace, `source inspection incomplete: ${error.message}`, "incomplete"); }
  }
  check() {
    if (this.scope.files.length === 0) this.diagnose("OS00", "<scope>", null, [], "source scope is empty", "incomplete");
    for (const file of this.scope.files) this.visit(file, [file]);
    this.report.coverage.discovered = this.report.visited.size;
    this.report.coverage.incomplete = new Set(this.report.diagnostics.filter((entry) => entry.classification === "incomplete").map((entry) => entry.file)).size;
    this.report.coverage.byRule = Object.fromEntries(this.report.coverage.rules.map((rule) => {
      const entries = this.report.diagnostics.filter((entry) => entry.rule === rule);
      const commonIncomplete = this.report.diagnostics.filter((entry) => entry.rule === "OS00" && entry.classification === "incomplete").length;
      const incomplete = entries.filter((entry) => entry.classification === "incomplete").length + commonIncomplete;
      return [rule, { complete: incomplete === 0, violations: entries.filter((entry) => entry.classification === "violation").length, incomplete }];
    }));
    return this.report;
  }
}
