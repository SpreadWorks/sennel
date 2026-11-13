import fs from "node:fs";
import path from "node:path";

const sourceExtensions = new Set([".js", ".mjs", ".cjs"]);
const unsupportedSourceExtensions = new Set([".jsx", ".ts", ".tsx", ".mts", ".cts", ".sh", ".bash", ".zsh", ".cmd", ".bat", ".ps1", ".py", ".rb", ".php"]);

export class SourceRepositoryError extends Error {
  constructor(code, file, message, cause = undefined) {
    super(`${message}: ${file}`, { cause });
    this.code = code;
    this.file = file;
  }
}

export function sourceFile(file, strict = false) {
  const extension = path.posix.extname(file).toLowerCase();
  if (strict && unsupportedSourceExtensions.has(extension)) {
    throw new SourceRepositoryError("UNSUPPORTED_SOURCE", file, "unsupported source entry");
  }
  return sourceExtensions.has(extension);
}

function discoveryFailure(onError) {
  if (onError !== null && typeof onError !== "function") throw new TypeError("source discovery onError must be a function");
  return (error) => { if (onError === null) throw error; onError(error); };
}

function traversalDepth(maxDepth) {
  if (maxDepth !== Infinity && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
    throw new TypeError("source inventory maxDepth must be a non-negative integer or Infinity");
  }
  return maxDepth;
}

function resolveDependency(file, inspect, kind) {
  const extension = path.posix.extname(file);
  if (extension) {
    if (!sourceFile(file, true)) throw new SourceRepositoryError("UNSUPPORTED_SOURCE", file, "unsupported dependency");
    const entry = inspect(file);
    if (entry === null) throw new SourceRepositoryError("MISSING_SOURCE", file, "missing dependency");
    if (entry !== "file") throw new SourceRepositoryError("UNSUPPORTED_SOURCE", file, "dependency is not a regular file");
    return file;
  }
  if (kind !== "require") throw new SourceRepositoryError("UNSUPPORTED_SOURCE", file, "ES module dependencies require a source extension");
  const entry = inspect(file);
  if (entry === "file") throw new SourceRepositoryError("UNSUPPORTED_SOURCE", file, "unsupported extensionless source entry");
  // Node's CommonJS extension search is .js, .json, .node. The latter two
  // are outside this JavaScript graph and must remain incomplete, not skipped.
  for (const extension of [".js", ".json", ".node"]) {
    const candidate = `${file}${extension}`;
    if (inspect(candidate) === null) continue;
    if (extension !== ".js" || inspect(candidate) !== "file") throw new SourceRepositoryError("UNSUPPORTED_SOURCE", candidate, "unsupported CommonJS dependency");
    return candidate;
  }
  if (entry === "directory") {
    if (inspect(`${file}/package.json`) !== null) throw new SourceRepositoryError("UNSUPPORTED_SOURCE", file, "package directory resolution is unsupported");
    for (const extension of [".js", ".json", ".node"]) {
      const candidate = `${file}/index${extension}`;
      if (inspect(candidate) === null) continue;
      if (extension !== ".js" || inspect(candidate) !== "file") throw new SourceRepositoryError("UNSUPPORTED_SOURCE", candidate, "unsupported CommonJS dependency");
      return candidate;
    }
  }
  throw new SourceRepositoryError("MISSING_SOURCE", file, "missing dependency");
}

