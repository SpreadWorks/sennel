import { SourceModule, SourceBodyPrimary, SourceClassMembers, SourceDeclaration, SourceInitializer, SourceInputBinding, SourceObjectMembers, SourceObjectSpread, SourceTemplateToken, SourceMemberAccess, matching, optionalAccessEnd, readCommaSeparated, readMemberAccess, readObjectProperty, readParameters } from "./source-reader.js";
import { classifyExecutable, UnclassifiedExecutable, supportedPlatforms } from "./os-command-policy.js";
import { ExecutionArgument, NodeExecutionBoundary } from "./node-execution-boundary.js";
import { PlatformExpression, PlatformImplementationBoundary } from "./os-platform-paths.js";
import { posix, win32 } from "node:path";
import { sourceBuiltin } from "./source-graph.js";

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
const posixPlatforms = ["linux", "darwin"];
const platformMembers = new Set(["platform", "type", "release", "version", "machine"]);
const authorityMembers = new Set(["uid", "gid", "mode", "getuid", "geteuid", "getgid", "getegid"]);
const pseudoPath = /^(?:\/proc(?:\/|$)|\/sys(?:\/|$)|\/dev(?:\/|$)|[A-Za-z]:\\(?:Windows|WINDOWS)(?:\\|$))/;
const literalKeywordValues = new Map([["true", true], ["false", false], ["null", null], ["undefined", undefined]]);
const emptyEnvironment = new Map();
const maximumModuleEvaluations = 6000;
const lexicalReceiver = Symbol("source invocation receiver");

class PlatformModuleBoundaries {
  constructor() {
    this.boundaries = [];
    this.callers = new Map();
    this.usages = new Map();
    this.public = new Set();
    this.resolutions = new Map();
    this.contexts = new Map();
    this.ready = false;
  }
  at(token) { return this.boundaries.filter((boundary) => boundary.contains(token)).sort((a, b) => a.declaration.tokens.length - b.declaration.tokens.length)[0]; }
  forDeclaration(declaration) { return this.boundaries.find((boundary) => boundary.declaration.token.offset === declaration.token.offset); }
}
class PlatformCallContext {
  constructor(platforms, uncertain = false, knownPlatforms = platforms) {
    if (typeof uncertain !== "boolean" || platforms.some((platform) => !supportedPlatforms.includes(platform))
      || knownPlatforms.some((platform) => !platforms.includes(platform))) throw new TypeError("supported platform reachability required");
    Object.assign(this, { platforms, uncertain, knownPlatforms });
  }
}
class SourceCallLocation {
  constructor(module, token) { Object.assign(this, { module, token }); }
}
function* namedFunctions(module) {
  for (const name of module.declarationNames()) {
    if (module.declarationHeader(name).token.value === "function") yield module.declaration(name);
  }
}
function signalArgument(args) {
  return !args[1] || args[1] instanceof LiteralValue && args[1].value === undefined ? new LiteralValue("SIGTERM") : args[1];
}

class SourceEvaluationLimit extends Error {
  constructor(module, token, callers) {
    super("static value evaluation exceeded the finite per-module work budget");
    this.file = module.file;
    this.line = token?.line ?? 1;
    this.column = token?.column ?? 1;
    this.callers = [...callers];
  }
}

/** Keep the failed root location separate from an imported evaluation frontier. */
export function reportOsInspectionFailure(diagnose, module, error, trace, prefix) {
  let token = error;
  let route = trace;
  let detail = error.message;
  if (error instanceof SourceEvaluationLimit) {
    const callers = error.callers.map((location) => location.module.file);
    const root = callers.indexOf(module.file);
    route = [...trace, ...(root < 0 ? [] : callers.slice(root + 1)), error.file];
    if (error.file !== module.file) {
      token = error.callers.find((location) => location.module.file === module.file)?.token ?? module.tokens[0];
      detail += ` (evaluation stopped at ${error.file}:${error.line}:${error.column})`;
    }
  }
  diagnose("OS00", module.file, token, route, `${prefix}: ${detail}`, "incomplete");
}

function strip(tokens) {
  while (tokens[0]?.kind === "identifier" && ["await", "return"].includes(tokens[0].value)) tokens = tokens.slice(1);
  while (tokens.at(-1)?.kind === "punctuation" && tokens.at(-1).value === ";") tokens = tokens.slice(0, -1);
  while (tokens[0]?.kind === "punctuation" && tokens[0].value === "(" && matching(tokens, 0, "(", ")") === tokens.length - 1) tokens = tokens.slice(1, -1);
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
    else if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) {
      index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]);
    } else if (tokens[index].kind === "punctuation" && (stops.has(tokens[index].value) || [")", "]", "}"].includes(tokens[index].value))) return index;
  }
  return tokens.length;
}

const noSensitivityInputs = Object.freeze([]);

class OsValue {
  constructor(trace = []) {
    if (!Array.isArray(trace) || trace.some((file) => typeof file !== "string")) throw new TypeError("source route required");
    this.trace = [...new Set(trace)];
  }
  get ownSensitive() { return false; }
  get sensitivityInputs() { return noSensitivityInputs; }
  get sensitive() { return SourceValueSensitivity.of(this); }
  get intrinsicSyntax() { return false; }
}

/** Fresh reachability query: capture backedges alone do not create or hide a capability. */
class SourceValueSensitivity {
  constructor(value, inputs) {
    if (!(value instanceof OsValue) || !Array.isArray(inputs)
      || inputs.some(input => !(input instanceof OsValue))) throw new TypeError("source sensitivity inputs required");
    Object.assign(this, { value, inputs });
    Object.freeze(this);
  }
  static of(value) {
    if (value.ownSensitive) return true;
    const inputs = value.sensitivityInputs;
    return inputs.length > 0 && new SourceValueSensitivity(value, inputs).evaluate();
  }
  evaluate() {
    const visited = new Set([this.value]);
    const pending = [...this.inputs].reverse();
    while (pending.length > 0) {
      const value = pending.pop();
      if (visited.has(value)) continue;
      visited.add(value);
      if (value.ownSensitive) return true;
      const inputs = value.sensitivityInputs;
      for (let index = inputs.length - 1; index >= 0; index--) pending.push(inputs[index]);
    }
    return false;
  }
}
class UnknownValue extends OsValue {
  constructor(reason = "runtime value", sensitive = false, trace = []) { super(trace); this.reason = reason; this.isSensitive = sensitive; }
  get ownSensitive() { return this.isSensitive; }
  get intrinsicSyntax() { return true; }
}
class LiteralValue extends OsValue {
  constructor(value, trace = []) { super(trace); this.value = value; }
  get intrinsicSyntax() { return true; }
}
/** Regex syntax is context-free metadata, without inferred method/result semantics. */
class RegexLiteralValue extends UnknownValue {
  constructor(token, trace = []) {
    if (!RegexLiteralValue.matches([token])) throw new TypeError("regex literal source required");
    super("runtime value", false, trace);
    this.token = token;
  }
  static matches(tokens) {
    return tokens.length === 1 && tokens[0]?.kind === "literal" && tokens[0].value === "<regex>";
  }
}

/** Cache copied constant leaves whose evaluation emitted no observations. */
class ConstantEvaluationCache {
  constructor() { this.environments = new WeakMap(); }
  entries(environment, module) {
    if (!this.environments.has(environment)) this.environments.set(environment, new WeakMap());
    const modules = this.environments.get(environment);
    if (!modules.has(module)) modules.set(module, new Map());
    return modules.get(module);
  }
  copy(value, environment = emptyEnvironment) {
    if (value instanceof LiteralValue) return new LiteralValue(value.value, value.trace);
    if (value instanceof RegexLiteralValue) return new RegexLiteralValue(value.token, value.trace);
    if (value instanceof BuiltinValue) return new BuiltinValue(value.builtin, [...value.members], value.trace);
    if (value instanceof EmptyObjectValue) return new EmptyObjectValue(value.module, value.tokens, environment, value.trace);
    throw new TypeError("constant source cache value required");
  }
  read(environment, module, key, valueEnvironment = environment) {
    const value = this.entries(environment, module).get(key);
    return value ? this.copy(value, valueEnvironment) : null;
  }
  remember(environment, module, key, value) {
    this.entries(environment, module).set(key, this.copy(value));
  }
  invalidate(environment) { this.environments.delete(environment); }
}
class BuiltinValue extends OsValue {
  constructor(builtin, members = [], trace = []) {
    super(trace);
    if (typeof builtin !== "string" || !builtin || !Array.isArray(members)) throw new TypeError("builtin identity required");
    this.builtin = builtin; this.members = members;
  }
  get ownSensitive() { return sensitiveBuiltins.has(this.builtin); }
  get intrinsicSyntax() { return true; }
  get member() { return this.members.at(-1); }
  get identity() { return `${this.builtin}.${this.members.join(".")}`; }
}
class SequenceValue extends OsValue {
  constructor(values, trace = []) {
    super(trace);
    if (!Array.isArray(values) || values.some((value) => !(value instanceof OsValue))) throw new TypeError("source values required");
    this.values = values;
  }
  get sensitivityInputs() { return this.values; }
}
class OperationValue extends SequenceValue {
  constructor(operator, values) {
    super(values, values.flatMap((value) => value.trace));
    if (typeof operator !== "string" || !operator) throw new TypeError("source operator required");
    this.operator = operator;
  }
  get supported() { return ["|", "&", "^"].includes(this.operator); }
  get containsLogical() {
    return ["&&", "||", "??"].includes(this.operator)
      || this.values.some((value) => value instanceof OperationValue && value.containsLogical);
  }
  get booleanResult() {
    if (["!", "===", "!==", "==", "!=", "<", "<=", ">", ">=", "instanceof", "in"].includes(this.operator)) {
      // General provenance retains operators without precedence. A comparison
      // containing a logical operand cannot prove the complete result's type.
      if (this.values.some((value) => value instanceof OperationValue && value.containsLogical)) return false;
      return !(["instanceof", "in"].includes(this.operator) && this.values[1] instanceof LiteralValue);
    }
    return ["&&", "||", "??"].includes(this.operator) && this.values.every((value) =>
      value instanceof LiteralValue && typeof value.value === "boolean" || value instanceof OperationValue && value.booleanResult);
  }
  get constantBoolean() {
    if (!this.values.every((value) => value instanceof LiteralValue)) return null;
    const [left, right] = this.values.map((value) => value.value);
    if (this.values.some((value) => typeof value.value === "number" && Number.isNaN(value.value))) return null;
    switch (this.operator) {
      case "!": return !left;
      case "===": return left === right;
      case "!==": return left !== right;
      case "==": return left == right;
      case "!=": return left != right;
      case "<": return left < right;
      case "<=": return left <= right;
      case ">": return left > right;
      case ">=": return left >= right;
      case "&&": return typeof left === "boolean" && typeof right === "boolean" ? left && right : null;
      case "||": return typeof left === "boolean" && typeof right === "boolean" ? left || right : null;
      case "??": return typeof left === "boolean" ? left : null;
      default: return null;
    }
  }
}
/** Exact lexical expression identity, shared by invocation-local observations. */
class SourceExpression {
  constructor(module, tokens) {
    if (!(module instanceof SourceModule) || !Array.isArray(tokens) || tokens.length === 0) throw new TypeError("source expression required");
    this.module = module; this.tokens = Object.freeze([...tokens]);
    Object.freeze(this);
  }
  contains(module, token) {
    return module === this.module && token.offset >= this.tokens[0].offset && token.offset <= this.tokens.at(-1).offset;
  }
  hasExpression(module, tokens) {
    return module === this.module && tokens.length === this.tokens.length
      && tokens.every((token, index) => token === this.tokens[index]);
  }
}
/** Parsed syntax only; callees, argument values and observed results are never retained. */
class IntrinsicExpression {
  constructor(expression, calleeToken, arguments_) {
    if (!(expression instanceof SourceExpression) || !expression.tokens.includes(calleeToken)
      || arguments_ !== null && arguments_.some(part => !(part instanceof SourceExpression) || part.module !== expression.module)) {
      throw new TypeError("intrinsic expression syntax required");
    }
    Object.assign(this, { expression, calleeToken, arguments: arguments_ === null ? null : Object.freeze([...arguments_]) });
  }
  static read(module, tokens) {
    return IntrinsicMemberExpression.read(module, tokens) ?? IntrinsicCallExpression.read(module, tokens);
  }
  hasExpression(module, tokens) { return this.expression.hasExpression(module, tokens); }
  get called() { return this.arguments !== null; }
  invoke(origins, environment, callee, constructed = false) {
    const module = this.expression.module;
    const args = this.arguments.map(part => origins.value(module, part.tokens, environment));
    return origins.invoke(callee, args, this.expression.tokens[0], module, environment, constructed);
  }
}
class IntrinsicMemberExpression extends IntrinsicExpression {
  constructor(expression, member, arguments_) {
    super(expression, expression.tokens[0], arguments_);
    if (!(member instanceof SourceMemberAccess) || member.token !== expression.tokens[2]
      || member.name === null || member.called !== this.called) throw new TypeError("intrinsic member syntax required");
    this.member = member;
    Object.freeze(this);
  }
  static read(module, tokens) {
    if (tokens.length < 3 || tokens[0].kind !== "identifier") return null;
    const member = readMemberAccess(tokens, 0);
    if (member === null || member.name === null || member.token !== tokens[2]) return null;
    if (member.called) {
      if (tokens[3]?.value !== "(" || matching(tokens, 3, "(", ")") !== tokens.length - 1) return null;
    } else if (tokens.length !== 3) return null;
    const arguments_ = member.called ? readCommaSeparated(tokens, 4, tokens.length - 1)
      .map(part => new SourceExpression(module, part)) : null;
    return new IntrinsicMemberExpression(new SourceExpression(module, tokens), member, arguments_);
  }
  evaluate(origins, environment, receiver) {
    const module = this.expression.module;
    const value = origins.readMember(receiver, this.member.name, this.member.token, module, environment);
    return this.called ? this.invoke(origins, environment, value) : value;
  }
}
class IntrinsicCallExpression extends IntrinsicExpression {
  constructor(expression, calleeToken, arguments_, constructed) {
    super(expression, calleeToken, arguments_);
    if (!this.called || typeof constructed !== "boolean" || calleeToken !== expression.tokens[constructed ? 1 : 0]) {
      throw new TypeError("intrinsic call syntax required");
    }
    this.constructed = constructed;
    Object.freeze(this);
  }
  static read(module, tokens) {
    const constructed = tokens[0]?.value === "new";
    const index = constructed ? 1 : 0;
    if (tokens[index]?.kind !== "identifier" || tokens[index + 1]?.value !== "("
      || matching(tokens, index + 1, "(", ")") !== tokens.length - 1) return null;
    // Loading and unary prefixes have their own source grammar. They are not
    // ordinary identifier calls, even though the reader tokenizes keywords alike.
    if (!constructed && (["import", "typeof", "void", "delete"].includes(tokens[0].value)
      || module.references.some(reference => reference.kind === "require" && reference.token === tokens[0]))) return null;
    const args = readCommaSeparated(tokens, index + 2, tokens.length - 1).map(part => new SourceExpression(module, part));
    return new IntrinsicCallExpression(new SourceExpression(module, tokens), tokens[index], args, constructed);
  }
  evaluate(origins, environment, callee) {
    return this.invoke(origins, environment, callee, this.constructed);
  }
}

