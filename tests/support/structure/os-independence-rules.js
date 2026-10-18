import { SourceDeclaration, SourceTemplateToken, matching, readCommaSeparated, readObjectProperty, readParameters } from "./source-reader.js";
import { classifyExecutable, OsSpecificExecutable, UnclassifiedExecutable } from "./os-command-policy.js";
import { posix, win32 } from "node:path";

const sensitiveBuiltins = new Set(["fs", "fs/promises", "child_process", "process", "os", "path", "url", "module", "vm", "globalThis", "global"]);
const launchMethods = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
class FilesystemCallContract {
  constructor(positions, patterns = false) {
    if (!Array.isArray(positions) || positions.some((position) => !Number.isInteger(position) || position < 0)) throw new TypeError("filesystem path positions required");
    Object.assign(this, { positions, patterns });
  }
  paths(args) {
    return this.positions.flatMap((position) => this.patterns && args[position]?.constructor === SequenceValue
      ? args[position].values : args.slice(position, position + 1));
  }
}
class StreamFilesystemCallContract extends FilesystemCallContract {
  constructor() { super([0]); }
  paths(args, property) {
    const options = args[1];
    if (!options || options instanceof LiteralValue && options.value == null) return super.paths(args);
    if (options instanceof ObjectValue) {
      const hasFd = readObjectProperty(options.tokens, "fd");
      const spread = options.tokens.some((token, index, tokens) => token.value === "." && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === ".");
      if (!spread) {
        if (!hasFd) return super.paths(args);
        const fd = property(options, "fd");
        if (fd instanceof FileDescriptorValue || fd instanceof LiteralValue && Number.isInteger(fd.value) && fd.value >= 0) return [];
        if (fd instanceof LiteralValue && fd.value == null) return super.paths(args);
      }
    }
    return super.paths(args).map((value) => new ConditionalFilesystemPathValue(value));
  }
}
const oneFilesystemPath = new FilesystemCallContract([0]);
const twoFilesystemPaths = new FilesystemCallContract([0, 1]);
const filesystemContracts = new Map([
  ...["access", "appendFile", "chmod", "chown", "exists", "lchmod", "lchown", "lstat", "lutimes", "mkdir", "mkdtemp", "mkdtempDisposable", "open", "openAsBlob", "opendir", "readdir", "readFile", "readlink", "realpath", "rm", "rmdir", "stat", "statfs", "truncate", "unlink", "unwatchFile", "utimes", "watch", "watchFile", "writeFile"].map((name) => [name, oneFilesystemPath]),
  ...["copyFile", "cp", "link", "rename", "symlink"].map((name) => [name, twoFilesystemPaths]),
  ...["createReadStream", "createWriteStream"].map((name) => [name, new StreamFilesystemCallContract()]),
  ["glob", new FilesystemCallContract([0], true)],
]);

function filesystemContract(callee) {
  const name = callee.member === "native" && ["realpath", "realpathSync"].includes(callee.members.at(-2)) ? callee.members.at(-2) : callee.member;
  return filesystemContracts.get(name?.replace(/Sync$/, ""));
}
const osFlags = new Set(["O_DIRECTORY", "O_NOFOLLOW", "O_DIRECT", "O_DSYNC", "O_SYNC", "UV_FS_O_FILEMAP", "S_IFSOCK", "S_IFIFO"]);
const platformMembers = new Set(["platform", "type", "release", "version", "machine"]);
const authorityMembers = new Set(["uid", "gid", "mode", "getuid", "geteuid", "getgid", "getegid"]);
const pseudoPath = /^(?:\/proc(?:\/|$)|\/sys(?:\/|$)|\/dev(?:\/|$)|[A-Za-z]:\\(?:Windows|WINDOWS)(?:\\|$))/;
const emptyEnvironment = new Map();
const maximumModuleEvaluations = 6000;

class SourceEvaluationLimit extends Error {
  constructor(module, token) {
    super("static value evaluation exceeded the finite per-module work budget");
    this.file = module.file;
    this.line = token?.line ?? 1;
    this.column = token?.column ?? 1;
  }
}

function strip(tokens) {
  while (["await", "return"].includes(tokens[0]?.value)) tokens = tokens.slice(1);
  while (tokens.at(-1)?.value === ";") tokens = tokens.slice(0, -1);
  while (tokens[0]?.value === "(" && matching(tokens, 0, "(", ")") === tokens.length - 1) tokens = tokens.slice(1, -1);
  return tokens;
}

function templateEnd(tokens, index) {
  const end = tokens.indexOf(tokens[index].endToken, index + 1);
  return end < 0 ? tokens.length : end;
}

function endOfExpression(tokens, start, stops = new Set([";", ","]), boundary = Infinity) {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].offset >= boundary) return index;
    if (tokens[index] instanceof SourceTemplateToken) index = templateEnd(tokens, index);
    else if (["(", "[", "{"].includes(tokens[index].value)) {
      index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]);
    } else if (stops.has(tokens[index].value) || [")", "]", "}"].includes(tokens[index].value)) return index;
  }
  return tokens.length;
}

