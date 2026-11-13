import path from "node:path";
import { OsIndependenceDiagnostic } from "./os-independence-checker.js";
import { sourceFile } from "./source-repository.js";

/** A declared manifest edge, retained separately from directory coverage. */
export class AuditEntrypoint {
  constructor(kind, name, file) {
    if (![kind, name, file].every((value) => typeof value === "string" && value)) throw new TypeError("entrypoint identity required");
    Object.assign(this, { kind, name, file });
    Object.freeze(this);
  }
}

/** Whole-source inventory: entrypoint reachability never limits inspection. */
export class OsAuditScope {
  constructor(repository) {
    if (!repository || typeof repository.inventory !== "function" || typeof repository.read !== "function") throw new TypeError("source repository required");
    this.repository = repository;
    this.files = [];
    this.resources = [];
    this.entrypoints = [];
    this.diagnostics = [];
    this.manifest = null;
    this.coverage = {
      directories: [], distribution: [], entrypoints: [],
      distributionContract: "Conservative directory-prefix superset of manifest files patterns; exclusions never narrow owned source inspection. This is not npm pack file matching.",
      external: ["Declared external plugin implementations and user command internals; owned calling boundaries remain inspected."],
    };
  }

  #incomplete(file, message, trace = [file]) {
    if (this.diagnostics.some((entry) => entry.file === file && entry.message === message)) return;
    this.diagnostics.push(new OsIndependenceDiagnostic("OS00", file, null, trace, message, "incomplete"));
  }

  #inventory(name, options = {}) {
    try {
      return this.repository.inventory(name, {
        ...options,
        allowResourceAliases: true,
        onError: (error) => this.#incomplete(error.file || name, `source discovery failed: ${error.message}`, [name, error.file || name]),
      });
    }
    catch (error) { this.#incomplete(name, `source discovery failed: ${error.message}`); return []; }
  }

  #path(value) {
    if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value)) throw new Error("manifest entry must be a repository-relative path");
    const normalized = path.posix.normalize(value);
    if (normalized === ".." || normalized.startsWith("../")) throw new Error("manifest entry escapes repository");
    return normalized.replace(/\/$/, "");
  }

  #entry(kind, name, value, selected) {
    try {
      const file = this.#path(value);
      if (!sourceFile(file, true)) throw new Error(`unsupported implementation entry: ${value}`);
      const entries = this.#inventory(file);
      if (entries.length !== 1 || entries[0] !== file) throw new Error(`entrypoint is not one regular source file: ${value}`);
      selected.add(file);
      this.entrypoints.push(new AuditEntrypoint(kind, name, file));
    } catch (error) { this.#incomplete("package.json", `${kind} ${name}: ${error.message}`, ["package.json", value]); }
  }

  discover() {
    const selected = new Set();
    for (const directory of ["src", "scripts", "tests/support", "tests/runner"]) {
      const entries = this.#inventory(directory);
      this.coverage.directories.push({ directory, files: entries.length });
      if (!entries.length) this.#incomplete(directory, "audit directory is empty");
      for (const file of entries) selected.add(file);
    }
    // Runner helpers at the tests root are infrastructure; suites and negative
    // fixture programs have their own test-owned execution contracts.
    for (const file of this.#inventory("tests", { maxDepth: 1 })) selected.add(file);
    try {
      this.manifest = JSON.parse(this.repository.read("package.json"));
      if (!this.manifest || typeof this.manifest !== "object" || Array.isArray(this.manifest)) throw new Error("package manifest must be an object");
    } catch (error) { this.#incomplete("package.json", `manifest unreadable: ${error.message}`); }
    if (this.manifest) {
      const bin = this.manifest.bin;
      if (typeof bin === "string") this.#entry("bin", this.manifest.name || "package", bin, selected);
      else if (bin && typeof bin === "object" && !Array.isArray(bin)) for (const [name, value] of Object.entries(bin)) this.#entry("bin", name, value, selected);
      else this.#incomplete("package.json", "package bin declarations are missing or invalid");
      const scripts = this.manifest.scripts;
      if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) this.#incomplete("package.json", "package scripts declarations are missing or invalid");
      else for (const [name, command] of Object.entries(scripts)) {
        // This is a deliberately closed entrypoint declaration, not a shell
        // parser. Chaining, substitutions and shims cannot hide a new entry.
        const match = typeof command === "string" && /^node\s+((?:\.\/)?[\w./-]+\.(?:js|mjs|cjs))(?:\s+[^;&|`$\r\n]*)?$/.exec(command);
        if (!match) this.#incomplete("package.json", `script ${name} has an unsupported executable declaration`, ["package.json", `scripts.${name}`]);
        else this.#entry("script", name, match[1], selected);
      }
      if (!Array.isArray(this.manifest.files) || !this.manifest.files.length) this.#incomplete("package.json", "package distribution declarations are missing or empty");
      else for (const declaration of this.manifest.files) {
        try {
          if (typeof declaration !== "string" || !declaration) throw new Error("invalid distribution declaration");
          const excluded = declaration.startsWith("!");
          const value = this.#path(excluded ? declaration.slice(1) : declaration);
          const wildcard = value.search(/[?*[]/);
          const prefix = wildcard < 0 ? value : value.slice(0, value.lastIndexOf("/", wildcard) + 1).replace(/\/$/, "");
          if (!prefix || prefix === ".") throw new Error("distribution glob has no auditable directory prefix");
          const entries = this.#inventory(prefix, { allowMissing: excluded });
          this.coverage.distribution.push({ declaration, directory: prefix, files: entries.length, excluded });
          // Distribution exclusions do not exempt owned source from audit.
          for (const file of entries) selected.add(file);
        } catch (error) { this.#incomplete("package.json", `distribution: ${error.message}`); }
      }
    }
    for (const file of [...selected].sort()) {
      try {
        if (sourceFile(file, true)) this.files.push(file);
        else this.resources.push(file);
      } catch (error) { this.#incomplete(file, `unsupported implementation format: ${error.message}`); }
    }
    if (!this.files.length) this.#incomplete(".", "audit has no implementation files");
    this.coverage.entrypoints = this.entrypoints;
    return this;
  }
}