/** Reuse completed syntax interpretation within one original work-budget period. */
class IntrinsicExpressions {
  #modules = new WeakMap();
  #charged = new WeakSet();
  resetCharges() { this.#charged = new WeakSet(); }
  value(module, tokens, environment, origins) {
    let syntax = this.#modules.get(module)?.get(tokens[0])?.find(entry => entry.hasExpression(module, tokens)) ?? null;
    const existing = syntax !== null;
    syntax ??= IntrinsicExpression.read(module, tokens);
    if (syntax === null) return null;
    const receiver = origins.intrinsicReceiver(module, syntax.calleeToken, environment);
    if (receiver === null) return null;
    if (!existing) {
      if (!this.#modules.has(module)) this.#modules.set(module, new Map());
      const expressions = this.#modules.get(module);
      if (!expressions.has(tokens[0])) expressions.set(tokens[0], []);
      expressions.get(tokens[0]).push(syntax);
    }
    if (syntax.called && !this.#charged.has(syntax)) origins.consumeWork(module, tokens[0]);
    const value = syntax.evaluate(origins, environment, receiver);
    if (syntax.called) this.#charged.add(syntax);
    return value;
  }
}

class ObjectValue extends OsValue {
  constructor(module, tokens, environment, trace = [], values = []) { super(trace); Object.assign(this, { module, tokens, environment, values }); }
  get sensitivityInputs() { return this.values; }
}
/** No fields or initializers; each read still creates its own source object. */
class EmptyObjectValue extends ObjectValue {
  constructor(module, tokens, environment, trace = []) {
    if (!EmptyObjectValue.matches(tokens)) throw new TypeError("empty object source required");
    super(module, tokens, environment, trace);
  }
  static matches(tokens) {
    return tokens.length === 2 && tokens[0].kind === "punctuation" && tokens[0].value === "{"
      && tokens[1].kind === "punctuation" && tokens[1].value === "}";
  }
}
/** Plain input fields are reusable only inside their original unwritten invocation. */
class InputObjectOrigin extends ObjectValue {
  constructor(value) {
    if (!InputObjectOrigin.matches(value)) throw new TypeError("unwritten invocation input object required");
    super(value.module, value.tokens, value.environment, value.trace, [...value.values]);
    this.expression = new SourceExpression(value.module, value.tokens);
  }
  static matches(value) {
    if (!(value instanceof ObjectValue) || !(value.environment instanceof SourceInvocationEnvironment)) return false;
    const { module, tokens, environment } = value;
    if (tokens[0]?.value !== "{" || matching(tokens, 0) !== tokens.length - 1
      || !environment.contains(module, tokens[0]) || !environment.contains(module, tokens.at(-1))) return false;
    const members = new SourceObjectMembers(tokens);
    return members.complete && members.entries.length > 0 && members.entries.every(property => {
      if (!(property instanceof SourceInitializer) || property instanceof SourceObjectSpread
        || property.tokens.length !== 1 || property.tokens[0].kind !== "identifier") return false;
      const binding = module.bindingAt(property.tokens[0]);
      return binding instanceof SourceInputBinding && environment.has(binding) && module.bindingWrites([binding]).length === 0;
    });
  }
  hasExpression(module, tokens) { return this.expression.hasExpression(module, tokens); }
  copy() { return new ObjectValue(this.module, this.tokens, this.environment, this.trace, [...this.values]); }
}
class NamespaceValue extends OsValue {
  constructor(file, trace = []) { super(trace); this.file = file; }
}
class CommonJsModuleValue extends NamespaceValue {}
class CallableValue extends OsValue {
  constructor(module, declaration, environment = new Map(), trace = []) { super(trace); Object.assign(this, { module, declaration, environment }); }
}
class ClassValue extends OsValue {
  constructor(module, declaration, instance = false, trace = [], arguments_ = [], environment = emptyEnvironment) {
    super(trace);
    if (!(declaration instanceof SourceDeclaration)) throw new TypeError("lexical class declaration required");
    Object.assign(this, { module, declaration, name: declaration.name, instance, arguments: arguments_, environment });
  }
  get sensitivityInputs() { return [...this.arguments, ...this.environment.values()]; }
  get ownSensitive() { return this.sensitivityInputs.some(value => pseudoPathUse(value) !== null); }
}

/** A closed constructor/parent contract, resolved by lexical identity. */
class InvocationClassContract {
  constructor(source, parent) { this.source = source; this.parent = parent; }
  static matches(tokens, source) {
    return tokens.length > 0 && new SourceInitializer(tokens[0], 0, tokens).matches(source);
  }
  static refusalTail(declaration, condition) {
    const body = declaration.bodyTokens() ?? [];
    if (body[0]?.value !== "if" || body[1]?.value !== "(") return null;
    const end = matching(body, 1, "(", ")");
    if (!this.matches(body.slice(2, end), condition)
      || body[end + 1]?.value !== "throw" || body[end + 2]?.value !== "new"
      || body[end + 3]?.kind !== "identifier" || body[end + 4]?.value !== "(") return null;
    const thrown = matching(body, end + 4, "(", ")");
    return body[thrown + 1]?.value === ";" ? body.slice(thrown + 2) : null;
  }
  static ordinaryFunction(value, count) {
    if (!(value instanceof CallableValue) || value.declaration.tokens[0]?.value !== "function"
      || value.declaration.prefix.some(token => token.value === "async")) return null;
    const parameters = readParameters(value.declaration.tokens);
    return parameters.length === count ? parameters : null;
  }
  static unbound(value, names) {
    return value.declaration.tokens.filter(token => names.includes(token.value))
      .every(token => value.module.isUnbound(token.value, token));
  }
  static scalar(value) {
    const parameters = this.ordinaryFunction(value, 3);
    if (!parameters || parameters.slice(0, 2).some(parameter => parameter.length !== 1 || parameter[0].kind !== "identifier")) return false;
    const [input, label, empty] = parameters.map(parameter => parameter[0]?.value);
    if (!empty || !this.matches(parameters[2], `${empty} = false`)) return false;
    const tail = this.refusalTail(value.declaration,
      `typeof ${input} !== 'string' || (!${empty} && !${input}) || ${input}.includes('\\0')`);
    return tail !== null && this.matches(tail, `return ${input};`);
  }
  static argv(value, scalar, origins) {
    const parameters = this.ordinaryFunction(value, 2);
    if (!parameters || parameters.some(parameter => parameter.length !== 1 || parameter[0].kind !== "identifier")
      || !this.unbound(value, ["Array", "Object"])) return false;
    const [input, label] = parameters.map(parameter => parameter[0].value);
    const tail = this.refusalTail(value.declaration, `!Array.isArray(${input})`);
    if (tail === null) return false;
    const arrow = tail.findIndex(token => token.value === "=>");
    const entry = tail[arrow - (tail[arrow - 1]?.value === ")" ? 2 : 1)];
    const helper = tail[arrow + 1];
    if (entry?.kind !== "identifier" || helper?.kind !== "identifier") return false;
    const resolved = origins.identifier(value.module, helper);
    if (!(resolved instanceof CallableValue) || resolved.module !== scalar.module
      || resolved.declaration.token !== scalar.declaration.token) return false;
    return this.matches(tail, `return Object.freeze([...${input}].map((${entry.value}) => ${helper.value}(${entry.value}, ${label}, true)));`)
      || this.matches(tail, `return Object.freeze([...${input}].map(${entry.value} => ${helper.value}(${entry.value}, ${label}, true)));`);
  }
  static inspect(source, origins) {
    const tokens = source.declaration.tokens;
    // A module binding is stable independently of a particular factory call.
    if (source.module.moduleBinding(source.name) !== source.module.bindingAt(tokens[1])
      || tokens[2]?.value !== "extends" || tokens[3]?.kind !== "identifier" || tokens[4]?.value !== "{") return null;
    const child = new SourceClassMembers(source.declaration);
    if (child.instanceMembers.size !== 2 || !child.instanceMembers.has("toJSON") || child.staticMembers.size
      || child.instanceInitializers.length || child.unresolvedInstanceMembers.length || child.unresolvedStaticMembers.length) return null;
    const constructor = child.instanceMembers.get("constructor");
    const parameters = constructor && readParameters(constructor.tokens);
    if (parameters?.length !== 1 || parameters[0].length !== 1 || parameters[0][0].kind !== "identifier"
      || !constructor.matchesBody(`super(${parameters[0][0].value}); Object.freeze(this);`)
      || !this.unbound(source, ["Object"])) return null;
    const parent = origins.identifier(source.module, tokens[3]);
    const base = parent instanceof ClassValue && !parent.instance ? origins.invocationBaseContract(parent) : null;
    return base === null ? null : new this(source, base);
  }
  static inspectBase(parent, origins) {
    if (!(parent instanceof ClassValue) || parent.declaration.tokens[2]?.value !== "{"
      || parent.module.moduleBinding(parent.name) !== parent.module.bindingAt(parent.declaration.tokens[1])) return null;
    const members = new SourceClassMembers(parent.declaration);
    if (members.instanceInitializers.length || members.unresolvedInstanceMembers.length || members.unresolvedStaticMembers.length
      || ["executable", "args", "cwd", "env", "stdio"].some(name => members.instanceMembers.has(name))) return null;
    const initialize = members.instanceMembers.get("constructor"), options = members.instanceMembers.get("processOptions");
    if (!initialize || !options || !options.matchesDeclaration(`processOptions() {
      return { ...(this.cwd !== null && { cwd: this.cwd }), ...(this.env !== null && { env: this.env }), stdio: this.stdio };
    }`)) return null;
    const input = readParameters(initialize.tokens);
    if (input.length !== 1 || !this.matches(input[0], `{ executable, args = [], cwd = null, env = null, stdio = 'pipe' }`)) return null;
    const tail = this.refusalTail(initialize, `new.target === ${parent.name}`);
    if (tail === null) return null;
    const helper = name => {
      const index = tail.findIndex((token, offset) => token.value === "this" && tail[offset + 1]?.value === "."
        && tail[offset + 2]?.value === name && tail[offset + 3]?.value === "=");
      return index < 0 || tail[index + 4]?.kind !== "identifier" ? null : tail[index + 4];
    };
    const scalarToken = helper("executable"), argvToken = helper("args"), environmentToken = helper("env"), stdioToken = helper("stdio");
    if (!scalarToken || !argvToken || !environmentToken || !stdioToken
      || !this.matches(tail, `this.executable = ${scalarToken.value}(executable, $STRING_LITERAL);
        this.args = ${argvToken.value}(args, $STRING_LITERAL);
        this.cwd = cwd === null ? null : ${scalarToken.value}(cwd, $STRING_LITERAL);
        this.env = ${environmentToken.value}(env); this.stdio = ${stdioToken.value}(stdio);`)) return null;
    const scalar = origins.identifier(parent.module, scalarToken), argv = origins.identifier(parent.module, argvToken);
    if (!this.scalar(scalar) || !this.argv(argv, scalar, origins)
      || !(origins.identifier(parent.module, environmentToken) instanceof CallableValue)
      || !(origins.identifier(parent.module, stdioToken) instanceof CallableValue)) return null;
    return new InvocationBaseContract(parent);
  }
}
class InvocationBaseContract {
  constructor(source) { this.source = source; }
}
class InvocationClassValue extends ClassValue {
  get ownSensitive() { return true; }
}
class InvocationInstanceValue extends InvocationClassValue {
  constructor(source, arguments_, contract) {
    super(source.module, source.declaration, true, source.trace, arguments_, source.environment);
    this.contract = contract;
    this.input = arguments_[0] ?? new UnknownValue();
  }
}
class InvocationOptionsMethodValue extends OsValue {
  constructor(owner, binding) { super(owner.trace); this.owner = owner; this.binding = binding; }
  get sensitivityInputs() { return [this.owner]; }
}
class InvocationOptionsValue extends OsValue {
  #fields;
  constructor(method, fields) { super(method.trace); this.owner = method.owner; this.binding = method.binding; this.#fields = new Map(fields); }
  member(name) { return this.#fields.get(name) ?? null; }
  get sensitivityInputs() { return [...this.#fields.values()]; }
}
class DerivedValue extends OsValue {
  constructor(origin, details = null) {
    super(origin.trace);
    if (!(origin instanceof OsValue)) throw new TypeError("source value origin required");
    Object.assign(this, { origin, details });
  }
}
class PrimitiveConversionValue extends DerivedValue {
  get sensitivityInputs() { return [this.origin]; }
}
class SensitiveValue extends DerivedValue { get ownSensitive() { return true; } }
class PlatformValue extends SensitiveValue {}
class AuthorityValue extends SensitiveValue {}
class StatValue extends SensitiveValue { get intrinsicSyntax() { return true; } }
class StatfsValue extends SensitiveValue { get intrinsicSyntax() { return true; } }
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
  get ownSensitive() { return pseudoPathUse(this.details) !== null; }
  get sensitivityInputs() { return [this.inputs]; }
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
  get ownSensitive() { return pseudoPathUse(this) !== null; }
  get sensitivityInputs() { return [this.origin]; }
}
class UserInfoValue extends SensitiveValue { get intrinsicSyntax() { return true; } }
class ChildProcessValue extends DerivedValue {}
class TemporaryRootValue extends DerivedValue {}
class NativePathValue extends DerivedValue {
  constructor(origin, source) {
    if (!(source instanceof OsValue)) throw new TypeError("native path source required");
    super(origin, source);
    this.trace = [...new Set([...origin.trace, ...source.trace])];
  }
  get ownSensitive() { return pseudoPathUse(this.details) !== null; }
  get sensitivityInputs() { return [this.details]; }
}
class OwnedRootValue extends DerivedValue {}
class ShellArgvValue extends DerivedValue {}
class StringMethodValue extends DerivedValue {}
class JoinMethodValue extends DerivedValue {}
class DescriptorMethodValue extends DerivedValue {}
class ChildMethodValue extends DerivedValue {}
class ConcatenationValue extends DerivedValue { get sensitivityInputs() { return [this.origin]; } }
class TemplateValue extends DerivedValue { get sensitivityInputs() { return [this.origin]; } }
class TaggedTemplateValue extends DerivedValue {
  get ownSensitive() { return pseudoPathUse(this) !== null; }
  get sensitivityInputs() { return [this.origin]; }
}
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
/** Unknown selection retains every possible OS/path origin until its consumer. */
class UncertainValue extends UnknownValue {
  constructor(origin, reason) {
    if (!(origin instanceof SequenceValue)) throw new TypeError("source value alternatives required");
    super(reason, hasOsSensitiveOrigin(origin), origin.trace);
    this.origin = origin;
  }
  get sensitivityInputs() { return [this.origin]; }
  get intrinsicSyntax() { return false; }
}
class UnresolvedCompositionValue extends UnknownValue {
  constructor(origin) {
    if (!(origin instanceof OsValue)) throw new TypeError("composed value origin required");
    super("unsupported composed-value transform retains an OS-sensitive origin", true, origin.trace);
    this.origin = origin;
  }
}
class RetainedStringMethodValue extends DerivedValue { get ownSensitive() { return pseudoPathUse(this.origin) !== null; } get sensitivityInputs() { return [this.origin]; } }
class TransformedStringValue extends DerivedValue { get ownSensitive() { return pseudoPathUse(this.origin) !== null; } get sensitivityInputs() { return [this.origin]; } }
class ConditionalFilesystemPathValue extends DerivedValue {}
class ModuleLoaderValue extends SensitiveValue {}
class BindingExpression {
  constructor(module, tokens, target) { Object.assign(this, { module, tokens, target }); }
}
/** A fallback belongs to the member depth where its binding can be missing. */
class BindingDefault {
  constructor(tokens, memberDepth) {
    if (!Array.isArray(tokens) || tokens.length === 0 || !Number.isSafeInteger(memberDepth) || memberDepth < 0) throw new TypeError("binding default source and member depth required");
    Object.assign(this, { tokens, memberDepth });
  }
}

/** One projection contract for declarations, helper parameters and constructors. */
class BindingTarget {
  constructor(token, members = [], complete = true, defaults = []) {
    if (token?.kind !== "identifier" || !Array.isArray(members) || !Array.isArray(defaults)
      || defaults.some(value => !(value instanceof BindingDefault))) throw new TypeError("source binding target required");
    Object.assign(this, { token, members, complete, defaults });
  }
}

function bindingTargets(pattern, members = [], complete = true, defaults = []) {
  pattern = strip(pattern);
  const equal = endOfExpression(pattern, 0, new Set(["="]));
  if (equal < pattern.length) {
    const left = pattern.slice(0, equal);
    const simple = members.length === 0 && left.length === 1 && left[0].kind === "identifier";
    return bindingTargets(left, members, complete && simple, [...defaults, new BindingDefault(pattern.slice(equal + 1), members.length)]);
  }
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
  if (value instanceof ConcatenationValue || value instanceof TemplateValue || value instanceof TaggedTemplateValue || value instanceof UncertainValue || value instanceof UnresolvedCompositionValue || value instanceof TransformedStringValue || value instanceof RetainedStringMethodValue || value instanceof ConditionalFilesystemPathValue) return [value, ...valueOrigins(value.origin, nativePath, urlPaths)];
  if (urlPaths && (value instanceof FileUrlValue || value instanceof NativePathValue || value instanceof UnresolvedUrlPathValue)) return [value, ...valueOrigins(value.details, nativePath, true)];
  if (urlPaths && value instanceof UrlPathnameValue) return [value, ...valueOrigins(value.origin, nativePath, true)];
  return [value];
}

function hasOsSensitiveOrigin(value) {
  return valueOrigins(value).some(origin => origin.sensitive || pseudoPathUse(origin) !== null
    || origin instanceof WindowsPathValue || origin instanceof PosixPathValue);
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
  // Logical expressions retain every possible path operand. This does not
  // infer precedence, select an unproven branch or grant callable authority.
  if (value instanceof OperationValue && ["&&", "||", "??"].includes(value.operator)) {
    return value.values.some(part => pseudoPathUse(part)) ? "incomplete" : null;
  }
  if (value instanceof UncertainValue) return valueOrigins(value.origin).some(origin => pseudoPathUse(origin)) ? "incomplete" : null;
  if (value instanceof TaggedTemplateValue) return value.origin.values.some((part) => pseudoPathUse(part)) ? "incomplete" : null;
  if (value instanceof FileUrlPathValue) {
    if (value.uncertain) return "incomplete";
    return [value.text(posix), value.text(win32)].some((text) => pseudoPath.test(text)) ? "violation" : null;
  }
  if (value instanceof FileUrlValue || value instanceof NativePathValue) return pseudoPathUse(value.details);
  if (value instanceof UrlPathnameValue) return pseudoPathUse(value.origin);
  if (value instanceof UnresolvedUrlPathValue) return value.details.values.some((part) => pseudoPathUse(part)) ? "incomplete" : null;
  if (value instanceof TransformedStringValue || value instanceof RetainedStringMethodValue || value instanceof ConditionalFilesystemPathValue) return pseudoPathUse(value.origin) ? "incomplete" : null;
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

/** Own this for a call or field initializer; arrows preserve the captured binding. */
class SourceReceiverEnvironment extends Map {
  constructor(environment, receiver, lexicalThis = false) {
    super();
    if (!(environment instanceof Map)) throw new TypeError("source receiver context required");
    for (const [binding, value] of environment) super.set(binding, value);
    if (!lexicalThis) {
      if (receiver instanceof ClassValue || receiver instanceof ObjectValue) super.set(lexicalReceiver, receiver);
      else super.delete(lexicalReceiver);
    }
  }
}

/** One invocation owns its local origins; captured/other calls never share them. */
class SourceInvocationEnvironment extends SourceReceiverEnvironment {
  #origins = new Map();
  #revision = 0;
  constructor(module, declaration, environment, receiver = null) {
    if (!(module instanceof SourceModule) || !(declaration instanceof SourceDeclaration)) throw new TypeError("source invocation context required");
    super(environment, receiver, declaration.lexicalThis);
    this.module = module;
    const body = declaration.bodyTokens() ?? [];
    this.start = body[0]?.offset ?? Infinity;
    this.end = body.at(-1)?.offset ?? -Infinity;
    Object.freeze(this);
  }
  #invalidate() { this.#origins.clear(); this.#revision++; }
  get revision() { return this.#revision; }
  set(binding, value) { this.#invalidate(); return super.set(binding, value); }
  delete(binding) { this.#invalidate(); return super.delete(binding); }
  clear() { this.#invalidate(); super.clear(); }
  contains(module, token) {
    return module === this.module && token.offset >= this.start && token.offset <= this.end;
  }
  owns(expression) { return this.contains(expression.module, expression.target.token); }
  readOrigin(binding, mode) { return this.#origins.get(binding)?.get(mode) ?? null; }
  rememberOrigin(binding, mode, value) {
    if (!(value instanceof OsValue)) throw new TypeError("source origin value required");
    if (!this.#origins.has(binding)) this.#origins.set(binding, new Map());
    this.#origins.get(binding).set(mode, value);
  }
}


/** A completed data observation, never a constructor or authority grant. */
class SourceScannedValue {
  constructor(expression, value, observations) {
    if (!(expression instanceof SourceExpression) || !(value instanceof OsValue) || value.sensitive
      || !Number.isSafeInteger(observations) || observations < 0) throw new TypeError("observed source data required");
    Object.assign(this, { expression, value, observations });
    Object.freeze(this);
  }
}

/** Cycle detection depends on the exact active binding and export memberships. */
class SourceResolutionContext {
  #bindings;
  #exports;
  constructor(bindings, exports) {
    if (!(bindings instanceof Set) || !(exports instanceof Set)) throw new TypeError("source resolution context required");
    this.#bindings = new Set(bindings);
    this.#exports = new Set(exports);
    Object.freeze(this);
  }
  matches(bindings, exports) {
    if (bindings.size !== this.#bindings.size || exports.size !== this.#exports.size) return false;
    for (const binding of this.#bindings) if (!bindings.has(binding)) return false;
    for (const exported of this.#exports) if (!exports.has(exported)) return false;
    return true;
  }
}

/** One source member query; subclasses own its identity and projection semantics. */
class SourceMemberProjection {
  constructor(receiver, name) {
    if (!(receiver instanceof OsValue) || typeof name !== "string") throw new TypeError("source member projection required");
    Object.assign(this, { receiver, name });
  }
  matches() { throw new Error("source member projection identity required"); }
  read() { throw new Error("source member projection implementation required"); }
}

/** Only active queries are retained; completed results and authority are never cached. */
class SourceMemberProjections {
  constructor() { this.active = []; }
  read(projection, origins) {
    if (!(projection instanceof SourceMemberProjection)) throw new TypeError("source member projection required");
    if (this.active.some(active => active.matches(projection, origins))) {
      return new UnknownValue(projection.cycleReason, true, projection.receiver.trace);
    }
    this.active.push(projection);
    try { return projection.read(origins); }
    finally { this.active.pop(); }
  }
}

/** Only an active, identical object member projection is a provenance cycle. */
class SourceObjectProjection extends SourceMemberProjection {
  constructor(receiver, name, origins) {
    super(receiver, name);
    if (!(receiver instanceof ObjectValue)) throw new TypeError("source object required");
    Object.assign(this, { expression: new SourceExpression(receiver.module, receiver.tokens),
      environment: receiver.environment, revision: receiver.environment.revision, mode: origins.evaluationMode,
      route: origins.route, callers: origins.callers,
      resolution: new SourceResolutionContext(origins.activeBindings, origins.activeExports) });
    Object.freeze(this);
  }
  get cycleReason() { return "unresolved object member projection cycle"; }
  matches(projection, origins) {
    if (!(projection instanceof SourceObjectProjection)) return false;
    const { receiver, name } = projection;
    return name === this.name && this.expression.hasExpression(receiver.module, receiver.tokens)
      && receiver.environment === this.environment && receiver.environment.revision === this.revision
      && origins.evaluationMode === this.mode && origins.route === this.route && origins.callers === this.callers
      && this.resolution.matches(origins.activeBindings, origins.activeExports);
  }
  read(origins) {
    const { receiver, name } = this;
    const members = new SourceObjectMembers(receiver.tokens);
    if (!members.entries.some(property => property instanceof SourceObjectSpread)) {
      const property = readObjectProperty(receiver.tokens, name);
      if (!property) return null;
      if (property instanceof SourceDeclaration) {
        const index = receiver.tokens.findIndex(item => item.offset === property.token.offset);
        const callable = new CallableValue(receiver.module, property, receiver.environment, receiver.trace);
        return receiver.tokens[index - 1]?.value === "get"
          ? origins.invoke(callable, [], property.token, receiver.module, receiver.environment, false, receiver) : callable;
      }
      return origins.value(receiver.module, property.tokens, receiver.environment);
    }
    if (!members.complete) return new UnknownValue("object member projection is ambiguous or executable", true, receiver.trace);
    for (const property of [...members.entries].reverse()) {
      if (property instanceof SourceObjectSpread) {
        const spread = origins.value(receiver.module, property.tokens, receiver.environment);
        if (!origins.closedSpread(spread)) {
          return new UnknownValue("object spread has no inspected data members", true, spread.trace);
        }
        const selected = spread instanceof InvocationOptionsValue ? spread.member(name) : origins.objectMember(spread, name);
        if (selected !== null) return selected;
        continue;
      }
      if (property.token.value !== name) continue;
      if (property instanceof SourceDeclaration) return new CallableValue(receiver.module, property, receiver.environment, receiver.trace);
      return origins.value(receiver.module, property.tokens, receiver.environment);
    }
    return null;
  }
}

/** A class field/getter query keeps the exact constructed receiver and context. */
class SourceClassProjection extends SourceMemberProjection {
  constructor(receiver, name, token, module, environment, origins) {
    super(receiver, name);
    if (!(receiver instanceof ClassValue)) throw new TypeError("source class required");
    Object.assign(this, { token, module, environment, revision: receiver.environment.revision, mode: origins.evaluationMode,
      route: origins.route, callers: origins.callers,
      resolution: new SourceResolutionContext(origins.activeBindings, origins.activeExports) });
    Object.freeze(this);
  }
  get cycleReason() { return "unresolved class member projection cycle"; }
  matches(projection, origins) {
    return projection instanceof SourceClassProjection && projection.receiver === this.receiver
      && projection.name === this.name && this.receiver.environment.revision === this.revision
      && origins.evaluationMode === this.mode && origins.route === this.route && origins.callers === this.callers
      && this.resolution.matches(origins.activeBindings, origins.activeExports);
  }
  read(origins) {
    const { receiver, name, token, module, environment } = this;
    if (!origins.classMembers.has(receiver.declaration.token)) origins.classMembers.set(receiver.declaration.token, new SourceClassMembers(receiver.declaration));
    const members = origins.classMembers.get(receiver.declaration.token);
    const property = (receiver.instance ? members.instanceMembers : members.staticMembers).get(name);
    if (!property) {
      const constructor = receiver.instance && members.instanceMembers.get("constructor");
      if (!constructor) return new UnknownValue();
      const local = new SourceInvocationEnvironment(receiver.module, constructor, receiver.environment, receiver);
      origins.bindArguments(receiver.module, readParameters(constructor.tokens), receiver.arguments, local);
      const tokens = constructor.bodyTokens();
      const assignment = tokens.findIndex((item, index) => item.value === "this" && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === name && tokens[index + 3]?.value === "=");
      return assignment < 0 ? new UnknownValue() : origins.value(receiver.module, tokens.slice(assignment + 4, endOfExpression(tokens, assignment + 4)), local);
    }
    if (property.token.value === name && property.tokens[1]?.value === "=") return origins.value(receiver.module, property.tokens.slice(2),
      new SourceReceiverEnvironment(receiver.environment, receiver));
    const callable = new CallableValue(receiver.module, property, receiver.environment, receiver.trace);
    const index = receiver.module.tokens.findIndex((item) => item.offset === property.token.offset);
    return receiver.module.tokens[index - 1]?.value === "get" ? origins.invoke(callable, [], token, module, environment, false, receiver) : callable;
  }
}

/** Completed inspection metadata; sensitive coverage ends at the next observation. */
class SourceEvaluationCoverage {
  constructor(expression, observations) {
    if (!(expression instanceof SourceExpression)
      || observations !== null && (!Number.isSafeInteger(observations) || observations < 0)) throw new TypeError("completed source inspection required");
    Object.assign(this, { expression, observations });
    Object.freeze(this);
  }
  matches(module, tokens, observations) {
    return this.expression.hasExpression(module, tokens)
      && (this.observations === null || this.observations === observations);
  }
}

/** One body scan owns both completed inspections and its last observed data. */
class SourceBodyScan {
  #values = new Map();
  #evaluated = new Map();
  constructor(module, tokens, environment, origins) {
    if (!(module instanceof SourceModule) || environment !== emptyEnvironment && (!(environment instanceof SourceInvocationEnvironment)
      || environment.module !== module) || typeof origins.evaluationMode !== "string") throw new TypeError("source scan context required");
    Object.assign(this, { module, environment, expression: new SourceExpression(module, tokens),
      mode: origins.evaluationMode, revision: environment.revision,
      route: origins.route, callers: origins.callers,
      resolution: new SourceResolutionContext(origins.activeBindings, origins.activeExports) });
    Object.freeze(this);
  }
  #current(module, environment, origins) {
    return module === this.module && environment === this.environment && origins.evaluationMode === this.mode
      && environment.revision === this.revision && origins.route === this.route && origins.callers === this.callers;
  }
  #owns(tokens) {
    return tokens.length > 0 && this.expression.contains(this.module, tokens[0])
      && this.expression.contains(this.module, tokens.at(-1))
      && (this.environment === emptyEnvironment || this.environment.contains(this.module, tokens[0])
        && this.environment.contains(this.module, tokens.at(-1)));
  }
  #evaluationContext(module, environment, origins) {
    return this.#current(module, environment, origins) && this.resolution.matches(origins.activeBindings, origins.activeExports);
  }
  rememberEvaluation(module, tokens, environment, origins, value) {
    if (!this.#evaluationContext(module, environment, origins) || !this.#owns(tokens)) return;
    if (!this.#evaluated.has(tokens[0])) this.#evaluated.set(tokens[0], []);
    const expressions = this.#evaluated.get(tokens[0]);
    const coverage = new SourceEvaluationCoverage(new SourceExpression(module, tokens),
      value.sensitive || this.environment === emptyEnvironment ? origins.observations : null);
    const index = expressions.findIndex(entry => entry.expression.hasExpression(module, tokens));
    if (index < 0) expressions.push(coverage);
    else expressions[index] = coverage;
  }
  evaluated(module, tokens, environment, origins) {
    return this.#evaluationContext(module, environment, origins)
      && (this.#evaluated.get(tokens[0])?.some(coverage => coverage.matches(module, tokens, origins.observations)) ?? false);
  }
  remember(tokens, value, origins) {
    if (this.environment === emptyEnvironment || !this.#current(this.module, this.environment, origins)
      || value.sensitive || !this.#owns(tokens)) return;
    this.#values.set(tokens[0], new SourceScannedValue(new SourceExpression(this.module, tokens), value, origins.observations));
  }
  read(module, tokens, environment, origins) {
    if (!this.#current(module, environment, origins)) return null;
    const observed = this.#values.get(tokens[0]);
    return observed?.observations === origins.observations && observed.expression.hasExpression(module, tokens) ? observed.value : null;
  }
}

function uncertainOrigins(values, reason) {
  if (values.length > 0 && values.every((value) => value instanceof BuiltinValue && value.identity === values[0].identity)) return values[0];
  return new UncertainValue(new SequenceValue(values, values.flatMap(value => value.trace)), reason);
}

/** Source-only value provenance. It reuses the reader's lexical identities and grammar. */
class OsSourceOrigins {
  constructor(graph, diagnose) {
    Object.assign(this, { graph, diagnose });
    this.indexes = new WeakMap();
    this.activeBindings = new Set();
    this.activeExports = new Set();
    this.activeCalls = new Set();
    this.memberProjections = new SourceMemberProjections();
    this.route = [];
    this.callers = [];
    this.intrinsicExpressions = new IntrinsicExpressions();
    this.resetWork();
    this.values = new WeakMap();
    this.interpolationBoundaries = new WeakMap();
    this.classMembers = new WeakMap();
    this.invocationContracts = new WeakMap();
    this.invocationBaseContracts = new WeakMap();
    this.constantValues = new ConstantEvaluationCache();
    this.observations = 0;
    this.scanning = null;
    this.deepCalls = true;
    this.scanHelpers = true;
    this.selectCallRoute = () => null;
    this.observing = false;
    this.onCall = () => {};
    this.onMember = () => {};
    this.onUnsupported = () => {};
    this.onSelection = () => {};
  }

  resetWork() {
    this.evaluations = new Map();
    this.work = 0;
    this.intrinsicExpressions.resetCharges();
  }

  observe(callback, ...args) {
    this.observations++;
    this[callback](...args);
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
      if (token.kind !== "identifier" || tokens[index - 1]?.value === ".") continue;
      if (["const", "let", "var"].includes(token.value)) {
        const end = endOfExpression(tokens, index + 1, new Set([";"]));
        for (const part of readCommaSeparated(tokens, index + 1, end)) {
          const equal = endOfExpression(part, 0, new Set(["="]));
          if (equal < part.length) bind(part.slice(0, equal), part.slice(equal + 1));
        }
      }
      if (["function", "class"].includes(token.value) && tokens[index + 1]?.kind === "identifier") {
        const name = tokens[index + 1];
        const primary = SourceBodyPrimary.read(tokens, index);
        if (primary === null) continue;
        const binding = module.bindingAt(name);
        register(binding, new BindingExpression(module, primary.declaration.tokens, new BindingTarget(name)));
      }
      if (token.kind === "identifier" && tokens[index + 1]?.value === "=" && tokens[index + 2]?.value !== "="
        && ![".", "=", "const", "let", "var"].includes(tokens[index - 1]?.value)) {
        register(module.bindingAt(token), new BindingExpression(module, tokens.slice(index + 2, endOfExpression(tokens, index + 2)), new BindingTarget(token)));
      }
    }
    return bindings;
  }

  unwrittenInput(module, binding, environment) {
    if (!binding || !environment.has(binding) && !(binding instanceof SourceInputBinding)
      || module.bindingWrites([binding]).length > 0) return null;
    if (environment.has(binding)) return environment.get(binding);
    return this.index(module).has(binding) ? null : new UnknownValue();
  }

  intrinsicReceiver(module, token, environment) {
    const binding = module.bindingAt(token);
    const supplied = this.recalledOrigin(module, binding, environment) ?? this.unwrittenInput(module, binding, environment);
    if (supplied !== null) return supplied.intrinsicSyntax ? supplied : null;
    if (binding) {
      if (environment.has(binding) || module.bindingWrites([binding]).length > 0) return null;
      const imported = this.importReference(module, token, binding);
      if (!imported || sourceBuiltin(imported.specifier) === null) return null;
    } else if (!module.isUnbound(token.value, token)) return null;
    const receiver = this.identifier(module, token, environment);
    return receiver.intrinsicSyntax ? receiver : null;
  }

  classValue(module, declaration, environment) {
    const value = new ClassValue(module, declaration, false, [module.file], [], environment);
    return this.invocationType(value) ? new InvocationClassValue(module, declaration, false, value.trace, [], environment) : value;
  }

  // A single unwritten module declaration is already parsed source metadata.
  // Each read creates a fresh value with its current environment. Class contracts
  // use the existing lexical proof; bodies, arguments and calls still run later.
  unwrittenModuleDeclaration(module, token, binding, environment) {
    if (!binding || environment.has(binding) || module.moduleBinding(token.value) !== binding) return null;
    const kind = module.declarationHeader(token.value)?.token.value;
    if (!["function", "class"].includes(kind) || module.bindingWrites([binding]).length > 0) return null;
    const origins = this.index(module).get(binding);
    if (origins?.expressions.length !== 1) return null;
    const declaration = module.declaration(token.value);
    if (origins.expressions[0].tokens[0] !== declaration.token) return null;
    if (kind === "class") return this.classValue(module, new SourceDeclaration(declaration.name, declaration.tokens), environment);
    return new CallableValue(module, new SourceDeclaration(`<helper:${declaration.token.offset}>`, declaration.tokens,
      declaration.prefix.filter(token => token.value === "async")), environment, [module.file]);
  }

  inputWriteValue(module, binding, environment, supplied = null) {
    const writes = module.bindingWrites([binding]);
    if (writes.length === 0) return supplied;
    const offsets = new Set(writes.map(write => write.token.offset));
    const expressions = (this.index(module).get(binding)?.expressions ?? [])
      .filter(expression => offsets.has(expression.target.token.offset));
    if (expressions.length !== writes.length) return uncertainOrigins([
      ...(supplied === null ? [] : [supplied]),
      new UnknownValue("runtime input write has no inspected value", true, [module.file])],
    "runtime input write has no inspected value");
    return supplied === null ? null : this.bindingOrigin(module, binding, expressions, environment, supplied);
  }

  importReference(module, token, binding) {
    return module.references.find(reference => reference.kind === "import" && reference.bindings.has(token.value)
      && module.moduleBinding(token.value) === binding);
  }

  get evaluationMode() { return `${this.observing}:${this.deepCalls}:${this.scanHelpers}`; }

  recalledOrigin(module, binding, environment) {
    return binding && environment instanceof SourceInvocationEnvironment && environment.module === module
      ? environment.readOrigin(binding, this.evaluationMode) : null;
  }

  identifier(module, token, environment = emptyEnvironment) {
    const binding = module.bindingAt(token);
    const recalled = this.recalledOrigin(module, binding, environment);
    if (recalled !== null) return recalled;
    const unwritten = this.unwrittenInput(module, binding, environment);
    if (unwritten !== null) return unwritten;
    if (binding && environment.has(binding)) return this.inputWriteValue(module, binding, environment, environment.get(binding));
    if (binding instanceof SourceInputBinding) {
      const written = this.inputWriteValue(module, binding, environment);
      if (written !== null) return written;
    }
    if (!binding) {
      if (module.isUnbound("process", token) && token.value === "process") return new BuiltinValue("process", [], [module.file]);
      if (literalKeywordValues.has(token.value)) return new LiteralValue(literalKeywordValues.get(token.value), [module.file]);
      if (token.value === "this") return environment.get(lexicalReceiver) ?? new UnknownValue();
      if (["URL", "Reflect", "Object", "String", "BigInt", "console", "globalThis", "global"].includes(token.value) && module.isUnbound(token.value, token)) return new BuiltinValue(token.value, [], [module.file]);
      return new UnknownValue();
    }
    const imported = this.importReference(module, token, binding);
    if (imported) {
      const target = this.graph.resolve(module.file, imported);
      const name = imported.bindings.get(token.value);
      if (target.builtin) {
        const value = new BuiltinValue(target.builtin, [], [module.file]);
        return ["default", "*"].includes(name) ? value : this.member(value, name, token, module, environment);
      }
      return name === "*" ? new NamespaceValue(target.file, [module.file, target.file]) : this.exported(target.file, name, [module.file]);
    }
    const declared = this.unwrittenModuleDeclaration(module, token, binding, environment);
    if (declared !== null) return declared;
    const origins = this.index(module).get(binding);
    return origins ? this.bindingOrigin(module, binding, origins.expressions, environment) : new UnknownValue();
  }

  bindingOrigin(module, binding, expressions, environment, supplied = null) {
    if (this.activeBindings.has(binding)) return supplied ?? (binding instanceof SourceInputBinding ? new UnknownValue()
      : new UnknownValue("unresolved binding origin cycle", true, [module.file]));
    this.activeBindings.add(binding);
    try {
      const values = expressions.map((expression) => {
        const value = this.value(expression.module, expression.tokens, environment);
        return this.project(expression.module, expression.target, value, environment);
      });
      if (supplied !== null) values.unshift(supplied);
      const value = values.length === 1 ? values[0]
        : uncertainOrigins(values, "multiple binding writes obscure the capability origin");
      const expression = expressions[0];
      if (supplied === null && environment instanceof SourceInvocationEnvironment && expressions.length === 1
        && environment.owns(expression) && expression.target.complete && expression.target.members.length === 0
        && expression.target.defaults.length === 0 && module.bindingWrites([binding]).length === 0) {
        environment.rememberOrigin(binding, this.evaluationMode, value);
      }
      return value;
    } finally { this.activeBindings.delete(binding); }
  }

  project(module, target, origin, environment) {
    const projectMembers = (value, members) => members.reduce((selected, member) =>
      this.member(selected, member, target.token, module, environment), value);
    const value = projectMembers(origin, target.members);
    if (!target.complete) {
      const defaults = target.defaults.flatMap(fallback => {
        const input = this.value(module, fallback.tokens, environment);
        return [input, projectMembers(input, target.members.slice(fallback.memberDepth))];
      });
      const values = [origin, value, ...defaults];
      // Unsupported selection retains supplied and fallback member paths,
      // without borrowing nominal authority from either alternative.
      const unknown = new UncertainValue(new SequenceValue(values, values.flatMap(value => value.trace)),
        "unsupported binding pattern obscures the capability origin");
      this.observe("onUnsupported", unknown, target.token, module);
      return unknown;
    }
    if (target.defaults.length === 0) return value;
    if (value instanceof LiteralValue && value.value !== undefined) return value;
    if (!(value instanceof LiteralValue || value instanceof UnknownValue || value instanceof OperationValue)) return value;
    const defaults = target.defaults.map(fallback => this.value(module, fallback.tokens, environment));
    if (value instanceof LiteralValue) return defaults.at(-1);
    return uncertainOrigins([value, ...defaults], "parameter default has no single static value");
  }

  invocationContract(value) {
    const key = value.declaration.token;
    if (!this.invocationContracts.has(key)) {
      // Cyclic heritage/helpers remain unsupported; a later lookup cannot turn
      // an incomplete recursive proof into an unchecked constructor contract.
      this.invocationContracts.set(key, null);
      this.invocationContracts.set(key, InvocationClassContract.inspect(value, this));
    }
    return this.invocationContracts.get(key);
  }

  invocationBaseContract(value) {
    const key = value.declaration.token;
    if (!this.invocationBaseContracts.has(key)) {
      this.invocationBaseContracts.set(key, null);
      this.invocationBaseContracts.set(key, InvocationClassContract.inspectBase(value, this));
    }
    return this.invocationBaseContracts.get(key);
  }

  invocationType(value) {
    return value instanceof ClassValue && (this.invocationContract(value) !== null || this.invocationBaseContract(value) !== null);
  }

  bindArguments(module, parameters, args, environment) {
    parameters.forEach((parameter, index) => {
      for (const target of bindingTargets(parameter)) {
        const binding = module.bindingAt(target.token);
        if (binding) {
          const value = this.project(module, target, args[index] ?? new LiteralValue(undefined), environment);
          environment.set(binding, value);
          this.constantValues.invalidate(environment);
        }
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

  closedSpread(value) {
    return value instanceof InvocationOptionsValue || value instanceof ObjectValue && new SourceObjectMembers(value.tokens).complete;
  }

  objectMember(receiver, name) {
    return this.memberProjections.read(new SourceObjectProjection(receiver, name, this), this);
  }

  readMember(receiver, name, token, module, environment) {
    this.observe("onMember", receiver, name, token, module, false);
    return this.member(receiver, name, token, module, environment);
  }

  member(receiver, name, token, module, environment) {
    if (receiver instanceof BuiltinValue) {
      if (["globalThis", "global"].includes(receiver.builtin) && ["process", "console", "Object", "String", "BigInt", "Reflect", "URL"].includes(name)) return new BuiltinValue(name, [], receiver.trace);
      const result = new BuiltinValue(receiver.builtin, [...receiver.members, name], receiver.trace);
      if ((receiver.builtin === "process" || receiver.builtin === "os") && platformMembers.has(name)) return new PlatformValue(result);
      if (authorityMembers.has(name) && ["process", "os"].includes(receiver.builtin)) return new AuthorityValue(result);
      if (receiver.builtin === "path" && ["posix", "win32"].includes(name)) return result;
      if (receiver.builtin === "os" && name === "devNull") return new DevNullValue(result);
      return result;
    }
    if (receiver instanceof NamespaceValue) return this.exported(receiver.file, name, receiver.trace);
    if (receiver instanceof UncertainValue) return uncertainOrigins(receiver.origin.values.map(value =>
      this.member(value, name, token, module, environment)), receiver.reason);
    if (receiver instanceof ObjectValue) return this.objectMember(receiver, name) ?? new UnknownValue();
    if (receiver instanceof InvocationInstanceValue) {
      if (name === "processOptions") {
        const index = module.tokens.indexOf(token);
        const reference = module.tokens[index - 1]?.value === "." ? module.tokens[index - 2] : null;
        return new InvocationOptionsMethodValue(receiver, reference?.kind === "identifier" ? module.bindingAt(reference) : null);
      }
      if (["executable", "args", "cwd", "env", "stdio"].includes(name)) {
        const value = receiver.input instanceof ObjectValue ? this.objectMember(receiver.input, name) : new UnknownValue();
        if (value !== null && !(value instanceof LiteralValue && value.value === undefined)) return value;
        return name === "args" ? new SequenceValue([], receiver.trace)
          : ["cwd", "env"].includes(name) ? new LiteralValue(null, receiver.trace)
            : name === "stdio" ? new LiteralValue("pipe", receiver.trace) : new UnknownValue();
      }
    }
    if (receiver.constructor === SequenceValue && /^(?:0|[1-9][0-9]*)$/.test(name)) {
      const index = Number(name);
      if (Number.isSafeInteger(index)) return receiver.values[index] ?? new UnknownValue();
    }
    if (receiver instanceof ClassValue) {
      return this.memberProjections.read(new SourceClassProjection(receiver, name, token, module, environment, this), this);
    }
    if (receiver instanceof PrimitiveConversionValue) return name === "toString"
      ? new RetainedStringMethodValue(receiver) : new UnknownValue("primitive conversion member is unresolved", receiver.sensitive, receiver.trace);
    if ((receiver instanceof StatValue || receiver instanceof StatfsValue) && (authorityMembers.has(name) || name === "type")) return new AuthorityValue(receiver, name);
    if (receiver instanceof UserInfoValue && authorityMembers.has(name)) return new AuthorityValue(receiver, name);
    if (receiver instanceof FileUrlValue && name === "pathname") return new UrlPathnameValue(receiver);
    if (receiver instanceof PlatformValue || receiver instanceof UrlPathnameValue || receiver instanceof FileUrlValue || receiver instanceof NativePathValue || receiver instanceof TaggedTemplateValue || receiver instanceof TransformedStringValue) return new RetainedStringMethodValue(receiver);
    if (receiver instanceof FileDescriptorValue) return new DescriptorMethodValue(receiver, name);
    if (receiver instanceof ChildProcessValue) return new ChildMethodValue(receiver, name);
    if (receiver instanceof WindowsPathValue || receiver instanceof PosixPathValue) return receiver;
    if (receiver instanceof LiteralValue && ["split", "join", "replace", "replaceAll", "trim", "toString"].includes(name)) return new StringMethodValue(receiver, name);
    if (receiver instanceof SequenceValue && name === "join") return new JoinMethodValue(receiver);
    if (receiver instanceof OperationValue) return new UnknownValue("unresolved operator member origin", receiver.sensitive, receiver.trace);
    if ((receiver instanceof ComposedPathValue || receiver instanceof TemplateValue || receiver instanceof ConcatenationValue)
      && hasOsSensitiveOrigin(receiver)) return new UnresolvedCompositionValue(receiver);
    return receiver instanceof UnknownValue ? receiver : new UnknownValue();
  }

  invoke(callee, args, token, module, environment, constructed = false, receiver = null) {
    if (callee instanceof CommonJsModuleValue) return this.invoke(this.exported(callee.file, "default", callee.trace), args, token, module, environment, constructed);
    this.observe("onCall", callee, args, token, module, environment, constructed);
    if (receiver instanceof UncertainValue) {
      const unknown = new UnknownValue("method receiver has no single inspected value", true, receiver.trace);
      this.observe("onUnsupported", unknown, token, module);
      return unknown;
    }
    if (callee instanceof UncertainValue) {
      // Do not discard known callable bodies or builtin consumers because the
      // selection is unresolved. Preserve the original unknown alternatives,
      // and never combine returned nominal values into a proven capability.
      const results = callee.origin.values.map(value => this.invoke(value, args, token, module, environment, constructed, receiver));
      return uncertainOrigins([callee, ...results], "callable selection has no single inspected result");
    }
    if (callee instanceof UnresolvedCompositionValue) return callee;
    if (callee instanceof ClassValue) {
      const contract = this.invocationContract(callee);
      return contract === null ? new ClassValue(callee.module, callee.declaration, true, callee.trace, args, callee.environment)
        : new InvocationInstanceValue(callee, args, contract);
    }
    if (callee instanceof InvocationOptionsMethodValue) {
      const fields = ["cwd", "env", "stdio"].map(name => [name, this.member(callee.owner, name, token, module, environment)])
        .filter(([, value]) => !(value instanceof LiteralValue && value.value === null));
      return new InvocationOptionsValue(callee, fields);
    }
    if (callee instanceof CallableValue) {
      if (!this.deepCalls) return new UnknownValue();
      const key = `${callee.module.file}:${callee.declaration.token.offset}`;
      if (this.activeCalls.has(key)) return new UnknownValue("recursive helper result", args.some((arg) => arg.sensitive), callee.trace);
      this.activeCalls.add(key);
      const previousRoute = this.route;
      const previousCallers = this.callers;
      this.route = [...new Set([...previousRoute, module.file, ...callee.trace])];
      this.callers = [...previousCallers, new SourceCallLocation(module, token)];
      try {
        const local = new SourceInvocationEnvironment(callee.module, callee.declaration, callee.environment, receiver);
        const parameters = readParameters(callee.declaration.tokens);
        this.bindArguments(callee.module, parameters, args, local);
        const route = this.selectCallRoute(callee);
        const body = callee.declaration.bodyTokens();
        const scanned = this.scanHelpers ? this.scan(callee.module, route?.tokens ?? body ?? [], local) : null;
        if (route) return route.terminal === "return" ? this.returnedValue(callee.module, route.result, local, scanned)
          : new UnknownValue("helper has no proven returned value", true, callee.trace);
        const returns = callee.declaration.returns();
        if (returns.length === 1) {
          const result = this.returnedValue(callee.module, returns[0].tokens, local, scanned);
          result.trace = [...new Set([...callee.trace, ...result.trace])];
          const captured = [...callee.environment.values()].filter(value => value.sensitive);
          if (result instanceof UnknownValue && !result.sensitive && captured.length > 0) {
            const unresolved = uncertainOrigins([result, ...captured], "helper return has no inspected captured capability result");
            this.observe("onUnsupported", unresolved, returns[0].token, callee.module);
            return unresolved;
          }
          return result;
        }
        const expressionBody = callee.declaration.expressionBodyTokens();
        if (expressionBody !== null) return this.returnedValue(callee.module, expressionBody, local, scanned);
        const synchronous = !callee.declaration.prefix.some(token => token.value === "async" || token.value === "*")
          && !(callee.declaration.tokens[0]?.value === "async" && callee.declaration.tokens[1]?.value !== "=>")
          && !callee.declaration.tokens.slice(0, 2).some(token => token.kind === "punctuation" && token.value === "*");
        // The body was inspected above. Without a return, normal synchronous
        // completion yields undefined; sensitive arguments are not a result.
        if (returns.length === 0 && synchronous && this.scanHelpers && body !== null) {
          return new LiteralValue(undefined, callee.trace);
        }
        const alternatives = returns.map((entry) => this.returnedValue(callee.module, entry.tokens, local, scanned));
        return uncertainOrigins([...alternatives, ...args.filter((arg) => arg.sensitive)], "helper has no single static result");
      } finally { this.activeCalls.delete(key); this.route = previousRoute; this.callers = previousCallers; }
    }
    if (callee instanceof DerivedValue) {
      if (callee instanceof RetainedStringMethodValue) return new TransformedStringValue(callee.origin);
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
    if (callee.builtin === "BigInt" && member === undefined) return new PrimitiveConversionValue(args[0] ?? new UnknownValue());
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

  returnedValue(module, tokens, environment, scanned) {
    return scanned?.read(module, tokens, environment, this)
      ?? this.value(module, tokens, environment);
  }

  value(module, expression, environment = emptyEnvironment) {
    const leaf = expression.length === 1 ? expression[0] : null;
    const binding = leaf?.kind === "identifier" ? module.bindingAt(leaf) : null;
    const recalled = this.recalledOrigin(module, binding, environment);
    if (recalled !== null) return recalled;
    // An unwritten input is its projected argument, or an unknown runtime
    // value when no argument/default origin is available. Neither read emits
    // observations; writes/defaults and all consumers still evaluate normally.
    const unwritten = this.unwrittenInput(module, binding, environment);
    if (unwritten !== null) return unwritten;
    const declared = this.unwrittenModuleDeclaration(module, leaf, binding, environment);
    if (declared !== null) return declared;
    const inputObject = environment instanceof SourceInvocationEnvironment
      ? environment.readOrigin(expression[0], this.evaluationMode) : null;
    if (inputObject instanceof InputObjectOrigin && inputObject.hasExpression(module, expression)) return inputObject.copy();
    const cacheable = !this.observing && this.deepCalls && environment.size === 0 && this.activeBindings.size === 0 && this.activeExports.size === 0 && this.activeCalls.size === 0;
    if (!this.values.has(module)) this.values.set(module, new Map());
    const cache = this.values.get(module);
    const key = `${expression[0]?.offset}:${expression.at(-1)?.offset}`;
    if (cacheable && cache.has(key)) return cache.get(key);
    const constantKey = `${this.evaluationMode}:${key}`;
    const imported = binding && !environment.has(binding) && module.bindingWrites([binding]).length === 0
      && this.importReference(module, leaf, binding);
    // Empty object syntax has no captured fields or initializers. Its cached
    // metadata is context-free; reads create a fresh object in the current
    // environment. Other aggregates and all observed consumers still evaluate.
    const constantEnvironment = EmptyObjectValue.matches(expression) || RegexLiteralValue.matches(expression) || leaf && (["string", "number"].includes(leaf.kind)
      || !binding && literalKeywordValues.has(leaf.value) || imported) ? emptyEnvironment : environment;
    const remembered = this.constantValues.read(constantEnvironment, module, constantKey, environment);
    if (remembered) return remembered;
    const observations = this.observations;
    let value = this.intrinsicExpressions.value(module, expression, environment, this);
    if (value === null) {
      this.consumeWork(module, expression[0]);
      value = this.expression(module, expression, environment);
    }
    if ((value instanceof LiteralValue || value instanceof RegexLiteralValue || value instanceof BuiltinValue || value instanceof EmptyObjectValue) && observations === this.observations) {
      this.constantValues.remember(constantEnvironment, module, constantKey, value);
    }
    if (observations === this.observations && InputObjectOrigin.matches(value)) {
      const origin = new InputObjectOrigin(value);
      if (origin.environment === environment && origin.hasExpression(module, expression)) {
        environment.rememberOrigin(expression[0], this.evaluationMode, origin);
      }
    }
    if (cacheable) cache.set(key, value);
    this.scanning?.rememberEvaluation(module, expression, environment, this, value);
    return value;
  }

  consumeWork(module, token) {
    const count = (this.evaluations.get(module.file) ?? 0) + 1;
    this.evaluations.set(module.file, count);
    if (count > maximumModuleEvaluations || ++this.work > maximumModuleEvaluations) throw new SourceEvaluationLimit(module, token, this.callers);
  }

  template(module, token, environment, raw = false) {
    const chunk = (index) => raw ? token.chunks[index]?.raw ?? "" : token.chunks[index]?.value ?? "";
    let text = chunk(0);
    const values = [];
    for (let index = 0; index < token.interpolations.length; index++) {
      const part = this.value(module, token.interpolations[index].tokens, environment);
      values.push(part);
      text += (part instanceof LiteralValue ? String(part.value) : "<dynamic>") + chunk(index + 1);
    }
    return values.every((item) => item instanceof LiteralValue) ? new LiteralValue(text, [module.file])
      : new TemplateValue(new SequenceValue(values, [module.file, ...values.flatMap((value) => value.trace)]), text);
  }

  expression(module, expression, environment) {
    const tokens = strip(expression);
    if (!tokens.length) return new UnknownValue();
    const token = tokens[0];
    if (tokens.length === 1 && token.kind === "string") return new LiteralValue(token.value, [module.file]);
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] instanceof SourceTemplateToken) { index = templateEnd(tokens, index); continue; }
      if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) { index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]); continue; }
      if (tokens[index].value !== "?" || tokens[index + 1]?.value === "." || tokens[index + 1]?.value === "?") continue;
      let depth = 0;
      for (let end = index + 1; end < tokens.length; end++) {
        if (tokens[end].kind === "punctuation" && ["(", "[", "{"].includes(tokens[end].value)) { end = matching(tokens, end, tokens[end].value, { "(": ")", "[": "]", "{": "}" }[tokens[end].value]); continue; }
        if (tokens[end].value === "?") depth++;
        if (tokens[end].value !== ":" || depth-- !== 0) continue;
        this.observe("onSelection", this.value(module, tokens.slice(0, index), environment), tokens[0], module);
        return uncertainOrigins([
          this.value(module, tokens.slice(index + 1, end), environment),
          this.value(module, tokens.slice(end + 1), environment),
        ], "conditional helper capability origin cannot be proven");
      }
    }
    let arrow = -1;
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] instanceof SourceTemplateToken) index = templateEnd(tokens, index);
      else if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]);
      else if (tokens[index].value === "=>") { arrow = index; break; }
    }
    const primary = SourceBodyPrimary.read(tokens);
    if (primary === null && arrow >= 0 && (tokens[0].value === "(" || tokens[0].kind === "identifier")) {
      return new CallableValue(module, new SourceDeclaration(`<helper:${token.offset}>`, tokens), environment, [module.file]);
    }
    // Evaluate concatenation before postfix expressions, without interpreting operators.
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index] instanceof SourceTemplateToken) { index = templateEnd(tokens, index); continue; }
      if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) { index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]); continue; }
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
    let value; let cursor = 1; let constructed = false; let receiver = null;
    if (primary !== null) {
      // The primary's exact body is shared with binding discovery and scanning.
      // All following calls/members retain the existing invocation evaluator.
      value = primary.declaration.token.value === "function"
        ? new CallableValue(module, primary.declaration, environment, [module.file])
        : this.classValue(module, primary.declaration, environment);
      cursor = primary.endIndex + 1;
    } else if (token.kind === "identifier" && token.value === "new") { constructed = true; value = this.identifier(module, tokens[1], environment); cursor = 2; }
    else if (token.kind === "string") value = new LiteralValue(token.value, [module.file]);
    else if (token.kind === "number") value = new LiteralValue(Number(token.value.replaceAll("_", "")), [module.file]);
    else if (token.value === "<template>" && token.chunks) {
      value = this.template(module, token, environment);
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
          if (!this.closedSpread(spread)) {
            if (!(spread instanceof ObjectValue)) this.observe("onMember", spread, null, part[0], module, true);
            if (spread instanceof ObjectValue || !spread.sensitive) this.observe("onUnsupported", new UnknownValue("object spread has no inspected data members", true, spread.trace), part[0], module);
          }
          return [spread];
        }
        const colon = part.findIndex((item) => item.value === ":");
        return colon < 0 ? part.length === 1 ? [this.value(module, part, environment)] : [] : [this.value(module, part.slice(colon + 1), environment)];
      });
      value = end === 1 ? new EmptyObjectValue(module, tokens.slice(0, end + 1), environment, [module.file])
        : new ObjectValue(module, tokens.slice(0, end + 1), environment, [module.file], values);
      cursor = end + 1;
    } else if (token.value === "(") {
      const end = matching(tokens, 0, "(", ")"); value = this.value(module, tokens.slice(1, end), environment); cursor = end + 1;
    } else if (token.value === "import" && tokens[1]?.value === "(") {
      if (!loaded) return new UnknownValue("computed dynamic loading", true, [module.file]);
      value = this.referenceValue(module, loaded);
      cursor = matching(tokens, 1, "(", ")") + 1;
    } else if (loaded?.kind === "require") {
      value = this.referenceValue(module, loaded);
      cursor = matching(tokens, 1, "(", ")") + 1;
    } else if (RegexLiteralValue.matches([token])) value = new RegexLiteralValue(token, [module.file]);
    else if (token.kind === "identifier") value = this.identifier(module, token, environment);
    else return new UnknownValue();
    while (cursor < tokens.length) {
      const optionalEnd = optionalAccessEnd(tokens, cursor);
      if (optionalEnd !== cursor) {
        // Named members still consume their dot below. Calls and computed
        // members continue directly at their existing argument/key reader.
        cursor = tokens[optionalEnd]?.kind === "identifier" ? optionalEnd - 1 : optionalEnd;
      }
      if (tokens[cursor].value === "." && tokens[cursor + 1]?.kind === "identifier") {
        const member = tokens[cursor + 1];
        const owner = value;
        value = this.readMember(value, member.value, member, module, environment);
        receiver = owner instanceof ClassValue || owner instanceof ObjectValue || owner instanceof UncertainValue ? owner : null;
        cursor += 2;
      } else if (tokens[cursor] instanceof SourceTemplateToken) {
        const template = tokens[cursor];
        if (value instanceof BuiltinValue && value.builtin === "String" && value.member === "raw") {
          value = this.template(module, template, environment, true);
        } else {
          const cooked = this.template(module, template, environment);
          const raw = this.template(module, template, environment, true);
          value = new TaggedTemplateValue(new SequenceValue([cooked, raw], [...value.trace, ...cooked.trace, ...raw.trace]));
        }
        cursor = templateEnd(tokens, cursor) + 1;
      } else if (tokens[cursor].value === "[") {
        const end = matching(tokens, cursor, "[", "]");
        const key = this.value(module, tokens.slice(cursor + 1, end), environment);
        if (key instanceof LiteralValue && ["string", "number"].includes(typeof key.value)
          && (value instanceof ObjectValue || value.constructor === SequenceValue)) {
          const name = String(key.value);
          value = this.readMember(value, name, tokens[cursor], module, environment);
          cursor = end + 1;
          continue;
        }
        if (key instanceof PlatformValue) this.observe("onUnsupported", new UnknownValue("computed platform dispatch has no inspected implementation paths", true, key.trace), tokens[cursor], module);
        this.observe("onMember", value, null, tokens[cursor], module, true);
        value = new UnknownValue("computed capability access", value.sensitive, value.trace); cursor = end + 1;
      } else if (tokens[cursor].value === "(") {
        const end = matching(tokens, cursor, "(", ")");
        const args = readCommaSeparated(tokens, cursor + 1, end).map((part) => this.value(module, part, environment));
        value = this.invoke(value, args, token, module, environment, constructed, receiver);
        cursor = end + 1; constructed = false; receiver = null;
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
    const scanned = tokens.length > 0 && (environment === emptyEnvironment || environment instanceof SourceInvocationEnvironment)
      ? new SourceBodyScan(module, tokens, environment, this) : null;
    const previous = this.scanning;
    this.scanning = scanned;
    try {
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== "identifier" || [".", "?"].includes(tokens[index - 1]?.value)) continue;
        const primary = ["function", "class"].includes(token.value) ? SourceBodyPrimary.read(tokens, index) : null;
        let start = index;
        if (primary !== null) {
          // A declaration alone grants no invocation. A primary's actual
          // postfix use must still be inspected when its result is discarded.
          if (![".", "[", "(", "?"].includes(tokens[primary.endIndex + 1]?.value)) continue;
          if (tokens[index - 1]?.kind === "identifier" && tokens[index - 1].value === "async") start--;
        } else {
          if (token.kind !== "identifier" || [".", "?"].includes(tokens[index - 1]?.value)
            || ["import", "export", "from", "const", "let", "var", "function", "class", "return", "if", "switch", "while", "for", "catch"].includes(token.value)) continue;
          if (tokens[index + 1]?.value === "(" && tokens[matching(tokens, index + 1, "(", ")") + 1]?.value === "{") continue;
          if (![".", "[", "(", "?"].includes(tokens[index + 1]?.value)) continue;
          if (sensitiveOnly && !this.identifier(module, token, environment).sensitive) continue;
        }
        const end = this.expressionEnd(module, tokens, start);
        const expression = tokens.slice(start, end);
        if (scanned?.evaluated(module, expression, environment, this)) continue;
        const value = this.value(module, expression, environment);
        scanned?.remember(expression, value, this);
      }
    } finally { this.scanning = previous; }
    return scanned;
  }
}

/** OS policy owns capability use; lexical reading and module resolution stay shared. */
export class OsIndependenceRules {
  constructor(graph, diagnose) {
    Object.assign(this, { graph, diagnose });
    this.origins = new OsSourceOrigins(graph, diagnose);
    this.platformModules = new WeakMap();
    this.origins.onCall = (...args) => this.call(...args);
    this.origins.onMember = (...args) => this.member(...args);
    this.origins.onUnsupported = (value, token, module) => {
      if (value.sensitive) this.incomplete(this.ruleFor(value), module, token, value, value.reason);
    };
    this.origins.onSelection = (value, token, module) => {
      if (!this.origins.observing && valueOrigins(value).some((origin) => origin instanceof PlatformValue)) this.platformSelection(module, token, value);
    };
  }
  incomplete(rule, module, token, value, message) {
    this.diagnose(rule, module.file, token, [...this.origins.route, module.file, ...value.trace], message, "incomplete");
  }
  violation(rule, module, token, value, message) {
    this.diagnose(rule, module.file, token, [...this.origins.route, module.file, ...value.trace], message);
  }
  platformExpression(module, tokens) {
    tokens = strip(tokens);
    // Ordinary input predicates do not require walking arbitrary helper bodies
    // to discover an OS selector. Resolve their lexical roots through the same
    // origin graph first; opaque selectors remain incomplete at their real use.
    const scan = this.origins.scanHelpers;
    let candidate = false;
    this.origins.scanHelpers = false;
    try {
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== "identifier" || tokens[index - 1]?.value === ".") continue;
        const value = this.origins.identifier(module, token);
        if (valueOrigins(value).some((origin) => origin instanceof PlatformValue || origin instanceof BuiltinValue && ["process", "os"].includes(origin.builtin))) { candidate = true; break; }
      }
    } finally { this.origins.scanHelpers = scan; }
    if (!candidate && !(tokens.length === 1 && (tokens[0].kind === "string" || tokens[0].kind === "number" || ["true", "false", "null", "undefined"].includes(tokens[0].value)))) return new PlatformExpression(false, supportedPlatforms.map(() => null));
    // Split logical operators before using the shared value evaluator, whose
    // general provenance contract deliberately does not interpret precedence.
    for (const operator of ["||", "&&"]) {
      for (let index = 0; index < tokens.length - 1; index++) {
        if (tokens[index] instanceof SourceTemplateToken) { index = templateEnd(tokens, index); continue; }
        if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) { index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]); continue; }
        if (`${tokens[index].value}${tokens[index + 1].value}` !== operator) continue;
        const left = this.platformExpression(module, tokens.slice(0, index));
        const right = this.platformExpression(module, tokens.slice(index + 2));
        return new PlatformExpression(left.dependent || right.dependent, supportedPlatforms.map((platform) => {
          const a = left.at(platform); const b = right.at(platform);
          if (operator === "&&" && a === false || operator === "||" && a === true) return a;
          return a === null || b === null ? null : operator === "&&" ? Boolean(a && b) : Boolean(a || b);
        }));
      }
    }
    const interpret = (value) => {
      if (value instanceof LiteralValue) return new PlatformExpression(false, supportedPlatforms.map(() => value.value ?? null));
      if (value instanceof PlatformValue) {
        const member = value.origin.member;
        const values = member === "platform" ? supportedPlatforms : member === "type" ? ["Linux", "Darwin", "Windows_NT"] : supportedPlatforms.map(() => null);
        return new PlatformExpression(true, [...values]);
      }
      if (value instanceof OperationValue) {
        const operands = value.values.map(interpret);
        const dependent = operands.some((operand) => operand.dependent);
        return new PlatformExpression(dependent, supportedPlatforms.map((platform) => {
          const [a, b] = operands.map((operand) => operand.at(platform));
          if (a === null || value.operator !== "!" && b === null) return null;
          if (value.operator === "!") return !a;
          if (["===", "=="].includes(value.operator)) return a === b;
          if (["!==", "!="].includes(value.operator)) return a !== b;
          return null;
        }));
      }
      return new PlatformExpression(valueOrigins(value).some((origin) => origin instanceof PlatformValue), supportedPlatforms.map(() => null));
    };
    const scanHelpers = this.origins.scanHelpers;
    this.origins.scanHelpers = false;
    try { return interpret(this.origins.value(module, tokens)); }
    finally { this.origins.scanHelpers = scanHelpers; }
  }
  platformSignature(module, route) {
    const effects = new Map();
    const delegations = new Set();
    const typedDeclarations = new Set();
    let unknown = false;
    const previous = [this.origins.onCall, this.origins.selectCallRoute];
    this.origins.selectCallRoute = (callee) => {
      const boundary = this.indexPlatforms(callee.module).forDeclaration(callee.declaration);
      return boundary?.modeled ? boundary.routes.find((entry) => entry.platform === route.platform) : null;
    };
    this.origins.onCall = (callee, args, token, owner) => {
      const index = owner.tokens.indexOf(token);
      if (["Error", "TypeError", "RangeError"].includes(token.value) && owner.isUnbound(token.value, token)
        && owner.tokens[index - 1]?.value === "new" && owner.tokens[index - 2]?.value === "throw") return;
      if (callee instanceof BuiltinValue) {
        if (["fs", "fs/promises", "child_process"].includes(callee.builtin) || callee.builtin === "process" && callee.member === "kill") {
          if (callee.builtin === "child_process" && this.typedBoundary(owner, token) === true) {
            for (const declaration of namedFunctions(owner)) {
              if (declaration.token.offset <= token.offset && declaration.tokens.at(-1).offset >= token.offset) typedDeclarations.add(`${owner.file}:${declaration.token.offset}`);
            }
          }
          const flags = args.flatMap((arg) => valueOrigins(arg)).filter((arg) => arg instanceof BuiltinValue && osFlags.has(arg.member) && arg.member !== "UV_FS_O_FILEMAP").map((arg) => arg.member).sort();
          const mode = ["fs", "fs/promises"].includes(callee.builtin) && ["open", "openSync"].includes(callee.member) ? args[1]
            : callee.builtin === "process" && callee.member === "kill" ? signalArgument(args) : null;
          const knownArgument = (value) => value instanceof LiteralValue ? JSON.stringify(value.value) : value instanceof BuiltinValue ? value.identity : "unresolved";
          let contract = mode ? knownArgument(mode) : "";
          if (mode instanceof OperationValue) {
            const values = valueOrigins(mode).filter((value) => !(mode.operator === "|" && ["fs", "fs/promises"].includes(callee.builtin) && value instanceof BuiltinValue && value.member === "UV_FS_O_FILEMAP"));
            const operands = values.map(knownArgument).sort();
            contract = operands.length === 1 && mode.operator === "|" ? operands[0] : `${mode.operator}:${operands.join("|")}`;
          }
          effects.set(`${owner.file}:${token.offset}`, `${callee.identity}:${flags.join("|")}:${contract}`);
        } else if (!["console", "Object", "String", "path", "os", "url", "URL"].includes(callee.builtin)) unknown = true;
      } else if (callee instanceof CallableValue) delegations.add(callee);
      else if (callee instanceof UnknownValue || callee instanceof ModuleLoaderValue) unknown = true;
    };
    let result;
    try {
      this.origins.scan(module, route.tokens);
      result = route.terminal === "return" ? this.origins.value(module, route.result) : null;
    } finally { [this.origins.onCall, this.origins.selectCallRoute] = previous; }
    for (const callee of delegations) {
      if (!(callee.declaration.bodyTokens() ?? []).some((token) => ["throw", "if", "switch", "for", "while", "try"].includes(token.value))) continue;
      const boundary = this.indexPlatforms(callee.module).forDeclaration(callee.declaration);
      if (!typedDeclarations.has(`${callee.module.file}:${callee.declaration.token.offset}`)
        && !(boundary?.dependent && this.resolvePlatform(callee.module, boundary) === null)) unknown = true;
    }
    if (unknown) return "unknown";
    const resultKind = result instanceof LiteralValue ? `literal:${typeof result.value}:${[false, null, undefined].includes(result.value) ? String(result.value) : "value"}` : "result";
    if (effects.size) return `${[...effects.values()].join(",")};${route.terminal === "return" ? resultKind : "void"}`;
    if (result instanceof ClassValue && result.instance && this.invocationClass(result)) return "typed invocation";
    if (result instanceof OperationValue) {
      if (!result.booleanResult) return "unknown";
      const constant = result.constantBoolean;
      if (constant === false) return "empty";
      return constant === null && result.values.every((value) => value instanceof LiteralValue) ? "unknown" : "literal:boolean";
    }
    if (result instanceof LiteralValue && result.value != null && result.value !== false) return `literal:${typeof result.value}`;
    return result instanceof UnknownValue && route.result.length ? "unknown" : "empty";
  }
  indexPlatforms(module) {
    if (this.platformModules.has(module)) return this.platformModules.get(module);
    const index = new PlatformModuleBoundaries();
    this.platformModules.set(module, index);
    const previous = [this.origins.onCall, this.origins.onMember, this.origins.onUnsupported, this.origins.deepCalls];
    const observing = this.origins.observing;
    this.origins.observing = true;
    this.origins.onCall = this.origins.onMember = this.origins.onUnsupported = () => {};
    try {
      const declarations = [...namedFunctions(module)];
      const names = new Map(declarations.map((declaration) => [declaration.token.offset, declaration.name]));
      for (const name of module.declarationNames()) {
        const header = module.declarationHeader(name);
        if (header.token.value === "class") {
          const members = module.classMembers(name);
          declarations.push(...members.instanceMembers.values(), ...members.staticMembers.values());
        } else if (["const", "let"].includes(header.token.value)) {
          // The existing binding index already bounds initializer expressions;
          // reading every full variable declaration is unnecessary here.
          const origins = this.origins.index(module).get(module.moduleBinding(name));
          for (const expression of origins?.expressions ?? []) {
            if (expression.tokens[0]?.value !== "function" && !expression.tokens.some((token) => token.kind === "punctuation" && token.value === "=>")) continue;
            const value = this.origins.value(module, expression.tokens);
            if (value instanceof CallableValue) {
              declarations.push(value.declaration);
              names.set(value.declaration.token.offset, name);
            }
          }
        }
      }
      // Class identity is lexical: nested classes can shadow a module class or
      // exist only inside a factory. Inspect those bodies under their own
      // all-platform boundary instead of inheriting an unrelated outer route.
      const declared = new Set(declarations.map((declaration) => declaration.token.offset));
      for (const origins of this.origins.index(module).values()) {
        for (const expression of origins.expressions) {
          if (expression.tokens[0]?.value !== "class") continue;
          const value = this.origins.value(module, expression.tokens);
          if (!(value instanceof ClassValue)) continue;
          const members = new SourceClassMembers(value.declaration);
          for (const declaration of [...members.instanceMembers.values(), ...members.staticMembers.values()]) {
            if (declared.has(declaration.token.offset)) continue;
            declarations.push(declaration);
            declared.add(declaration.token.offset);
          }
        }
      }
      for (const declaration of declarations) {
        const boundary = new PlatformImplementationBoundary(declaration, (tokens) => this.platformExpression(module, tokens));
        index.boundaries.push(boundary);
        index.callers.set(boundary, new Map());
        const name = names.get(declaration.token.offset);
        if (!name) { index.public.add(boundary); continue; }
        const usage = module.originUsage([name], { moduleBindings: true, mutableAliases: true });
        const header = module.declarationHeader(name);
        usage.accept([module.tokens[module.tokens.indexOf(header.token) + 1]]);
        index.usages.set(boundary, usage);
        if (header.prefix.some((token) => token.value === "export") || module.exports.some((entry) => !entry.reference && usage.origins.has(entry.local))) index.public.add(boundary);
      }
      // Every declaration is registered before calls or guarantees are resolved.
      // Reuse the value evaluator for aliases, imports and callable identities;
      // the lexical origin index accounts for uses it cannot resolve as calls.
      this.origins.deepCalls = false;
      this.origins.onCall = (callee, args, token, owner) => {
        if (!(callee instanceof CallableValue)) return;
        const target = this.indexPlatforms(callee.module);
        const boundary = target.forDeclaration(callee.declaration);
        if (!boundary) return;
        target.callers.get(boundary).set(`${owner.file}:${token.offset}`, new SourceCallLocation(owner, token));
        if (owner === callee.module) target.usages.get(boundary)?.accept([token]);
      };
      if (index.usages.size) this.origins.scan(module);
      index.ready = true;
    } finally {
      [this.origins.onCall, this.origins.onMember, this.origins.onUnsupported, this.origins.deepCalls] = previous;
      this.origins.observing = observing;
    }
    return index;
  }
  resolvePlatform(module, boundary) {
    const index = this.indexPlatforms(module);
    if (index.resolutions.get(boundary) === "active") return "incomplete";
    if (index.resolutions.get(boundary) === "done") return boundary.classification;
    index.resolutions.set(boundary, "active");
    const context = this.boundaryContext(module, boundary, new Set());
    boundary.classify((route) => this.platformSignature(module, route), context.platforms, context.knownPlatforms);
    index.resolutions.set(boundary, "done");
    return boundary.classification;
  }
  boundaryContext(module, boundary, active) {
    const index = this.indexPlatforms(module);
    if (index.public.has(boundary)) return new PlatformCallContext([...supportedPlatforms]);
    if (!index.ready || active.has(boundary)) return new PlatformCallContext([...supportedPlatforms], true, []);
    if (index.contexts.has(boundary)) return index.contexts.get(boundary);
    this.origins.consumeWork(module, boundary.declaration.token);
    const callers = [...index.callers.get(boundary).values()];
    const unresolved = !callers.length || !index.usages.has(boundary) || index.usages.get(boundary).unresolved().length > 0;
    const contexts = unresolved ? [new PlatformCallContext([...supportedPlatforms], true, [])] : [];
    active.add(boundary);
    try { for (const caller of callers) contexts.push(this.platformContext(caller.module, caller.token, active)); }
    finally { active.delete(boundary); }
    const context = new PlatformCallContext([...new Set(contexts.flatMap((entry) => entry.platforms))], contexts.some((entry) => entry.uncertain), [...new Set(contexts.flatMap((entry) => entry.knownPlatforms))]);
    // A cyclic/opaque route is not a completed reachability result. Caching its
    // partial traversal would make a later caller depend on declaration order.
    if (!context.uncertain) index.contexts.set(boundary, context);
    return context;
  }
  platformContext(module, token, active = new Set()) {
    const boundary = this.indexPlatforms(module).at(token);
    if (!boundary) return new PlatformCallContext([...supportedPlatforms]);
    const context = this.boundaryContext(module, boundary, active);
    const routes = boundary.routesAt(token);
    // A declaration's token represents entry into its body, before its split.
    if (!boundary.modeled || token.offset === boundary.declaration.token.offset) return context;
    if (!routes.length) return new PlatformCallContext(context.platforms, true, []);
    const selected = routes.map((route) => route.platform);
    return new PlatformCallContext(context.platforms.filter((platform) => selected.includes(platform)), context.uncertain || routes.some((route) => route.unknown),
      context.knownPlatforms.filter((platform) => routes.some((route) => route.platform === platform && !route.unknown)));
  }
  capability(rule, module, token, value, platforms, message, classification = "violation") {
    let active = [...supportedPlatforms];
    let known = [...supportedPlatforms];
    let uncertain = false;
    for (const location of [...this.origins.callers, new SourceCallLocation(module, token)]) {
      const context = this.platformContext(location.module, location.token);
      active = active.filter((platform) => context.platforms.includes(platform));
      known = known.filter((platform) => context.knownPlatforms.includes(platform));
      uncertain ||= context.uncertain;
    }
    if (active.every((platform) => platforms.includes(platform))) return;
    if (classification === "incomplete" || uncertain && known.every((platform) => platforms.includes(platform))) this.incomplete(rule, module, token, value, `${message}; platform compatibility is unresolved`);
    else this.violation(rule, module, token, value, `${message}; required without an implementation on ${known.filter((platform) => !platforms.includes(platform)).join(", ")}`);
  }
  platformSelection(module, token, value) {
    const boundary = this.platformModules.get(module)?.at(token);
    if (boundary?.dependent && boundary.conditions.has(token.offset)) return;
    if (boundary) {
      this.incomplete("OS01", module, token, value, "platform selection expression has no inspected implementation path split");
      return;
    }
    this.violation("OS01", module, token, value, "platform implementation selection bypasses an inspected shared function boundary");
  }
  ruleFor(value) {
    if (value instanceof RetainedStringMethodValue || value instanceof TransformedStringValue) return valueOrigins(value.origin, false, true).some((origin) => origin instanceof UrlPathnameValue) ? "OS04" : "OS01";
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
    if ((computed || ["prototype", "constructor", "__proto__"].includes(name)) && this.origins.invocationType(receiver)) {
      this.incomplete("OS02", module, token, receiver, "invocation prototype or computed access escapes the closed option-method contract");
    }
  }
  call(callee, args, token, module, environment = emptyEnvironment) {
    if (callee instanceof OperationValue && callee.sensitive) this.incomplete(this.ruleFor(callee), module, token, callee, "operator result has no proven callable capability origin");
    if (callee instanceof UnknownValue && callee.sensitive) this.incomplete(this.ruleFor(callee), module, token, callee, callee.reason);
    if (callee instanceof BuiltinValue) {
      const name = callee.member;
      if (callee.builtin === "process" && name === "kill") this.signal(callee, args, token, module);
      if (callee.builtin === "vm" && name !== "isContext" || callee.builtin === "module" && !["createRequire", "isBuiltin"].includes(name)
        || callee.builtin === "process" && ["getBuiltinModule", "require"].includes(name)
        || ["globalThis", "global"].includes(callee.builtin) && ["eval", "Function"].includes(name)) this.incomplete("OS02", module, token, callee, "runtime module/code loading obscures the inspectable capability graph");
      if (callee.builtin === "child_process" && launchMethods.has(name)) this.launch(callee, args, token, module, environment);
      if ((callee.builtin === "Object" && !["freeze", "isFrozen", "seal", "isSealed", "preventExtensions", "isExtensible"].includes(name)
        || callee.builtin === "Reflect")
        && this.origins.invocationType(args[0])) this.incomplete("OS02", module, token, args[0], "invocation reflection escapes the closed option-method contract");
      if (["fs", "fs/promises"].includes(callee.builtin)) this.filesystem(callee, args, token, module);
      if (callee.builtin === "Reflect" && ["get", "apply", "construct"].includes(name) && args.some((arg) => arg.sensitive)) this.incomplete("OS02", module, token, callee, "reflective access obscures an OS-sensitive capability");
      if (callee.builtin === "path" && ["join", "resolve", "normalize"].includes(name) && args.flatMap((value) => valueOrigins(value, false, true)).some((arg) => arg instanceof UrlPathnameValue)) this.violation("OS04", module, token, callee, "file URL pathname is used as a native path without fileURLToPath");
      const inspectedConsumer = ["fs", "fs/promises", "child_process", "process", "os", "path", "url", "URL", "module", "vm", "console", "Reflect"].includes(callee.builtin)
        || callee.builtin === "Object" && ["freeze", "seal"].includes(name)
        || callee.builtin === "BigInt" && name === undefined && args.length === 1 && (
          args[0] instanceof LiteralValue || args[0] instanceof UnknownValue && !args[0].sensitive
          || args[0] instanceof AuthorityValue || args[0] instanceof PrimitiveConversionValue
          || args[0] instanceof BuiltinValue && args[0].builtin === "process" && args[0].member === "pid");
      if (!inspectedConsumer) for (const arg of args.filter((value) => value.sensitive)) this.incomplete(this.ruleFor(arg), module, token, arg, "unsupported builtin transform escapes an OS-sensitive capability");
    }
    if (callee instanceof ModuleLoaderValue) this.incomplete("OS02", module, token, callee, "created require function has an unsupported dynamic loading contract");
    if (callee instanceof DescriptorMethodValue && ["sync", "datasync"].includes(callee.details)) this.descriptorSync(callee.origin, token, module);
    if (callee instanceof ChildMethodValue && callee.details === "kill" && args.length > 0
      && (!(args[0] instanceof LiteralValue) || !["SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT"].includes(args[0].value))) this.incomplete("OS01", module, token, callee, "retained ChildProcess kill has no proven portable signal");
    if (!(callee instanceof CallableValue) && !(callee instanceof ClassValue) && !(callee instanceof BuiltinValue)
      && !(callee instanceof InvocationOptionsMethodValue || callee instanceof JoinMethodValue || callee instanceof StringMethodValue || callee instanceof RetainedStringMethodValue || callee instanceof ChildMethodValue || callee instanceof DescriptorMethodValue)) {
      for (const arg of args) {
        if (this.origins.invocationType(arg)) this.incomplete("OS02", module, token, arg, "invocation constructor or instance escapes to an uninspected consumer");
        else if (arg.sensitive) this.incomplete(this.ruleFor(arg), module, token, arg, "OS-sensitive capability escapes to an uninspected consumer");
      }
    }
  }
  property(value, name) {
    return value instanceof ObjectValue ? this.origins.member(value, name, value.tokens[0], value.module, value.environment) : new UnknownValue();
  }
  signal(callee, args, token, module) {
    const pid = args[0];
    const signal = signalArgument(args);
    const portableSignal = signal instanceof LiteralValue && [0, "SIGTERM", "SIGKILL", "SIGINT"].includes(signal.value);
    const positivePid = pid instanceof LiteralValue && Number.isInteger(pid.value) && pid.value > 0
      || pid instanceof BuiltinValue && pid.builtin === "process" && pid.member === "pid";
    if (positivePid && portableSignal) return;
    const groupPid = pid instanceof LiteralValue && Number.isInteger(pid.value) && pid.value <= 0
      || pid instanceof OperationValue && pid.operator === "-" && pid.values[0] instanceof LiteralValue && pid.values[0].value > 0;
    this.capability("OS01", module, token, callee, posixPlatforms, "PID/PGID or signal contract has no corresponding Windows implementation", groupPid ? "violation" : "incomplete");
  }
  launch(callee, args, token, module, environment = emptyEnvironment) {
    const options = args.find((value) => value instanceof ObjectValue);
    const invocation = this.constructedInvocationLaunch(module, token, environment, options);
    for (const property of ["uid", "gid"]) {
      if (options && readObjectProperty(options.tokens, property)) this.capability("OS03", module, token, callee, posixPlatforms, `process ${property} option requires a corresponding Windows authority implementation`);
    }
    if (invocation === null && options?.tokens.some((item, index, tokens) => item.value === "." && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === ".")) this.incomplete("OS02", module, token, callee, "spread launch options cannot prove shell and OS authority settings");
    if (this.property(options, "shell") instanceof LiteralValue && this.property(options, "shell").value === true) this.violation("OS02", module, token, callee, "shell:true bypasses the shell:false typed argv boundary");
    if (["exec", "execSync"].includes(callee.member)) this.violation("OS04", module, token, callee, "execution authority is reparsed from a shell command string");
    const command = args[0];
    if (command instanceof LiteralValue) {
      const executable = classifyExecutable(String(command.value));
      if (!(executable instanceof UnclassifiedExecutable)) this.capability("OS02", module, token, callee, executable.platforms, `required executable ${executable.identity} has no corresponding platform implementation`);
      if (executable instanceof UnclassifiedExecutable) this.incomplete("OS02", module, token, callee, `required executable portability is unclassified: ${executable.identity}`);
    }
    if (command instanceof ShellTextValue || args.some((value) => value instanceof ShellArgvValue)) this.violation("OS04", module, token, callee, "typed invocation was converted to shell text and reparsed");
    const nodeExecutable = command instanceof BuiltinValue && command.builtin === "process" && command.member === "execPath" ? "node"
      : command instanceof LiteralValue && typeof command.value === "string" ? command.value : "";
    const argv = args[1];
    const nodeArguments = argv?.constructor === SequenceValue ? argv.values.map((value) => value instanceof LiteralValue && typeof value.value === "string"
      ? new ExecutionArgument(value.value, false) : new ExecutionArgument("", true)) : [new ExecutionArgument("", true)];
    const nodeBoundary = NodeExecutionBoundary.inspect(nodeExecutable, nodeArguments);
    if (nodeBoundary?.status === "inline") this.incomplete("OS04", module, token, callee, "inline JavaScript execution has no inspected module boundary");
    else if (nodeBoundary?.status === "incomplete") this.incomplete("OS04", module, token, callee, `Node option boundary cannot be proven before the script entry (${nodeBoundary.option})`);
    const fixture = this.ownedFixture(module, token, callee, args);
    if (fixture === null) this.incomplete("OS02", module, token, callee, "test-owned launch has an unsupported cleanup or inline-code contract");
    else if (!fixture) {
      const boundary = invocation !== null || this.typedBoundary(module, token, environment);
      if (boundary === null) this.incomplete("OS02", module, token, callee, "apparent typed invocation boundary has an unsupported authority contract");
      else if (!boundary) this.violation("OS02", module, token, callee, "direct child_process launch bypasses the shared typed invocation boundary");
      else if (this.origins.callers.length > 0 && !(command instanceof LiteralValue)
        && !(command instanceof BuiltinValue && command.builtin === "process" && command.member === "execPath")) this.incomplete("OS02", module, token, callee, "typed launch executable identity is unresolved at an owned caller");
    }
  }
  constructedInvocationLaunch(module, token, environment = emptyEnvironment, capturedOptions = null) {
    let open = module.tokens.findIndex(item => item.offset === token.offset);
    while (open < module.tokens.length && module.tokens[open].value !== "(") open++;
    if (open === module.tokens.length) return null;
    const parts = readCommaSeparated(module.tokens, open + 1, matching(module.tokens, open, "(", ")"));
    const receiver = parts[0]?.[0];
    if (parts.length !== 3 || receiver?.kind !== "identifier"
      || !InvocationClassContract.matches(parts[0], `${receiver.value}.executable`)
      || !InvocationClassContract.matches(parts[1], `${receiver.value}.args`)) return null;
    // The ordinary expression evaluator already resolved the option spread at
    // this call. Reuse its nominal owner without evaluating the constructor's
    // complete argument/environment graph a second time.
    const captured = capturedOptions?.values.filter(value => value instanceof InvocationOptionsValue) ?? [];
    const binding = module.bindingAt(receiver);
    if (captured.length > 0 && (captured.length !== 1 || captured[0].binding !== binding)) return null;
    const instance = captured.length === 1 ? captured[0].owner : this.origins.identifier(module, receiver, environment);
    if (!(instance instanceof InvocationInstanceValue)) return null;
    const options = new SourceObjectMembers(parts[2]);
    if (!options.complete || options.entries.length !== 2) return null;
    const spreads = options.entries.filter(entry => entry instanceof SourceObjectSpread);
    const shell = options.entries.find(entry => !(entry instanceof SourceObjectSpread) && entry.token.value === "shell");
    if (spreads.length !== 1 || !shell || !shell.matches("false")
      || !InvocationClassContract.matches(spreads[0].tokens, `${receiver.value}.processOptions()`)) return null;
    // The three spellings must resolve to the SAME lexical binding; a matching
    // class name or a different instance's closed options confer no proof.
    const same = [parts[1][0], spreads[0].tokens[0]];
    if (!module.bindingAt(receiver) || same.some(reference => module.bindingAt(reference) !== module.bindingAt(receiver))) return null;
    return instance;
  }
  typedBoundary(module, token, environment = emptyEnvironment) {
    if (this.constructedInvocationLaunch(module, token, environment) !== null) return true;
    // A closed, deliberately narrow contract. Token words alone confer no authority.
    for (const declaration of namedFunctions(module)) {
      if (declaration.token.offset > token.offset || declaration.tokens.at(-1).offset < token.offset) continue;
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
    if (this.origins.invocationContract(value) !== null) return true;
    const declaration = value.declaration;
    if (declaration?.tokens[2]?.value !== "{") return false;
    const members = new SourceClassMembers(declaration);
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
    // Node documents UV_FS_O_FILEMAP as an ignored optimization elsewhere;
    // its presence establishes no stronger public filesystem guarantee.
    for (const flag of args.flatMap(flags)) this.capability("OS03", module, token, callee, flag === "UV_FS_O_FILEMAP" ? supportedPlatforms : posixPlatforms, `filesystem flag ${flag} has no corresponding platform guarantee`);
    for (const input of filesystemContract(callee)?.paths(args, (value, key) => this.property(value, key)) ?? []) this.filesystemPath(callee, input, token, module);
    if (/^(?:chmod|chown|fchmod|fchown|lchmod|lchown)/.test(name)) this.capability("OS03", module, token, callee, posixPlatforms, "UID/mode mutation requires a corresponding Windows authority implementation");
    if (/^(?:fsync|fdatasync)/.test(name)) {
      if (args[0] instanceof FileDescriptorValue) this.descriptorSync(args[0], token, module);
      else this.incomplete("OS03", module, token, callee, "fsync descriptor has no proven regular writable-file origin");
    }
  }
  filesystemPath(callee, input, token, module) {
    const pathOrigin = new SequenceValue([callee, input], [...callee.trace, ...input.trace]);
    const pathUse = pseudoPathUse(input);
    if (pathUse === "violation") {
      const texts = [pathText(input, posix), pathText(input, win32), input instanceof TemplateValue ? input.details : null].filter((text) => text !== null && pseudoPath.test(text));
      const platforms = texts.length ? texts.map((text) => /^\/(?:proc|sys)(?:\/|$)/.test(text) ? ["linux"] : text.startsWith("/dev") ? posixPlatforms : ["win32"])
        .reduce((common, selected) => common.filter((platform) => selected.includes(platform)), [...supportedPlatforms]) : [];
      this.capability("OS01", module, token, pathOrigin, platforms, "pseudo-filesystem or fixed OS path is used for I/O");
    }
    if (pathUse === "incomplete") this.incomplete("OS01", module, token, pathOrigin, "path composition retains an unresolved pseudo-filesystem or fixed OS origin");
    const origins = valueOrigins(input, false, true);
    if (pathUse !== "incomplete" && origins.some((value) => value instanceof TaggedTemplateValue)) this.incomplete("OS01", module, token, pathOrigin, "unsupported template tag has no proven filesystem path transformation");
    const unresolvedTransform = origins.some((value) => value instanceof TaggedTemplateValue || value instanceof UncertainValue || value instanceof UnresolvedCompositionValue || value instanceof TransformedStringValue || value instanceof RetainedStringMethodValue || value instanceof ConditionalFilesystemPathValue);
    if (origins.some((value) => value instanceof UrlPathnameValue)) {
      if (unresolvedTransform) this.incomplete("OS04", module, token, pathOrigin, "unsupported string transform retains file URL pathname provenance at native I/O");
      else this.violation("OS04", module, token, pathOrigin, "file URL pathname is used for native filesystem I/O");
    }
    if (origins.some((value) => value instanceof WindowsPathValue || value instanceof PosixPathValue)) {
      if (unresolvedTransform) this.incomplete("OS04", module, token, pathOrigin, "unsupported string transform retains logical path provenance at native I/O");
      else for (const origin of origins.filter((value) => value instanceof WindowsPathValue || value instanceof PosixPathValue)) {
        const text = origin.details.text;
        const rootedResolve = origin.origin.member !== "resolve" || origin.details.values.some((value) => {
          const part = pathText(value, origin.details.syntax);
          return part !== null && origin.details.syntax.isAbsolute(part);
        });
        const sharedText = text !== null && rootedResolve && !text.includes("\\") && !/^[A-Za-z]:|^\/\//.test(text);
        const platforms = sharedText ? supportedPlatforms : origin instanceof PosixPathValue ? posixPlatforms : ["win32"];
        this.capability("OS04", module, token, pathOrigin, platforms, "logical path has no compatible native interpretation on every selected platform", text === null || !rootedResolve ? "incomplete" : "violation");
      }
    }
    const unresolved = origins.find((value) => (value instanceof UnknownValue || value instanceof OperationValue) && value.sensitive);
    if (unresolved) this.incomplete("OS01", module, token, pathOrigin, unresolved.reason ?? "operator result has no proven filesystem path origin");
  }

  descriptorSync(descriptor, token, module) {
    const flags = descriptor.details?.[1];
    if (descriptor.origin.member.startsWith("opendir") || flags instanceof LiteralValue && flags.value === "r") this.capability("OS03", module, token, descriptor, posixPlatforms, "read-only/directory descriptor fsync requires a corresponding Windows guarantee");
    else if (!(flags instanceof LiteralValue) || !/^[wax]/.test(String(flags.value))) this.incomplete("OS03", module, token, descriptor, "descriptor origin does not prove a regular writable file for fsync");
  }
  inspect(module) {
    this.origins.constantValues = new ConstantEvaluationCache();
    this.origins.resetWork();
    const previous = [this.origins.onCall, this.origins.onMember, this.origins.onUnsupported, this.origins.observing];
    this.origins.observing = true;
    this.origins.onCall = this.origins.onMember = this.origins.onUnsupported = () => {};
    try {
      for (const boundary of this.indexPlatforms(module).boundaries) {
        this.resolvePlatform(module, boundary);
        if (boundary.dependent && boundary.classification) this.diagnose("OS01", module.file, boundary.declaration.token, [module.file], boundary.message, boundary.classification);
      }
    }
    catch (error) {
      reportOsInspectionFailure(this.diagnose, module, error, [module.file], "platform path inspection incomplete");
    } finally {
      [this.origins.onCall, this.origins.onMember, this.origins.onUnsupported, this.origins.observing] = previous;
    }
    // Each independently inspected source root gets a fresh finite work budget.
    // Work performed through an earlier caller must not suppress this module's rules.
    this.origins.resetWork();
    const tokens = module.tokens;
    this.origins.index(module);
    this.origins.deepCalls = false;
    try { this.origins.scan(module, tokens, emptyEnvironment, true); }
    finally { this.origins.deepCalls = true; }
    this.origins.resetWork();
    this.origins.scan(module);
    const bindingExpressions = new Set([...this.origins.index(module).values()].flatMap((origins) => origins.expressions.map((expression) => expression.tokens[0]?.offset)));
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index].value !== "=" || tokens[index - 1]?.value === "=" || tokens[index + 1]?.value === "="
        || tokens[index - 1]?.kind === "identifier" && tokens[index - 2]?.value !== ".") continue;
      if (bindingExpressions.has(tokens[index + 1]?.offset)) continue; // The shared binding projection owns declaration/destructuring validation.
      const value = this.origins.value(module, tokens.slice(index + 1, endOfExpression(tokens, index + 1)));
      if (value.sensitive) this.incomplete(this.ruleFor(value), module, tokens[index], value, "member/destructuring assignment escapes an OS-sensitive capability");
    }
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].value !== "switch" || tokens[index + 1]?.value !== "(") continue;
      const end = matching(tokens, index + 1, "(", ")");
      const value = this.origins.value(module, tokens.slice(index + 2, end));
      if (value instanceof PlatformValue) this.platformSelection(module, tokens[index + 2] ?? tokens[index], value);
      if (value instanceof AuthorityValue) this.capability("OS03", module, tokens[index], value, posixPlatforms, "UID/mode/filesystem magic selects an authority branch without a corresponding platform guarantee");
    }
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind !== "identifier" || [".", "import", "from", "as", "function", "class"].includes(tokens[index - 1]?.value)
        || ["const", "let", "var", "function", "class", "return", "if", "switch", "case", "while", "for", "catch", "throw", "export", "from"].includes(token.value)
        || tokens[index + 1]?.value === "=" && tokens[index + 2]?.value !== "=") continue;
      const value = this.origins.value(module, tokens.slice(index, this.origins.expressionEnd(module, tokens, index)));
      if (value instanceof UnknownValue && value.sensitive) this.incomplete("OS02", module, token, value, value.reason);
      const identities = valueOrigins(value);
      const platformPredicate = identities.some((origin) => origin instanceof PlatformValue) && value instanceof OperationValue && ["===", "==", "!==", "!=", "!"].includes(value.operator);
      if (value instanceof OperationValue && value.sensitive && !value.supported && !platformPredicate) this.incomplete("OS02", module, token, value, "unsupported operator obscures an OS-sensitive value");
      if (!identities.some((origin) => origin instanceof PlatformValue || origin instanceof AuthorityValue)) continue;
      let start = index;
      while (start > 0 && ![";", "{" , "}"].includes(tokens[start - 1].value)) start--;
      const end = this.origins.expressionEnd(module, tokens, index, new Set([";", "{"]));
      const statement = tokens.slice(start, end);
      const branch = statement.some((item, position) => ["if", "switch", "case"].includes(item.value)
        || item.value === "?" && statement[position + 1]?.value !== ".");
      if (identities.some((origin) => origin instanceof PlatformValue) && branch) this.platformSelection(module, token, value);
      if (identities.some((origin) => origin instanceof AuthorityValue) && branch) this.capability("OS03", module, token, value, posixPlatforms, "UID/mode/filesystem magic is used as authority without a corresponding platform guarantee");
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