class OsValue {
  constructor(trace = []) {
    if (!Array.isArray(trace) || trace.some((file) => typeof file !== "string")) throw new TypeError("source route required");
    this.trace = [...new Set(trace)];
  }
  get sensitive() { return false; }
}
class UnknownValue extends OsValue {
  constructor(reason = "runtime value", sensitive = false, trace = []) { super(trace); this.reason = reason; this.isSensitive = sensitive; }
  get sensitive() { return this.isSensitive; }
}
class LiteralValue extends OsValue {
  constructor(value, trace = []) { super(trace); this.value = value; }
}
class BuiltinValue extends OsValue {
  constructor(builtin, members = [], trace = []) {
    super(trace);
    if (typeof builtin !== "string" || !builtin || !Array.isArray(members)) throw new TypeError("builtin identity required");
    this.builtin = builtin; this.members = members;
  }
  get sensitive() { return sensitiveBuiltins.has(this.builtin); }
  get member() { return this.members.at(-1); }
  get identity() { return `${this.builtin}.${this.members.join(".")}`; }
}
class SequenceValue extends OsValue {
  constructor(values, trace = []) {
    super(trace);
    if (!Array.isArray(values) || values.some((value) => !(value instanceof OsValue))) throw new TypeError("source values required");
    this.values = values;
  }
  get sensitive() { return this.values.some((value) => value.sensitive); }
}
class OperationValue extends SequenceValue {
  constructor(operator, values) {
    super(values, values.flatMap((value) => value.trace));
    if (typeof operator !== "string" || !operator) throw new TypeError("source operator required");
    this.operator = operator;
  }
  get supported() { return ["|", "&", "^"].includes(this.operator); }
}
class ObjectValue extends OsValue {
  constructor(module, tokens, environment, trace = [], values = []) { super(trace); Object.assign(this, { module, tokens, environment, values }); }
  get sensitive() { return this.values.some((value) => value.sensitive); }
}
class NamespaceValue extends OsValue {
  constructor(file, trace = []) { super(trace); this.file = file; }
}
class CommonJsModuleValue extends NamespaceValue {}
class CallableValue extends OsValue {
  constructor(module, declaration, environment = new Map(), trace = []) { super(trace); Object.assign(this, { module, declaration, environment }); }
}
class ClassValue extends OsValue {
  constructor(module, name, instance = false, trace = [], arguments_ = []) { super(trace); Object.assign(this, { module, name, instance, arguments: arguments_ }); }
}
class DerivedValue extends OsValue {
  constructor(origin, details = null) {
    super(origin.trace);
    if (!(origin instanceof OsValue)) throw new TypeError("source value origin required");
    Object.assign(this, { origin, details });
  }
}
class SensitiveValue extends DerivedValue { get sensitive() { return true; } }
class PlatformValue extends SensitiveValue {}
class AuthorityValue extends SensitiveValue {}
class StatValue extends SensitiveValue {}
class StatfsValue extends SensitiveValue {}
class FileDescriptorValue extends SensitiveValue {}
class UrlPathnameValue extends SensitiveValue {}
class ShellTextValue extends SensitiveValue {}
class DevNullValue extends DerivedValue {}
class FileUrlValue extends DerivedValue {
  constructor(origin, inputs, path, href = null) {
    if (!(inputs instanceof SequenceValue) || !(path instanceof OsValue) || href !== null && typeof href !== "string") throw new TypeError("file URL source required");
    super(origin, path);
    this.inputs = inputs;
    this.href = href;
    this.trace = [...new Set([...origin.trace, ...inputs.trace, ...path.trace])];
  }
  get sensitive() { return this.inputs.sensitive || pseudoPathUse(this.details) !== null; }
}
class FileUrlPathValue extends OsValue {
  constructor(pathname, trace, hostname = "") {
    if (typeof pathname !== "string") throw new TypeError("file URL pathname required");
    super(trace);
    this.pathname = pathname;
    this.decoded = null;
    try { this.decoded = decodeURIComponent(pathname); } catch { /* Invalid encoding has no concrete native path. */ }
    this.uncertain = this.decoded === null || /%2f|%5c/i.test(pathname) || hostname !== "" && hostname !== "localhost";
  }
  text(syntax) {
    if (this.uncertain) return null;
    return syntax.normalize(syntax === win32 ? this.decoded.replace(/^\/(?=[A-Za-z]:\/)/, "") : this.decoded);
  }
}
class LiteralFileUrl {
  constructor(url, trace) {
    if (!(url instanceof URL) || url.protocol !== "file:") throw new TypeError("literal file URL required");
    this.path = new FileUrlPathValue(url.pathname, trace, url.hostname);
    this.href = url.href;
  }
}
class UnresolvedUrlPathValue extends DerivedValue {
  constructor(inputs, clues) {
    if (!(inputs instanceof SequenceValue) || !(clues instanceof SequenceValue)) throw new TypeError("unresolved URL path inputs required");
    super(inputs, clues);
  }
  get sensitive() { return this.origin.sensitive || pseudoPathUse(this) !== null; }
}
class UserInfoValue extends SensitiveValue {}
class ChildProcessValue extends DerivedValue {}
class TemporaryRootValue extends DerivedValue {}
class NativePathValue extends DerivedValue {
  constructor(origin, source) {
    if (!(source instanceof OsValue)) throw new TypeError("native path source required");
    super(origin, source);
    this.trace = [...new Set([...origin.trace, ...source.trace])];
  }
  get sensitive() { return this.details.sensitive || pseudoPathUse(this.details) !== null; }
}
class OwnedRootValue extends DerivedValue {}
class ShellArgvValue extends DerivedValue {}
class StringMethodValue extends DerivedValue {}
class JoinMethodValue extends DerivedValue {}
class DescriptorMethodValue extends DerivedValue {}
class ChildMethodValue extends DerivedValue {}
class ConcatenationValue extends DerivedValue { get sensitive() { return this.origin.sensitive; } }
class TemplateValue extends DerivedValue { get sensitive() { return this.origin.sensitive; } }
class WindowsPathValue extends DerivedValue {}
class PosixPathValue extends DerivedValue {}
/** A syntax-specific, source-only path result; null text retains uncertain inputs. */
class PathInterpretation {
  constructor(syntax, values, text) {
    if (![posix, win32].includes(syntax) || values.some((value) => !(value instanceof OsValue))
      || text !== null && typeof text !== "string") throw new TypeError("logical path interpretation required");
    Object.assign(this, { syntax, values, text });
  }
}
class ComposedPathValue extends SequenceValue {
  constructor(interpretations, trace, consumesPosix) {
    if (interpretations.length !== 2 || interpretations.some((value) => !(value instanceof PathInterpretation))) throw new TypeError("both native path interpretations required");
    if (typeof consumesPosix !== "boolean") throw new TypeError("native path conversion contract required");
    super([...new Set(interpretations.flatMap((value) => value.values))], trace);
    this.interpretations = interpretations;
    this.consumesPosix = consumesPosix;
  }
}
class UnresolvedCompositionValue extends UnknownValue {
  constructor(origin) {
    if (!(origin instanceof OsValue)) throw new TypeError("composed value origin required");
    super("unsupported composed-value transform retains an OS-sensitive origin", true, origin.trace);
    this.origin = origin;
  }
}
class PathStringMethodValue extends DerivedValue { get sensitive() { return this.origin.sensitive || pseudoPathUse(this.origin) !== null; } }
class TransformedPathValue extends DerivedValue { get sensitive() { return this.origin.sensitive || pseudoPathUse(this.origin) !== null; } }
class ConditionalFilesystemPathValue extends DerivedValue {}
class ModuleLoaderValue extends SensitiveValue {}
class BindingExpression {
  constructor(module, tokens, target) { Object.assign(this, { module, tokens, target }); }
}
/** One projection contract for declarations, helper parameters and constructors. */
class BindingTarget {
  constructor(token, members = [], complete = true, defaults = []) {
    if (token?.kind !== "identifier" || !Array.isArray(members) || !Array.isArray(defaults)) throw new TypeError("source binding target required");
    Object.assign(this, { token, members, complete, defaults });
  }
}

function bindingTargets(pattern, members = [], complete = true, defaults = []) {
  pattern = strip(pattern);
  const equal = endOfExpression(pattern, 0, new Set(["="]));
  if (equal < pattern.length) return bindingTargets(pattern.slice(0, equal), members, false, [...defaults, pattern.slice(equal + 1)]);
  if (pattern.slice(0, 3).length === 3 && pattern.slice(0, 3).every((token) => token.value === ".")) return bindingTargets(pattern.slice(3), members, false, defaults);
  if (pattern.length === 1 && pattern[0].kind === "identifier") return [new BindingTarget(pattern[0], members, complete, defaults)];
  if (!["{", "["].includes(pattern[0]?.value)) return [];
  const object = pattern[0].value === "{";
  return readCommaSeparated(pattern, 1, pattern.length - 1).flatMap((entry) => {
    if (!object) return bindingTargets(entry, members, false, defaults);
    const colon = endOfExpression(entry, 0, new Set([":"]));
    if (entry[0]?.value === "[") return bindingTargets(entry.slice(colon + 1), members, false, defaults);
    if (entry[0]?.kind === "identifier" || entry[0]?.kind === "string") {
      return bindingTargets(colon === entry.length ? entry : entry.slice(colon + 1), [...members, entry[0].value], complete, defaults);
    }
    return bindingTargets(entry, members, false, defaults);
  });
}

function valueOrigins(value, nativePath = false, urlPaths = false) {
  if (value instanceof ComposedPathValue) return value.values.flatMap((part) => valueOrigins(part, nativePath || value.consumesPosix, urlPaths));
  if (value instanceof SequenceValue) return value.values.flatMap((part) => valueOrigins(part, nativePath, urlPaths));
  if (value instanceof PosixPathValue || value instanceof WindowsPathValue) {
    const inputs = value.details.values.flatMap((part) => valueOrigins(part, nativePath, urlPaths));
    // POSIX storage separators are interpreted by both native path flavors.
    // Windows separators remain literal characters on POSIX hosts.
    return nativePath && value instanceof PosixPathValue ? inputs : [value, ...inputs];
  }
  if (value instanceof ConcatenationValue || value instanceof TemplateValue || value instanceof UnresolvedCompositionValue || value instanceof TransformedPathValue || value instanceof PathStringMethodValue || value instanceof ConditionalFilesystemPathValue) return [value, ...valueOrigins(value.origin, nativePath, urlPaths)];
  if (urlPaths && (value instanceof FileUrlValue || value instanceof NativePathValue || value instanceof UnresolvedUrlPathValue)) return [value, ...valueOrigins(value.details, nativePath, true)];
  if (urlPaths && value instanceof UrlPathnameValue) return [value, ...valueOrigins(value.origin, nativePath, true)];
  return [value];
}

function pathText(value, syntax) {
  if (value instanceof LiteralValue && typeof value.value === "string") return value.value;
  if (value instanceof ComposedPathValue) return value.interpretations.find((entry) => entry.syntax === syntax).text;
  if (value instanceof PosixPathValue || value instanceof WindowsPathValue) return value.details.text;
  if (value instanceof FileUrlPathValue) return value.text(syntax);
  if (value instanceof NativePathValue) return value.details instanceof FileUrlValue ? pathText(value.details.details, syntax) : pathText(value.details, syntax);
  return null;
}

function literalFileUrl(text, base, trace) {
  let url;
  try { url = new URL(text, base); } catch { return null; }
  return url.protocol === "file:" ? new LiteralFileUrl(url, trace) : null;
}

function urlPathClues(value) {
  if (value instanceof LiteralValue && typeof value.value === "string") return [literalFileUrl(value.value, undefined, value.trace)?.path ?? value];
  if (value instanceof TemplateValue) return [
    ...urlPathClues(new LiteralValue(value.details, value.trace)),
    ...value.origin.values.flatMap(urlPathClues),
  ];
  if (value instanceof ConcatenationValue) return value.origin.values.flatMap(urlPathClues);
  if (value instanceof FileUrlValue) return [value.details];
  return [value];
}

