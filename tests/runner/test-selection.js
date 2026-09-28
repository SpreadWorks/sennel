import { join, relative, resolve, sep } from "node:path";
import { TEST_SUITE_NAMES } from "./suite-definitions.js";

const SUITE_FLAGS = new Set(["--preset", "--scope", "--agent", "--all"]);
const VALUE_FLAGS = new Set(["--preset", "--scope", "--file", "--pattern", "--jobs"]);

export class TestSelection {
  constructor({ mode, preset = null, scope = null, fileArgs = [], patternArgs = [], positionalArgs = [], list = false, json = false, jobs = null }) {
    this.mode = mode;
    this.preset = preset;
    this.scope = scope;
    this.fileArgs = fileArgs;
    this.patternArgs = patternArgs;
    this.positionalArgs = positionalArgs;
    this.list = list;
    this.json = json;
    this.jobs = jobs;
  }

  static parse(args, { presetNames = [] } = {}) {
    const values = new Map();
    const flags = new Set();
    const fileArgs = [];
    const patternArgs = [];
    const positionalArgs = [];

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (VALUE_FLAGS.has(arg)) {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        if (arg === "--file") fileArgs.push(value);
        else if (arg === "--pattern") patternArgs.push(value);
        else {
          if (values.has(arg)) throw new Error(`${arg} may be specified only once`);
          values.set(arg, value);
        }
        index += 1;
        continue;
      }
      if (SUITE_FLAGS.has(arg) || arg === "--list" || arg === "--json" || arg === "--help" || arg === "-h") {
        if (flags.has(arg)) throw new Error(`${arg} may be specified only once`);
        flags.add(arg);
        continue;
      }
      if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
      positionalArgs.push(arg);
    }

    const help = flags.has("--help") || flags.has("-h");
    if (help) {
      if (args.length !== 1) throw new Error("--help cannot be combined with other options");
      return new TestSelection({ mode: "help" });
    }
    const list = flags.has("--list");
    const json = flags.has("--json");
    if (list !== json) throw new Error("--list and --json must be used together");

    const preset = values.get("--preset") || null;
    const scope = values.get("--scope") || null;
    if (scope && !TEST_SUITE_NAMES.includes(scope)) throw new Error("--scope must name a test suite");
    const jobs = values.has("--jobs") ? Number(values.get("--jobs")) : null;
    if (jobs !== null && (!Number.isInteger(jobs) || ![1, 2].includes(jobs))) throw new Error("--jobs must be 1 or 2");

    const suiteCount = [preset, scope, flags.has("--agent"), flags.has("--all")].filter(Boolean).length;
    if (suiteCount > 1) throw new Error("--preset, --scope, --agent, and --all are mutually exclusive");
    const hasFiles = fileArgs.length > 0 || patternArgs.length > 0 || positionalArgs.length > 0;
    if (suiteCount > 0 && hasFiles) throw new Error("file selectors cannot be combined with suite selectors");
    if (preset && !presetNames.includes(preset)) throw new Error(`unknown preset "${preset}"`);

    const mode = preset ? "preset" : scope ? "scope" : flags.has("--agent") ? "agent" : flags.has("--all") ? "all" : hasFiles ? "files" : "default";
    return new TestSelection({ mode, preset, scope, fileArgs, patternArgs, positionalArgs, list, json, jobs });
  }

  toListSelection() {
    return { mode: this.mode, preset: this.preset, scope: this.scope };
  }
}

export function resolveTestFiles(selection, {
  root,
  existsSync,
  statSync,
  readdirSync,
  globSync,
  searchDirs = [],
  maxDepth = 32,
  maxFiles = 10000,
  maxRelativePath = 4096,
}) {
  const files = [];
  const add = (candidate) => {
    const path = toRelativePath(root, candidate, maxDepth, maxRelativePath);
    if (!files.includes(path)) files.push(path);
    if (files.length > maxFiles) throw new Error(`resolved file limit exceeded (${maxFiles})`);
  };
  const visit = (dir, depth = 0) => {
    if (depth > maxDepth) throw new Error(`directory traversal depth exceeds ${maxDepth}`);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.name.endsWith(".test.js")) add(full);
    }
  };
  const collectPath = (value) => {
    const full = resolve(root, value);
    if (!existsSync(full)) throw new Error(`path not found: ${value}`);
    if (statSync(full).isDirectory()) visit(full);
    else add(full);
  };

  for (const file of selection.fileArgs) collectPath(file);
  for (const pattern of selection.patternArgs) {
    const matches = globSync(pattern, {
      cwd: root,
      maxDepth,
      maxEntries: maxFiles,
    });
    if (matches.length === 0) throw new Error(`no files matched pattern: ${pattern}`);
    for (const match of matches) if (match.endsWith(".test.js")) collectPath(match);
  }
  for (const positional of selection.positionalArgs) collectPath(positional);
  if (selection.mode !== "files") for (const dir of searchDirs) visit(dir);
  return validateResolvedFiles(files, { maxDepth, maxFiles, maxRelativePath });
}

export function validateResolvedFiles(files, { maxDepth = 32, maxFiles = 10000, maxRelativePath = 4096 } = {}) {
  if (files.length > maxFiles) throw new Error(`resolved file limit exceeded (${maxFiles})`);
  return [...new Set(files.map((file) => {
    const normalized = file.replaceAll(sep, "/");
    if (normalized.startsWith("../") || normalized === ".." || normalized.split("/").includes("..")) throw new Error("resolved path traversal is not allowed");
    if (normalized.length > maxRelativePath) throw new Error(`repository-relative path exceeds ${maxRelativePath}`);
    if (normalized.split("/").length - 1 > maxDepth) throw new Error(`resolved path depth exceeds ${maxDepth}`);
    return normalized;
  }))].sort();
}

export function renderTestList(selection, groups, limits = {}) {
  const categories = TEST_SUITE_NAMES;
  const suiteByCategory = new Map(groups.map((group) => [group.category, group.files]));
  const suites = categories.map((category) => {
    const files = validateResolvedFiles(suiteByCategory.get(category) || [], limits);
    return { category, files, count: files.length };
  });
  const totalFiles = suites.reduce((total, suite) => total + suite.count, 0);
  if (totalFiles > (limits.maxFiles ?? 10000)) throw new Error(`resolved file limit exceeded (${limits.maxFiles ?? 10000})`);
  const output = { version: 1, selection: selection.toListSelection(), suites, totalFiles };
  if (Buffer.byteLength(JSON.stringify(output)) > (limits.maxJsonBytes ?? 16 * 1024 * 1024)) throw new Error("JSON listing exceeds output limit");
  return output;
}

function toRelativePath(root, candidate, maxDepth, maxRelativePath) {
  const relativePath = relative(root, candidate);
  return validateResolvedFiles([relativePath], { maxDepth, maxFiles: 1, maxRelativePath })[0];
}