function inside(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Filesystem boundary for source discovery, reads, and relative resolution.
 * Source traversal uses lstat at every component. Audit-only Markdown aliases
 * resolve to regular owned resources and are revalidated before each read.
 * Filesystem injection permits portable failure tests without platform permissions.
 */
export class SourceRepository {
  #resourceAliases = new Set();
  constructor(root, { filesystem = fs } = {}) {
    this.root = path.resolve(root);
    this.filesystem = filesystem;
  }
  #relative(absolute) { return path.relative(this.root, absolute).split(path.sep).join("/"); }
  #absolute(relative) {
    const absolute = path.resolve(this.root, relative);
    if (!inside(this.root, absolute)) throw new SourceRepositoryError("ROOT_ESCAPE", relative, "path escapes repository");
    return absolute;
  }
  #stat(absolute) {
    try { return this.filesystem.lstatSync(absolute); }
    catch (error) {
      throw new SourceRepositoryError(error.code === "ENOENT" ? "MISSING_SOURCE" : "UNREADABLE_SOURCE",
        this.#relative(absolute), "cannot inspect source entry", error);
    }
  }
  #checked(absolute) {
    const components = path.relative(this.root, absolute).split(path.sep).filter(Boolean);
    let current = this.root;
    let stat = this.#stat(current);
    const inspect = () => {
      if (stat.isSymbolicLink()) throw new SourceRepositoryError("SYMLINK_SOURCE", this.#relative(current), "symbolic source entry");
      if (!stat.isDirectory() && !stat.isFile()) throw new SourceRepositoryError("SPECIAL_SOURCE", this.#relative(current), "special source entry");
    };
    inspect();
    for (const component of components) {
      current = path.join(current, component);
      stat = this.#stat(current);
      inspect();
    }
    return stat;
  }
  #resourceTarget(absolute) {
    this.#checked(path.dirname(absolute));
    if (path.extname(absolute).toLowerCase() !== ".md" || !this.#stat(absolute).isSymbolicLink()) {
      throw new SourceRepositoryError("SYMLINK_SOURCE", this.#relative(absolute), "resource alias must remain a Markdown file link");
    }
    let canonicalRoot;
    let canonical;
    try {
      canonicalRoot = this.filesystem.realpathSync(this.root);
      canonical = this.filesystem.realpathSync(absolute);
    } catch (error) {
      throw new SourceRepositoryError("UNREADABLE_SOURCE", this.#relative(absolute), "cannot resolve resource alias", error);
    }
    if (!inside(canonicalRoot, canonical)) throw new SourceRepositoryError("ROOT_ESCAPE", this.#relative(absolute), "resource alias escapes repository");
    const target = this.#absolute(path.relative(canonicalRoot, canonical));
    if (path.extname(target).toLowerCase() !== ".md" || !this.#checked(target).isFile()) {
      throw new SourceRepositoryError("SYMLINK_SOURCE", this.#relative(absolute), "resource alias target must be a regular Markdown file");
    }
    return target;
  }
  #sourceEntry(absolute, sourceOnly, allowResourceAliases = false) {
    const stat = this.#stat(absolute);
    if (allowResourceAliases && stat.isSymbolicLink() && path.extname(absolute).toLowerCase() === ".md") {
      const target = this.#resourceTarget(absolute);
      this.#resourceAliases.add(absolute);
      return this.#checked(target);
    }
    // Flow's lexical index owns JavaScript, while the whole-source inventory
    // owns every asset. A non-code file link is irrelevant to the former only
    // when its target is proven to be a regular file; directory links still fail.
    if (sourceOnly && !sourceFile(this.#relative(absolute))) {
      if (absolute !== this.root) this.#checked(path.dirname(absolute));
      if (stat.isFile()) return null;
      if (stat.isSymbolicLink()) {
        let target;
        try { target = this.filesystem.statSync(absolute); }
        catch (error) { throw new SourceRepositoryError("UNREADABLE_SOURCE", this.#relative(absolute), "cannot classify source entry", error); }
        if (target.isFile()) return null;
      }
    }
    return this.#checked(absolute);
  }
  #discover(relative, { allowMissing = false, onError = null, sourceOnly = false, maxDepth = Infinity,
    allowResourceAliases = false } = {}) {
    traversalDepth(maxDepth);
    const failed = discoveryFailure(onError);
    const files = [];
    let absolute;
    let stat;
    let canonicalRoot;
    try {
      absolute = this.#absolute(relative);
      stat = this.#sourceEntry(absolute, sourceOnly, allowResourceAliases);
      if (stat === null) return [];
      try { canonicalRoot = this.filesystem.realpathSync(this.root); }
      catch (error) { throw new SourceRepositoryError("UNREADABLE_SOURCE", ".", "cannot resolve source root", error); }
    } catch (error) {
      if (allowMissing && error.code === "MISSING_SOURCE") return [];
      failed(error); return [];
    }
    const visited = new Set();
    const walk = (entry, entryStat, depth) => {
      if (entryStat.isFile()) { files.push(this.#relative(entry)); return; }
      if (depth >= maxDepth) return;
      let children;
      try {
        const canonical = this.filesystem.realpathSync(entry);
        if (!inside(canonicalRoot, canonical)) throw new SourceRepositoryError("ROOT_ESCAPE", this.#relative(entry), "source traversal escapes repository");
        if (visited.has(canonical)) throw new SourceRepositoryError("SOURCE_CYCLE", this.#relative(entry), "source traversal cycle");
        visited.add(canonical);
        children = this.filesystem.readdirSync(entry, { withFileTypes: true });
      } catch (error) {
        failed(error instanceof SourceRepositoryError ? error
          : new SourceRepositoryError("UNREADABLE_SOURCE", this.#relative(entry), "cannot enumerate source directory", error));
        return;
      }
      for (const child of children) {
        let full;
        let childStat;
        try {
          full = path.join(entry, child.name);
          if (!inside(this.root, full) || path.dirname(full) !== entry) throw new SourceRepositoryError("ROOT_ESCAPE", child.name, "invalid source entry name");
          childStat = this.#sourceEntry(full, sourceOnly, allowResourceAliases);
        } catch (error) { failed(error); continue; }
        if (childStat !== null) walk(full, childStat, depth + 1);
      }
    };
    walk(absolute, stat, 0);
    return files.sort();
  }
  inventory(relative = ".", { allowMissing = false, onError = null, maxDepth = Infinity, allowResourceAliases = false } = {}) {
    return this.#discover(relative, { allowMissing, onError, maxDepth, allowResourceAliases });
  }
  list(relative = ".", { strict = false } = {}) {
    return this.#discover(relative, { allowMissing: !strict, sourceOnly: !strict }).filter((file) => sourceFile(file, strict));
  }
  read(file) {
    let absolute = this.#absolute(file);
    if (this.#resourceAliases.has(absolute)) absolute = this.#resourceTarget(absolute);
    if (!this.#checked(absolute).isFile()) throw new SourceRepositoryError("UNSUPPORTED_SOURCE", file, "source is not a regular file");
    try { return this.filesystem.readFileSync(absolute, "utf8"); }
    catch (error) { throw new SourceRepositoryError("UNREADABLE_SOURCE", file, "cannot read source", error); }
  }
  resolve(from, specifier, { kind = "import" } = {}) {
    this.#absolute(from);
    if (path.isAbsolute(specifier) || path.win32.isAbsolute(specifier)) throw new SourceRepositoryError("ROOT_ESCAPE", specifier, "dependency escapes repository");
    const file = this.#relative(this.#absolute(path.join(path.dirname(from), specifier)));
    return resolveDependency(file, (candidate) => {
      try { return this.#checked(this.#absolute(candidate)).isFile() ? "file" : "directory"; }
      catch (error) { if (error.code === "MISSING_SOURCE") return null; throw error; }
    }, kind);
  }
}

/** A non-I/O source repository with the same path and extension boundary. */
export class MemorySourceRepository {
  constructor(files) { this.files = new Map(files); }
  #path(file) {
    if (typeof file !== "string" || file.includes("\\") || path.posix.isAbsolute(file)
      || path.win32.isAbsolute(file)) throw new SourceRepositoryError("ROOT_ESCAPE", file, "path escapes repository");
    const normalized = path.posix.normalize(file);
    if (normalized === ".." || normalized.startsWith("../")) throw new SourceRepositoryError("ROOT_ESCAPE", file, "path escapes repository");
    return normalized;
  }
  inventory(relative = ".", { allowMissing = false, onError = null, maxDepth = Infinity } = {}) {
    const failed = discoveryFailure(onError);
    traversalDepth(maxDepth);
    try { relative = this.#path(relative); }
    catch (error) { failed(error); return []; }
    const files = [];
    let foundEntry = false;
    for (const file of this.files.keys()) {
      try {
        if (this.#path(file) !== file) throw new SourceRepositoryError("UNSUPPORTED_SOURCE", file, "noncanonical source entry");
      } catch (error) { failed(error); continue; }
      if (relative === "." || file === relative || file.startsWith(`${relative}/`)) {
        foundEntry = true;
        const depth = file === relative ? 0 : relative === "." ? file.split("/").length : file.slice(relative.length + 1).split("/").length;
        if (depth <= maxDepth) files.push(file);
      }
    }
    if (!foundEntry && relative !== "." && !allowMissing) failed(new SourceRepositoryError("MISSING_SOURCE", relative, "missing source entry"));
    return files.sort();
  }
  list(relative = ".", { strict = false } = {}) {
    return this.inventory(relative, { allowMissing: !strict }).filter((file) => sourceFile(file, strict));
  }
  read(file) {
    file = this.#path(file);
    if (!this.files.has(file)) throw new SourceRepositoryError("MISSING_SOURCE", file, "missing source");
    return this.files.get(file);
  }
  resolve(from, specifier, { kind = "import" } = {}) {
    this.#path(from);
    if (path.posix.isAbsolute(specifier) || path.win32.isAbsolute(specifier) || specifier.includes("\\")) {
      throw new SourceRepositoryError("ROOT_ESCAPE", specifier, "dependency escapes repository");
    }
    const file = this.#path(path.posix.join(path.posix.dirname(from), specifier));
    return resolveDependency(file, (candidate) => this.files.has(candidate) ? "file"
      : [...this.files.keys()].some((entry) => entry.startsWith(`${candidate}/`)) ? "directory" : null, kind);
  }
}