function fileUrlSource(callee, args, nativeInput = false) {
  const inputs = new SequenceValue(args, args.flatMap((value) => value.trace));
  const input = args[0] ?? new UnknownValue();
  if (nativeInput) return new FileUrlValue(callee, inputs, composePath(new BuiltinValue("path", ["resolve"], callee.trace), [input]));
  if (input instanceof FileUrlValue && args.length === 1) return new FileUrlValue(callee, inputs, input.details, input.href);
  const text = input instanceof LiteralValue && typeof input.value === "string" ? input.value : input instanceof FileUrlValue ? input.href : null;
  const base = args[1] instanceof LiteralValue && typeof args[1].value === "string" ? args[1].value : args[1] instanceof FileUrlValue ? args[1].href : undefined;
  const parsed = text !== null && (args.length < 2 || base !== undefined && base !== null) ? literalFileUrl(text, base, inputs.trace) : null;
  if (parsed) return new FileUrlValue(callee, inputs, parsed.path, parsed.href);
  return new FileUrlValue(callee, inputs, new UnresolvedUrlPathValue(inputs, new SequenceValue(args.flatMap(urlPathClues), inputs.trace)));
}

function interpretPath(callee, args, syntax) {
  let values = args;
  let texts = values.map((value) => pathText(value, syntax));
  if (callee.member === "resolve") {
    // A later absolute component resets earlier components. A rooted Windows
    // component can retain an earlier drive, so keep it when it is explicit.
    let reset = texts.findLastIndex((text) => text !== null && syntax.isAbsolute(text));
    if (syntax === win32 && reset >= 0 && !win32.parse(texts[reset]).root.match(/^(?:[A-Za-z]:|[\\/]{2})/)) {
      const device = texts.slice(0, reset).findLastIndex((text) => text !== null && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(text));
      if (device >= 0) reset = device;
    }
    if (reset >= 0) { values = values.slice(reset); texts = texts.slice(reset); }
  }
  let text = null;
  if (texts.every((part) => part !== null)) {
    if (callee.member === "join") text = syntax.join(...texts);
    else if (["normalize", "dirname", "basename"].includes(callee.member) && texts.length === 1) text = syntax[callee.member](texts[0]);
    else if (callee.member === "resolve") {
      // Never let logical resolution consult this checker's cwd or drive.
      if (syntax === posix) text = texts.some((part) => posix.isAbsolute(part)) ? posix.resolve(...texts) : posix.join(...texts);
      else if (!texts.some((part) => /^[A-Za-z]:(?![\\/])/.test(part))) {
        text = texts.some((part) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(part))
          ? win32.resolve(...texts) : win32.join(...texts);
      }
    }
  }
  return new PathInterpretation(syntax, values, text);
}

function composePath(callee, args) {
  const interpretations = [posix, win32].map((syntax) => interpretPath(callee, args, syntax));
  return new ComposedPathValue(interpretations, [...callee.trace, ...args.flatMap((value) => value.trace)],
    ["join", "resolve", "normalize", "dirname", "basename", "relative", "toNamespacedPath"].includes(callee.member));
}

function pseudoPathUse(value) {
  if (value instanceof FileUrlPathValue) {
    if (value.uncertain) return "incomplete";
    return [value.text(posix), value.text(win32)].some((text) => pseudoPath.test(text)) ? "violation" : null;
  }
  if (value instanceof FileUrlValue || value instanceof NativePathValue) return pseudoPathUse(value.details);
  if (value instanceof UrlPathnameValue) return pseudoPathUse(value.origin);
  if (value instanceof UnresolvedUrlPathValue) return value.details.values.some((part) => pseudoPathUse(part)) ? "incomplete" : null;
  if (value instanceof TransformedPathValue || value instanceof PathStringMethodValue || value instanceof ConditionalFilesystemPathValue) return pseudoPathUse(value.origin) ? "incomplete" : null;
  if (value instanceof UnresolvedCompositionValue) return pseudoPathUse(value.origin) ? "incomplete" : null;
  if (value instanceof LiteralValue) return typeof value.value === "string" && pseudoPath.test(value.value) ? "violation" : null;
  if (value instanceof TemplateValue) return pseudoPath.test(value.details) ? "violation"
    : value.origin.values.some((part) => pseudoPathUse(part)) ? "incomplete" : null;
  if (value instanceof ComposedPathValue) {
    if (value.interpretations.some((entry) => entry.text !== null && pseudoPath.test(entry.text))) return "violation";
    if (value.interpretations.some((entry) => entry.text === null && entry.values.some((part) => pseudoPathUse(part)))) return "incomplete";
  }
  if (value instanceof PosixPathValue || value instanceof WindowsPathValue) return value.details.text !== null
    ? pseudoPath.test(value.details.text) ? "violation" : null
    : value.details.values.some((part) => pseudoPathUse(part)) ? "incomplete" : null;
  if (value instanceof ConcatenationValue && value.origin.values.some((part) => pseudoPathUse(part))) return "incomplete";
  return null;
}

class BindingOrigins {
  constructor(expression) {
    if (!(expression instanceof BindingExpression)) throw new TypeError("binding expression required");
    this.expressions = [expression];
  }
  add(expression) {
    if (!this.expressions.some((entry) => entry.tokens[0]?.offset === expression.tokens[0]?.offset)) this.expressions.push(expression);
  }
}

function uncertainOrigins(values, reason) {
  if (values.length > 0 && values.every((value) => value instanceof BuiltinValue && value.identity === values[0].identity)) return values[0];
  return new UnknownValue(reason, values.some((value) => value.sensitive), values.flatMap((value) => value.trace));
}

/** Source-only value provenance. It reuses the reader's lexical identities and grammar. */
class OsSourceOrigins {
  constructor(graph, diagnose) {
    Object.assign(this, { graph, diagnose });
    this.indexes = new WeakMap();
    this.activeBindings = new Set();
    this.activeExports = new Set();
    this.activeCalls = new Set();
    this.route = [];
    this.evaluations = new Map();
    this.values = new WeakMap();
    this.interpolationBoundaries = new WeakMap();
    this.deepCalls = true;
    this.work = 0;
    this.onCall = () => {};
    this.onMember = () => {};
    this.onUnsupported = () => {};
  }

  expressionEnd(module, tokens, start, stops) {
    if (!this.interpolationBoundaries.has(module)) {
      const boundaries = new Map();
      for (const template of module.templates) for (const interpolation of template.interpolations) {
        for (const token of interpolation.tokens) boundaries.set(token.offset, Math.min(boundaries.get(token.offset) ?? Infinity, interpolation.endToken.offset));
      }
      this.interpolationBoundaries.set(module, boundaries);
    }
    return endOfExpression(tokens, start, stops, this.interpolationBoundaries.get(module).get(tokens[start]?.offset));
  }

  index(module) {
    if (this.indexes.has(module)) return this.indexes.get(module);
    const bindings = new Map();
    this.indexes.set(module, bindings);
    const tokens = module.tokens;
    const register = (binding, expression) => {
      if (!binding) return;
      if (bindings.has(binding)) bindings.get(binding).add(expression);
      else bindings.set(binding, new BindingOrigins(expression));
    };
    const bind = (pattern, expression) => {
      for (const target of bindingTargets(pattern)) register(module.bindingAt(target.token), new BindingExpression(module, expression, target));
    };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (["const", "let", "var"].includes(token.value)) {
        const end = endOfExpression(tokens, index + 1, new Set([";"]));
        for (const part of readCommaSeparated(tokens, index + 1, end)) {
          const equal = endOfExpression(part, 0, new Set(["="]));
          if (equal < part.length) bind(part.slice(0, equal), part.slice(equal + 1));
        }
      }
      if (["function", "class"].includes(token.value) && tokens[index + 1]?.kind === "identifier") {
        const name = tokens[index + 1];
        let open = index + 2;
        if (token.value === "function") {
          while (open < tokens.length && tokens[open].value !== "(") open++;
          open = matching(tokens, open, "(", ")") + 1;
        }
        while (open < tokens.length && tokens[open].value !== "{") open++;
        if (open >= tokens.length) continue;
        const end = matching(tokens, open);
        const binding = module.bindingAt(name);
        register(binding, new BindingExpression(module, tokens.slice(index, end + 1), new BindingTarget(name)));
      }
      if (token.kind === "identifier" && tokens[index + 1]?.value === "=" && tokens[index + 2]?.value !== "="
        && ![".", "=", "const", "let", "var"].includes(tokens[index - 1]?.value)) {
        register(module.bindingAt(token), new BindingExpression(module, tokens.slice(index + 2, endOfExpression(tokens, index + 2)), new BindingTarget(token)));
      }
    }
    return bindings;
  }

  identifier(module, token, environment = emptyEnvironment) {
    const binding = module.bindingAt(token);
    if (binding && environment.has(binding)) return environment.get(binding);
    if (!binding) {
      if (module.isUnbound("process", token) && token.value === "process") return new BuiltinValue("process", [], [module.file]);
      if (["true", "false", "null", "undefined"].includes(token.value)) return new LiteralValue({ true: true, false: false, null: null, undefined: undefined }[token.value], [module.file]);
      if (["URL", "Reflect", "Object", "console", "globalThis", "global"].includes(token.value) && module.isUnbound(token.value, token)) return new BuiltinValue(token.value, [], [module.file]);
      return new UnknownValue();
    }
    const imported = module.references.find((reference) => reference.kind === "import" && reference.bindings.has(token.value)
      && module.moduleBinding(token.value) === binding);
    if (imported) {
      const target = this.graph.resolve(module.file, imported);
      const name = imported.bindings.get(token.value);
      if (target.builtin) {
        const value = new BuiltinValue(target.builtin, [], [module.file]);
        return ["default", "*"].includes(name) ? value : this.member(value, name, token, module, environment);
      }
      return name === "*" ? new NamespaceValue(target.file, [module.file, target.file]) : this.exported(target.file, name, [module.file]);
    }
    const origins = this.index(module).get(binding);
    if (!origins) return new UnknownValue();
    if (this.activeBindings.has(binding)) return new UnknownValue("unresolved binding origin cycle", true, [module.file]);
    this.activeBindings.add(binding);
    let result;
    try {
      const values = origins.expressions.map((expression) => {
        const value = this.value(expression.module, expression.tokens, environment);
        return this.project(expression.module, expression.target, value, environment);
      });
      const sameBuiltin = values.every((value) => value instanceof BuiltinValue && value.identity === values[0].identity);
      result = values.length === 1 || sameBuiltin ? values[0] : new UnknownValue("multiple binding writes obscure the capability origin", values.some((value) => value.sensitive), values.flatMap((value) => value.trace));
    } finally { this.activeBindings.delete(binding); }
    return result;
  }

  project(module, target, origin, environment) {
    const defaults = target.defaults.map((tokens) => this.value(module, tokens, environment));
    if (!target.complete) {
      const value = uncertainOrigins([origin, ...defaults], "unsupported binding pattern obscures the capability origin");
      // Even an identical builtin default is not the destructured member itself.
      const unknown = new UnknownValue("unsupported binding pattern obscures the capability origin", value.sensitive, value.trace);
      this.onUnsupported(unknown, target.token, module);
      return unknown;
    }
    let value = origin;
    for (const member of target.members) value = this.member(value, member, target.token, module, environment);
    return value;
  }

  bindArguments(module, parameters, args, environment) {
    parameters.forEach((parameter, index) => {
      for (const target of bindingTargets(parameter)) {
        const binding = module.bindingAt(target.token);
        if (binding) environment.set(binding, this.project(module, target, args[index] ?? new UnknownValue(), environment));
      }
    });
  }

  referenceValue(module, reference) {
    const target = this.graph.resolve(module.file, reference);
    if (target.builtin) return new BuiltinValue(target.builtin, [], [module.file]);
    return reference.kind === "require" ? new CommonJsModuleValue(target.file, [module.file, target.file]) : new NamespaceValue(target.file, [module.file, target.file]);
  }

  exported(file, name, route = []) {
    const key = `${file}#${name}`;
    if (this.activeExports.has(key)) return new UnknownValue("unresolved exported origin cycle", true, [...route, file]);
    this.activeExports.add(key);
    try {
      const module = this.graph.module(file, { lexicalOnly: true });
      const explicit = module.exports.filter((entry) => entry.name === name);
      const entries = explicit.length ? explicit : module.exports.filter((entry) => entry.name === "*" && name !== "default");
      const results = entries.map((entry) => {
        if (entry.reference) {
          const target = this.graph.resolve(file, entry.reference);
          const exported = entry.local === "*" ? name : entry.local;
          if (target.builtin) {
            const value = new BuiltinValue(target.builtin, [], [...route, file]);
            return exported === "*" || exported === "default" ? value : this.member(value, exported, entry.token, module, emptyEnvironment);
          }
          if (entry.name === "default" && entry.reference.kind === "require") return this.exported(target.file, "default", [...route, file]);
          if (entry.name !== "*" && entry.local === "*") return new NamespaceValue(target.file, [...route, file, target.file]);
          return this.exported(target.file, exported, [...route, file]);
        }
        const binding = module.moduleBinding(entry.local);
        const token = module.bindingReferences(binding)[0] ?? module.tokens.find((item) => item.value === entry.local && module.bindingAt(item) === binding);
        return token ? this.identifier(module, token) : new UnknownValue(`unresolved export ${name}`, true, [...route, file]);
      });
      let result = results.length === 1 ? results[0] : new UnknownValue(`unresolved or ambiguous export ${name}`, true, [...route, file]);
      if (name === "default" && result instanceof CommonJsModuleValue) result = this.exported(result.file, "default", [...route, file, ...result.trace]);
      result.trace = [...new Set([...route, file, ...result.trace])];
      return result;
    } finally { this.activeExports.delete(key); }
  }

  member(receiver, name, token, module, environment) {
    if (receiver instanceof BuiltinValue) {
      if (["globalThis", "global"].includes(receiver.builtin) && ["process", "console", "Object", "Reflect", "URL"].includes(name)) return new BuiltinValue(name, [], receiver.trace);
      const result = new BuiltinValue(receiver.builtin, [...receiver.members, name], receiver.trace);
      if ((receiver.builtin === "process" || receiver.builtin === "os") && platformMembers.has(name)) return new PlatformValue(result);
      if (authorityMembers.has(name) && ["process", "os"].includes(receiver.builtin)) return new AuthorityValue(result);
      if (receiver.builtin === "path" && ["posix", "win32"].includes(name)) return result;
      if (receiver.builtin === "os" && name === "devNull") return new DevNullValue(result);
      return result;
    }
    if (receiver instanceof NamespaceValue) return this.exported(receiver.file, name, receiver.trace);
    if (receiver instanceof ObjectValue) {
      const property = readObjectProperty(receiver.tokens, name);
      if (!property) return new UnknownValue();
      if (property instanceof SourceDeclaration) {
        const index = receiver.tokens.findIndex((item) => item.offset === property.token.offset);
        const callable = new CallableValue(receiver.module, property, receiver.environment, receiver.trace);
        return receiver.tokens[index - 1]?.value === "get" ? this.invoke(callable, [], token, module, environment) : callable;
      }
      return this.value(receiver.module, property.tokens, receiver.environment);
    }
    if (receiver instanceof ClassValue) {
      const members = receiver.module.classMembers(receiver.name);
      const property = (receiver.instance ? members.instanceMembers : members.staticMembers).get(name);
      if (!property) {
        const constructor = receiver.instance && members.instanceMembers.get("constructor");
        if (!constructor) return new UnknownValue();
        const local = new Map(environment);
        this.bindArguments(receiver.module, readParameters(constructor.tokens), receiver.arguments, local);
        const tokens = constructor.bodyTokens();
        const assignment = tokens.findIndex((item, index) => item.value === "this" && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === name && tokens[index + 3]?.value === "=");
        return assignment < 0 ? new UnknownValue() : this.value(receiver.module, tokens.slice(assignment + 4, endOfExpression(tokens, assignment + 4)), local);
      }
      if (property.token.value === name && property.tokens[1]?.value === "=") return this.value(receiver.module, property.tokens.slice(2), environment);
      const callable = new CallableValue(receiver.module, property, environment, receiver.trace);
      const index = receiver.module.tokens.findIndex((item) => item.offset === property.token.offset);
      return receiver.module.tokens[index - 1]?.value === "get" ? this.invoke(callable, [], token, module, environment) : callable;
    }
    if ((receiver instanceof StatValue || receiver instanceof StatfsValue) && (authorityMembers.has(name) || name === "type")) return new AuthorityValue(receiver, name);
    if (receiver instanceof UserInfoValue && authorityMembers.has(name)) return new AuthorityValue(receiver, name);
    if (receiver instanceof FileUrlValue && name === "pathname") return new UrlPathnameValue(receiver);
    if (receiver instanceof UrlPathnameValue || receiver instanceof FileUrlValue || receiver instanceof NativePathValue || receiver instanceof TransformedPathValue) return new PathStringMethodValue(receiver);
    if (receiver instanceof FileDescriptorValue) return new DescriptorMethodValue(receiver, name);
    if (receiver instanceof ChildProcessValue) return new ChildMethodValue(receiver, name);
    if (receiver instanceof WindowsPathValue || receiver instanceof PosixPathValue) return receiver;
    if (receiver instanceof LiteralValue && ["split", "join", "replace", "replaceAll", "trim", "toString"].includes(name)) return new StringMethodValue(receiver, name);
    if (receiver instanceof SequenceValue && name === "join") return new JoinMethodValue(receiver);
    if (receiver instanceof OperationValue) return new UnknownValue("unresolved operator member origin", receiver.sensitive, receiver.trace);
    if ((receiver instanceof ComposedPathValue || receiver instanceof TemplateValue || receiver instanceof ConcatenationValue)
      && (receiver.sensitive || pseudoPathUse(receiver) || valueOrigins(receiver).some((value) => value instanceof WindowsPathValue || value instanceof PosixPathValue))) return new UnresolvedCompositionValue(receiver);
    return receiver instanceof UnknownValue ? receiver : new UnknownValue();
  }

  invoke(callee, args, token, module, environment, constructed = false) {
    if (callee instanceof CommonJsModuleValue) return this.invoke(this.exported(callee.file, "default", callee.trace), args, token, module, environment, constructed);
    this.onCall(callee, args, token, module, environment, constructed);
    if (callee instanceof UnresolvedCompositionValue) return callee;
    if (callee instanceof ClassValue) return new ClassValue(callee.module, callee.name, true, callee.trace, args);
    if (callee instanceof CallableValue) {
      if (!this.deepCalls) return new UnknownValue();
      const key = `${callee.module.file}:${callee.declaration.token.offset}`;
      if (this.activeCalls.has(key)) return new UnknownValue("recursive helper result", args.some((arg) => arg.sensitive), callee.trace);
      this.activeCalls.add(key);
      const previousRoute = this.route;
      this.route = [...new Set([...previousRoute, module.file, ...callee.trace])];
      try {
        const local = new Map(callee.environment);
        const parameters = readParameters(callee.declaration.tokens);
        this.bindArguments(callee.module, parameters, args, local);
        this.scan(callee.module, callee.declaration.bodyTokens() ?? [], local);
        const returns = callee.declaration.returns();
        if (returns.length === 1) {
          const result = this.value(callee.module, returns[0].tokens, local);
          result.trace = [...new Set([...callee.trace, ...result.trace])];
          return result;
        }
        const arrow = callee.declaration.tokens.findIndex((item) => item.value === "=>");
        if (arrow >= 0 && callee.declaration.tokens[arrow + 1]?.value !== "{") return this.value(callee.module, callee.declaration.tokens.slice(arrow + 1), local);
        const alternatives = returns.map((entry) => this.value(callee.module, entry.tokens, local));
        return uncertainOrigins([...alternatives, ...args.filter((arg) => arg.sensitive)], "helper has no single static result");
      } finally { this.activeCalls.delete(key); this.route = previousRoute; }
    }
    if (callee instanceof DerivedValue) {
      if (callee instanceof PathStringMethodValue) return new TransformedPathValue(callee.origin);
      if (callee instanceof PlatformValue || callee instanceof AuthorityValue) return callee;
      if (callee instanceof DescriptorMethodValue) return new UnknownValue();
      if (callee instanceof JoinMethodValue) {
        const separator = args[0] instanceof LiteralValue ? args[0].value : " ";
        return new ShellTextValue(callee.origin, separator);
      }
      if (callee instanceof StringMethodValue) {
        const text = callee.origin.value;
        if (callee.details === "split") return new ShellArgvValue(callee.origin);
        if (callee.details === "trim") return new LiteralValue(String(text).trim(), callee.trace);
      }
      return new UnknownValue();
    }
    if (!(callee instanceof BuiltinValue)) return new UnknownValue();
    const member = callee.member;
    if (callee.builtin === "URL" || callee.builtin === "url" && member === "URL") return fileUrlSource(callee, args);
    if (callee.builtin === "module" && callee.member === "createRequire") return new ModuleLoaderValue(callee);
    if (callee.builtin === "child_process" && launchMethods.has(member)) return new ChildProcessValue(callee, args);
    if (callee.builtin === "os" && member === "tmpdir") return new TemporaryRootValue(callee);
    if (callee.builtin === "os" && member === "userInfo") return new UserInfoValue(callee);
    if (callee.builtin === "url" && member === "fileURLToPath") return new NativePathValue(callee, fileUrlSource(callee, args.slice(0, 1)));
    if (callee.builtin === "url" && (member === "pathToFileURL" || member === "parse" && args[0] instanceof LiteralValue && String(args[0].value).startsWith("file:"))) return fileUrlSource(callee, args.slice(0, 1), member === "pathToFileURL");
    if (callee.builtin === "path" && ["join", "resolve", "normalize", "dirname", "basename", "relative", "parse", "format", "toNamespacedPath"].includes(member)) {
      if (callee.members.includes("win32")) return new WindowsPathValue(callee, interpretPath(callee, args, win32));
      if (callee.members.includes("posix")) return new PosixPathValue(callee, interpretPath(callee, args, posix));
      return composePath(callee, args);
    }
    if (["fs", "fs/promises"].includes(callee.builtin)) {
      if (/^(?:l?stat|fstat)(?:Sync)?$/.test(member)) return new StatValue(callee, args[0]);
      if (/^statfs(?:Sync)?$/.test(member)) return new StatfsValue(callee, args[0]);
      if (/^(?:open|openSync|opendir|opendirSync)$/.test(member)) return new FileDescriptorValue(callee, args);
      if (/^mkdtemp(?:Sync)?$/.test(member)) return new OwnedRootValue(callee, args[0]);
    }
    if (callee.builtin === "Object" && ["freeze", "seal"].includes(member)) return args[0] ?? new UnknownValue();
    return new UnknownValue();
  }

  value(module, expression, environment = emptyEnvironment) {
    const cacheable = this.deepCalls && environment.size === 0 && this.activeBindings.size === 0 && this.activeExports.size === 0 && this.activeCalls.size === 0;
    if (!this.values.has(module)) this.values.set(module, new Map());
    const cache = this.values.get(module);
    const key = `${expression[0]?.offset}:${expression.at(-1)?.offset}`;
    if (cacheable && cache.has(key)) return cache.get(key);
    const count = (this.evaluations.get(module.file) ?? 0) + 1;
    this.evaluations.set(module.file, count);
    if (count > maximumModuleEvaluations || ++this.work > maximumModuleEvaluations) throw new SourceEvaluationLimit(module, expression[0]);
    const value = this.expression(module, expression, environment);
    if (cacheable) cache.set(key, value);
    return value;
  }

  expression(module, expression, environment) {
    const tokens = strip(expression);
    if (!tokens.length) return new UnknownValue();
    const token = tokens[0];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] instanceof SourceTemplateToken) { index = templateEnd(tokens, index); continue; }
      if (["(", "[", "{"].includes(tokens[index].value)) { index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]); continue; }
      if (tokens[index].value !== "?" || tokens[index + 1]?.value === "." || tokens[index + 1]?.value === "?") continue;
      let depth = 0;
      for (let end = index + 1; end < tokens.length; end++) {
        if (["(", "[", "{"].includes(tokens[end].value)) { end = matching(tokens, end, tokens[end].value, { "(": ")", "[": "]", "{": "}" }[tokens[end].value]); continue; }
        if (tokens[end].value === "?") depth++;
        if (tokens[end].value !== ":" || depth-- !== 0) continue;
        return uncertainOrigins([
          this.value(module, tokens.slice(index + 1, end), environment),
          this.value(module, tokens.slice(end + 1), environment),
        ], "conditional helper capability origin cannot be proven");
      }
    }
    let arrow = -1;
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] instanceof SourceTemplateToken) index = templateEnd(tokens, index);
      else if (["(", "[", "{"].includes(tokens[index].value)) index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]);
      else if (tokens[index].value === "=>") { arrow = index; break; }
    }
    if (token.value === "function" || arrow >= 0 && (tokens[0].value === "(" || tokens[0].kind === "identifier")) {
      return new CallableValue(module, new SourceDeclaration(`<helper:${token.offset}>`, tokens), environment, [module.file]);
    }
    if (token.value === "class") return new ClassValue(module, tokens[1]?.value, false, [module.file]);
    // Evaluate concatenation before postfix expressions, without interpreting operators.
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index] instanceof SourceTemplateToken) { index = templateEnd(tokens, index); continue; }
      if (["(", "[", "{"].includes(tokens[index].value)) { index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]); continue; }
      if (index > 0 && tokens[index].value === "+") {
        const left = this.value(module, tokens.slice(0, index), environment);
        const right = this.value(module, tokens.slice(index + 1), environment);
        if (left instanceof LiteralValue && right instanceof LiteralValue) return new LiteralValue(left.value + right.value, [...left.trace, ...right.trace]);
        return new ConcatenationValue(new SequenceValue([left, right], [...left.trace, ...right.trace]));
      }
    }
    if (["!", "~", "+", "-", "typeof", "void", "delete"].includes(token.value)) {
      return new OperationValue(token.value, [this.value(module, tokens.slice(1), environment)]);
    }
    const loaded = module.references.find((entry) => ["dynamic", "require"].includes(entry.kind) && entry.token.offset === token.offset);
    let value; let cursor = 1; let constructed = false;
    if (token.value === "new") { constructed = true; value = this.identifier(module, tokens[1], environment); cursor = 2; }
    else if (token.kind === "string") value = new LiteralValue(token.value, [module.file]);
    else if (token.kind === "number") value = new LiteralValue(Number(token.value.replaceAll("_", "")), [module.file]);
    else if (token.value === "<template>" && token.chunks) {
      let text = token.chunks[0]?.value ?? "";
      const values = [];
      for (let index = 0; index < token.interpolations.length; index++) {
        const part = this.value(module, token.interpolations[index].tokens, environment);
        values.push(part);
        text += (part instanceof LiteralValue ? String(part.value) : "<dynamic>") + (token.chunks[index + 1]?.value ?? "");
      }
      value = values.every((item) => item instanceof LiteralValue) ? new LiteralValue(text, [module.file])
        : new TemplateValue(new SequenceValue(values, [module.file]), text);
      cursor = tokens.findIndex((item) => item === token.endToken) + 1;
      if (cursor === 0) cursor = tokens.length;
    } else if (token.value === "[") {
      const end = matching(tokens, 0, "[", "]");
      value = new SequenceValue(readCommaSeparated(tokens, 1, end).flatMap((part) => {
        if (part.slice(0, 3).every((item) => item.value === ".") && part.length > 3) {
          const spread = this.value(module, part.slice(3), environment);
          return spread instanceof SequenceValue ? spread.values : [spread];
        }
        return [this.value(module, part, environment)];
      }), [module.file]); cursor = end + 1;
    } else if (token.value === "{") {
      const end = matching(tokens, 0);
      const values = readCommaSeparated(tokens, 1, end).flatMap((part) => {
        if (part.length > 3 && part.slice(0, 3).every((item) => item.value === ".")) {
          const spread = this.value(module, part.slice(3), environment);
          this.onMember(spread, null, part[0], module, true);
          return [spread];
        }
        const colon = part.findIndex((item) => item.value === ":");
        return colon < 0 ? part.length === 1 ? [this.value(module, part, environment)] : [] : [this.value(module, part.slice(colon + 1), environment)];
      });
      value = new ObjectValue(module, tokens.slice(0, end + 1), environment, [module.file], values); cursor = end + 1;
    } else if (token.value === "(") {
      const end = matching(tokens, 0, "(", ")"); value = this.value(module, tokens.slice(1, end), environment); cursor = end + 1;
    } else if (token.value === "import" && tokens[1]?.value === "(") {
      if (!loaded) return new UnknownValue("computed dynamic loading", true, [module.file]);
      value = this.referenceValue(module, loaded);
      cursor = matching(tokens, 1, "(", ")") + 1;
    } else if (loaded?.kind === "require") {
      value = this.referenceValue(module, loaded);
      cursor = matching(tokens, 1, "(", ")") + 1;
    } else if (token.kind === "identifier") value = this.identifier(module, token, environment);
    else return new UnknownValue();
    while (cursor < tokens.length) {
      if (tokens[cursor].value === "?" && tokens[cursor + 1]?.value === ".") cursor++;
      if (tokens[cursor].value === "." && tokens[cursor + 1]?.kind === "identifier") {
        const member = tokens[cursor + 1];
        this.onMember(value, member.value, member, module, false);
        value = this.member(value, member.value, member, module, environment); cursor += 2;
      } else if (tokens[cursor].value === "[") {
        const end = matching(tokens, cursor, "[", "]");
        const key = this.value(module, tokens.slice(cursor + 1, end), environment);
        if (key instanceof PlatformValue) this.diagnose("OS01", module.file, tokens[cursor], [module.file, ...key.trace], "OS identity selects a computed implementation");
        this.onMember(value, null, tokens[cursor], module, true);
        value = new UnknownValue("computed capability access", value.sensitive, value.trace); cursor = end + 1;
      } else if (tokens[cursor].value === "(") {
        const end = matching(tokens, cursor, "(", ")");
        const args = readCommaSeparated(tokens, cursor + 1, end).map((part) => this.value(module, part, environment));
        value = this.invoke(value, args, token, module, environment, constructed); cursor = end + 1; constructed = false;
      } else {
        let end = cursor;
        while (end < tokens.length && tokens[end].kind === "punctuation" && ",=!-*/%&|^<>?+".includes(tokens[end].value)) end++;
        if (end === cursor && ["instanceof", "in"].includes(tokens[end]?.value)) end++;
        if (end === cursor) return new UnknownValue("unsupported expression suffix obscures the capability origin", value.sensitive, value.trace);
        return new OperationValue(tokens.slice(cursor, end).map((item) => item.value).join(""), [value, this.value(module, tokens.slice(end), environment)]);
      }
    }
    return value;
  }

  scan(module, tokens = module.tokens, environment = emptyEnvironment, sensitiveOnly = false) {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind !== "identifier" || [".", "?"].includes(tokens[index - 1]?.value)
        || ["import", "export", "from", "const", "let", "var", "function", "class", "return", "if", "switch", "while", "for", "catch"].includes(token.value)) continue;
      if (tokens[index + 1]?.value === "(" && tokens[matching(tokens, index + 1, "(", ")") + 1]?.value === "{") continue;
      if (![".", "[", "(", "?"].includes(tokens[index + 1]?.value)) continue;
      if (sensitiveOnly && !this.identifier(module, token, environment).sensitive) continue;
      const end = this.expressionEnd(module, tokens, index);
      this.value(module, tokens.slice(index, end), environment);
    }
  }
}

/** OS policy owns capability use; lexical reading and module resolution stay shared. */
export class OsIndependenceRules {
  constructor(graph, diagnose) {
    Object.assign(this, { graph, diagnose });
    this.origins = new OsSourceOrigins(graph, diagnose);
    this.origins.onCall = (...args) => this.call(...args);
    this.origins.onMember = (...args) => this.member(...args);
    this.origins.onUnsupported = (value, token, module) => {
      if (value.sensitive) this.incomplete(this.ruleFor(value), module, token, value, value.reason);
    };
  }
  incomplete(rule, module, token, value, message) {
    this.diagnose(rule, module.file, token, [...this.origins.route, module.file, ...value.trace], message, "incomplete");
  }
  violation(rule, module, token, value, message) {
    this.diagnose(rule, module.file, token, [...this.origins.route, module.file, ...value.trace], message);
  }
  ruleFor(value) {
    if (value instanceof PathStringMethodValue || value instanceof TransformedPathValue) return valueOrigins(value.origin, false, true).some((origin) => origin instanceof UrlPathnameValue) ? "OS04" : "OS01";
    if (value instanceof UnresolvedCompositionValue) return valueOrigins(value.origin).some((origin) => origin instanceof UrlPathnameValue || origin instanceof WindowsPathValue || origin instanceof PosixPathValue) ? "OS04" : "OS01";
    if (value instanceof BuiltinValue) return value.builtin === "child_process" ? "OS02" : ["url", "path"].includes(value.builtin) ? "OS04" : "OS01";
    if (value instanceof AuthorityValue || value instanceof StatValue || value instanceof StatfsValue || value instanceof FileDescriptorValue) return "OS03";
    if (value instanceof UrlPathnameValue) return "OS04";
    if (value instanceof DerivedValue) return "OS01";
    return "OS02";
  }
  member(receiver, name, token, module, computed) {
    if (computed && receiver.sensitive) this.incomplete(this.ruleFor(receiver), module, token, receiver, "computed access obscures an OS-sensitive capability");
    if (receiver instanceof BuiltinValue && receiver.builtin === "process" && ["binding", "_linkedBinding", "dlopen"].includes(name)) this.incomplete("OS02", module, token, receiver, "native binding bypasses the inspectable invocation boundary");
    if (receiver instanceof BuiltinValue && receiver.sensitive && receiver.members.length > 0 && ["call", "apply", "bind"].includes(name)) this.incomplete(this.ruleFor(receiver), module, token, receiver, "function indirection obscures an OS-sensitive invocation");
  }
  call(callee, args, token, module) {
    if (callee instanceof OperationValue && callee.sensitive) this.incomplete(this.ruleFor(callee), module, token, callee, "operator result has no proven callable capability origin");
    if (callee instanceof UnknownValue && callee.sensitive) this.incomplete(this.ruleFor(callee), module, token, callee, callee.reason);
    if (callee instanceof BuiltinValue) {
      const name = callee.member;
      if (callee.builtin === "process" && name === "kill") this.violation("OS01", module, token, callee, "PID/PGID signalling bypasses a retained ChildProcess handle");
      if (callee.builtin === "vm" && name !== "isContext" || callee.builtin === "module" && !["createRequire", "isBuiltin"].includes(name)
        || callee.builtin === "process" && ["getBuiltinModule", "require"].includes(name)
        || ["globalThis", "global"].includes(callee.builtin) && ["eval", "Function"].includes(name)) this.incomplete("OS02", module, token, callee, "runtime module/code loading obscures the inspectable capability graph");
      if (callee.builtin === "child_process" && launchMethods.has(name)) this.launch(callee, args, token, module);
      if (["fs", "fs/promises"].includes(callee.builtin)) this.filesystem(callee, args, token, module);
      if (callee.builtin === "Reflect" && ["get", "apply", "construct"].includes(name) && args.some((arg) => arg.sensitive)) this.incomplete("OS02", module, token, callee, "reflective access obscures an OS-sensitive capability");
      if (callee.builtin === "path" && ["join", "resolve", "normalize"].includes(name) && args.flatMap((value) => valueOrigins(value, false, true)).some((arg) => arg instanceof UrlPathnameValue)) this.violation("OS04", module, token, callee, "file URL pathname is used as a native path without fileURLToPath");
      const inspectedConsumer = ["fs", "fs/promises", "child_process", "process", "os", "path", "url", "URL", "module", "vm", "console", "Reflect"].includes(callee.builtin)
        || callee.builtin === "Object" && ["freeze", "seal"].includes(name);
      if (!inspectedConsumer) for (const arg of args.filter((value) => value.sensitive)) this.incomplete(this.ruleFor(arg), module, token, arg, "unsupported builtin transform escapes an OS-sensitive capability");
    }
    if (callee instanceof ModuleLoaderValue) this.incomplete("OS02", module, token, callee, "created require function has an unsupported dynamic loading contract");
    if (callee instanceof DescriptorMethodValue && ["sync", "datasync"].includes(callee.details)) this.descriptorSync(callee.origin, token, module);
    if (callee instanceof ChildMethodValue && callee.details === "kill" && args.length > 0
      && (!(args[0] instanceof LiteralValue) || !["SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT"].includes(args[0].value))) this.incomplete("OS01", module, token, callee, "retained ChildProcess kill has no proven portable signal");
    if (!(callee instanceof CallableValue) && !(callee instanceof ClassValue) && !(callee instanceof BuiltinValue)
      && !(callee instanceof JoinMethodValue || callee instanceof StringMethodValue || callee instanceof PathStringMethodValue || callee instanceof ChildMethodValue || callee instanceof DescriptorMethodValue)) {
      for (const arg of args.filter((arg) => arg.sensitive)) this.incomplete(this.ruleFor(arg), module, token, arg, "OS-sensitive capability escapes to an uninspected consumer");
    }
  }
  property(value, name) {
    return value instanceof ObjectValue ? this.origins.member(value, name, value.tokens[0], value.module, value.environment) : new UnknownValue();
  }
  launch(callee, args, token, module) {
    const options = args.find((value) => value instanceof ObjectValue);
    for (const property of ["uid", "gid"]) {
      if (options && readObjectProperty(options.tokens, property)) this.violation("OS03", module, token, callee, `process ${property} option requires an OS-specific authority model`);
    }
    if (options?.tokens.some((item, index, tokens) => item.value === "." && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === ".")) this.incomplete("OS02", module, token, callee, "spread launch options cannot prove shell and OS authority settings");
    if (this.property(options, "shell") instanceof LiteralValue && this.property(options, "shell").value === true) this.violation("OS02", module, token, callee, "shell:true makes invocation depend on the host shell");
    if (["exec", "execSync"].includes(callee.member)) this.violation("OS04", module, token, callee, "execution authority is reparsed from a shell command string");
    const command = args[0];
    if (command instanceof LiteralValue) {
      const executable = classifyExecutable(String(command.value));
      if (executable instanceof OsSpecificExecutable) this.violation("OS02", module, token, callee, `OS-specific required command or shim ${executable.identity}`);
      if (executable instanceof UnclassifiedExecutable) this.incomplete("OS02", module, token, callee, `required executable portability is unclassified: ${executable.identity}`);
    }
    if (command instanceof ShellTextValue || args.some((value) => value instanceof ShellArgvValue)) this.violation("OS04", module, token, callee, "typed invocation was converted to shell text and reparsed");
    const fixture = this.ownedFixture(module, token, callee, args);
    if (fixture === null) this.incomplete("OS02", module, token, callee, "test-owned launch has an unsupported cleanup or inline-code contract");
    else if (!fixture) {
      const boundary = this.typedBoundary(module, token);
      if (boundary === null) this.incomplete("OS02", module, token, callee, "apparent typed invocation boundary has an unsupported authority contract");
      else if (!boundary) this.violation("OS02", module, token, callee, "direct child_process launch bypasses the shared typed invocation boundary");
    }
  }
  typedBoundary(module, token) {
    // A closed, deliberately narrow contract. Token words alone confer no authority.
    for (const name of module.declarationNames()) {
      const declaration = module.declaration(name);
      if (!declaration?.callable || declaration.token.offset > token.offset || declaration.tokens.at(-1).offset < token.offset) continue;
      const body = declaration.bodyTokens() ?? [];
      const guard = body.findIndex((item) => item.value === "instanceof");
      if (guard < 0) return false;
      const parameter = body[guard - 1]; const type = body[guard + 1];
      if (parameter?.kind !== "identifier" || type?.kind !== "identifier") return null;
      const parameters = readParameters(declaration.tokens);
      if (parameters.length !== 1 || parameters[0].length !== 1 || module.bindingAt(parameters[0][0]) !== module.bindingAt(parameter)) return null;
      const resolved = this.origins.identifier(module, type);
      if (!(resolved instanceof ClassValue) || resolved.instance || !this.invocationClass(resolved)) return null;
      const callStart = module.tokens.findIndex((item) => item.offset === token.offset);
      const call = [];
      for (let offset = callStart; offset < module.tokens.length && module.tokens[offset].value !== "("; offset++) call.push(module.tokens[offset].value);
      if (!declaration.matchesFunction(parameter.value, `
        if (!(${parameter.value} instanceof ${type.value})) throw new TypeError($STRING_LITERAL);
        return ${call.join("")}(${parameter.value}.executable, ${parameter.value}.args, { shell: false });
      `)) return null;
      return body.filter((item) => item.value === "TypeError").every((item) => module.isUnbound("TypeError", item));
    }
    return false;
  }
  invocationClass(value) {
    const declaration = value.module.declaration(value.name);
    if (declaration?.tokens[2]?.value !== "{") return false;
    const members = value.module.classMembers(value.name);
    const constructor = members.instanceMembers.get("constructor");
    if (!constructor || members.instanceMembers.size !== 1 || members.staticMembers.size !== 0 || members.instanceInitializers.length !== 0
      || members.unresolvedInstanceMembers.length !== 0 || members.unresolvedStaticMembers.length !== 0) return false;
    const parameters = readParameters(constructor.tokens);
    if (parameters.length !== 2 || parameters.some((parameter) => parameter.length !== 1 || parameter[0].kind !== "identifier")) return false;
    const [executable, args] = parameters.map((parameter) => parameter[0].value);
    const arrow = constructor.tokens.findIndex((item) => item.value === "=>");
    const element = constructor.tokens[arrow - (constructor.tokens[arrow - 1]?.value === ")" ? 2 : 1)];
    if (!element || !constructor.matchesBody(`
      if (typeof ${executable} !== 'string' || ${executable}.length === 0) throw new TypeError($STRING_LITERAL);
      if (!Array.isArray(${args}) || ${args}.some((${element.value}) => typeof ${element.value} !== 'string')) throw new TypeError($STRING_LITERAL);
      this.executable = ${executable};
      this.args = Object.freeze([...${args}]);
      Object.freeze(this);
    `)) return false;
    return constructor.tokens.filter((item) => ["Array", "Object", "TypeError"].includes(item.value))
      .every((item) => value.module.isUnbound(item.value, item));
  }
  ownedFixture(module, token, callee, args) {
    if (!module.file.startsWith("tests/") || !["spawn", "fork"].includes(callee.member)) return false;
    const tokens = module.tokens;
    const index = tokens.findIndex((item) => item.offset === token.offset);
    const start = Math.max(0, index - 5);
    const owner = tokens.slice(start, index).find((item, offset, part) => ["const", "let"].includes(item.value)
      && part[offset + 1]?.kind === "identifier" && part[offset + 2]?.value === "=");
    if (!owner) return false;
    const ownerIndex = tokens.indexOf(owner);
    const binding = module.bindingAt(tokens[ownerIndex + 1]);
    const references = module.bindingReferences(binding);
    const retainedCleanup = references.some((item) => {
      const offset = tokens.indexOf(item);
      return tokens[offset + 1]?.value === "." && tokens[offset + 2]?.value === "kill" && tokens[offset + 3]?.value === "(";
    });
    const command = args[0];
    const portableCommand = callee.member === "fork" || command instanceof BuiltinValue && command.builtin === "process" && command.member === "execPath";
    if (!portableCommand || !retainedCleanup) return false;
    // A forked module body is an execution dependency, not an inert argument.
    // Until its entry and lifetime can be proven, retaining the parent is insufficient.
    if (callee.member === "fork") return null;
    const argv = args[1];
    if (callee.member === "spawn" && (!(argv instanceof SequenceValue)
      || argv.values.some((value) => !(value instanceof LiteralValue))
      || argv.values.length !== 1 || !["--version", "-v", "--help", "-h"].includes(argv.values[0].value))) return null;
    if (args[2] && (!(args[2] instanceof ObjectValue) || this.property(args[2], "shell") instanceof UnknownValue
      && args[2].tokens.some((item) => item.value === "shell"))) return null;
    for (let cursor = 0; cursor < tokens.length; cursor++) {
      if (tokens[cursor].value !== "try" || tokens[cursor + 1]?.value !== "{") continue;
      const tryEnd = matching(tokens, cursor + 1);
      let finalizer = tryEnd + 1;
      if (tokens[finalizer]?.value === "catch") {
        finalizer++;
        if (tokens[finalizer]?.value === "(") finalizer = matching(tokens, finalizer, "(", ")") + 1;
        if (tokens[finalizer]?.value !== "{") continue;
        finalizer = matching(tokens, finalizer) + 1;
      }
      if (tokens[finalizer]?.value !== "finally" || tokens[finalizer + 1]?.value !== "{") continue;
      const afterLaunch = endOfExpression(tokens, index);
      const protectedLaunch = index > cursor && index < tryEnd || tokens[afterLaunch]?.value === ";" && afterLaunch + 1 === cursor;
      if (!protectedLaunch) continue;
      const end = matching(tokens, finalizer + 1);
      const cleanup = new SourceDeclaration("ownedCleanup", tokens.slice(finalizer, end + 1));
      const childName = tokens[ownerIndex + 1].value;
      const reference = tokens[finalizer + 2];
      if (module.bindingAt(reference) !== binding) continue;
      if (["", "'SIGTERM'", "'SIGKILL'", "'SIGINT'", "'SIGQUIT'"].some((signal) => cleanup.matchesDeclaration(`finally { ${childName}.kill(${signal}); }`))) return true;
    }
    return null;
  }
  filesystem(callee, args, token, module) {
    const name = callee.member;
    const flags = (value) => value instanceof BuiltinValue ? value.members.filter((member) => osFlags.has(member))
      : value instanceof SequenceValue || value instanceof ObjectValue ? value.values.flatMap(flags)
        : value instanceof ConcatenationValue ? flags(value.origin) : [];
    for (const flag of args.flatMap(flags)) this.violation("OS03", module, token, callee, `OS-specific filesystem flag ${flag}`);
    for (const input of filesystemContract(callee)?.paths(args, (value, key) => this.property(value, key)) ?? []) this.filesystemPath(callee, input, token, module);
    if (/^(?:chmod|chown|fchmod|fchown|lchmod|lchown)/.test(name)) this.violation("OS03", module, token, callee, "UID/mode mutation cannot establish portable authority");
    if (/^(?:fsync|fdatasync)/.test(name)) {
      if (args[0] instanceof FileDescriptorValue) this.descriptorSync(args[0], token, module);
      else this.incomplete("OS03", module, token, callee, "fsync descriptor has no proven regular writable-file origin");
    }
  }
  filesystemPath(callee, input, token, module) {
    const pathOrigin = new SequenceValue([callee, input], [...callee.trace, ...input.trace]);
    const pathUse = pseudoPathUse(input);
    if (pathUse === "violation") this.violation("OS01", module, token, pathOrigin, "pseudo-filesystem or fixed OS path is used for I/O");
    if (pathUse === "incomplete") this.incomplete("OS01", module, token, pathOrigin, "path composition retains an unresolved pseudo-filesystem or fixed OS origin");
    const origins = valueOrigins(input, false, true);
    const unresolvedTransform = origins.some((value) => value instanceof UnresolvedCompositionValue || value instanceof TransformedPathValue || value instanceof PathStringMethodValue || value instanceof ConditionalFilesystemPathValue);
    if (origins.some((value) => value instanceof UrlPathnameValue)) {
      if (unresolvedTransform) this.incomplete("OS04", module, token, pathOrigin, "unsupported string transform retains file URL pathname provenance at native I/O");
      else this.violation("OS04", module, token, pathOrigin, "file URL pathname is used for native filesystem I/O");
    }
    if (origins.some((value) => value instanceof WindowsPathValue || value instanceof PosixPathValue)) {
      if (unresolvedTransform) this.incomplete("OS04", module, token, pathOrigin, "unsupported string transform retains logical path provenance at native I/O");
      else this.violation("OS04", module, token, pathOrigin, "logical path syntax bypasses the native filesystem path boundary");
    }
    const unresolved = origins.find((value) => (value instanceof UnknownValue || value instanceof OperationValue) && value.sensitive);
    if (unresolved) this.incomplete("OS01", module, token, pathOrigin, unresolved.reason ?? "operator result has no proven filesystem path origin");
  }

  descriptorSync(descriptor, token, module) {
    const flags = descriptor.details?.[1];
    if (descriptor.origin.member.startsWith("opendir") || flags instanceof LiteralValue && flags.value === "r") this.violation("OS03", module, token, descriptor, "read-only/directory descriptor fsync is required as a portable guarantee");
    else if (!(flags instanceof LiteralValue) || !/^[wax]/.test(String(flags.value))) this.incomplete("OS03", module, token, descriptor, "descriptor origin does not prove a regular writable file for fsync");
  }
  inspect(module) {
    // Each independently inspected source root gets a fresh finite work budget.
    // Work performed through an earlier caller must not suppress this module's rules.
    this.origins.evaluations = new Map();
    this.origins.work = 0;
    const tokens = module.tokens;
    this.origins.index(module);
    this.origins.deepCalls = false;
    try { this.origins.scan(module, tokens, emptyEnvironment, true); }
    finally { this.origins.deepCalls = true; }
    this.origins.evaluations = new Map();
    this.origins.work = 0;
    this.origins.scan(module);
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index].value !== "=" || tokens[index - 1]?.value === "=" || tokens[index + 1]?.value === "="
        || tokens[index - 1]?.kind === "identifier" && tokens[index - 2]?.value !== ".") continue;
      const value = this.origins.value(module, tokens.slice(index + 1, endOfExpression(tokens, index + 1)));
      if (value.sensitive) this.incomplete(this.ruleFor(value), module, tokens[index], value, "member/destructuring assignment escapes an OS-sensitive capability");
    }
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].value !== "switch" || tokens[index + 1]?.value !== "(") continue;
      const end = matching(tokens, index + 1, "(", ")");
      const value = this.origins.value(module, tokens.slice(index + 2, end));
      if (value instanceof PlatformValue) this.violation("OS01", module, tokens[index], value, "OS identity selects a switch implementation");
      if (value instanceof AuthorityValue) this.violation("OS03", module, tokens[index], value, "UID/mode/filesystem magic selects an authority branch");
    }
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind !== "identifier" || [".", "import", "from", "as"].includes(tokens[index - 1]?.value)
        || ["const", "let", "var", "function", "class", "return", "if", "switch", "case", "while", "for", "catch", "throw", "export", "from"].includes(token.value)
        || tokens[index + 1]?.value === "=" && tokens[index + 2]?.value !== "=") continue;
      const value = this.origins.value(module, tokens.slice(index, this.origins.expressionEnd(module, tokens, index)));
      if (value instanceof UnknownValue && value.sensitive) this.incomplete("OS02", module, token, value, value.reason);
      if (value instanceof OperationValue && value.sensitive && !value.supported) this.incomplete("OS02", module, token, value, "unsupported operator obscures an OS-sensitive value");
      const identities = valueOrigins(value);
      if (!identities.some((origin) => origin instanceof PlatformValue || origin instanceof AuthorityValue)) continue;
      let start = index;
      while (start > 0 && ![";", "{" , "}"].includes(tokens[start - 1].value)) start--;
      const end = this.origins.expressionEnd(module, tokens, index, new Set([";", "{"]));
      const statement = tokens.slice(start, end);
      const branch = statement.some((item, position) => ["if", "switch", "case", "<", ">"].includes(item.value)
        || item.value === "?" && statement[position + 1]?.value !== "."
        || item.value === "=" && (statement[position - 1]?.value === "=" || statement[position + 1]?.value === "="));
      if (identities.some((origin) => origin instanceof PlatformValue) && branch) this.violation("OS01", module, token, value, "OS identity selects implementation behavior");
      if (identities.some((origin) => origin instanceof AuthorityValue) && branch) this.violation("OS03", module, token, value, "UID/mode/filesystem magic is used as authority or a portability guarantee");
    }
    for (const token of module.dynamic) {
      if (!module.references.some((entry) => entry.kind === "dynamic" && entry.token.offset === token.offset)) this.incomplete("OS02", module, token, new UnknownValue(), "dynamic loading cannot prove the OS-sensitive capability graph complete");
    }
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (["eval", "Function"].includes(token.value) && module.isUnbound(token.value, token) && tokens[index + 1]?.value === "(") this.incomplete("OS02", module, token, new UnknownValue(), "runtime code generation is outside static inspection");
    }
  }
}
