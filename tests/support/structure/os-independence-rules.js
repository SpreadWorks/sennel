import { SourceConditionalExpression, SourceOperator, immutableSourceTokens, SourceModule, SourceBodyPrimary, SourceArrayPrimary, SourceGroupPrimary, SourceForOf, SourceClassMembers, SourceClassFieldInitializer, SourceClassAccessor, SourceDeclaration, SourceInitializer, SourceInputBinding, SourceObjectMembers, SourceObjectCopies, SourceObjectSpread, SourceTemplateToken, SourceRegexToken, SourceMemberAccess, matching, optionalAccessEnd, readCommaSeparated, readMemberAccess, readAssignmentTarget, readObjectProperty, readParameters, readInvocations } from "./source-reader.js";
import { SourceMemberMutations } from "./source-member-mutations.js";
import { classifyExecutable, UnclassifiedExecutable, supportedPlatforms } from "./os-command-policy.js";
import { ExecutionArgument, NodeExecutionBoundary } from "./node-execution-boundary.js";
import { PlatformExpression, PlatformImplementationBoundary, SourceStatementRoutes } from "./os-platform-paths.js";
import { posix, win32 } from "node:path";
import { sourceBuiltin } from "./source-graph.js";
import { SourceNativePermissionContract } from "./source-native-permission-contract.js";

const sensitiveBuiltins = new Set(["fs", "fs/promises", "child_process", "process", "os", "path", "url", "module", "vm", "globalThis", "global"]);
const launchMethods = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const portableChildSignals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT"]);

/** Closed observations cannot replace the invocation's execution authority. */
class ProcessObservationOption {
  constructor(property) {
    if (!(property instanceof SourceInitializer)) throw new TypeError("source option initializer required");
    this.property = property;
  }
  get accepted() {
    const tokens = strip(this.property.tokens);
    const literal = tokens.length === 1 && tokens[0].kind === "string" ? tokens[0].value : null;
    switch (this.property.token.value) {
      case "encoding": return literal !== null && ["utf8", "utf-8", "ascii", "latin1", "binary", "base64", "base64url", "hex", "ucs2", "ucs-2", "utf16le", "utf-16le", "buffer"].includes(literal);
      case "killSignal": return portableChildSignals.has(literal);
      case "input": return literal !== null;
      case "timeout":
      case "maxBuffer": {
        // A literal product has no coercions, accessors or invocation effects.
        if (!tokens.length || tokens.length % 2 !== 1 || !tokens.every((token, index) => index % 2 === 0
          ? token.kind === "number" : token.value === "*")) return false;
        const value = tokens.filter((_, index) => index % 2 === 0).reduce((product, token) => product * Number(token.value.replaceAll("_", "")), 1);
        return Number.isSafeInteger(value) && (this.property.token.value === "maxBuffer" ? value > 0 : value >= 0);
      }
      default: return false;
    }
  }
}
class FilesystemCallContract {
  constructor(positions, patterns = false) {
    if (!Array.isArray(positions) || positions.some((position) => !Number.isInteger(position) || position < 0)) throw new TypeError("filesystem path positions required");
    Object.assign(this, { positions, patterns });
  }
  paths(args) {
    return this.positions.flatMap((position) => {
      const input = args[position];
      if (this.patterns && input instanceof SourceArrayValue) return input.closed ? input.values
        : [uncertainOrigins([input, new UnknownValue("filesystem pattern array has unresolved members", true, input.trace)],
          "filesystem pattern array has unresolved members")];
      return this.patterns && fixedSequence(input) ? input.values : args.slice(position, position + 1);
    });
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
const literalIdentifierValues = new Map([["true", true], ["false", false], ["null", null], ["undefined", undefined], ["NaN", NaN], ["Infinity", Infinity]]);
const emptyEnvironment = new Map();
const maximumModuleEvaluations = 6000;
const lexicalReceiver = Symbol("source invocation receiver");
const lexicalHomeClass = Symbol("source method home class");
const lexicalConstruction = Symbol("source construction frame");
const nativeErrorConstructors = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"]);

/** Shared lexical uses/public reachability for module callable contracts. */
class SourceModuleCallableUsage {
  constructor(module, name) {
    this.module = module;
    this.name = name;
    this.usage = module.originUsage([name], { moduleBindings: true, mutableAliases: true });
    const header = module.declarationHeader(name);
    this.usage.accept([module.tokens[module.tokens.indexOf(header.token) + 1]]);
    this.public = header.prefix.some(token => token.value === "export")
      || module.exports.some(entry => !entry.reference && this.usage.origins.has(entry.local));
  }
  accept(tokens) { this.usage.accept(tokens); }
  get closed() { return !this.public && this.usage.unresolved().length === 0; }
  directCalls(invocations) {
    const binding = this.module.moduleBinding(this.name);
    if (this.public || !binding || this.module.bindingWrites([binding]).length > 0) return null;
    const references = this.module.bindingReferences(binding);
    const calls = invocations.filter(call => this.module.bindingAt(call.token) === binding);
    if (!calls.length || references.length !== calls.length || references.some(token => !calls.some(call => call.token === token))
      || calls.some(call => call.constructed || call.arguments.some(argument => argument.length >= 3
        && argument.slice(0, 3).every(token => token.value === ".")))) return null;
    this.accept(calls.map(call => call.token));
    return this.closed ? calls : null;
  }
}

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
  let conditionalDepth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].offset >= boundary) return index;
    if (tokens[index] instanceof SourceTemplateToken) index = templateEnd(tokens, index);
    else if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) {
      index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]);
    } else if (SourceConditionalExpression.isQuestion(tokens, index)) conditionalDepth++;
    else if (tokens[index].kind === "punctuation" && tokens[index].value === ":") {
      if (conditionalDepth === 0) return index;
      conditionalDepth--;
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
  /** Interpretation provenance is not a normal-completion or equality proof. */
  withCallContext(context) {
    if (!(context instanceof SourceCallEvaluationContext)) throw new TypeError("source call evaluation context required");
    this.callContext = context;
    return this;
  }
  /** Concrete allocation models expose only their existing nominal heap state. */
  get allocationState() { return null; }
  get ownSensitive() { return false; }
  get sensitivityInputs() { return noSensitivityInputs; }
  get sensitive() { return SourceValueSensitivity.of(this); }
  get intrinsicSyntax() { return false; }
}

/** A query edge records whether the value is a possible returned alias/path origin. */
class SourceSensitivityVisit {
  constructor(value, pathOrigin = false) {
    if (!(value instanceof OsValue) || typeof pathOrigin !== "boolean") throw new TypeError("sensitivity query edge required");
    this.value = value;
    this.pathOrigin = pathOrigin || value instanceof SourceProvenanceResult;
  }
  get mode() { return this.pathOrigin ? 2 : 1; }
  get sensitive() {
    return this.value.ownSensitive || this.pathOrigin && this.value instanceof LiteralValue
      && typeof this.value.value === "string" && pseudoPath.test(this.value.value);
  }
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
    const root = new SourceSensitivityVisit(this.value);
    const visited = new Map([[this.value, root.mode]]);
    const states = new Map();
    const summaries = new Set();
    if (this.value instanceof SourceObjectState) states.set(this.value, this.value.revision);
    if (this.value instanceof SourceEffectSummary) summaries.add(this.value);
    const pending = [...this.inputs].reverse().map(value => new SourceSensitivityVisit(value, root.pathOrigin));
    const revisit = value => {
      const modes = visited.get(value) ?? 0;
      visited.delete(value);
      if (modes & 1) pending.push(new SourceSensitivityVisit(value));
      if (modes & 2) pending.push(new SourceSensitivityVisit(value, true));
    };
    while (true) {
      while (pending.length > 0) {
        const visit = pending.pop(), value = visit.value;
        if ((visited.get(value) ?? 0) & visit.mode) continue;
        visited.set(value, (visited.get(value) ?? 0) | visit.mode);
        if (value instanceof SourceObjectState) states.set(value, value.revision);
        if (value instanceof SourceEffectSummary) summaries.add(value);
        if (visit.sensitive) return true;
        const inputs = value.sensitivityInputs;
        for (let index = inputs.length - 1; index >= 0; index--) pending.push(new SourceSensitivityVisit(inputs[index], visit.pathOrigin));
      }
      // Lazy effects may add edges to an earlier heap node. Revisit every
      // previously observed path mode until state/effect dependencies stabilize.
      for (const [state, revision] of states) if (state.revision !== revision) revisit(state);
      for (const summary of summaries) if (summary.origins.deepCalls && !summary.resolving && !summary.current) revisit(summary);
      if (pending.length === 0) return false;
    }
  }
}
class UnknownValue extends OsValue {
  constructor(reason = "runtime value", sensitive = false, trace = []) { super(trace); this.reason = reason; this.isSensitive = sensitive; }
  get ownSensitive() { return this.isSensitive; }
  get intrinsicSyntax() { return true; }
}
/** Abstract caller data used only while summarizing a callable's effects. */
class SourceEffectInput extends UnknownValue {}
/** One summary owns one abstract input per formal position, never actual call data. */
class SourceEffectParameters {
  constructor(declaration) {
    if (declaration !== null && !(declaration instanceof SourceDeclaration)) throw new TypeError("source effect declaration required");
    this.values = Object.freeze(declaration === null ? []
      : readParameters(declaration.tokens).map(() => new SourceEffectInput()));
    Object.freeze(this);
  }
}
class SourceEffectResult extends UnknownValue {
  constructor(inputs) { super("call result depends on abstract caller data"); this.inputs = inputs; }
}
/** A possible returned alias retains provenance, beyond abstract argument dependence. */
class SourceProvenanceResult extends SourceEffectResult {
  get sensitivityInputs() { return this.inputs; }
}
/** A producer's unknown result retains its inputs without proving a runtime type. */
class SourceUninspectedCallResult extends SourceProvenanceResult {
  constructor(inputs) { super(inputs); this.reason = "uninspected call result"; }
}
/** Normal completion of new is an object, never the undefined default case. */
class SourceConstructedValue extends SourceProvenanceResult {
  constructor(inputs, constructionIdentity = null) {
    super(inputs);
    this.constructionIdentity = constructionIdentity;
  }
}
/** Native Error retains its message/cause; getters and coercion are inspected at creation. */
class SourceNativeErrorValue extends SourceConstructedValue {
  get allocationState() { return this.state; }
  constructor(builtin, message, cause, state) {
    super([message, cause]);
    if (!(message instanceof OsValue) || !(cause instanceof OsValue) || !(state instanceof SourceObjectState)) throw new TypeError("native error fields required");
    if (!nativeErrorConstructors.has(builtin)) throw new TypeError("native error identity required");
    Object.assign(this, { builtin, message, cause, state });
  }
  get sensitivityInputs() { return [...this.inputs, this.state]; }
}
class SourceEffectDependence {
  static of(value) {
    const seen = new Set();
    const pending = [value];
    while (pending.length > 0) {
      const value = pending.pop();
      if (seen.has(value)) continue;
      seen.add(value);
      if (value instanceof SourceEffectInput) return true;
      if (value.allocationState !== null) pending.push(value.allocationState);
      if (value instanceof SourceObjectState) pending.push(...value.sensitivityInputs);
      if (value instanceof SourceSuperReferenceValue || value instanceof InvocationOptionsValue) pending.push(...value.sensitivityInputs);
      if (value instanceof SourceWeakCollectionValue || value instanceof SourceWeakCollectionMethodValue || value instanceof SourceWeakMapEntry) pending.push(...value.sensitivityInputs);
      else if (value instanceof SourceEffectResult) pending.push(...value.inputs);
      else if (value instanceof SourceArrayValue) pending.push(...value.values);
      else if (value instanceof SourceValues || value instanceof ObjectValue) pending.push(...value.values);
      else if (value instanceof ClassValue) pending.push(...value.arguments, ...value.captures.values);
      else if (value instanceof CallableValue) pending.push(...value.captures.values);
      else if (value instanceof DerivedValue) {
        pending.push(value.origin);
        if (value.details instanceof OsValue) pending.push(value.details);
        else if (value.details instanceof PathInterpretation) pending.push(...value.details.values);
      } else if (value instanceof UncertainValue) pending.push(value.origin);
    }
    return false;
  }
}
class LiteralValue extends OsValue {
  static sameOrigins(left, right) {
    return left.constructor === LiteralValue && right.constructor === LiteralValue
      && Object.is(left.value, right.value) && left.trace.length === right.trace.length
      && left.trace.every((part, index) => part === right.trace[index]);
  }
  constructor(value, trace = []) { super(trace); this.value = value; }
  get intrinsicSyntax() { return true; }
}
/** Source regex allocation retains its own writes without executing its pattern. */
class RegexLiteralValue extends OsValue {
  constructor(token, module, environment, trace = []) {
    if (!(token instanceof SourceRegexToken)) throw new TypeError("regex literal source required");
    super(trace);
    Object.assign(this, { token, module, environment, tokens: [token], state: null });
  }
  static matches(tokens) { return tokens.length === 1 && tokens[0] instanceof SourceRegexToken; }
  static sameAllocation(left, right) {
    return left instanceof RegexLiteralValue && right instanceof RegexLiteralValue
      && left.state !== null && left.state === right.state;
  }
  get allocationState() { return this.state; }
  get sensitivityInputs() { return this.state === null ? [] : [this.state]; }
}

/** Partition evaluations by their exact lexical environment and source module. */
class SourceEvaluationCache {
  constructor() { this.environments = new WeakMap(); }
  entries(environment, module) {
    if (!this.environments.has(environment)) this.environments.set(environment, new WeakMap());
    const modules = this.environments.get(environment);
    if (!modules.has(module)) modules.set(module, new Map());
    return modules.get(module);
  }
  invalidate(environment) { this.environments.delete(environment); }
}
/** Cache copied constant leaves whose evaluation emitted no observations. */
class ConstantEvaluationCache extends SourceEvaluationCache {
  copy(value, environment = emptyEnvironment) {
    if (value instanceof LiteralValue) return new LiteralValue(value.value, value.trace);
    if (value instanceof RegexLiteralValue) return new RegexLiteralValue(value.token, value.module, environment, value.trace);
    if (value instanceof BuiltinValue) return new value.constructor(value.builtin, [...value.members], value.trace);
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
}
/** A plain call supplies no property receiver; it grants no object or native brand. */
class SourceAbsentReceiverValue extends UnknownValue {}
const absentCallReceiver = new SourceAbsentReceiverValue("call has no inspected property receiver");
/** Only the current expression evaluation can carry a member Reference across parentheses. */
class SourceCallReference {
  #receiver = null;
  get receiver() { return this.#receiver; }
  set receiver(value) {
    if (value !== null && !(value instanceof OsValue)) throw new TypeError("source call reference receiver required");
    this.#receiver = value;
  }
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
class GlobalIntrinsicValue extends BuiltinValue { get ownSensitive() { return true; } }
/** A changed native object/member no longer owns its original call contract. */
class SourceNativeMutation {
  constructor(receiver, name) {
    if (!(receiver instanceof BuiltinValue) || name !== null && typeof name !== "string") throw new TypeError("native mutation target required");
    this.builtin = receiver.builtin;
    this.members = [...receiver.members, ...(name === null ? [] : [name])];
  }
  matches(value) {
    if (!(value instanceof BuiltinValue)) return false;
    const members = value.builtin === this.builtin ? value.members
      : value instanceof GlobalIntrinsicValue && ["globalThis", "global"].includes(this.builtin)
        ? [value.builtin, ...value.members] : null;
    return members !== null && (this.members.every((member, index) => members[index] === member)
      || (["Array", "WeakSet", "WeakMap", "RegExp"].includes(value.builtin) || nativeErrorConstructors.has(value.builtin))
        && members.every((member, index) => this.members[index] === member));
  }
}
class SourceNativeMutations {
  #effects = [];
  get revision() { return this.#effects.length; }
  add(receiver, name = null) {
    const effect = new SourceNativeMutation(receiver, name);
    if (!this.#effects.some(existing => existing.builtin === effect.builtin && existing.members.length === effect.members.length
      && existing.members.every((member, index) => effect.members[index] === member))) this.#effects.push(effect);
  }
  affects(value) { return this.#effects.some(effect => effect.matches(value)); }
}

class SourceValues extends OsValue {
  constructor(values, trace = []) {
    super(trace);
    if (!Array.isArray(values) || values.some((value) => !(value instanceof OsValue))) throw new TypeError("source values required");
    this.values = values;
  }
  get sensitivityInputs() { return this.values; }
}
class SequenceValue extends SourceValues {}
/** An actual array allocation; possible selections never prove fixed argv positions. */
class SourceArrayValue extends SourceValues {
  get allocationState() { return this.state; }
  constructor(module, tokens, environment, values, origins, fixed = true, inspected = true) {
    super(values, [module.file, ...values.flatMap(value => value.trace)]);
    if (!(module instanceof SourceModule) || !(environment instanceof Map) || typeof fixed !== "boolean" || typeof inspected !== "boolean") throw new TypeError("source array allocation required");
    Object.assign(this, { module, tokens, environment, origins, fixed, inspected });
    this.state = null;
    origins.objectState(this);
  }
  get closed() {
    return this.inspected && !this.state.hasWrites && !this.origins.nativeMutations.affects(new BuiltinValue("Array"))
      && !this.origins.nativeMutations.affects(new BuiltinValue("Array", ["prototype"]));
  }
  get sensitivityInputs() { return [...this.values, this.state]; }
}
/** A finite own-key snapshot keeps string ordering separate from property reads. */
class SourceOwnKey {
  constructor(name) {
    if (typeof name !== "string") throw new TypeError("own string key required");
    this.name = name;
  }
  get index() {
    const value = Number(this.name);
    return Number.isInteger(value) && value >= 0 && value < 4294967295 && String(value) === this.name ? value : null;
  }
}
class SourceOwnKeys {
  constructor(receiver, keys) {
    if (!(receiver instanceof ObjectValue || receiver instanceof SourceArrayValue)
      || keys.some(key => !(key instanceof SourceOwnKey))) throw new TypeError("finite own-key snapshot required");
    Object.assign(this, { receiver, keys });
  }
  static read(receiver, origins, active = new Set()) {
    if (receiver instanceof SourceArrayValue) return receiver.closed && receiver.fixed
      ? new SourceOwnKeys(receiver, receiver.values.map((_, index) => new SourceOwnKey(String(index)))) : null;
    if (!(receiver instanceof ObjectValue) || active.has(receiver.state)) return null;
    const state = origins.objectState(receiver).state;
    origins.effectSummary?.readState(state);
    if (state.hasWrites || origins.nativeMutations.affects(new BuiltinValue("Object", ["prototype"]))) return null;
    const members = new SourceObjectMembers(receiver.tokens);
    if (members.unresolvedEntries.length || members.accessors.some(accessor => members.accessors.filter(other =>
      other.name === accessor.name && other.kind === accessor.kind).length > 1)) return null;
    const properties = [...members.entries, ...members.accessors].sort((left, right) => left.token.offset - right.token.offset);
    if (members.accessors.length && members.entries.some(property => property instanceof SourceObjectSpread)) return null;
    active.add(state);
    try {
      const names = new Map();
      for (const property of properties) {
        if (property instanceof SourceObjectSpread) {
          const value = origins.value(receiver.module, property.tokens, receiver.environment);
          const spread = SourceOwnKeys.read(value, origins, active);
          if (spread === null) return null;
          for (const key of spread.keys) if (!names.has(key.name)) names.set(key.name, key);
        } else {
          const name = members.accessors.includes(property) ? property.name : property.token.value;
          if (!names.has(name)) names.set(name, new SourceOwnKey(name));
        }
      }
      const keys = [...names.values()];
      keys.sort((left, right) => left.index !== null && right.index !== null ? left.index - right.index
        : left.index !== null ? -1 : right.index !== null ? 1 : 0);
      return new SourceOwnKeys(receiver, keys);
    } finally { active.delete(state); }
  }
  get current() { return !this.receiver.state.hasWrites; }
}
/** Native-created tuples at one call site still have separate allocation identities. */
class SourceNativeArrayAllocations {
  #sites = new WeakMap();
  environment(token, caller, index) {
    if (!this.#sites.has(token)) this.#sites.set(token, new WeakMap());
    const callers = this.#sites.get(token);
    if (!callers.has(caller)) callers.set(caller, new Map());
    const slots = callers.get(caller);
    if (!slots.has(index)) slots.set(index, new Map());
    return slots.get(index);
  }
}
class SourceObjectEnumeration {
  constructor(callee, snapshot) {
    if (!SourceObjectEnumeration.supports(callee) || !(snapshot instanceof SourceOwnKeys)) throw new TypeError("native own-property enumeration required");
    Object.assign(this, { callee, snapshot });
  }
  static supports(callee) {
    return callee instanceof BuiltinValue && callee.builtin === "Object" && callee.members.length === 1
      && ["keys", "values", "entries"].includes(callee.member);
  }
  static inspect(callee, args, origins) {
    if (!SourceObjectEnumeration.supports(callee) || args.length !== 1 || origins.nativeMutations.affects(callee)) return null;
    const snapshot = SourceOwnKeys.read(args[0], origins);
    return snapshot === null ? null : new SourceObjectEnumeration(callee, snapshot);
  }
  result(origins, token, module, environment) {
    const values = [];
    for (const [index, key] of this.snapshot.keys.entries()) {
      const name = new LiteralValue(key.name);
      if (this.callee.member === "keys") { values.push(name); continue; }
      const value = origins.readMember(this.snapshot.receiver, key.name, token, module, environment);
      // A getter may invalidate the captured descriptor/key assumptions. Keep
      // its effects, then refuse an unproven fixed tuple/sequence result.
      if (!this.snapshot.current) return null;
      values.push(this.callee.member === "values" ? value : new SourceArrayValue(module, [token],
        origins.nativeArrayAllocations.environment(token, environment, index), [name, value], origins));
    }
    return new SourceArrayValue(module, [token], environment, values, origins);
  }
}

/** A native weak collection keeps its brand, own members and entry provenance separate. */
class SourceWeakCollectionValue extends OsValue {
  get allocationState() { return this.state; }
  constructor(module, token, environment, origins) {
    super([]);
    this.trace = [module.file];
    Object.assign(this, { module, token, environment, origins });
    this.state = origins.allocationState(module, [token], environment);
    this.entries = origins.weakCollectionEntries(this.state);
  }
  get closed() {
    return !this.state.hasOpaqueMutation && this.state.alternatives("__proto__").length === 0
      && !this.origins.nativeMutations.affects(new BuiltinValue(this.builtin));
  }
  get sensitivityInputs() { return [this.state, this.entries]; }
  static sameAllocation(left, right) {
    return left instanceof SourceWeakCollectionValue && right instanceof SourceWeakCollectionValue
      && left.constructor === right.constructor && left.state === right.state;
  }
}
class SourceWeakSetValue extends SourceWeakCollectionValue {
  get builtin() { return "WeakSet"; }
  get methods() { return ["has", "add", "delete"]; }
  write(key, _value, token) { this.entries.write(new SourceObjectWrite(token, null, key)); }
}
/** Key comparison may prove different genuine allocations, never unknown constructions. */
class SourceWeakMapKey {
  constructor(value, origins) {
    if (!(value instanceof OsValue)) throw new TypeError("weak key source value required");
    this.value = value;
    const native = value instanceof BuiltinValue ? value : value instanceof SourceWeakCollectionMethodValue
      ? new BuiltinValue(value.owner.builtin, ["prototype", value.name]) : null;
    this.nativeIdentity = native !== null && !origins.nativeMutations.affects(native) ? native.identity : null;
    this.state = origins.objectState(value).allocationState;
  }
  get known() { return this.state !== null || this.nativeIdentity !== null || this.value instanceof CallableValue; }
  compare(other) {
    if (!(other instanceof SourceWeakMapKey)) throw new TypeError("weak key comparison required");
    const left = this.value, right = other.value;
    if (left === right) return true;
    if (left instanceof LiteralValue && right instanceof LiteralValue) return Object.is(left.value, right.value);
    if (this.state !== null && other.state !== null) return this.state === other.state;
    if (this.nativeIdentity !== null && other.nativeIdentity !== null) return this.nativeIdentity === other.nativeIdentity;
    if (left instanceof CallableValue && right instanceof CallableValue) return left.declaration.token === right.declaration.token && left.environment === right.environment;
    return this.known && other.known ? false : null;
  }
}
/** Entry payload keeps key provenance separate from the value returned by get. */
class SourceWeakMapEntry extends OsValue {
  constructor(key, value, origins) {
    super([...key.trace, ...value.trace]);
    this.key = new SourceWeakMapKey(key, origins);
    this.value = value;
    this.valueIdentity = new SourceWeakMapKey(value, origins);
  }
  get sensitivityInputs() { return [this.key.value, this.value]; }
  static same(left, right) {
    return left instanceof SourceWeakMapEntry && right instanceof SourceWeakMapEntry
      && left.key.compare(right.key) === true && left.valueIdentity.compare(right.valueIdentity) === true;
  }
}
class SourceWeakMapValue extends SourceWeakCollectionValue {
  get builtin() { return "WeakMap"; }
  get methods() { return ["has", "get", "set", "delete"]; }
  write(key, value, token) { this.entries.write(new SourceObjectWrite(token, null, new SourceWeakMapEntry(key, value, this.origins))); }
  read(key) {
    if (key instanceof LiteralValue || key instanceof SourceBooleanValue) return new LiteralValue(undefined);
    const selected = new SourceWeakMapKey(key, this.origins);
    const entries = this.entries.writes.flatMap(write => write.values);
    const values = entries.filter(entry => entry.key.compare(selected) !== false).map(entry => entry.value);
    return values.length ? new SourceCallResults([new LiteralValue(undefined), ...values], this.trace) : new LiteralValue(undefined);
  }
}
/** Normal insertion and possible TypeError share the same noncoercing native boundary. */
class SourceWeakInsertionCompletion {
  constructor(key, mayThrow) {
    if (!(key instanceof OsValue) || typeof mayThrow !== "boolean") throw new TypeError("weak insertion completion required");
    Object.assign(this, { key, mayThrow });
  }
  static inspect(key, origins) {
    if (origins.weakObject(key)) return new SourceWeakInsertionCompletion(key, false);
    const callerData = (key.constructor === UnknownValue || key.constructor === SourceEffectInput)
      && key.reason === "runtime value" && !key.isSensitive;
    return callerData ? new SourceWeakInsertionCompletion(key, true) : null;
  }
  apply(owner, value, token) {
    // Possible abrupt completion grants no successful-execution guarantee.
    // The normal branch retains the original key/value origin graph.
    owner.write(this.key, value, token);
    return owner;
  }
}
class SourceWeakCollectionMethodValue extends OsValue {
  constructor(owner, name) {
    super(owner.trace);
    if (!(owner instanceof SourceWeakCollectionValue) || !owner.methods.includes(name)) throw new TypeError("native weak collection method required");
    Object.assign(this, { owner, name });
  }
  get sensitivityInputs() { return [this.owner]; }
}

/** Repeated interpretation of one unchanged array allocation, never distinct arrays. */
class SourceStableArrayContents {
  constructor(value) {
    if (!(value instanceof SourceArrayValue) || !value.closed) throw new TypeError("unchanged source array required");
    this.state = value.state;
    this.fixed = value.fixed;
    this.values = [...value.values];
  }
  matches(value) {
    return value instanceof SourceArrayValue && value.closed && value.state === this.state && value.fixed === this.fixed
      && value.values.length === this.values.length && this.values.every((entry, index) => entry === value.values[index]
        || entry.constructor === LiteralValue && value.values[index].constructor === LiteralValue && Object.is(entry.value, value.values[index].value));
  }
  static same(left, right) {
    return left instanceof SourceArrayValue && left.closed && new this(left).matches(right);
  }
}
function fixedSequence(value) {
  return value?.constructor === SequenceValue || value instanceof SourceArrayValue && value.fixed && value.closed;
}
/** A native predicate returns only a boolean, never an input capability. */
class SourceBooleanValue extends OsValue {}
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
  get constantNumber() {
    // The provenance reader does not promise general operator precedence.
    // Only one operator with already literal numeric operands is exact here.
    if (!this.values.every(value => value instanceof LiteralValue && typeof value.value === "number")) return null;
    const [left, right] = this.values.map(value => value.value);
    if (this.values.length === 1) {
      if (this.operator === "+") return new LiteralValue(+left, this.trace);
      if (this.operator === "-") return new LiteralValue(-left, this.trace);
      if (this.operator === "~") return new LiteralValue(~left, this.trace);
      return null;
    }
    if (this.values.length !== 2) return null;
    switch (this.operator) {
      case "+": return new LiteralValue(left + right, this.trace);
      case "-": return new LiteralValue(left - right, this.trace);
      case "*": return new LiteralValue(left * right, this.trace);
      case "/": return new LiteralValue(left / right, this.trace);
      case "%": return new LiteralValue(left % right, this.trace);
      case "**": return new LiteralValue(left ** right, this.trace);
      case "|": return new LiteralValue(left | right, this.trace);
      case "&": return new LiteralValue(left & right, this.trace);
      case "^": return new LiteralValue(left ^ right, this.trace);
      case "<<": return new LiteralValue(left << right, this.trace);
      case ">>": return new LiteralValue(left >> right, this.trace);
      case ">>>": return new LiteralValue(left >>> right, this.trace);
      default: return null;
    }
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
/** Native truth tests do not coerce object values or execute source methods. */
class SourceValueTruth {
  static read(value, nullish = false) {
    if (value instanceof LiteralValue) return nullish ? value.value != null : Boolean(value.value);
    if (value instanceof OperationValue && ["===", "!=="].includes(value.operator) && value.values.length === 2
      && value.values.every(operand => operand.constructor === LiteralValue
        && (operand.value === null || !["object", "function"].includes(typeof operand.value)))) {
      const result = value.constantBoolean;
      return result === null ? null : nullish ? true : result;
    }
    if (value instanceof ObjectValue || value instanceof ClassValue || value instanceof CallableValue
      || value instanceof SourceArrayValue || value instanceof SourceWeakCollectionValue
      || value instanceof SourceWeakCollectionMethodValue || value instanceof SourceConstructedValue) return true;
    return null;
  }
}
/** Logical operators produce values; they never preserve a property Reference. */
class SourceCallableSelection {
  constructor(values) {
    if (!Array.isArray(values) || values.length === 0 || values.some(value => !(value instanceof OsValue))) throw new TypeError("possible logical callees required");
    this.values = values;
  }
  static read(value) {
    if (!(value instanceof OperationValue) || value.values.length !== 2 || !["&&", "||", "??"].includes(value.operator)) return null;
    const [left, right] = value.values;
    const truth = SourceValueTruth.read(left, value.operator === "??");
    return new this(truth === null ? [left, right] : [value.operator === "&&" ? truth ? right : left : truth ? left : right]);
  }
}

/** Exact lexical expression identity, shared by invocation-local observations. */
class SourceExpression {
  constructor(module, tokens) {
    if (!(module instanceof SourceModule) || !Array.isArray(tokens) || tokens.length === 0) throw new TypeError("source expression required");
    this.module = module; this.tokens = immutableSourceTokens(tokens);
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
/** One syntactic conditional retains its context without changing value alternatives. */
class SourceCallInputSelection {
  constructor(expression, environment, condition, values) {
    if (!(expression instanceof SourceExpression) || !(environment instanceof Map) || !(condition instanceof OsValue)
      || !Array.isArray(values) || values.length !== 2 || values.some(value => !(value instanceof OsValue))) {
      throw new TypeError("conditional input expression and original branches required");
    }
    const home = environment.get(lexicalHomeClass) ?? null;
    if (home !== null && !(home instanceof SourceClassHome)) throw new TypeError("conditional input lexical home required");
    Object.assign(this, { expression, environment, condition, home, values: Object.freeze([...values]) });
    Object.freeze(this);
  }
  hasSameDefinition(other) {
    return other instanceof SourceCallInputSelection && this.expression.hasExpression(other.expression.module, other.expression.tokens)
      && this.environment === other.environment
      && (this.home === other.home || this.home !== null && this.home.matches(other.home));
  }
  static same(left, right) {
    return left === right || left instanceof SourceCallInputSelection && left.hasSameDefinition(right)
      && left.condition === right.condition
      && left.values.every((value, index) => value === right.values[index]);
  }
}

/** Source-only call boundaries supplied by the existing postfix evaluator. */
class SourceCallSyntax {
  static supports(value, origins) {
    return SourceStringReplacement.supports(value) || value instanceof SourceRegexMethodValue
      || origins.nativeErrorConstructor(value) || value instanceof SourceSuperConstructorValue
      || value instanceof BuiltinValue && value.builtin === "String" && value.members.length === 0
      || value instanceof UnknownValue;
  }
  constructor(module, callee, arguments_, constructed, expression) {
    if (typeof constructed !== "boolean") throw new TypeError("source call construction mode required");
    this.expression = new SourceExpression(module, expression);
    this.callee = new SourceExpression(module, callee);
    this.arguments = arguments_.map(tokens => tokens.length ? new SourceExpression(module, tokens) : null);
    this.constructed = constructed;
    Object.freeze(this.arguments);
    Object.freeze(this);
  }
  replacement(origins) {
    if (this.constructed) return null;
    const reference = new SourceCallReference();
    const { module, tokens } = this.callee;
    const callee = origins.value(module, tokens, emptyEnvironment, reference);
    const args = this.arguments.map(expression => expression === null ? new LiteralValue(undefined)
      : origins.value(module, expression.tokens, emptyEnvironment));
    return SourceStringReplacement.supports(callee)
      ? new SourceStringReplacement(callee, args, reference.receiver, this) : null;
  }
  containsDirectArrow(callable) {
    const expression = this.arguments[1];
    if (!(callable instanceof CallableValue) || expression === null || expression === undefined
      || expression.module !== callable.module || !callable.declaration.lexicalThis) return false;
    const tokens = strip(expression.tokens), declaration = callable.declaration;
    if (tokens[0]?.value === "async" || declaration.prefix.some(token => token.value === "async" || token.value === "*")) return false;
    return tokens.length === declaration.tokens.length && tokens.every((token, index) => token === declaration.tokens[index]);
  }
}

/** Source evaluation identity grants no normal result, native or callable authority. */
class SourceCallEvaluationContext {
  constructor(source, callee, receiver, environment, inputs, outputs, trace, constructed) {
    if (typeof constructed !== "boolean" || !(source instanceof SourceCallSyntax) || !(callee instanceof OsValue)
      || receiver !== null && !(receiver instanceof OsValue) || !(environment instanceof Map)
      || !Array.isArray(inputs) || inputs.some(value => !(value instanceof OsValue))
      || !Array.isArray(outputs) || outputs.some(value => !(value instanceof OsValue))
      || !Array.isArray(trace) || trace.some(value => typeof value !== "string")) throw new TypeError("source call evaluation required");
    Object.assign(this, { source, callee, receiver, environment, constructed,
      home: environment.get(lexicalHomeClass) ?? null,
      inputs: Object.freeze([...inputs]), outputs: Object.freeze([...outputs]), trace: Object.freeze([...trace]) });
    Object.freeze(this);
  }
}
/** Native operation producers retain their stricter native-callee invariant. */
class SourceNativeCallContext extends SourceCallEvaluationContext {
  constructor(source, callee, receiver, environment, inputs, outputs, trace, constructed) {
    if (!(callee instanceof BuiltinValue)) throw new TypeError("native call interpretation required");
    super(source, callee, receiver, environment, inputs, outputs, trace, constructed);
  }
}
/** An ordinary uninspected call stays unknown and retains every original edge. */
class SourceUninspectedCallContext extends SourceCallEvaluationContext {}
/** Explicit String(...) differs from implicit conversion and text replacement. */
class SourceStringCallContext extends SourceNativeCallContext {}
/** Nullable exec output preserves ordered match-allocation and null alternatives. */
class SourceRegexExecContext extends SourceNativeCallContext {}
/** Native Error.message ToString is separate from explicit String and rendering. */
class SourceErrorMessageContext extends SourceNativeCallContext {}
/** Restricted conversion inputs contain no mutable heap; native proof is versioned separately. */
class SourceErrorMessageFootprint {
  constructor(index, before, after) {
    if (!(index instanceof SourceNativeMutations) || !Number.isInteger(before) || !Number.isInteger(after)) throw new TypeError("native message input footprint required");
    Object.assign(this, { index, before, after });
    Object.freeze(this);
  }
  same(other) {
    return other instanceof SourceErrorMessageFootprint && this.index === other.index
      && this.before === this.after && other.before === other.after && this.after === other.after
      && this.index.revision === this.after;
  }
}
/** Semantic duplicate proof for one closed message template, never an input-context key. */
class SourceErrorMessageInterpretation {
  constructor(context, footprint) {
    if (!(context instanceof SourceErrorMessageContext) || !(footprint instanceof SourceErrorMessageFootprint)) throw new TypeError("native message interpretation required");
    Object.assign(this, { context, footprint });
    Object.freeze(this);
  }
  same(other, left, right) {
    if (!(other instanceof SourceErrorMessageInterpretation) || !this.footprint.same(other.footprint)) return false;
    const a = this.context, b = other.context;
    return a.environment === b.environment && (a.home === b.home || a.home !== null && a.home.matches(b.home)) && a.receiver === b.receiver
      && a.constructed === b.constructed && a.source.constructed === b.source.constructed
      && a.source.expression.hasExpression(b.source.expression.module, b.source.expression.tokens)
      && new SourceCallInputIdentity(a.callee).matches(b.callee)
      && a.callee.trace.length === b.callee.trace.length && a.callee.trace.every((part, index) => part === b.callee.trace[index])
      && a.trace.length === b.trace.length && a.trace.every((part, index) => part === b.trace[index])
      && a.inputs.length === 1 && b.inputs.length === 1 && a.inputs[0] === left && b.inputs[0] === right
      && a.outputs.length === 0 && b.outputs.length === 0 && TemplateValue.sameMessageOrigins(left, right);
  }
}


/** One literal native match, retaining the real callback argument roles. */
class SourceStringMatch {
  constructor(owner, search, position) {
    if (!(owner instanceof LiteralValue) || typeof owner.value !== "string"
      || !(search instanceof LiteralValue) || typeof search.value !== "string"
      || !Number.isSafeInteger(position) || position < 0) throw new TypeError("literal string match required");
    Object.assign(this, { owner, search, position });
    Object.freeze(this);
  }
  get arguments() { return [this.search, new LiteralValue(this.position), this.owner]; }
}
class SourceStringMatches {
  constructor(owner, search, all) {
    if (!(owner instanceof LiteralValue) || typeof owner.value !== "string"
      || !(search instanceof LiteralValue) || typeof search.value !== "string" || typeof all !== "boolean") {
      throw new TypeError("literal string match inputs required");
    }
    Object.assign(this, { owner, search, all });
    Object.freeze(this);
  }
  *[Symbol.iterator]() {
    const { owner, search, all } = this;
    let position = owner.value.indexOf(search.value);
    while (position >= 0) {
      yield new SourceStringMatch(owner, search, position);
      if (!all) return;
      const next = position + Math.max(1, search.value.length);
      position = next <= owner.value.length ? owner.value.indexOf(search.value, next) : -1;
    }
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
  invoke(origins, environment, callee, constructed = false, receiver = null) {
    const module = this.expression.module;
    const args = this.arguments.map(part => origins.value(module, part.tokens, environment));
    const source = SourceCallSyntax.supports(callee, origins) ? new SourceCallSyntax(module, this.calleeTokens,
      this.arguments.map(part => part.tokens), constructed, this.expression.tokens) : null;
    return origins.invoke(callee, args, this.expression.tokens[0], module, environment, constructed, receiver, source);
  }
}
class IntrinsicMemberExpression extends IntrinsicExpression {
  get calleeTokens() { return this.expression.tokens.slice(0, 3); }
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
    return this.called ? this.invoke(origins, environment, value, false, receiver) : value;
  }
}
class IntrinsicCallExpression extends IntrinsicExpression {
  get calleeTokens() { return this.expression.tokens.slice(0, this.constructed ? 2 : 1); }
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

/** A member effect distinguishes inspected assigned data from opaque mutation. */
class SourceObjectWrite {
  constructor(token, name, value, exposed = false) {
    if (!token || name !== null && typeof name !== "string" || !(value instanceof OsValue) || typeof exposed !== "boolean") {
      throw new TypeError("source object write required");
    }
    Object.assign(this, { token, name, exposed });
    this.values = [value];
    this.result = new SourceAlternativeValues(this.values, value.trace);
  }
  affects(name) { return this.name === null || this.name === name; }
  add(effect) {
    if (!(effect instanceof SourceObjectWrite)) throw new TypeError("source object write required");
    let changed = this.name !== effect.name && this.name !== null || this.exposed && !effect.exposed;
    if (this.name !== effect.name) this.name = null;
    this.exposed = this.exposed && effect.exposed;
    for (const value of effect.values) if (!this.values.some(existing => existing === value
      || existing instanceof SourceEffectInput && value instanceof SourceEffectInput
      || existing instanceof ObjectValue && value instanceof ObjectValue && existing.state !== null && existing.state === value.state
      || SourceConstructionIdentity.same(existing, value)
      || UncertainValue.sameOrigins(existing, value)
      || SourceDefaultValue.sameOrigins(existing, value)
      || SourceStringValue.sameOrigins(existing, value)
      || ComposedPathValue.sameAbstractOrigins(existing, value)
      || SourceStableArrayContents.same(existing, value)
      || RegexLiteralValue.sameAllocation(existing, value)
      || SourceWeakCollectionValue.sameAllocation(existing, value)
      || SourceWeakMapEntry.same(existing, value)
      || DevNullValue.sameNativeOrigin(existing, value)
      || PrimitiveConversionValue.sameLiteralOrigin(existing, value)
      || existing.constructor === LiteralValue && value.constructor === LiteralValue && Object.is(existing.value, value.value)
      || existing.constructor === value.constructor && existing instanceof BuiltinValue && existing.identity === value.identity
      || existing.constructor === UnknownValue && value.constructor === UnknownValue && existing.reason === value.reason && existing.sensitive === value.sensitive)) { this.values.push(value); changed = true; }
    if (changed) this.result.trace = [...new Set(this.values.flatMap(value => value.trace))];
    return changed;
  }
  get value() { return this.values.length === 1 ? this.values[0] : this.result; }
}
/** One allocation site in one invocation; aliases share all possible writes. */
class SourceObjectState extends OsValue {
  #writes = new Map();
  #revision = 0;
  #frozen = false;
  get frozen() { return this.#frozen; }
  freeze() { if (!this.#frozen) { this.#frozen = true; this.#revision++; } }
  constructor(expression, environment) {
    super([expression.module.file]);
    if (!(expression instanceof SourceExpression) || !(environment instanceof Map)) throw new TypeError("source allocation context required");
    this.expression = expression;
    this.environment = environment;
  }
  write(effect) {
    if (!(effect instanceof SourceObjectWrite)) throw new TypeError("source object write required");
    if (!this.#writes.has(effect.token)) this.#writes.set(effect.token, new Map());
    const members = this.#writes.get(effect.token);
    if (members.has(effect.name)) {
      if (members.get(effect.name).add(effect)) this.#revision++;
    } else { members.set(effect.name, effect); this.#revision++; }
  }
  get revision() { return this.#revision; }
  get hasWrites() { return this.#writes.size > 0; }
  get writes() { return [...this.#writes.values()].flatMap(members => [...members.values()]); }
  get hasOpaqueMutation() { return this.writes.some(effect => effect.exposed); }
  get sensitivityInputs() { return this.writes.filter(effect => !effect.exposed).map(effect => effect.value); }
  alternatives(name) { return this.writes.filter(effect => effect.affects(name)).map(effect => effect.value); }

}
class ObjectValue extends OsValue {
  get allocationState() { return this.state; }
  constructor(module, tokens, environment, trace = [], values = [], origins = null) {
    super(trace);
    Object.assign(this, { module, tokens, environment, values });
    this.state = null;
    this.effects = origins === null ? null : origins.objectEffectsFor(this);
  }
  get sensitivityInputs() { return [...this.values, ...(this.effects === null ? [] : [this.effects]), ...(this.state === null ? [] : [this.state])]; }
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
  constructor(module, declaration, environment, trace, origins, receiver = null, home = null) {
    super(trace);
    Object.assign(this, { module, declaration, environment, home });
    this.captures = new SourceCapturedEnvironment(module, declaration, environment);
    this.effects = origins.effectsFor(this, receiver);
  }
  get sensitivityInputs() { return [...this.captures.values, this.effects]; }
}
/** Effect queries share one isolated abstract-call context and revision contract. */
class SourceEffectSummary extends OsValue {
  #resolved = false;
  #resolving = false;
  #states = new Map();
  #revision;
  #nativeRevision;
  #invocationRevision;
  #iterationInputMode;
  #records = new Set();
  #values = [];
  #outputs = [];
  constructor(origins, environment, trace) {
    super(trace);
    this.origins = origins;
    this.environment = environment;
  }
  record(value) {
    const marker = new UnknownValue("source has unproven native effects", true, value.trace);
    const key = new SourceUnknownContextIdentity(marker).key;
    // Repeated observations assert the same fact. Actual value dependencies,
    // evaluated outputs and every observer call remain independently retained.
    if (!this.#records.has(key)) { this.#records.add(key); this.#values.push(marker); }
  }
  depend(value) {
    if (!(value instanceof OsValue)) throw new TypeError("source effect dependency required");
    if (!this.#values.includes(value)) this.#values.push(value);
  }
  readState(state) {
    if (!(state instanceof SourceObjectState)) throw new TypeError("source heap dependency required");
    this.#states.set(state, state.revision);
  }
  get resolving() { return this.#resolving; }
  get current() {
    return this.#resolved && this.#revision === this.environment.revision
      && this.#nativeRevision === this.origins.nativeMutations.revision
      && this.#invocationRevision === this.origins.invocationAuthorities.revision
      && this.#iterationInputMode === this.origins.resolvingIterationInputs
      && [...this.#states].every(([state, revision]) => state.revision === revision);
  }
  get sensitivityInputs() {
    if (!this.origins.deepCalls) return noSensitivityInputs;
    if (!this.#resolving && !this.current) this.resolve();
    return this.#values;
  }
  get exposureInputs() {
    if (!this.origins.deepCalls) return noSensitivityInputs;
    if (!this.#resolving && !this.current) this.resolve();
    return this.#outputs;
  }
  evaluate() { throw new Error("source effect evaluation required"); }
  resolve() {
    this.#resolving = true;
    this.#resolved = true;
    this.#revision = this.environment.revision;
    this.#nativeRevision = this.origins.nativeMutations.revision;
    this.#invocationRevision = this.origins.invocationAuthorities.revision;
    this.#iterationInputMode = this.origins.resolvingIterationInputs;
    this.#values = [];
    this.#outputs = [];
    this.#records.clear();
    this.#states.clear();
    const origins = this.origins;
    const previous = [origins.effectSummary, origins.activeCalls, origins.activeBindings, origins.activeExports,
      origins.deepCalls, origins.scanHelpers, origins.route, origins.callers, origins.selectCallRoute,
      origins.onCall, origins.onMember, origins.onUnsupported];
    origins.effectSummary = this;
    origins.activeCalls = new Set();
    origins.activeBindings = new Set();
    origins.activeExports = new Set();
    origins.deepCalls = origins.scanHelpers = true;
    origins.route = [];
    origins.callers = [];
    origins.selectCallRoute = () => null;
    [origins.onCall, origins.onMember, origins.onUnsupported] = origins.effectObservers;
    try {
      const value = this.evaluate();
      this.#values.push(value);
      this.#outputs.push(value);
      if (pseudoPathUse(value) !== null || value instanceof WindowsPathValue || value instanceof PosixPathValue) this.record(value);
    } finally {
      this.#resolving = false;
      for (const state of this.#states.keys()) this.#states.set(state, state.revision);
      [origins.effectSummary, origins.activeCalls, origins.activeBindings, origins.activeExports,
        origins.deepCalls, origins.scanHelpers, origins.route, origins.callers, origins.selectCallRoute,
        origins.onCall, origins.onMember, origins.onUnsupported] = previous;
    }
  }
}
/** Inspect source with abstract caller data; never execute target JavaScript. */
class SourceCallableEffects extends SourceEffectSummary {
  constructor(origins, callable, receiver) {
    super(origins, callable.environment, callable.trace);
    this.callable = callable;
    this.receiver = receiver;
    this.abstractReceiver = receiver ?? new SourceEffectInput();
    this.parameters = new SourceEffectParameters(callable.declaration);
  }
  evaluate() {
    return this.origins.invoke(this.callable, this.parameters.values, this.callable.declaration.token,
      this.callable.module, this.callable.environment, false, this.abstractReceiver);
  }
}
class SourceObjectEffects extends SourceEffectSummary {
  constructor(origins, receiver) { super(origins, receiver.environment, receiver.trace); this.receiver = receiver; }
  evaluate() {
    const receiver = this.receiver;
    const members = new SourceObjectMembers(receiver.tokens);
    const callable = property => new CallableValue(receiver.module, property, receiver.environment,
      receiver.trace, this.origins, receiver);
    return new SequenceValue([
      ...members.entries.filter(property => property instanceof SourceDeclaration).map(callable),
      ...members.accessors.map(callable),
      ...members.unresolvedEntries.map(() => new UnknownValue("object member effects remain unresolved", true, receiver.trace)),
    ], receiver.trace);
  }
}
class SourceFieldEffects extends SourceEffectSummary {
  constructor(origins, receiver, tokens) {
    super(origins, receiver.environment, receiver.trace);
    this.receiver = receiver;
    this.expression = new SourceExpression(receiver.module, tokens);
  }
  evaluate() {
    const environment = new SourceReceiverEnvironment(this.receiver.environment, this.receiver, false, new SourceClassHome(this.receiver, this.receiver.instance));
    this.origins.scan(this.receiver.module, this.expression.tokens, environment);
    return this.origins.value(this.receiver.module, this.expression.tokens, environment);
  }
}
class SourceClassEffects extends SourceEffectSummary {
  #parameters = null;
  #instance = null;
  constructor(origins, receiver) { super(origins, receiver.environment, receiver.trace); this.receiver = receiver; }
  evaluate() {
    const receiver = this.receiver;
    const members = new SourceClassMembers(receiver.declaration);
    const constructor = members.instanceMembers.get("constructor");
    this.#parameters ??= new SourceEffectParameters(constructor ?? null);
    this.#instance ??= new ClassValue(receiver.module, receiver.declaration, true, receiver.trace,
      this.#parameters.values, receiver.environment, this.origins);
    const instance = this.#instance;
    instance.prototypeValue = receiver.prototypeValue;
    const values = [];
    const permission = this.origins.nativePermissionContract(receiver);
    const constructorProven = this.origins.invocationType(receiver);
    const inspect = (properties, owner) => {
      for (const [name, property] of properties) {
        // Only the constructor body is covered by the existing closed proof.
        // All other methods, fields and accessors still contribute effects.
        if (owner.instance && name === "constructor" && constructorProven) continue;
        // Closed methods contribute a conditional effect summary. Actual calls
        // must still supply the exact genuine receiver and current native state.
        if (permission !== null && [permission.initialize, permission.capture, permission.apply,
          permission.equal, permission.afterWrite].some(member => member.token === property.token)) continue;
        values.push(property.tokens[1]?.value === "="
          ? new SourceFieldEffects(this.origins, owner, property.tokens.slice(2))
          : new CallableValue(owner.module, property, owner.environment, owner.trace, this.origins, owner, new SourceClassHome(owner, owner.instance)));
      }
    };
    inspect(members.staticMembers, receiver);
    inspect(members.instanceMembers, instance);
    for (const property of members.instanceAccessors) values.push(new CallableValue(instance.module,
      property, instance.environment, instance.trace, this.origins, instance, new SourceClassHome(instance, true)));
    for (const property of members.staticAccessors) values.push(new CallableValue(receiver.module,
      property, receiver.environment, receiver.trace, this.origins, receiver, new SourceClassHome(receiver, false)));
    for (const initializer of members.moduleInitializers) values.push(new SourceFieldEffects(this.origins, receiver, initializer.tokens));
    for (const initializer of members.instanceInitializers) values.push(new SourceFieldEffects(this.origins, instance, initializer.tokens));
    if (members.unresolvedStaticMembers.length || members.unresolvedInstanceMembers.length) {
      values.push(new UnknownValue("class member effects remain unresolved", true, receiver.trace));
    }
    const primary = SourceBodyPrimary.read(receiver.declaration.tokens);
    if (primary.heritageTokens !== null) {
      const parent = this.origins.value(receiver.module, primary.heritageTokens, receiver.environment);
      if (parent instanceof ClassValue) { if (parent.effects !== null) values.push(parent.effects); }
      else if (!this.origins.nativeErrorConstructor(parent)) values.push(new UnknownValue("class heritage effects remain unresolved", true, receiver.trace));
    }
    return new SequenceValue(values, receiver.trace);
  }
}
/** Lexical captures are binding references, not the caller's whole environment. */
class SourceCapturedEnvironment {
  #bindings = new Map();
  #contextBindings;
  constructor(module, declaration, environment) {
    if (!(module instanceof SourceModule) || !(declaration instanceof SourceDeclaration) || !(environment instanceof Map)) {
      throw new TypeError("source lexical capture context required");
    }
    this.expression = new SourceExpression(module, declaration.tokens);
    this.environment = environment;
    this.lexicalThis = declaration.lexicalThis;
  }
  get contextBindings() {
    if (this.#contextBindings !== undefined) return this.#contextBindings;
    const { module, tokens } = this.expression;
    const bindings = new Map();
    const complete = (!this.environment.has(lexicalReceiver) || this.environment.get(lexicalReceiver) === absentCallReceiver) && tokens.every(token => {
      if (token.kind === "identifier" && ["this", "arguments", "super"].includes(token.value)) return false;
      const binding = token.kind === "identifier" ? module.bindingAt(token) : null;
      if (!binding || module.moduleBinding(token.value) === binding
        || module.bindingDeclarations(binding).some(declaration => this.expression.contains(module, declaration))) return true;
      if (!this.environment.has(binding) || module.bindingWrites([binding]).length > 0) return false;
      bindings.set(binding, this.environment.get(binding));
      return true;
    });
    this.#contextBindings = complete ? bindings : null;
    return this.#contextBindings;
  }
  get values() {
    const captured = [];
    for (const [binding, value] of this.environment) {
      // Receiver provenance remains conservative until its lexical-this
      // contract is established separately from ordinary named bindings.
      if (binding === lexicalReceiver) {
        if (this.lexicalThis && this.expression.tokens.some(token => token.value === "this")) captured.push(value);
        continue;
      }
      if (binding === lexicalConstruction || binding === lexicalHomeClass) continue;
      if (!this.#bindings.has(binding)) this.#bindings.set(binding,
        this.expression.module.bindingReferences(binding).some(token => this.expression.contains(this.expression.module, token)));
      if (this.#bindings.get(binding)) captured.push(value);
    }
    return captured;
  }
}
class ClassValue extends OsValue {
  get allocationState() { return this.state; }
  constructor(module, declaration, instance = false, trace = [], arguments_ = [], environment = emptyEnvironment, origins = null) {
    super(trace);
    if (!(declaration instanceof SourceDeclaration)) throw new TypeError("lexical class declaration required");
    Object.assign(this, { module, declaration, name: declaration.name, instance, arguments: arguments_, environment });
    this.captures = new SourceCapturedEnvironment(module, declaration, environment);
    this.state = null;
    this.ancestors = [];
    this.effects = origins === null ? null : origins.classEffectsFor(this);
  }
  get sensitivityInputs() { return [...this.arguments, ...this.captures.values, ...(this.state === null ? [] : [this.state]), ...(this.prototypeValue ? [this.prototypeValue.state] : []), ...(this.effects === null ? [] : [this.effects])]; }
  get ownSensitive() { return this.sensitivityInputs.some(value => pseudoPathUse(value) !== null); }
}

/** The prototype is a distinct, mutable object shared by instances of this source class. */
class SourceNativePermissionClassValue extends ClassValue {
  get ownSensitive() { return true; }
}
/** A known invalid input has no normal constructor result. */
class SourceNativePermissionConstructorInput {
  constructor(value, mayThrow) {
    if (!(value instanceof OsValue) || typeof mayThrow !== "boolean") throw new TypeError("native metadata constructor input required");
    Object.assign(this, { value, mayThrow });
    Object.freeze(this);
  }
  static alternatives(value) {
    const selected = SourceCallableSelection.read(value);
    return selected !== null ? selected.values : value instanceof SourceAlternativeValues ? value.values
      : value instanceof UncertainValue ? value.origin.values : null;
  }
  static knownRejected(value, contract, active = new Set()) {
    if (active.has(value)) return false;
    const primitive = value instanceof OperationValue ? value.constantNumber : value;
    if (primitive instanceof LiteralValue) return !contract.acceptsNumber(primitive.value);
    const alternatives = this.alternatives(value);
    if (alternatives !== null) {
      const next = new Set(active); next.add(value);
      return alternatives.length > 0 && alternatives.every(candidate => this.knownRejected(candidate, contract, next));
    }
    return value instanceof ObjectValue || value instanceof ClassValue || value instanceof CallableValue
      || value instanceof SourceArrayValue || value instanceof SourceWeakCollectionValue || value instanceof BuiltinValue
      || value instanceof PrimitiveConversionValue || value instanceof SourceBooleanValue
      || value instanceof OperationValue && value.booleanResult;
  }
  static inspect(value, contract, origins, active = new Set()) {
    if (active.has(value)) return null;
    const primitive = value instanceof OperationValue ? value.constantNumber : value;
    if (primitive instanceof LiteralValue) return contract.acceptsNumber(primitive.value) ? new this(value, false) : null;
    if (value instanceof AuthorityValue && value.origin instanceof SourceNativePermissionInstanceValue
      && origins.nativePermissionValid(value.origin)) return new this(value, false);
    const alternatives = this.alternatives(value);
    if (alternatives !== null) {
      const next = new Set(active); next.add(value);
      const completions = alternatives.map(candidate => this.inspect(candidate, contract, origins, next));
      if (alternatives.some((candidate, index) => completions[index] === null && !this.knownRejected(candidate, contract, next))) return null;
      const normal = completions.filter(completion => completion !== null);
      return normal.length ? new this(value, normal.some(completion => completion.mayThrow) || normal.length !== alternatives.length) : null;
    }
    const callerData = (value.constructor === UnknownValue || value.constructor === SourceEffectInput)
      && value.reason === "runtime value" && !value.isSensitive;
    return callerData ? new this(value, true) : null;
  }
}
/** A possible normal result of the inspected constructor, never a structural lookalike. */
class SourceNativePermissionInstanceValue extends ClassValue {
  constructor(source, args, contract, state, completion) {
    super(source.module, source.declaration, true, source.trace, args, source.environment);
    if (!(completion instanceof SourceNativePermissionConstructorInput)) throw new TypeError("native metadata normal constructor completion required");
    Object.assign(this, { source, contract, state, completion, prototypeValue: source.prototypeValue });
  }
  get ownSensitive() { return true; }
  get sensitivityInputs() { return [...this.arguments, this.state, this.source.state, this.prototypeValue.state]; }
}
class SourceNativePermissionMethodValue extends OsValue {
  constructor(owner, contract, member) { super(owner.trace); Object.assign(this, { owner, contract, member }); }
  get ownSensitive() { return true; }
  get sensitivityInputs() { return [this.owner]; }
}
class SourceClassPrototypeValue extends ClassValue {
  constructor(source, origins) {
    super(source.module, source.declaration, true, source.trace, [], source.environment);
    this.source = source;
    this.state = new SourceObjectState(new SourceExpression(source.module, source.declaration.tokens), source.environment);
    this.effects = origins.classEffectsFor(this);
  }
  get ownSensitive() { return this.source instanceof SourceNativePermissionClassValue || super.ownSensitive; }
}

/** One constructor invocation owns its this binding and initialization phase. */
class SourceConstructionFrame {
  constructor(source, instance, parent, token, module, environment) {
    if (!(source instanceof ClassValue) || !(instance instanceof ClassValue)) throw new TypeError("class construction context required");
    Object.assign(this, { source, instance, parent, token, module, environment });
    this.initialized = parent === null;
    this.fieldsInitialized = false;
    this.unprovenControl = false;
  }
  fork() {
    const frame = new SourceConstructionFrame(this.source, this.instance, this.parent, this.token, this.module, this.environment);
    frame.initialized = this.initialized;
    frame.fieldsInitialized = this.fieldsInitialized;
    frame.unprovenControl = this.unprovenControl;
    return frame;
  }
}
/** Reuse the bounded route reader; a possible super call cannot initialize every path. */
class SourceConstructionControl {
  constructor(origins, callable, environment, selectedRoute) {
    this.route = selectedRoute;
    this.unknown = false;
    const declaration = callable.declaration;
    const body = declaration.bodyTokens();
    const tokens = body ?? declaration.expressionBodyTokens() ?? [];
    const calls = tokens.filter((token, index) => token.value === "super" && tokens[index + 1]?.value === "("
      && (body === null || declaration.ownsBodyToken(token)));
    if (calls.length === 0) return;
    if (body === null) {
      this.unknown = calls.some(token => this.guarded(tokens.slice(0, tokens.indexOf(token))));
      return;
    }
    const boundary = new PlatformImplementationBoundary(declaration, condition => {
      origins.scan(callable.module, condition, environment);
      return origins.conditionExpression(callable.module, condition, environment);
    });
    const route = selectedRoute ? boundary.routes.find(route => route.platform === selectedRoute.platform) : boundary.routes[0];
    this.unknown = !boundary.modeled || route.unknown || !selectedRoute && boundary.routes.some(other => other.unknown
      || other.terminal !== route.terminal || other.tokens.length !== route.tokens.length
      || other.tokens.some((token, index) => token !== route.tokens[index]));
    this.unknown ||= calls.some(token => route.tokens.includes(token) && this.guarded(route.prefixBefore(token)));
    if (!this.unknown) this.route = route;
  }
  guarded(tokens) {
    return tokens.some((token, index) => token.kind === "punctuation" && (token.value === "?"
      || ["&&", "||"].includes(`${token.value}${tokens[index + 1]?.value}`)));
  }
}
/** A method's home object remains lexical when its receiver is inherited or borrowed. */
/** A static initializer exposes only fields whose definition has been reached. */
class SourceStaticInitialization {
  constructor(source, token) {
    if (!(source instanceof ClassValue) || source.instance) throw new TypeError("static initialization source required");
    Object.assign(this, { source, token });
    Object.freeze(this);
  }
  contains(source) {
    return this.source.declaration.token === source.declaration.token && this.source.environment === source.environment;
  }
  reaches(field) { return (field.fieldToken ?? field.token).offset < this.token.offset; }
}
class SourceClassHome {
  constructor(source, instance) {
    if (!(source instanceof ClassValue) || typeof instance !== "boolean") throw new TypeError("source class home required");
    Object.assign(this, { source, instance });
    Object.freeze(this);
  }
  matches(other) {
    return other instanceof SourceClassHome && this.instance === other.instance
      && this.source.declaration.token === other.source.declaration.token && this.source.environment === other.source.environment;
  }
  selectContext(trie, instanceContext) {
    return trie.select([[this.source.declaration.token, this.source.environment], [SourceClassHome, instanceContext]]);
  }
}
class SourceSuperReferenceValue extends OsValue {
  constructor(home, receiver, frame = null) {
    super(home.source.trace);
    if (!(home instanceof SourceClassHome)) throw new TypeError("lexical super home required");
    Object.assign(this, { home, receiver, frame });
  }
  get sensitivityInputs() { return [this.home.source, ...(this.receiver instanceof OsValue ? [this.receiver] : [])]; }
}
class SourceSuperConstructorValue extends SourceSuperReferenceValue {
  constructor(frame) { super(new SourceClassHome(frame.source, true), frame.instance, frame); }
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
  static environmentClone(value) {
    const parameters = this.ordinaryFunction(value, 1);
    if (!parameters || parameters[0].length !== 1 || parameters[0][0].kind !== "identifier") return false;
    const input = parameters[0][0].value;
    return this.matches(value.declaration.bodyTokens() ?? [], `return ${input} === null ? null : { ...${input} };`);
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
    if (!initialize || !options) return null;
    const environmentClone = (options.bodyTokens() ?? []).find((token, index, tokens) => token.kind === "identifier"
      && tokens[index - 2]?.value === "env" && tokens[index - 1]?.value === ":");
    if (!environmentClone || !this.environmentClone(origins.identifier(parent.module, environmentClone))
      || !options.matchesDeclaration(`processOptions() {
        return { ...(this.cwd !== null && { cwd: this.cwd }), ...(this.env !== null && { env: ${environmentClone.value}(this.env) }), stdio: this.stdio };
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
  constructor(source, arguments_, contract, authority) {
    super(source.module, source.declaration, true, source.trace, arguments_, source.environment);
    if (!(authority instanceof SourceInvocationAuthority)) throw new TypeError("invocation allocation authority required");
    this.contract = contract;
    this.authority = authority;
    this.input = arguments_[0] ?? new UnknownValue();
  }
}
/** An exact allocation loses its closed-method proof after mutation or escape. */
class SourceInvocationAuthority {
  #valid = true;
  constructor(declaration) {
    if (!(declaration instanceof SourceDeclaration)) throw new TypeError("invocation declaration required");
    this.declaration = declaration;
  }
  invalidate() { const changed = this.#valid; this.#valid = false; return changed; }
  get valid() { return this.#valid; }
}
class SourceInvocationAuthorities {
  #allocations = new WeakMap();
  #classes = new WeakSet();
  #revision = 0;
  get revision() { return this.#revision; }
  allocation(token, environment, declaration) {
    if (!this.#allocations.has(token)) this.#allocations.set(token, new WeakMap());
    const contexts = this.#allocations.get(token);
    if (!contexts.has(environment)) contexts.set(environment, new WeakMap());
    const declarations = contexts.get(environment);
    if (!declarations.has(declaration.token)) declarations.set(declaration.token, new SourceInvocationAuthority(declaration));
    return declarations.get(declaration.token);
  }
  invalidate(value, shared = false, parent = null) {
    if (value instanceof InvocationInstanceValue && !shared) {
      if (value.authority.invalidate()) this.#revision++;
    } else if (value instanceof ClassValue && !this.#classes.has(value.declaration.token)) {
      this.#classes.add(value.declaration.token); this.#revision++;
    }
    if (shared && parent !== null && !this.#classes.has(parent.declaration.token)) {
      this.#classes.add(parent.declaration.token); this.#revision++;
    }
  }
  valid(value) {
    return value.authority.valid && !this.#classes.has(value.declaration.token)
      && !this.#classes.has(value.contract.parent.source.declaration.token);
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
/** Ordinary internal integrity operations do not read property values. */
class SourceNativeIntegrityOperation {
  static supports(method) { return ["isFrozen", "isSealed", "isExtensible", "preventExtensions"].includes(method); }
  constructor(method, input) {
    if (!SourceNativeIntegrityOperation.supports(method) || !(input instanceof OsValue)) throw new TypeError("native integrity operation required");
    Object.assign(this, { method, input });
    Object.freeze(this);
  }
  static inspect(callee, args) {
    if (!(callee instanceof BuiltinValue) || callee.builtin !== "Object" || callee.members.length !== 1
      || !this.supports(callee.member)) return null;
    const input = args[0] ?? new LiteralValue(undefined);
    // Unknown constructions may be proxies. Only actual source allocations and
    // literal primitives have the ordinary internal methods inspected here.
    return input instanceof LiteralValue || input.allocationState !== null
      || input instanceof ClassValue && !input.instance
      ? new this(callee.member, input) : null;
  }
  result() { return this.method === "preventExtensions" ? this.input : new SourceBooleanValue(); }
}

class DerivedValue extends OsValue {
  constructor(origin, details = null) {
    super(origin.trace);
    if (!(origin instanceof OsValue)) throw new TypeError("source value origin required");
    Object.assign(this, { origin, details });
  }
}
class PrimitiveConversionValue extends DerivedValue {
  static inspect(origin, constructed) {
    if (constructed) return null;
    const primitive = origin instanceof OperationValue
      ? origin.constantNumber ?? (origin.booleanResult ? new SourceBooleanValue() : null) : origin;
    if (primitive === null || primitive instanceof ConcatenationValue) return null;
    if (primitive instanceof LiteralValue) {
      // Only source primitive data reaches this conversion. Never execute an
      // inspected object's getters, valueOf or toPrimitive in the analyzer.
      if (!["string", "number", "bigint", "boolean"].includes(typeof primitive.value)) return null;
      try { BigInt(primitive.value); }
      catch { return null; }
    }
    return new this(origin);
  }
  static sameLiteralOrigin(left, right) {
    return left instanceof this && right instanceof this && left.origin instanceof LiteralValue
      && right.origin instanceof LiteralValue && Object.is(left.origin.value, right.origin.value);
  }
  get sensitivityInputs() { return [this.origin]; }
}
class SensitiveValue extends DerivedValue { get ownSensitive() { return true; } }
class PlatformValue extends SensitiveValue {}
class AuthorityValue extends SensitiveValue {}
class StatValue extends SensitiveValue {
  get allocationState() { return this.state; }
  constructor(origin, input, state) {
    super(origin, input);
    if (!(state instanceof SourceObjectState)) throw new TypeError("native stat allocation state required");
    this.state = state;
  }
  get intrinsicSyntax() { return true; }
  get sensitivityInputs() { return [...super.sensitivityInputs, this.state]; }
}
class StatfsValue extends SensitiveValue { get intrinsicSyntax() { return true; } }
class FileDescriptorValue extends SensitiveValue {}
class UrlPathnameValue extends SensitiveValue {}
class ShellTextValue extends SensitiveValue {}
/** Native join preserves shell provenance while exposing only proven constant text. */
class SourceJoinedTextValue extends ShellTextValue {
  constructor(origin, separator) {
    super(origin);
    if (!(separator instanceof OsValue)) throw new TypeError("source join separator required");
    this.separator = separator;
  }
  get text() {
    return fixedSequence(this.origin) && this.origin.values.every(value => value instanceof LiteralValue)
      && this.separator instanceof LiteralValue ? this.origin.values.map(value => value.value).join(this.separator.value) : null;
  }
  get sensitivityInputs() { return [this.origin, this.separator]; }
}
/** One genuine portable native null-device constant, retaining its read provenance. */
class DevNullValue extends DerivedValue {
  static sameNativeOrigin(left, right) {
    if (![left, right].every(value => value.constructor === DevNullValue && value.details === null
      && value.origin.constructor === BuiltinValue && value.origin.builtin === "os"
      && value.origin.members.length === 1 && value.origin.member === "devNull")) return false;
    return [[left, right], [left.origin, right.origin]].every(([first, second]) =>
      first.trace.length === second.trace.length && first.trace.every((part, index) => part === second.trace[index]));
  }
}
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
/** Closed native string search dispatch; every source replacer is interpreted normally. */
/** Genuine literal regex protocol without running the source pattern. */
class SourceRegexProtocol {
  constructor(owner, origins) {
    if (!(owner instanceof RegexLiteralValue)) throw new TypeError("source regex allocation required");
    this.owner = origins.objectState(owner);
    this.origins = origins;
    origins.effectSummary?.readState(owner.state);
  }
  get unchanged() {
    return !this.owner.state.hasWrites
      && !this.origins.nativeMutations.affects(new BuiltinValue("RegExp", ["prototype"]))
      && !this.origins.nativeMutations.affects(new BuiltinValue("Object", ["prototype"]));
  }
  get portableFlags() {
    const flags = [...this.owner.token.flags];
    return new Set(flags).size === flags.length && flags.every(flag => "dgimsuy".includes(flag));
  }
  get writableLastIndex() {
    return !this.owner.state.frozen || ![...this.owner.token.flags].some(flag => flag === "g" || flag === "y");
  }
}
class SourceRegexMethodValue extends DerivedValue {
  constructor(owner, name) {
    if (!(owner instanceof RegexLiteralValue) || !["test", "exec"].includes(name)) throw new TypeError("native regex method required");
    super(owner, name);
  }
  get sensitivityInputs() { return [this.origin]; }
}
/** Unknown native integer metadata, never an object, callable or literal index proof. */
class SourceRegexIntegerValue extends OsValue {}
class SourceRegexMatchValue extends SourceProvenanceResult {
  constructor(input, state) {
    if (!(input instanceof OsValue) || !(state instanceof SourceObjectState)) throw new TypeError("native match input and allocation required");
    const capture = new SourceRegexCaptureValue(input);
    super([input, capture]);
    Object.assign(this, { input, capture, state });
  }
  get allocationState() { return this.state; }
  get sensitivityInputs() { return [...this.inputs, this.state]; }
}

class SourceStringReplacement {
  static supports(callee) {
    return (callee instanceof StringMethodValue || callee instanceof RetainedStringMethodValue)
      && ["replace", "replaceAll"].includes(callee.details);
  }
  constructor(callee, args, receiver, source = null, constructed = false) {
    if (!SourceStringReplacement.supports(callee)) throw new TypeError("string replacement method required");
    Object.assign(this, { callee, args, receiver, source, constructed });
  }
  get receiverProven() {
    const owner = this.callee.origin, receiver = this.receiver;
    return SourceStringValue.matches(owner) && (receiver === owner
      || owner instanceof LiteralValue && receiver instanceof LiteralValue && receiver.value === owner.value);
  }
  nativeUnchanged(origins) {
    return !origins.nativeMutations.affects(new BuiltinValue("String", ["prototype", this.callee.details]))
      && !origins.nativeMutations.affects(new BuiltinValue("String", ["prototype", "__proto__"]))
      && !origins.nativeMutations.affects(new BuiltinValue("Object", ["prototype"]))
      && !origins.nativeMutations.affects(new BuiltinValue("Object", ["prototype", "__proto__"]));
  }
  matches(origins) {
    const owner = this.callee.origin, search = this.args[0];
    return this.receiverProven && this.nativeUnchanged(origins)
      && owner instanceof LiteralValue && search instanceof LiteralValue && typeof search.value === "string"
      ? new SourceStringMatches(owner, search, this.callee.details === "replaceAll") : null;
  }
  evaluate(origins, token, module, environment) {
    const { callee, args, receiver } = this;
    const owner = callee.origin;
    const search = args[0] ?? new LiteralValue(undefined);
    const replacement = args[1] ?? new LiteralValue(undefined);
    const incomplete = reason => {
      const unknown = new UnknownValue(reason, true, [...callee.trace, ...args.flatMap(value => value.trace)]);
      origins.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([owner, ...args, unknown], reason);
    };
    if (this.constructed) return incomplete("native string replacement method is not a constructor");
    if (!this.receiverProven) {
      return incomplete("string replacement has no inspected actual primitive receiver");
    }
    // The minimum runtime also performs @@replace lookup on primitive search
    // values. Prototype hooks and prototype-chain changes invalidate this path.
    if (!this.nativeUnchanged(origins)) {
      return incomplete("string replacement native method or protocol may have changed");
    }
    if (search instanceof RegexLiteralValue) {
      const protocol = new SourceRegexProtocol(search, origins);
      if (!protocol.unchanged) {
        return incomplete("regex replacement protocol may have changed");
      }
      if (!protocol.portableFlags) {
        return incomplete("regex flags have no native contract across supported runtimes");
      }
      if (callee.details === "replaceAll" && !search.token.flags.includes("g")) return incomplete("replaceAll requires a global regex");
      if (!protocol.unchanged) return incomplete("regex input conversion changed the native protocol");
      if (!protocol.writableLastIndex) return incomplete("frozen regex lastIndex cannot be updated by native execution");
      if (!(replacement instanceof LiteralValue)) return incomplete("regex replacer requires uninspected match and capture arguments");
      const converted = origins.stringValue([replacement], token, module);
      if (!(converted instanceof LiteralValue && typeof converted.value === "string")) return incomplete("regex replacement conversion has no inspected primitive result");
      // Native regex matching is not executed by the audit. Both source text and
      // replacement text remain possible origins of the transformed result.
      return new SourceStringValue(new SourceAlternativeValues([owner, converted], [...owner.trace, ...converted.trace]));
    }
    if (!(search instanceof LiteralValue && typeof search.value === "string")) {
      return incomplete("string replacement search has no inspected native string protocol");
    }
    const callable = replacement instanceof CallableValue
      || replacement instanceof BuiltinValue && replacement.builtin === "String" && replacement.members.length === 0
      || replacement instanceof SourceAlternativeValues && replacement.values.every(value => value instanceof CallableValue);
    if (!callable) {
      if (!(replacement instanceof LiteralValue)) return incomplete("string replacement value has unresolved callable or conversion effects");
      const converted = origins.stringValue([replacement], token, module);
      if (!(converted instanceof LiteralValue && typeof converted.value === "string")) return incomplete("string replacement conversion has no inspected primitive result");
      // Only inspected primitive analyzer data reaches this native operation;
      // no source RegExp, replacement function or conversion hook is executed.
      if (!(owner instanceof LiteralValue)) return new SourceStringValue(
        new SourceAlternativeValues([owner, converted], [...owner.trace, ...converted.trace]));
      return new LiteralValue(owner.value[callee.details](search.value, converted.value), [...owner.trace, ...converted.trace]);
    }
    if (!(owner instanceof LiteralValue)) return incomplete("string callback has no inspected match positions");
    const matches = this.matches(origins);
    if (this.source !== null) origins.closedCallInputs.rememberCallback(this.source, replacement);
    const results = [];
    let text = "", previous = 0, exact = true;
    for (const match of matches) {
      origins.consumeWork(module, token);
      const result = origins.invoke(replacement, match.arguments,
        token, module, environment, false, null);
      const converted = origins.stringValue([result], token, module);
      results.push(converted);
      if (converted instanceof LiteralValue && typeof converted.value === "string") text += owner.value.slice(previous, match.position) + converted.value;
      else exact = false;
      previous = match.position + search.value.length;
    }
    if (exact) return new LiteralValue(text + owner.value.slice(previous), [...owner.trace, ...results.flatMap(value => value.trace)]);
    return new SourceStringValue(new SourceAlternativeValues([owner, ...results], [...owner.trace, ...results.flatMap(value => value.trace)]));
  }
}

class JoinMethodValue extends DerivedValue {}
class SourceArrayMethodValue extends DerivedValue {
  constructor(owner, name, token, module) { super(owner, name); this.token = token; this.module = module; }
  get sensitivityInputs() { return [this.origin]; }
}
class DescriptorMethodValue extends DerivedValue {}
class ChildMethodValue extends DerivedValue {}
class ConcatenationValue extends DerivedValue { get sensitivityInputs() { return [this.origin]; } }
/** One pending pair in a source-value proof, with explicit cycle lifetime. */
class SourceValuePair {
  constructor(left, right, rule, leaving = false) {
    if (!(left instanceof OsValue) || !(right instanceof OsValue) || typeof rule !== "function"
      || typeof leaving !== "boolean") throw new TypeError("source-value interpretation pair required");
    Object.assign(this, { left, right, rule, leaving });
    Object.freeze(this);
  }
  inspect(comparison) { return this.rule.call(comparison, this.left, this.right); }
  leave() { return new SourceValuePair(this.left, this.right, this.rule, true); }
}
/** One comparison lifetime; neither input contexts nor results are cached. */
class SourceValuePairProof {
  constructor() { this.pending = []; this.active = new Map(); this.completed = new Map(); }
  same(left, right, rule) {
    this.add(left, right, rule);
    while (this.pending.length) {
      const pair = this.pending.pop();
      if (pair.leaving) {
        this.active.get(pair.left).delete(pair.right);
        if (!this.completed.has(pair.left)) this.completed.set(pair.left, new Map());
        const rights = this.completed.get(pair.left);
        if (!rights.has(pair.right)) rights.set(pair.right, new Set());
        rights.get(pair.right).add(pair.rule);
        continue;
      }
      if (this.active.get(pair.left)?.has(pair.right)) return false;
      if (this.completed.get(pair.left)?.get(pair.right)?.has(pair.rule)) continue;
      if (!this.active.has(pair.left)) this.active.set(pair.left, new Set());
      const rights = this.active.get(pair.left);
      rights.add(pair.right);
      this.pending.push(pair.leave());
      if (!pair.inspect(this)) return false;
    }
    return true;
  }
  add(left, right, rule) { this.pending.push(new SourceValuePair(left, right, rule)); }
  sameTrace(left, right) {
    return left.trace.length === right.trace.length && left.trace.every((part, index) => part === right.trace[index]);
  }
}
/** Error.message grammar remains separate from the shared comparison lifetime. */
class SourceErrorMessageValues extends SourceValuePairProof {
  same(left, right) { return super.same(left, right, this.template); }
  static guardLeaf(value) {
    return value.constructor === LiteralValue
      && (value.value === null || ["undefined", "string", "number", "bigint", "boolean"].includes(typeof value.value))
      || value.constructor === UnknownValue && value.reason === "runtime value" && !value.isSensitive;
  }
  scalar(left, right, eligible) {
    if (left.constructor !== right.constructor) return false;
    if (left.constructor === SourceDefaultValue) {
      return left.origin.values.length === 2 && right.origin.values.length === 2
        && left.origin.values.every(eligible) && right.origin.values.every(eligible)
        && SourceDefaultValue.sameOrigins(left, right);
    }
    if (!eligible(left) || !eligible(right)) return false;
    if (left.constructor === UnknownValue) return new SourceUnknownContextIdentity(left).key === new SourceUnknownContextIdentity(right).key;
    return LiteralValue.sameOrigins(left, right);
  }
  template(left, right) {
    if (left.constructor !== TemplateValue || right.constructor !== TemplateValue || left.token !== right.token
      || left.raw !== right.raw || left.details !== right.details || !this.sameTrace(left, right)
      || left.origin.constructor !== SequenceValue || right.origin.constructor !== SequenceValue
      || !this.sameTrace(left.origin, right.origin) || left.origin.values.length !== right.origin.values.length) return false;
    left.origin.values.forEach((value, index) => this.add(value, right.origin.values[index], this.part));
    return true;
  }
  part(left, right) {
    if (left.constructor !== right.constructor) return false;
    if (left.constructor === TemplateValue) return this.template(left, right);
    if (left.constructor === UncertainValue) return this.selection(left, right);
    return this.scalar(left, right, TemplateValue.messageLeaf);
  }
  selection(left, right) {
    if (left.constructor !== UncertainValue || right.constructor !== UncertainValue
      || left.reason !== right.reason || left.isSensitive !== right.isSensitive || !this.sameTrace(left, right)
      || left.origin.constructor !== SequenceValue || right.origin.constructor !== SequenceValue
      || !this.sameTrace(left.origin, right.origin) || left.origin.values.length !== 2 || right.origin.values.length !== 2) return false;
    const a = left.inputSelection, b = right.inputSelection;
    if (a?.constructor !== SourceCallInputSelection || b?.constructor !== SourceCallInputSelection || !a.hasSameDefinition(b)
      || !a.values.every((value, index) => value === left.origin.values[index])
      || !b.values.every((value, index) => value === right.origin.values[index])) return false;
    this.add(a.condition, b.condition, this.condition);
    a.values.forEach((value, index) => this.add(value, b.values[index], this.branch));
    return true;
  }
  condition(left, right) {
    if (left.constructor !== OperationValue || right.constructor !== OperationValue
      || !["===", "!=="].includes(left.operator) || left.operator !== right.operator
      || left.values.length !== 2 || right.values.length !== 2 || !this.sameTrace(left, right)) return false;
    left.values.forEach((value, index) => this.add(value, right.values[index], this.operand));
    return true;
  }
  operand(left, right) { return this.scalar(left, right, SourceErrorMessageValues.guardLeaf); }
  branch(left, right) {
    if (left.constructor !== right.constructor) return false;
    if (left.constructor === TemplateValue) return this.template(left, right);
    // A bare unknown is not an inspected branch result. A default retains both
    // its supplied ordinary leaf and its approved fallback interpretation.
    return (left.constructor === LiteralValue || left.constructor === SourceDefaultValue)
      && this.scalar(left, right, SourceErrorMessageValues.guardLeaf);
  }
}

class TemplateValue extends DerivedValue {
  static messageLeaf(value) {
    return value.constructor === UnknownValue || value.constructor === LiteralValue
      && (value.value === null || !["object", "function"].includes(typeof value.value));
  }
  static sameMessageOrigins(left, right) {
    return new SourceErrorMessageValues().same(left, right);
  }

  constructor(origin, text, token, raw) {
    if (!(origin instanceof SequenceValue) || typeof text !== "string" || !(token instanceof SourceTemplateToken)
      || token.interpolations.length !== origin.values.length || typeof raw !== "boolean") throw new TypeError("source template interpretation required");
    super(origin, text);
    this.token = token;
    this.raw = raw;
  }
  get sensitivityInputs() { return [this.origin]; }
}
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
  static sameAbstractOrigins(left, right) {
    return left.constructor === ComposedPathValue && right.constructor === ComposedPathValue
      && new SourceComposedPathOrigins().same(left, right);
  }
  get ownSensitive() { return pseudoPathUse(this) !== null; }
  constructor(interpretations, trace, consumesPosix) {
    if (interpretations.length !== 2 || interpretations.some((value) => !(value instanceof PathInterpretation))) throw new TypeError("both native path interpretations required");
    if (typeof consumesPosix !== "boolean") throw new TypeError("native path conversion contract required");
    super([...new Set(interpretations.flatMap((value) => value.values))], trace);
    this.interpretations = interpretations;
    this.consumesPosix = consumesPosix;
  }
}
/** Exact audit abstraction only: unresolved native ambient inputs stay unresolved. */
class SourceComposedPathOrigins extends SourceValuePairProof {
  same(left, right) { return super.same(left, right, this.path); }
  path(left, right) {
    if (left.constructor !== ComposedPathValue || right.constructor !== ComposedPathValue
      || left.consumesPosix !== right.consumesPosix || !this.sameTrace(left, right)
      || left.callContext !== right.callContext || left.values.length !== right.values.length
      || left.interpretations.length !== right.interpretations.length) return false;
    for (const [index, first] of left.interpretations.entries()) {
      const second = right.interpretations[index];
      if (first.constructor !== PathInterpretation || second.constructor !== PathInterpretation
        || first.syntax !== second.syntax || first.text !== second.text
        || first.values.length !== second.values.length) return false;
      first.values.forEach((value, index) => this.add(value, second.values[index], this.part));
    }
    // The generated union is an observed dependency list, not an equality key.
    left.values.forEach((value, index) => this.add(value, right.values[index], this.part));
    return true;
  }
  part(left, right) {
    if (left.constructor === ComposedPathValue || right.constructor === ComposedPathValue) return this.path(left, right);
    return left === right || LiteralValue.sameOrigins(left, right)
      || SourceDefaultValue.sameOrigins(left, right) || UncertainValue.sameOrigins(left, right);
  }
}
/** Unknown selection retains every possible OS/path origin until its consumer. */
class UncertainValue extends UnknownValue {
  static sameOrigins(left, right) {
    // Equal wrapper interpretations retain the same live dependency edges.
    // This neither flattens alternatives nor turns an unknown into a value.
    return left.constructor === UncertainValue && right.constructor === UncertainValue
      && left.reason === right.reason && left.isSensitive === right.isSensitive
      && left.trace.length === right.trace.length && left.trace.every((part, index) => part === right.trace[index])
      && SourceCallInputSelection.same(left.inputSelection, right.inputSelection)
      && left.origin.values.length === right.origin.values.length
      && left.origin.values.every((value, index) => value === right.origin.values[index]);
  }
  constructor(origin, reason, inputSelection = null) {
    if (!(origin instanceof SequenceValue) || inputSelection !== null && !(inputSelection instanceof SourceCallInputSelection)) {
      throw new TypeError("source value alternatives and optional input selection required");
    }
    super(reason, hasOsSensitiveOrigin(origin), origin.trace);
    Object.assign(this, { origin, inputSelection });
  }
  get sensitivityInputs() { return [this.origin]; }
  get intrinsicSyntax() { return false; }
}
/** Supplied undefined is replaced; no nominal or sequence authority is inferred. */
class SourceDefaultValue extends UncertainValue {
  static sameOrigins(left, right) {
    if (left.constructor !== this || right.constructor !== this || left.defined !== right.defined
      || left.isSensitive !== right.isSensitive || left.trace.length !== right.trace.length
      || !left.trace.every((part, index) => part === right.trace[index])) return false;
    return left.origin.values.every((value, index) => {
      const other = right.origin.values[index];
      if (value === other) return true;
      if (value.constructor === UnknownValue && other.constructor === UnknownValue) {
        return new SourceUnknownContextIdentity(value).key === new SourceUnknownContextIdentity(other).key;
      }
      return LiteralValue.sameOrigins(value, other);
    });
  }
  constructor(supplied, fallback) {
    super(new SequenceValue([supplied, fallback], [...supplied.trace, ...fallback.trace]),
      "binding pattern default has no single inspected value");
    this.defined = fallback instanceof SourceConstructedValue || fallback instanceof ClassValue
      || fallback instanceof ObjectValue || fallback instanceof LiteralValue && fallback.value !== undefined;
  }
}

/** Direct immutable lexical captures identify an equivalent abstract effect call. */
/** No object identity or provenance edges: only the exact ordinary unknown domain. */
class SourceUnknownContextIdentity {
  constructor(value) {
    if (value.constructor !== UnknownValue) throw new TypeError("ordinary unknown context required");
    this.key = JSON.stringify([value.reason, value.isSensitive, value.trace]);
    Object.freeze(this);
  }
}
class SourceEffectContext {
  #children = null;
  #unknowns = null;
  identity(value) {
    // This merges interpretation contexts, never values or successful verdicts.
    // EffectResult, captures, alternatives, allocations and nominal authorities
    // retain reference identity and every dependency edge.
    if (value.constructor !== UnknownValue) return value;
    const identity = new SourceUnknownContextIdentity(value);
    const unknowns = this.#unknowns ??= new Map();
    if (!unknowns.has(identity.key)) unknowns.set(identity.key, identity);
    return unknowns.get(identity.key);
  }
  select(bindings) {
    let context = this;
    for (const [binding, value] of bindings) for (const key of [binding, this.identity(value)]) {
      const children = context.#children ??= new WeakMap();
      if (!children.has(key)) children.set(key, new SourceEffectContext());
      context = children.get(key);
    }
    return context;
  }
}
/** Equal unresolved construction interpretations retain the same input graph, never a native contract. */
class SourceConstructionIdentity {
  constructor(state, inputs, nativeRevision) {
    if (!(state instanceof SourceObjectState) || !(inputs instanceof SourceEffectContext)) throw new TypeError("source construction context required");
    Object.assign(this, { state, inputs, nativeRevision, environmentRevision: state.environment.revision });
    Object.freeze(this);
  }
  matches(other) {
    return other instanceof SourceConstructionIdentity && this.state === other.state && this.inputs === other.inputs
      && this.nativeRevision === other.nativeRevision && this.environmentRevision === other.environmentRevision;
  }
  static same(left, right) {
    return left.constructor === SourceConstructedValue && right.constructor === SourceConstructedValue
      && left.constructionIdentity instanceof SourceConstructionIdentity
      && left.constructionIdentity.matches(right.constructionIdentity);
  }
}
/** A projected method and its exact receiver stay paired across selection. */
class SourceMemberCandidate {
  constructor(receiver, value) {
    if (!(receiver instanceof OsValue) || !(value instanceof OsValue)) throw new TypeError("source member candidate required");
    Object.assign(this, { receiver, value });
    Object.freeze(this);
  }
}
class SourceAlternativeValues extends SourceValues {
  constructor(values, trace = [], inputSelection = null) {
    super(values, trace);
    if (inputSelection !== null && !(inputSelection instanceof SourceCallInputSelection)) throw new TypeError("conditional input selection required");
    this.inputSelection = inputSelection;
  }
  get ownSensitive() { return pseudoPathUse(this) !== null; }
}
class SourceNativeAlternatives extends SourceAlternativeValues {
  constructor(values, inputSelection = null) {
    if (!values.length || values.some(value => !(value instanceof BuiltinValue))) throw new TypeError("resolved native alternatives required");
    super(values, values.flatMap(value => value.trace), inputSelection);
  }
}
class SourceCallResults extends SourceAlternativeValues {}
class SourceMemberAlternatives extends SourceAlternativeValues {
  constructor(candidates, reason, owner) {
    if (!(owner instanceof OsValue)) throw new TypeError("member projection owner required");
    if (!Array.isArray(candidates) || candidates.length === 0 || candidates.some(candidate => !(candidate instanceof SourceMemberCandidate))) {
      throw new TypeError("source member candidates required");
    }
    // Nested selections already carry their own concrete receivers. Flatten
    // only that proven projection structure, preserving every unknown leaf.
    candidates = candidates.flatMap(candidate => candidate.value instanceof SourceMemberAlternatives
      ? candidate.value.candidates.map(nested => candidate.receiver === candidate.value.owner
        ? nested : new SourceMemberCandidate(candidate.receiver, nested.value)) : [candidate]);
    super(candidates.map(candidate => candidate.value), candidates.flatMap(candidate => candidate.value.trace));
    this.reason = reason;
    this.candidates = candidates;
    this.owner = owner;
  }
  get callsResolved() { return this.candidates.every(candidate => candidate.value instanceof BuiltinValue || candidate.value instanceof CallableValue || candidate.value instanceof SourceWeakCollectionMethodValue); }
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
/** Normal completion of an inspected conversion/replacement is primitive text. */
class SourceStringValue extends TransformedStringValue {
  static sameOrigins(left, right) {
    return left.constructor === SourceStringValue && right.constructor === SourceStringValue
      && left.details === right.details && left.trace.length === right.trace.length
      && left.trace.every((part, index) => part === right.trace[index])
      && left.messageInterpretation instanceof SourceErrorMessageInterpretation
      && left.messageInterpretation.same(right.messageInterpretation, left.origin, right.origin);
  }

  static matches(value) {
    return value instanceof LiteralValue && typeof value.value === "string"
      || value instanceof SourceStringValue || value instanceof NativePathValue || value instanceof UrlPathnameValue
      || value instanceof SourceJoinedTextValue
      || (value instanceof WindowsPathValue || value instanceof PosixPathValue)
        && value.origin instanceof BuiltinValue && value.origin.member !== "parse";
  }
}
/** Unknown substring content is not an inspected native filesystem path. */
class SourceRegexCaptureValue extends SourceStringValue {}
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

/** An array binding step requires native iteration, not an array-like property lookup. */
class BindingArrayElement {
  constructor(index) {
    if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("binding iterator position required");
    this.index = index;
  }
}
/** One projection contract for declarations, helper parameters and constructors. */
class BindingProjection {
  constructor(token, members = [], complete = true, defaults = []) {
    if (!token || !Array.isArray(members) || !Array.isArray(defaults)
      || defaults.some(value => !(value instanceof BindingDefault))) throw new TypeError("source binding target required");
    Object.assign(this, { token, members, complete, defaults });
  }
}

class BindingTarget extends BindingProjection {
  constructor(token, members = [], complete = true, defaults = []) {
    if (token?.kind !== "identifier") throw new TypeError("source binding name required");
    super(token, members, complete, defaults);
  }
}
/** Iterator acquisition/close exists even when a pattern binds no names. */
class BindingIteration extends BindingProjection {
  constructor(token, members, complete, defaults) {
    if (token?.value !== "[") throw new TypeError("array binding initialization required");
    super(token, members, complete, defaults);
  }
}
class BindingPattern {
  constructor(tokens) {
    this.iterations = [];
    this.targets = bindingTargets(tokens, [], true, [], this.iterations);
  }
}
class BindingInitialization {
  constructor(module, tokens, pattern) {
    if (!(module instanceof SourceModule) || !Array.isArray(tokens) || !(pattern instanceof BindingPattern)) throw new TypeError("source binding initialization required");
    Object.assign(this, {module, tokens, pattern});
  }
}

function bindingTargets(pattern, members = [], complete = true, defaults = [], iterations = []) {
  pattern = strip(pattern);
  const equal = endOfExpression(pattern, 0, new Set(["="]));
  if (equal < pattern.length) {
    const left = pattern.slice(0, equal);
    const named = left.length === 1 && left[0].kind === "identifier" || left[0]?.value === "{";
    return bindingTargets(left, members, complete && named, [...defaults, new BindingDefault(pattern.slice(equal + 1), members.length)], iterations);
  }
  if (pattern.slice(0, 3).length === 3 && pattern.slice(0, 3).every((token) => token.value === ".")) return bindingTargets(pattern.slice(3), members, false, defaults, iterations);
  if (pattern.length === 1 && pattern[0].kind === "identifier") return [new BindingTarget(pattern[0], members, complete, defaults)];
  if (!["{", "["].includes(pattern[0]?.value)) return [];
  const object = pattern[0].value === "{";
  if (!object) iterations.push(new BindingIteration(pattern[0], members, complete, defaults));
  return readCommaSeparated(pattern, 1, pattern.length - 1).flatMap((entry, index) => {
    if (!object) return bindingTargets(entry, [...members, new BindingArrayElement(index)], complete, defaults, iterations);
    const colon = endOfExpression(entry, 0, new Set([":"]));
    if (entry[0]?.value === "[") return bindingTargets(entry.slice(colon + 1), members, false, defaults, iterations);
    if (entry[0]?.kind === "identifier" || entry[0]?.kind === "string") {
      return bindingTargets(colon === entry.length ? entry : entry.slice(colon + 1), [...members, entry[0].value], complete, defaults, iterations);
    }
    return bindingTargets(entry, members, false, defaults, iterations);
  });
}

/** A private module function's complete direct-call input sources, never evaluated results. */
class SourceClosedCallInput {
  constructor(parameterIndex, target, calls) {
    if (!Number.isSafeInteger(parameterIndex) || parameterIndex < 0 || !(target instanceof BindingTarget)
      || !Array.isArray(calls) || calls.length === 0) throw new TypeError("closed source parameter input required");
    Object.assign(this, { parameterIndex, target, calls });
  }
  resolve(origins, module) {
    const values = this.calls.map(call => {
      const args = call.arguments.map(tokens => tokens.length ? origins.value(module, tokens, emptyEnvironment) : new LiteralValue(undefined));
      return origins.project(module, this.target, args[this.parameterIndex] ?? new LiteralValue(undefined), emptyEnvironment);
    });
    return values.length === 1 ? values[0] : new SourceAlternativeValues(values, values.flatMap(value => value.trace));
  }
}
class SourceClosedCallbackInput extends SourceClosedCallInput {
  constructor(parameterIndex, target, source, declaration) {
    super(parameterIndex, target, [source]);
    this.source = source;
    this.declaration = declaration;
  }
  resolve(origins, module) {
    const replacement = this.source.replacement(origins);
    if (replacement === null || !this.source.containsDirectArrow(replacement.args[1])
      || replacement.args[1].declaration.token !== this.declaration.token) return null;
    const matches = replacement.matches(origins);
    if (matches === null) return null;
    const values = [];
    for (const match of matches) {
      origins.consumeWork(module, this.target.token);
      values.push(origins.project(module, this.target, match.arguments[this.parameterIndex] ?? new LiteralValue(undefined), emptyEnvironment));
    }
    return values.length === 0 ? null : values.length === 1 ? values[0]
      : new SourceAlternativeValues(values, values.flatMap(value => value.trace));
  }
}
class SourceClosedCallInputs {
  #queryRevision = 0;
  get queryRevision() { return this.#queryRevision; }
  recordQuery() { this.#queryRevision++; }
  #modules = new WeakMap();
  #callbacks = new WeakMap();
  callback(module, binding) { return this.#callbacks.get(module)?.get(binding) ?? null; }
  references(module, tokens) {
    const inputs = this.#callbacks.get(module);
    return inputs !== undefined && tokens.some(token => token.kind === "identifier" && inputs.has(module.bindingAt(token)));
  }
  rememberCallback(source, callable) {
    if (!(source instanceof SourceCallSyntax) || !source.containsDirectArrow(callable)) return;
    const module = callable.module;
    if (!this.#callbacks.has(module)) this.#callbacks.set(module, new Map());
    const inputs = this.#callbacks.get(module);
    readParameters(callable.declaration.tokens).forEach((parameter, index) => {
      for (const target of new BindingPattern(parameter).targets) {
        if (!target.complete || target.members.length || target.defaults.length) continue;
        const binding = module.bindingAt(target.token);
        if (binding instanceof SourceInputBinding && module.bindingWrites([binding]).length === 0) {
          inputs.set(binding, new SourceClosedCallbackInput(index, target, source, callable.declaration));
        }
      }
    });
  }
  read(module, binding) {
    if (!this.#modules.has(module)) this.#modules.set(module, this.index(module));
    return this.#modules.get(module).get(binding) ?? null;
  }
  index(module) {
    const result = new Map();
    const invocations = readInvocations(module);
    for (const name of module.declarationNames()) {
      if (module.declarationHeader(name).token.value !== "function") continue;
      const calls = new SourceModuleCallableUsage(module, name).directCalls(invocations);
      if (calls === null) continue;
      readParameters(module.declaration(name).tokens).forEach((parameter, index) => {
        for (const target of new BindingPattern(parameter).targets) {
          // Whole inputs retain direct caller identity. Abstract destructuring
          // and defaults still own their existing independent fallback/effect
          // inspection; selecting a concrete call must not erase that coverage.
          if (!target.complete || target.members.length || target.defaults.length) continue;
          const input = module.bindingAt(target.token);
          if (input instanceof SourceInputBinding) result.set(input, new SourceClosedCallInput(index, target, calls));
        }
      });
    }
    return result;
  }
}

/** A provenance visit retains the native interpretation without array semantics. */
class SourceOriginVisit {
  constructor(value, nativePath, urlPaths) {
    if (!(value instanceof OsValue) || typeof nativePath !== "boolean" || typeof urlPaths !== "boolean") {
      throw new TypeError("source origin and path interpretation required");
    }
    Object.assign(this, { value, nativePath, urlPaths });
  }
  get mode() { return 1 << (Number(this.nativePath) + 2 * Number(this.urlPaths)); }
}
/** Query-local reachability: shared graph edges do not duplicate provenance. */
class SourceOriginQuery {
  read(value, nativePath, urlPaths) {
    const seen = new Map();
    const pending = [new SourceOriginVisit(value, nativePath, urlPaths)];
    const result = [];
    while (pending.length) {
      const visit = pending.pop();
      const { value, nativePath, urlPaths } = visit;
      if ((seen.get(value) ?? 0) & visit.mode) continue;
      seen.set(value, (seen.get(value) ?? 0) | visit.mode);
      const append = (values, native = nativePath, urls = urlPaths) => {
        for (let index = values.length - 1; index >= 0; index--) pending.push(new SourceOriginVisit(values[index], native, urls));
      };
      if (value.allocationState !== null) append([value.allocationState]);
      if (value instanceof SourceSuperReferenceValue || value instanceof InvocationOptionsValue) { result.push(value); append(value.sensitivityInputs); }
      else if (value instanceof ComposedPathValue) append(value.values, nativePath || value.consumesPosix);
      else if (value instanceof SourceJoinedTextValue) { result.push(value); append([value.origin, value.separator]); }
      else if (value instanceof SourceArrayValue) append(value.values);
      else if (value instanceof ObjectValue) { result.push(value); append(value.values); }
      else if (value instanceof SourceObjectState) append(value.sensitivityInputs);
      else if (value instanceof SourceValues) append(value.values);
      else if (value instanceof SourceWeakCollectionValue) { result.push(value); append(value.entries.sensitivityInputs); }
      else if (value instanceof SourceWeakCollectionMethodValue) { result.push(value); append([value.owner]); }
      else if (value instanceof SourceWeakMapEntry) append(value.sensitivityInputs);
      else if (value instanceof SourceProvenanceResult) { result.push(value); append(value.inputs); }
      else if (value instanceof PosixPathValue || value instanceof WindowsPathValue) {
        if (!nativePath || !(value instanceof PosixPathValue)) result.push(value);
        append(value.details.values);
      } else if (value instanceof ConcatenationValue || value instanceof TemplateValue || value instanceof TaggedTemplateValue || value instanceof UncertainValue || value instanceof UnresolvedCompositionValue || value instanceof TransformedStringValue || value instanceof RetainedStringMethodValue || value instanceof ConditionalFilesystemPathValue) {
        result.push(value); append([value.origin]);
      } else if (urlPaths && (value instanceof FileUrlValue || value instanceof NativePathValue || value instanceof UnresolvedUrlPathValue)) {
        result.push(value); append([value.details]);
      } else if (urlPaths && value instanceof UrlPathnameValue) {
        result.push(value); append([value.origin]);
      } else result.push(value);
    }
    return result;
  }
}
function valueOrigins(value, nativePath = false, urlPaths = false) {
  return new SourceOriginQuery().read(value, nativePath, urlPaths);
}

function hasOsSensitiveOrigin(value) {
  // Complete the existing lazy effect/heap sensitivity query before reading
  // path edges: a getter summary can add a later path write to an earlier node.
  return value.sensitive || valueOrigins(value).some(origin => pseudoPathUse(origin) !== null
    || origin instanceof WindowsPathValue || origin instanceof PosixPathValue);
}

function pathText(value, syntax) {
  if (value instanceof LiteralValue && typeof value.value === "string") return value.value;
  if (value instanceof SourceJoinedTextValue) return value.text;
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

/** No cross-query cache: heap/effect revisions remain visible to each consumer. */
class SourcePseudoPathQuery {
  #values = new Map();
  #active = new Map();
  read(value) {
    if (this.#values.has(value)) return this.#values.get(value);
    if (this.#active.has(value)) return "incomplete";
    const pending = [value];
    this.#active.set(value, this.evaluate(value));
    let result;
    try {
      while (pending.length > 0) {
        const current = pending.at(-1);
        const next = this.#active.get(current).next(result);
        if (next.done) {
          result = next.value;
          this.#values.set(current, result);
          this.#active.delete(current);
          pending.pop();
        } else if (this.#values.has(next.value)) result = this.#values.get(next.value);
        else if (this.#active.has(next.value)) result = "incomplete";
        else {
          pending.push(next.value);
          this.#active.set(next.value, this.evaluate(next.value));
          result = undefined;
        }
      }
      return result;
    } finally {
      for (const current of pending) this.#active.delete(current);
    }
  }
  *some(values) {
    for (const value of values) if (yield value) return true;
    return false;
  }
  *evaluate(value) {
    // Logical expressions retain every possible path operand. This does not
    // infer precedence, select an unproven branch or grant callable authority.
    if (value instanceof OperationValue && ["&&", "||", "??"].includes(value.operator)) {
      return (yield* this.some(value.values)) ? "incomplete" : null;
    }
    if (value instanceof SourceRegexCaptureValue) return "incomplete";
    if (value instanceof SourceJoinedTextValue) return value.text === null ? "incomplete" : pseudoPath.test(value.text) ? "violation" : null;
    if (value instanceof SourceArrayValue) return (yield* this.some([...value.values, ...value.state.sensitivityInputs])) ? "incomplete" : null;
    if (value instanceof SourceProvenanceResult) return (yield* this.some(value.inputs)) ? "incomplete" : null;
    if (value instanceof UncertainValue) return (yield* this.some(valueOrigins(value.origin))) ? "incomplete" : null;
    if (value instanceof SourceAlternativeValues) return (yield* this.some(value.values)) ? "incomplete" : null;
    if (value instanceof TaggedTemplateValue) return (yield* this.some(value.origin.values)) ? "incomplete" : null;
    if (value instanceof FileUrlPathValue) {
      if (value.uncertain) return "incomplete";
      return [value.text(posix), value.text(win32)].some((text) => pseudoPath.test(text)) ? "violation" : null;
    }
    if (value instanceof FileUrlValue || value instanceof NativePathValue) return yield value.details;
    if (value instanceof UrlPathnameValue) return yield value.origin;
    if (value instanceof UnresolvedUrlPathValue) return (yield* this.some(value.details.values)) ? "incomplete" : null;
    if (value instanceof TransformedStringValue || value instanceof RetainedStringMethodValue || value instanceof ConditionalFilesystemPathValue) return (yield value.origin) ? "incomplete" : null;
    if (value instanceof UnresolvedCompositionValue) return (yield value.origin) ? "incomplete" : null;
    if (value instanceof LiteralValue) return typeof value.value === "string" && pseudoPath.test(value.value) ? "violation" : null;
    if (value instanceof TemplateValue) return pseudoPath.test(value.details) ? "violation"
      : (yield* this.some(value.origin.values)) ? "incomplete" : null;
    if (value instanceof ComposedPathValue) {
      if (value.interpretations.some((entry) => entry.text !== null && pseudoPath.test(entry.text))) return "violation";
      for (const entry of value.interpretations) if (entry.text === null && (yield* this.some(entry.values))) return "incomplete";
    }
    if (value instanceof PosixPathValue || value instanceof WindowsPathValue) return value.details.text !== null
      ? pseudoPath.test(value.details.text) ? "violation" : null
      : (yield* this.some(value.details.values)) ? "incomplete" : null;
    if (value instanceof ConcatenationValue && (yield* this.some(value.origin.values))) return "incomplete";
    return null;
  }
}
function pseudoPathUse(value) { return new SourcePseudoPathQuery().read(value); }

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
  constructor(environment, receiver, lexicalThis = false, home = null) {
    super();
    if (!(environment instanceof Map)) throw new TypeError("source receiver context required");
    for (const [binding, value] of environment) super.set(binding, value);
    if (!lexicalThis) {
      const construction = super.get(lexicalConstruction);
      if (construction && construction.instance !== receiver) super.delete(lexicalConstruction);
      if (home instanceof SourceClassHome) super.set(lexicalHomeClass, home);
      else super.delete(lexicalHomeClass);
      if (receiver instanceof ClassValue || (receiver?.allocationState ?? null) !== null) super.set(lexicalReceiver, receiver);
      else if (receiver === null) super.set(lexicalReceiver, absentCallReceiver);
      else super.delete(lexicalReceiver);
    }
  }
}

/** Field allocations belong to home captures and the actual receiver, never constructor parameters. */
class SourceClassFieldEnvironment extends SourceReceiverEnvironment {
  #revision = 0;
  #sourceRevision;
  constructor(source, receiver) {
    super(source.environment, receiver, false, new SourceClassHome(source, receiver.instance));
    this.source = source;
    this.receiverDeclaration = receiver.declaration;
    this.receiverEnvironment = receiver.environment;
    this.#sourceRevision = source.environment.revision;
  }
  matches(source, receiver) {
    return this.source.declaration === source.declaration && this.source.environment === source.environment
      && this.receiverDeclaration === receiver.declaration && this.receiverEnvironment === receiver.environment;
  }
  get revision() { return this.#revision; }
  refresh() {
    const environment = this.source.environment;
    let changed = this.#sourceRevision !== environment.revision;
    this.#sourceRevision = environment.revision;
    for (const binding of this.keys()) {
      if (binding === lexicalReceiver || binding === lexicalConstruction || binding === lexicalHomeClass) continue;
      if (!environment.has(binding)) { super.delete(binding); changed = true; }
    }
    for (const [binding, value] of environment) {
      if (binding === lexicalReceiver || binding === lexicalConstruction || binding === lexicalHomeClass) continue;
      if (!this.has(binding) || this.get(binding) !== value) { super.set(binding, value); changed = true; }
    }
    if (changed) this.#revision++;
    return this;
  }
}
class SourceConstructionFieldEnvironment extends SourceClassFieldEnvironment {
  constructor(frame) {
    super(frame.source, frame.instance);
    this.refresh(frame);
  }
  matches(frame) { return super.matches(frame.source, frame.instance); }
  refresh(frame) {
    super.refresh();
    // A reinterpreted construction keeps allocation identity and still reads
    // current heap/native revisions; the active phase is not a cached result.
    super.set(lexicalReceiver, frame.instance);
    super.set(lexicalConstruction, frame);
    return this;
  }
}

/** Same allocation and exact input interpretation reuse locals, never results or verdicts. */
class SourceConstructionInvocation {
  #inputs = new SourceCallInputs();
  #environments = new WeakMap();
  constructor(frame, callable) {
    this.declaration = callable.declaration.token;
    this.sourceEnvironment = frame.source.environment;
  }
  matches(frame, callable) {
    return callable.declaration.token === this.declaration && frame.source.environment === this.sourceEnvironment;
  }
  environment(frame, callable, args, receiver, origins) {
    const context = this.#inputs.select(args, origins);
    if (!this.#environments.has(context)) this.#environments.set(context,
      new SourceInvocationEnvironment(callable.module, callable.declaration, callable.environment, receiver, callable.home));
    const environment = this.#environments.get(context);
    environment.refresh(callable.environment, receiver, callable.home);
    environment.set(lexicalConstruction, frame);
    environment.set(lexicalReceiver, receiver);
    return environment;
  }
}
class SourceConstructionInvocations {
  #allocations = new WeakMap();
  #fields = new WeakMap();
  #unresolved = new WeakMap();
  identity(state, inputs, nativeRevision) {
    if (!this.#unresolved.has(state)) this.#unresolved.set(state, new SourceEffectContext());
    const context = this.#unresolved.get(state).select(inputs.map(value => [state, value]));
    return new SourceConstructionIdentity(state, context, nativeRevision);
  }
  fieldEnvironment(frame) {
    if (!(frame instanceof SourceConstructionFrame) || !(frame.instance.state instanceof SourceObjectState)
      || !frame.initialized) throw new TypeError("initialized field allocation required");
    const state = frame.instance.state;
    if (!this.#fields.has(state)) this.#fields.set(state, []);
    const contexts = this.#fields.get(state);
    let context = contexts.find(context => context.matches(frame));
    if (!context) { context = new SourceConstructionFieldEnvironment(frame); contexts.push(context); }
    else context.refresh(frame);
    return context;
  }
  environment(frame, callable, args, receiver, origins) {
    if (!(frame instanceof SourceConstructionFrame) || !(receiver.state instanceof SourceObjectState)) throw new TypeError("constructed allocation required");
    if (!this.#allocations.has(receiver.state)) this.#allocations.set(receiver.state, []);
    const contexts = this.#allocations.get(receiver.state);
    let context = contexts.find(context => context.matches(frame, callable));
    if (!context) { context = new SourceConstructionInvocation(frame, callable); contexts.push(context); }
    return context.environment(frame, callable, args, receiver, origins);
  }
}

/** Input interpretation identifies a method allocation context, never a completed result. */
class SourceMethodInvocationDomain {
  #constructorInputs = new SourceCallInputs();
  #inputs = new WeakMap();
  #environments = new WeakMap();
  constructor(callable, receiver) {
    this.callable = callable;
    this.receiver = receiver;
  }
  matches(callable, receiver) {
    const home = this.callable.home;
    const other = callable.home;
    return this.callable.declaration.token === callable.declaration.token && this.callable.environment === callable.environment
      && this.receiver.declaration.token === receiver.declaration.token && this.receiver.environment === receiver.environment
      && this.receiver.instance === receiver.instance
      && (home === other || home !== null && home.matches(other));
  }
  environment(callable, args, receiver, origins) {
    const constructor = this.#constructorInputs.select(receiver.arguments, origins);
    if (!this.#inputs.has(constructor)) this.#inputs.set(constructor, new SourceCallInputs());
    const context = this.#inputs.get(constructor).select(args, origins);
    if (!this.#environments.has(context)) this.#environments.set(context,
      new SourceInvocationEnvironment(callable.module, callable.declaration, callable.environment, receiver, callable.home));
    const environment = this.#environments.get(context);
    environment.refresh(callable.environment, receiver, callable.home);
    return environment;
  }
}
class SourceMethodInvocations {
  #states = new WeakMap();
  environment(callable, args, receiver, token, caller, origins) {
    if (!(receiver instanceof ClassValue) || !(receiver.state instanceof SourceObjectState)) throw new TypeError("method receiver allocation required");
    if (!this.#states.has(receiver.state)) this.#states.set(receiver.state, new SourceCallInvocations(SourceMethodInvocationDomain));
    return this.#states.get(receiver.state).environment(callable, args, receiver, token, caller, origins);
  }
}

/** Exact scalar/native-origin identity; native mutation validity is rechecked by each effect. */
class SourceCallInputIdentity {
  constructor(value) {
    if (!(value instanceof LiteralValue || value instanceof BuiltinValue)) throw new TypeError("scalar or native-origin call input required");
    this.value = value;
  }
  matches(value) {
    if (this.value.constructor !== value.constructor) return false;
    return value instanceof LiteralValue ? Object.is(this.value.value, value.value)
      : value instanceof BuiltinValue && this.value.builtin === value.builtin
        && this.value.members.length === value.members.length
        && this.value.members.every((member, index) => member === value.members[index]);
  }
}
/** Shared exact input identities for reinterpreted calls and lexical iterations. */
class SourceCallInputs {
  #inputs = new SourceEffectContext();
  #identityInputs = [];
  #templateInputs = new WeakMap();
  #defaultInputs = null;
  select(values, origins, active = new Set()) {
    const inputs = values.flatMap(value => {
      if (value === null) return [[SourceCallInputs, SourceCallInputs]];
      // Unsupported cyclic producer edges keep reference identity; they never
      // acquire a normalized value or a successful-execution guarantee.
      if (active.has(value)) return [[value.constructor, value]];
      active.add(value);
      try {
        const state = origins.objectState(value).allocationState;
        let identity = state ?? value;
        if (value instanceof TemplateValue) {
          if (!this.#templateInputs.has(value.token)) this.#templateInputs.set(value.token, new SourceCallInputs());
          // This is an interpretation key, not a template result cache. Actual
          // interpolation/coercion effects and parameter binding still run.
          identity = this.#templateInputs.get(value.token).select([new LiteralValue(value.raw), ...value.origin.values], origins, active);
        }
        if (value instanceof SourceDefaultValue) {
          // Preserve both supplied and fallback origins while reusing only their
          // interpretation context. Defaults and all their effects still run.
          const defaults = this.#defaultInputs ??= new SourceCallInputs();
          identity = defaults.select([new LiteralValue(value.defined), ...value.origin.values], origins, active);
        }
        if ((value instanceof SourceAlternativeValues || value instanceof UncertainValue)
          && value.inputSelection instanceof SourceCallInputSelection) {
          const selection = value.inputSelection;
          const condition = this.selectionContext(selection.condition, origins, active);
          const branches = this.#inputs.select(selection.values.map(value =>
            [SourceCallInputSelection, this.selectionContext(value, origins, active)]));
          identity = this.#inputs.select([[SourceCallInputSelection, this.expressionContext(selection.expression)],
            [selection.environment, this.homeContext(selection.home, origins, active)],
            [SourceCallInputSelection, condition], [SourceCallInputSelection, branches]]);
        }
        if (value.callContext instanceof SourceCallEvaluationContext) {
          const call = value.callContext;
          // Retain evaluation operation/definition and all original argument/result
          // roles. Trace stays on the current wrapper; no verdict or revision is
          // cached, and nullable outputs never become a nominal allocation.
          identity = this.#inputs.select([[call.constructor, this.expressionContext(call.source.expression)],
            [call.environment, this.homeContext(call.home, origins, active)],
            [SourceCallEvaluationContext, call instanceof SourceNativeCallContext
              ? this.select([call.callee], origins, active) : this.#inputs.select([[call.callee, SourceUninspectedCallContext]])],
            [SourceCallEvaluationContext, this.select([new LiteralValue(call.source.constructed)], origins, active)],
            [SourceCallEvaluationContext, this.select([new LiteralValue(call.constructed)], origins, active)],
            [SourceCallEvaluationContext, this.select([call.receiver], origins, active)],
            [SourceCallEvaluationContext, this.select(call.inputs, origins, active)],
            [SourceCallEvaluationContext, this.select(call.outputs, origins, active)]]);
        }
        if (value instanceof LiteralValue || value instanceof BuiltinValue) {
          identity = this.#identityInputs.find(input => input.matches(value));
          if (!identity) { identity = new SourceCallInputIdentity(value); this.#identityInputs.push(identity); }
        }
        return [[value.constructor, identity]];
      } finally { active.delete(value); }
    });
    return this.#inputs.select(inputs);
  }
  expressionContext(expression) {
    return this.#inputs.select([[SourceExpression, expression.module],
      ...expression.tokens.map(token => [SourceExpression, token])]);
  }
  homeContext(home, origins, active) {
    return home === null ? this.select([null], origins, active)
      : home.selectContext(this.#inputs, this.select([new LiteralValue(home.instance)], origins, active));
  }
  selectionContext(value, origins, active) {
    if (!(value instanceof OperationValue) || active.has(value)) return this.select([value], origins, active);
    active.add(value);
    try {
      // Preserve the operator and every original operand; no truth or arithmetic
      // value is inferred for this interpretation-context key.
      return this.#inputs.select([[OperationValue, this.select([new LiteralValue(value.operator)], origins, active)],
        ...value.values.map(operand => [OperationValue, this.selectionContext(operand, origins, active)])]);
    } finally { active.delete(value); }
  }
}
/** Reinterpreting one call site preserves its allocations, while still running every effect. */
class SourceCallInvocationDomain {
  #inputs = new SourceCallInputs();
  #environments = new WeakMap();
  constructor(callable) { this.callable = callable; }
  matches(callable) {
    return this.callable.declaration.token === callable.declaration.token
      && this.callable.environment === callable.environment
      && (this.callable.home === callable.home || this.callable.home !== null && this.callable.home.matches(callable.home));
  }
  environment(callable, args, receiver, origins) {
    const context = this.#inputs.select([receiver, ...args], origins);
    if (!this.#environments.has(context)) this.#environments.set(context,
      new SourceInvocationEnvironment(callable.module, callable.declaration, callable.environment, receiver, callable.home));
    const environment = this.#environments.get(context);
    environment.refresh(callable.environment, receiver, callable.home);
    return environment;
  }
}
class SourceCallInvocations {
  #sites = new WeakMap();
  #domainType;
  constructor(domainType = SourceCallInvocationDomain) { this.#domainType = domainType; }
  environment(callable, args, receiver, token, caller, origins) {
    if (!this.#sites.has(token)) this.#sites.set(token, new WeakMap());
    const callers = this.#sites.get(token);
    if (!callers.has(caller)) callers.set(caller, []);
    const domains = callers.get(caller);
    let domain = domains.find(domain => domain.matches(callable, receiver));
    if (!domain) { domain = new this.#domainType(callable, receiver); domains.push(domain); }
    return domain.environment(callable, args, receiver, origins);
  }
}

/** One loop iteration captures its own lexical names and the actual enclosing receiver. */
class SourceIterationEnvironment extends SourceReceiverEnvironment {
  constructor(source) {
    super(source, null, true);
    this.inspectDeferred = source === emptyEnvironment || source instanceof SourceIterationEnvironment && source.inspectDeferred;
  }
  refresh(source) {
    super.clear();
    for (const [binding, value] of source) super.set(binding, value);
    return this;
  }
}
class SourceIterationContexts {
  #sites = new WeakMap();
  environment(loop, source, iterable, value, position, origins) {
    const token = loop.separator;
    if (!this.#sites.has(token)) this.#sites.set(token, new WeakMap());
    const callers = this.#sites.get(token);
    if (!callers.has(source)) callers.set(source, new SourceIterationInputs());
    return callers.get(source).environment(source, iterable, value, position, origins);
  }
}
class SourceIterationInputs {
  #inputs = new SourceCallInputs();
  #environments = new WeakMap();
  environment(source, iterable, value, position, origins) {
    const context = this.#inputs.select([iterable, value, new LiteralValue(position)], origins);
    if (!this.#environments.has(context)) this.#environments.set(context, new SourceIterationEnvironment(source));
    return this.#environments.get(context).refresh(source);
  }
}

/** One invocation owns its local origins; captured/other calls never share them. */
class SourceInvocationEnvironment extends SourceReceiverEnvironment {
  #sourceEnvironment;
  #origins = new Map();
  #revision = 0;
  #sourceBindings;
  #sourceRevision;
  constructor(module, declaration, environment, receiver = null, home = null) {
    if (!(module instanceof SourceModule) || !(declaration instanceof SourceDeclaration)) throw new TypeError("source invocation context required");
    super(environment, receiver, declaration.lexicalThis, home);
    this.module = module;
    this.declaration = declaration;
    this.#sourceEnvironment = environment;
    this.#sourceBindings = new Set(environment.keys());
    this.#sourceRevision = environment.revision;
    const body = declaration.bodyTokens() ?? [];
    this.start = body[0]?.offset ?? Infinity;
    this.end = body.at(-1)?.offset ?? -Infinity;
    Object.freeze(this);
  }
  #invalidate() { this.#origins.clear(); this.#revision++; }
  get revision() { return this.#revision; }
  set(binding, value) {
    const previous = this.get(binding);
    const same = previous === value || previous?.constructor === LiteralValue && value?.constructor === LiteralValue
      && Object.is(previous.value, value.value) || previous?.constructor === UnknownValue && value?.constructor === UnknownValue
      && new SourceUnknownContextIdentity(previous).key === new SourceUnknownContextIdentity(value).key
      || previous instanceof SourceDefaultValue && value instanceof SourceDefaultValue
      && SourceDefaultValue.sameOrigins(previous, value);
    this.#origins.clear();
    if (!same) this.#revision++;
    return super.set(binding, value);
  }
  refresh(source, receiver, home) {
    this.#sourceEnvironment = source;
    this.#origins.clear();
    if (this.#sourceRevision !== source.revision) this.#revision++;
    this.#sourceRevision = source.revision;
    for (const binding of this.#sourceBindings) {
      if (binding === lexicalReceiver || binding === lexicalConstruction || binding === lexicalHomeClass) continue;
      if (!source.has(binding)) this.delete(binding);
    }
    for (const [binding, value] of source) {
      if (binding === lexicalReceiver || binding === lexicalConstruction || binding === lexicalHomeClass) continue;
      this.set(binding, value);
    }
    this.#sourceBindings = new Set(source.keys());
    // Domain selection already compared the home, receiver and all input
    // origins. Replace their current wrappers without changing that identity.
    const bindings = new SourceReceiverEnvironment(source, receiver, this.declaration.lexicalThis, home);
    for (const key of [lexicalReceiver, lexicalConstruction, lexicalHomeClass]) {
      if (bindings.has(key)) super.set(key, bindings.get(key));
      else super.delete(key);
    }
  }
  delete(binding) { this.#invalidate(); return super.delete(binding); }
  clear() { this.#invalidate(); super.clear(); }
  contains(module, token) {
    return module === this.module && token.offset >= this.start && token.offset <= this.end;
  }
  owns(expression) { return this.contains(expression.module, expression.target.token); }
  originEnvironment(expression) {
    let environment = this;
    while (environment instanceof SourceInvocationEnvironment) {
      if (environment.owns(expression)) return environment;
      environment = environment.#sourceEnvironment;
    }
    return environment;
  }
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
    if (projection.receiver instanceof ObjectValue && origins.effectSummary !== null) {
      origins.effectSummary.readState(origins.objectState(projection.receiver).state);
    }
    if (this.active.some(active => active.matches(projection, origins))) {
      return new UnknownValue(projection.cycleReason, true, projection.receiver.trace);
    }
    this.active.push(projection);
    try {
      const value = projection.read(origins);
      const effects = projection.receiver instanceof ObjectValue
        ? projection.receiver.state?.writes.filter(effect => effect.affects(projection.name)) ?? [] : [];
      // One concrete own write to an absent source property has one origin.
      // Unknown-key and opaque writes retain their possible absence/aliases.
      if (value === null && effects.length === 1 && effects[0].name === projection.name && !effects[0].exposed) return effects[0].value;
      const writes = effects.map(effect => effect.value);
      return writes.length ? uncertainOrigins([...(value === null ? [] : [value]), ...writes], "member writes retain multiple possible origins") : value;
    }
    finally { this.active.pop(); }
  }
}

/** Copy selection retains absent branches so earlier own fields remain possible. */
class SourceCopiedMember {
  constructor(values, absent) {
    if (!Array.isArray(values) || values.some(value => !(value instanceof OsValue))
      || typeof absent !== "boolean" || values.length === 0 && !absent) throw new TypeError("copied member alternatives required");
    this.values = values;
    this.absent = absent;
  }
  withEarlier(earlier) {
    if (!(earlier instanceof SourceCopiedMember)) throw new TypeError("earlier copied member required");
    return this.absent ? new SourceCopiedMember([...this.values, ...earlier.values], earlier.absent) : this;
  }
  get value() {
    if (this.values.length === 0) return null;
    const values = this.absent ? [...this.values, new LiteralValue(undefined)] : this.values;
    return values.length === 1 ? values[0] : uncertainOrigins(values, "copied member has multiple inspected alternatives");
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
    if (members.unresolvedEntries.length) return new UnknownValue("object member selection has unresolved definitions", true, receiver.trace);
    if (!members.entries.some(property => property instanceof SourceObjectSpread)) {
      const accessors = members.accessors.filter(property => property.name === name);
      if (accessors.length) {
        const getters = accessors.filter(property => property.kind === "get");
        if (getters.length > 1 || accessors.filter(property => property.kind === "set").length > 1) {
          return new UnknownValue("object accessor selection has duplicate definitions", true, receiver.trace);
        }
        if (!getters.length) return new LiteralValue(undefined, receiver.trace);
        return origins.invoke(new CallableValue(receiver.module, getters[0], receiver.environment, receiver.trace, origins, receiver),
          [], getters[0].token, receiver.module, receiver.environment, false, receiver);
      }
      const property = readObjectProperty(receiver.tokens, name);
      if (!property) return null;
      if (property instanceof SourceDeclaration) {
        const index = receiver.tokens.findIndex(item => item.offset === property.token.offset);
        const callable = new CallableValue(receiver.module, property, receiver.environment, receiver.trace, origins, receiver);
        return receiver.tokens[index - 1]?.value === "get"
          ? origins.invoke(callable, [], property.token, receiver.module, receiver.environment, false, receiver) : callable;
      }
      return origins.value(receiver.module, property.tokens, receiver.environment);
    }
    if (!members.complete) return new UnknownValue("object member projection is ambiguous or executable", true, receiver.trace);
    let selected = new SourceCopiedMember([], true);
    for (const property of [...members.entries].reverse()) {
      if (property instanceof SourceObjectSpread) {
        const spread = origins.value(receiver.module, property.tokens, receiver.environment);
        if (!origins.closedSpread(spread)) {
          return new UnknownValue("object spread has no inspected data members", true, spread.trace);
        }
        selected = selected.withEarlier(origins.copiedMember(spread, name));
        if (!selected.absent) return selected.value;
        continue;
      }
      if (property.token.value !== name) continue;
      const value = property instanceof SourceDeclaration
        ? new CallableValue(receiver.module, property, receiver.environment, receiver.trace, origins, receiver)
        : origins.value(receiver.module, property.tokens, receiver.environment);
      return selected.withEarlier(new SourceCopiedMember([value], false)).value;
    }
    return selected.value;
  }
}

/** A class field/getter query keeps the exact constructed receiver and context. */
class SourceClassProjection extends SourceMemberProjection {
  constructor(receiver, name, token, module, environment, origins, start = receiver, prototypeOnly = false) {
    super(receiver, name);
    if (!(receiver instanceof ClassValue)) throw new TypeError("source class required");
    Object.assign(this, { token, module, environment, start, prototypeOnly, revision: receiver.environment.revision, mode: origins.evaluationMode,
      route: origins.route, callers: origins.callers,
      resolution: new SourceResolutionContext(origins.activeBindings, origins.activeExports) });
    Object.freeze(this);
  }
  get cycleReason() { return "unresolved class member projection cycle"; }
  matches(projection, origins) {
    return projection instanceof SourceClassProjection && projection.receiver === this.receiver
      && projection.name === this.name && projection.start === this.start && projection.prototypeOnly === this.prototypeOnly
      && this.receiver.environment.revision === this.revision
      && origins.evaluationMode === this.mode && origins.route === this.route && origins.callers === this.callers
      && this.resolution.matches(origins.activeBindings, origins.activeExports);
  }
  read(origins) {
    const { receiver, name, token, module, environment } = this;
    if (!origins.classMembers.has(receiver.declaration.token)) origins.classMembers.set(receiver.declaration.token, new SourceClassMembers(receiver.declaration));
    const members = origins.classMembers.get(receiver.declaration.token);
    // Abstract escape inspection of the proven invocation constructor uses
    // its already validated data fields. It must not run validators again for
    // each property read, and these inputs grant no nominal launch authority.
    if (receiver.instance && receiver.state === null && origins.invocationType(receiver)
      && ["executable", "args", "cwd", "env", "stdio"].includes(name)) return new SourceEffectInput();
    if (!this.prototypeOnly && this.start === receiver && receiver.state !== null) {
      origins.effectSummary?.readState(receiver.state);
      const own = receiver.state.alternatives(name);
      if (own.length) {
        const values = own.map(value => value.constructor === UnknownValue && !value.sensitive && origins.effectSummary === null
          ? new UnknownValue("constructor field initializer has unresolved member provenance", true, [...receiver.trace, ...value.trace]) : value);
        return values.length === 1 ? values[0] : uncertainOrigins(values, "class field has multiple possible writes");
      }
    }
    let owner = this.start;
    let property;
    const visited = new Set();
    while (owner instanceof ClassValue && !visited.has(owner.declaration.token)) {
      visited.add(owner.declaration.token);
      const inheritedState = receiver.instance ? owner.prototypeValue?.state : owner.state;
      if (inheritedState !== null && inheritedState !== undefined) {
        origins.effectSummary?.readState(inheritedState);
        const writes = inheritedState.alternatives(name);
        if (writes.length) return writes.length === 1 ? writes[0] : uncertainOrigins(writes, "inherited member has possible writes");
      }
      const owned = new SourceClassMembers(owner.declaration);
      property = (receiver.instance ? owned.instanceMembers : owned.staticMembers).get(name);
      if (this.prototypeOnly && property?.tokens[1]?.value === "=") property = null;
      if (!receiver.instance) {
        const initializing = [...origins.staticInitializations].reverse().find(entry => entry.contains(owner));
        const fields = [...owned.moduleInitializers.filter(field => field instanceof SourceClassFieldInitializer && field.fieldName === name),
          ...[...owned.staticMembers.values()].filter(field => field.token.value === name && field.tokens[1]?.value === "=")]
          .filter(field => !initializing || initializing.reaches(field))
          .sort((left, right) => (left.fieldToken ?? left.token).offset - (right.fieldToken ?? right.token).offset);
        if (fields.length) property = fields.at(-1);
        else if (property?.tokens[1]?.value === "=") property = null;
      }
      if (property) break;
      const parent = origins.classParent(owner);
      if (parent === null) break;
      if (!(parent instanceof ClassValue)) {
        // Shallow classification has not run this constructor yet. Retain its
        // complete argument/effect provenance until the actual construction.
        if (receiver.state === null && origins.nativeErrorConstructor(parent) && ["message", "cause"].includes(name)) {
          return new SourceConstructedValue([receiver]);
        }
        return new UnknownValue("inherited class member has unresolved parent", true, owner.trace);
      }
      owner = parent;
    }
    if (!property && receiver.state !== null) return new LiteralValue(undefined, receiver.trace);
    if (!property) {
      const constructor = receiver.instance && members.instanceMembers.get("constructor");
      if (!constructor) return new UnknownValue();
      const local = new SourceInvocationEnvironment(receiver.module, constructor, receiver.environment, receiver);
      origins.bindArguments(receiver.module, readParameters(constructor.tokens), receiver.arguments, local);
      const tokens = constructor.bodyTokens();
      const assignment = tokens.findIndex((item, index) => item.value === "this" && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === name && tokens[index + 3]?.value === "=");
      if (assignment < 0) return new UnknownValue();
      const selected = origins.value(receiver.module, tokens.slice(assignment + 4, endOfExpression(tokens, assignment + 4)), local);
      return selected instanceof UnknownValue && !selected.sensitive && origins.effectSummary === null
        ? new UnknownValue("constructor field initializer has unresolved member provenance", true, [...receiver.trace, ...selected.trace]) : selected;
    }
    if (!receiver.instance && (property instanceof SourceClassFieldInitializer || property.tokens[1]?.value === "=")) {
      return origins.staticInitializer(owner, property);
    }
    if (property.token.value === name && property.tokens[1]?.value === "=") return origins.value(owner.module, property.tokens.slice(2),
      new SourceReceiverEnvironment(owner.environment, receiver, false, new SourceClassHome(owner, receiver.instance)));
    if (property instanceof SourceClassAccessor) {
      const accessors = new SourceClassMembers(owner.declaration);
      property = (receiver.instance ? accessors.instanceAccessors : accessors.staticAccessors)
        .find(accessor => accessor.fieldName === name && accessor.kind === "get");
      if (!property) return new LiteralValue(undefined, receiver.trace);
    }
    const callable = new CallableValue(owner.module, property, owner.environment, owner.trace, origins, receiver, new SourceClassHome(owner, receiver.instance));
    const index = owner.module.tokens.findIndex((item) => item.offset === property.token.offset);
    return owner.module.tokens[index - 1]?.value === "get" ? origins.invoke(callable, [], token, module, environment, false, receiver) : callable;
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
      this.environment === emptyEnvironment || origins.effectSummary !== null || value.sensitive ? origins.observations : null);
    const index = expressions.findIndex(entry => entry.expression.hasExpression(module, tokens));
    if (index < 0) expressions.push(coverage);
    else expressions[index] = coverage;
  }
  evaluated(module, tokens, environment, origins) {
    return this.#evaluationContext(module, environment, origins)
      && (this.#evaluated.get(tokens[0])?.some(coverage => coverage.matches(module, tokens, origins.observations)) ?? false);
  }
  remember(tokens, value, origins) {
    if (this.environment === emptyEnvironment || origins.effectSummary !== null || !this.#current(this.module, this.environment, origins)
      || value.sensitive || !this.#owns(tokens)) return;
    this.#values.set(tokens[0], new SourceScannedValue(new SourceExpression(this.module, tokens), value, origins.observations));
  }
  read(module, tokens, environment, origins) {
    if (!this.#current(module, environment, origins)) return null;
    const observed = this.#values.get(tokens[0]);
    return observed?.observations === origins.observations && observed.expression.hasExpression(module, tokens) ? observed.value : null;
  }
}

function uncertainOrigins(values, reason, inputSelection = null) {
  if (values.length > 0 && values.every((value) => value instanceof BuiltinValue && value.identity === values[0].identity)) return values[0];
  if (values.length > 0 && values.every(value => value instanceof BuiltinValue)) return new SourceNativeAlternatives(values, inputSelection);
  if (values.length > 0 && values.every(value => value instanceof ObjectValue
    || value instanceof ClassValue && value.instance && value.state !== null && !(value instanceof InvocationClassValue))) {
    return new SourceAlternativeValues(values, values.flatMap(value => value.trace), inputSelection);
  }
  return new UncertainValue(new SequenceValue(values, values.flatMap(value => value.trace)), reason, inputSelection);
}

/** Source-only value provenance. It reuses the reader's lexical identities and grammar. */
class OsSourceOrigins {
  constructor(graph, diagnose) {
    Object.assign(this, { graph, diagnose });
    this.indexes = new WeakMap();
    this.bindingInitializations = new WeakMap();
    this.closedCallInputs = new SourceClosedCallInputs();
    this.resolvingIterationInputs = false;
    this.activeCallInputs = new Set();
    this.activeBindings = new Set();
    this.activeExports = new Set();
    this.activeCalls = new Set();
    this.callableEffects = new WeakMap();
    this.effectContexts = new WeakMap();
    this.classEffects = new WeakMap();
    this.memberProjections = new SourceMemberProjections();
    this.memberMutations = new WeakMap();
    this.objectCopies = new WeakMap();
    this.globalWrites = new WeakMap();
    this.nativeMutations = new SourceNativeMutations();
    this.invocationAuthorities = new SourceInvocationAuthorities();
    this.objectStates = new WeakMap();
    this.weakCollectionStates = new WeakMap();
    this.nativeArrayAllocations = new SourceNativeArrayAllocations();
    this.objectEffects = new WeakMap();
    this.route = [];
    this.callers = [];
    this.intrinsicExpressions = new IntrinsicExpressions();
    this.resetWork();
    this.values = new SourceEvaluationCache();
    this.expressionBoundaries = new WeakMap();
    this.classMembers = new WeakMap();
    this.classDefinitions = new WeakMap();
    this.activeConstructions = new Set();
    this.staticInitializations = [];
    this.staticFieldEnvironments = new WeakMap();
    this.constructionInvocations = new SourceConstructionInvocations();
    this.methodInvocations = new SourceMethodInvocations();
    this.callInvocations = new SourceCallInvocations();
    this.iterationContexts = new SourceIterationContexts();
    this.invocationContracts = new WeakMap();
    this.invocationBaseContracts = new WeakMap();
    this.constantValues = new ConstantEvaluationCache();
    this.observations = 0;
    this.scanning = null;
    this.deepCalls = true;
    this.scanHelpers = true;
    this.selectCallRoute = () => null;
    this.conditionExpression = () => new PlatformExpression(false, supportedPlatforms.map(() => null));
    this.observing = false;
    this.effectSummary = null;
    this.onCall = () => {};
    this.onMember = () => {};
    this.onUnsupported = () => {};
    this.onSelection = () => {};
  }

  objectState(value) {
    if (!(value instanceof ObjectValue || value instanceof SourceArrayValue || value instanceof RegexLiteralValue)) return value;
    value.state = this.allocationState(value.module, value.tokens, value.environment);
    return value;
  }

  allocationState(module, tokens, environment) {
    const token = tokens[0];
    if (!this.objectStates.has(token)) this.objectStates.set(token, new WeakMap());
    const contexts = this.objectStates.get(token);
    if (!contexts.has(environment)) contexts.set(environment,
      new SourceObjectState(new SourceExpression(module, tokens), environment));
    return contexts.get(environment);
  }

  weakCollectionEntries(state) {
    if (!this.weakCollectionStates.has(state)) this.weakCollectionStates.set(state, new SourceObjectState(state.expression, state.environment));
    return this.weakCollectionStates.get(state);
  }

  weakObject(value) {
    return this.objectState(value).allocationState !== null || value instanceof ClassValue || value instanceof CallableValue
      || value instanceof SourceWeakCollectionMethodValue || value instanceof SourceConstructedValue
      || value instanceof BuiltinValue && !this.nativeMutations.affects(value) && (value.members.length === 0
        || ["fs", "fs/promises"].includes(value.builtin) && value.members.length === 1 && filesystemContract(value)
        || value.builtin === "child_process" && value.members.length === 1 && launchMethods.has(value.member));
  }

  objectEffectsFor(receiver) {
    const state = this.objectState(receiver).state;
    if (!this.objectEffects.has(state)) this.objectEffects.set(state, new SourceObjectEffects(this, receiver));
    return this.objectEffects.get(state);
  }

  exposedObject(value, token) {
    const pending = [value];
    const visited = new Set();
    while (pending.length) {
      const member = pending.pop();
      if (visited.has(member)) continue;
      visited.add(member);
      if (member instanceof BuiltinValue) this.nativeMutations.add(member);
      if (member instanceof SourceSuperReferenceValue || member instanceof InvocationOptionsValue) pending.push(...member.sensitivityInputs);
      if (member instanceof RegexLiteralValue) this.nativeMutations.add(new BuiltinValue("RegExp", ["prototype"]));
      if (member instanceof SourceWeakCollectionValue) {
        pending.push(...member.entries.sensitivityInputs);
        this.nativeMutations.add(new BuiltinValue(member.builtin, ["prototype"]));
      }
      if (member instanceof SourceWeakCollectionMethodValue) pending.push(member.owner);
      if (member instanceof SourceWeakMapEntry) pending.push(...member.sensitivityInputs);
      if (member instanceof SourceValues || member instanceof ObjectValue) pending.push(...member.values);
      if (member instanceof UncertainValue) pending.push(member.origin);
      if (member instanceof CallableValue) pending.push(...member.captures.values, member.effects);
      if (member instanceof SourceEffectSummary) pending.push(...member.exposureInputs);
      if (member instanceof InvocationOptionsMethodValue) pending.push(member.owner);
      if (member instanceof SourceProvenanceResult) pending.push(...member.inputs);
      if (member instanceof ClassValue) {
        if (this.invocationType(member)) this.invalidateInvocation(member, true);
        pending.push(...member.arguments, ...member.captures.values);
        if (member.prototypeValue) pending.push(member.prototypeValue);
        if (member.effects !== null) pending.push(member.effects);
      }
      const state = this.objectState(member).allocationState;
      if (state === null) continue;
      pending.push(...state.sensitivityInputs);
      state.write(new SourceObjectWrite(token, null,
        new UnknownValue("opaque consumer may change object members", true, member.trace), true));
    }
  }

  mutations(module) {
    if (!this.memberMutations.has(module)) this.memberMutations.set(module, new SourceMemberMutations(module));
    return this.memberMutations.get(module);
  }

  invalidateInvocation(value, shared = false) {
    const contract = value instanceof InvocationInstanceValue ? value.contract : this.invocationContract(value);
    this.invocationAuthorities.invalidate(value, shared, contract?.parent.source ?? null);
  }

  inspectIntrinsicAssignment(module, token, environment) {
    if (!this.globalWrites.has(module)) this.globalWrites.set(module, new Set(module.unboundWrites().map(write => write.token)));
    if (!this.globalWrites.get(module).has(token)) return;
    const value = this.identifier(module, token, environment);
    if (value instanceof BuiltinValue) {
      this.nativeMutations.add(value);
      this.observe("onUnsupported", new UnknownValue("assignment replaces a global intrinsic", true, value.trace), token, module);
    }
  }

  inspectMutation(module, mutation, environment) {
    const receiver = mutation.receivers.length ? this.value(module, mutation.receivers.at(-1).tokens, environment) : null;
    let memberName = mutation.member?.name ?? null;
    if (mutation.member?.token.value === "[") {
      const target = mutation.target.tokens;
      const open = target.indexOf(mutation.member.token);
      const close = matching(target, open, "[", "]");
      const key = this.value(module, target.slice(open + 1, close), environment);
      if (key instanceof LiteralValue && ["string", "number"].includes(typeof key.value)) memberName = String(key.value);
      else this.observe("onUnsupported", new UnknownValue("computed mutation key has unresolved conversion effects", true, key.trace), mutation.member.token, module);
    }
    let value;
    if (mutation.supported && mutation.operator === "=") {
      const start = module.tokens.indexOf(mutation.operatorTokens.at(-1)) + 1;
      value = this.value(module, module.tokens.slice(start, this.expressionEnd(module, module.tokens, start)), environment);
    } else value = new UnknownValue("member mutation has no inspected assigned value", true, [module.file]);
    this.writeMutation(receiver, value, memberName, mutation, module, environment);
    return value;
  }

  writeMutation(receiver, value, memberName, mutation, module, environment) {
    if (receiver instanceof SourceAbsentReceiverValue) this.observe("onUnsupported",
      new UnknownValue("member mutation has no inspected call receiver", true, receiver.trace), mutation.token, module);
    if (receiver instanceof SourceAlternativeValues || receiver instanceof UncertainValue) {
      const alternatives = receiver instanceof SourceAlternativeValues ? receiver.values : receiver.origin.values;
      for (const alternative of alternatives) this.writeMutation(alternative, value, memberName, mutation, module, environment);
      return value;
    }
    if (receiver instanceof StatValue) this.observe("onUnsupported",
      new UnknownValue("native stat metadata was changed", true, receiver.trace), mutation.token, module);
    const state = this.objectState(receiver)?.allocationState ?? null;
    if (state !== null) {
      if (receiver instanceof ClassValue) {
        const owners = [];
        const visited = new Set();
        let owner = receiver;
        while (owner instanceof ClassValue && !visited.has(owner.declaration.token)) {
          visited.add(owner.declaration.token);
          owners.push(owner);
          owner = this.classParent(owner);
        }
        const setters = owners.flatMap(owner => {
          const members = new SourceClassMembers(owner.declaration);
          return (receiver.instance ? members.instanceAccessors : members.staticAccessors)
            .filter(property => property.kind === "set" && (!mutation.supported || memberName === null || property.fieldName === memberName))
            .map(property => new CallableValue(owner.module, property, owner.environment, owner.trace, this, receiver,
              new SourceClassHome(owner, receiver.instance)));
        });
        for (const setter of setters) this.invoke(setter, [value], mutation.token, module, environment, false, receiver);
        if (setters.length > 0 && mutation.supported) return value;
      }
      state.write(new SourceObjectWrite(mutation.token, mutation.supported ? memberName : null, value));
      if (receiver instanceof ClassValue) {
        const frame = environment.get(lexicalConstruction);
        if (this.invocationType(receiver) && !(frame instanceof SourceConstructionFrame && frame.instance === receiver && frame.initialized)) {
          this.invalidateInvocation(receiver);
          this.observe("onUnsupported", new UnknownValue("member mutation changes an OS-sensitive capability", true, receiver.trace), mutation.token, module);
        }
        const members = new SourceClassMembers(receiver.declaration);
        if (!mutation.supported || (receiver.instance ? members.unresolvedInstanceMembers : members.unresolvedStaticMembers).length) this.observe("onUnsupported",
          new UnknownValue("class mutation may execute unresolved members", true, receiver.trace), mutation.token, module);
        return value;
      }
      if (!(receiver instanceof ObjectValue)) return value;
      const members = new SourceObjectMembers(receiver.tokens);
      for (const accessor of members.accessors.filter(accessor => accessor.kind === "set"
        && (!mutation.supported || memberName === null || accessor.name === memberName))) {
        this.invoke(new CallableValue(receiver.module, accessor, receiver.environment, receiver.trace, this, receiver), [value],
          mutation.token, module, environment, false, receiver);
      }
      if (members.unresolvedEntries.length) this.observe("onUnsupported",
        new UnknownValue("member mutation may execute unresolved object members", true, receiver.trace), mutation.token, module);
    } else if (receiver?.sensitive) {
      if (receiver instanceof BuiltinValue) this.nativeMutations.add(receiver, mutation.supported ? memberName : null);
      if (this.invocationType(receiver)) this.invalidateInvocation(receiver);
      this.observe("onUnsupported", new UnknownValue("member mutation changes an OS-sensitive capability", true, receiver.trace), mutation.token, module);
    }
    return value;
  }

  classEffectsFor(receiver) {
    const { declaration, environment } = receiver;
    if (!this.classEffects.has(declaration.token)) this.classEffects.set(declaration.token, new WeakMap());
    const environments = this.classEffects.get(declaration.token);
    if (!environments.has(environment)) environments.set(environment, new SourceClassEffects(this, receiver));
    return environments.get(environment);
  }

  effectsFor(callable, receiver) {
    const { declaration } = callable;
    let environment = callable.environment;
    if (receiver === null && callable.captures.contextBindings !== null) {
      if (!this.effectContexts.has(declaration.token)) this.effectContexts.set(declaration.token, new SourceEffectContext());
      environment = this.effectContexts.get(declaration.token).select(callable.captures.contextBindings);
    }
    if (!this.callableEffects.has(declaration.token)) this.callableEffects.set(declaration.token, new WeakMap());
    const environments = this.callableEffects.get(declaration.token);
    if (!environments.has(environment)) environments.set(environment, new WeakMap());
    const receivers = environments.get(environment);
    const identity = this.objectState(receiver)?.allocationState ?? receiver ?? environment;
    if (!receivers.has(identity)) receivers.set(identity, new SourceCallableEffects(this, callable, receiver));
    return receivers.get(identity);
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
    if (!this.expressionBoundaries.has(module)) {
      const boundaries = new Map();
      for (const template of module.templates) for (const interpolation of template.interpolations) {
        for (const token of interpolation.tokens) boundaries.set(token.offset, Math.min(boundaries.get(token.offset) ?? Infinity, interpolation.endToken.offset));
      }
      for (let index = 0; index < module.tokens.length; index++) {
        if (module.tokens[index].value !== "class") continue;
        const primary = SourceBodyPrimary.read(module.tokens, index);
        if (primary === null) continue;
        for (const token of primary.heritageTokens ?? []) boundaries.set(token.offset,
          Math.min(boundaries.get(token.offset) ?? Infinity, module.tokens[primary.bodyIndex].offset));
      }
      this.expressionBoundaries.set(module, boundaries);
    }
    return endOfExpression(tokens, start, stops, this.expressionBoundaries.get(module).get(tokens[start]?.offset));
  }

  index(module) {
    if (this.indexes.has(module)) return this.indexes.get(module);
    const bindings = new Map();
    this.indexes.set(module, bindings);
    const initializations = new Map();
    this.bindingInitializations.set(module, initializations);
    const tokens = module.tokens;
    const register = (binding, expression) => {
      if (!binding) return;
      if (bindings.has(binding)) bindings.get(binding).add(expression);
      else bindings.set(binding, new BindingOrigins(expression));
    };
    const bind = (tokens, expression, declaration) => {
      const pattern = new BindingPattern(tokens);
      for (const target of pattern.targets) register(module.bindingAt(target.token), new BindingExpression(module, expression, target));
      if (pattern.iterations.length > 0) {
        if (!initializations.has(declaration)) initializations.set(declaration, []);
        initializations.get(declaration).push(new BindingInitialization(module, expression, pattern));
      }
    };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind !== "identifier" || tokens[index - 1]?.value === ".") continue;
      if (["const", "let", "var"].includes(token.value)) {
        const end = endOfExpression(tokens, index + 1, new Set([";"]));
        for (const part of readCommaSeparated(tokens, index + 1, end)) {
          const equal = endOfExpression(part, 0, new Set(["="]));
          if (equal < part.length) bind(part.slice(0, equal), part.slice(equal + 1), token);
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

  closedCallInput(module, binding, source = this.closedCallInputs.read(module, binding)) {
    if (source === null) return null;
    this.closedCallInputs.recordQuery();
    if (this.activeCallInputs.has(binding)) return new UnknownValue("recursive helper input sources remain unresolved", true, [module.file]);
    this.activeCallInputs.add(binding);
    try {
      return source.resolve(this, module);
    } finally { this.activeCallInputs.delete(binding); }
  }

  unwrittenInput(module, binding, environment) {
    if (!binding || !environment.has(binding) && !(binding instanceof SourceInputBinding)
      || module.bindingWrites([binding]).length > 0) return null;
    if (environment.has(binding)) return environment.get(binding);
    const callback = binding instanceof SourceInputBinding ? this.closedCallInputs.callback(module, binding) : null;
    if (callback !== null) {
      const input = this.closedCallInput(module, binding, callback);
      if (input !== null) return input;
    }
    if (this.resolvingIterationInputs && binding instanceof SourceInputBinding) {
      const input = this.closedCallInput(module, binding);
      if (input !== null) return input;
    }
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
    if (!this.classDefinitions.has(declaration.token)) this.classDefinitions.set(declaration.token, new WeakMap());
    const definitions = this.classDefinitions.get(declaration.token);
    if (definitions.has(environment)) return definitions.get(environment);
    const local = new Map(environment);
    const candidate = new ClassValue(module, declaration, false, [module.file], [], local);
    const value = this.invocationType(candidate) ? new InvocationClassValue(module, declaration, false, candidate.trace, [], local)
      : this.nativePermissionContract(candidate) !== null ? new SourceNativePermissionClassValue(module, declaration, false, candidate.trace, [], local) : candidate;
    value.state = this.allocationState(module, [declaration.token], environment);
    value.effects = this.classEffectsFor(value);
    value.prototypeValue = new SourceClassPrototypeValue(value, this);
    const self = module.classSelfBinding(declaration);
    if (self !== null) local.set(self, value);
    definitions.set(environment, value);
    return value;
  }

  // A module declaration captures the module lexical scope, never its caller's
  // parameters or receiver. Arguments and nested declarations still acquire
  // their own invocation environments when the body is inspected.
  unwrittenModuleDeclaration(module, token, binding, environment) {
    if (!binding || environment.has(binding) || module.moduleBinding(token.value) !== binding) return null;
    const kind = module.declarationHeader(token.value)?.token.value;
    if (!["function", "class"].includes(kind) || module.bindingWrites([binding]).length > 0) return null;
    const origins = this.index(module).get(binding);
    if (origins?.expressions.length !== 1) return null;
    const declaration = module.declaration(token.value);
    if (origins.expressions[0].tokens[0] !== declaration.token) return null;
    if (kind === "class") return this.classValue(module, new SourceDeclaration(declaration.name, declaration.tokens), emptyEnvironment);
    return new CallableValue(module, new SourceDeclaration(`<helper:${declaration.token.offset}>`, declaration.tokens,
      declaration.prefix.filter(token => token.value === "async")), emptyEnvironment, [module.file], this);
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

  get evaluationMode() { return `${this.observing}:${this.deepCalls}:${this.scanHelpers}:${this.effectSummary !== null}:${this.resolvingIterationInputs}`; }

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
      if (literalIdentifierValues.has(token.value)) return new LiteralValue(literalIdentifierValues.get(token.value), [module.file]);
      if (token.value === "super") {
        const frame = environment.get(lexicalConstruction);
        const home = environment.get(lexicalHomeClass);
        return frame ? new SourceSuperConstructorValue(frame) : home instanceof SourceClassHome
          ? new SourceSuperReferenceValue(home, environment.get(lexicalReceiver)) : new UnknownValue();
      }
      if (token.value === "this") {
        const frame = environment.get(lexicalConstruction);
        if (frame && !frame.initialized) {
          const unknown = new UnknownValue("derived receiver is unavailable before super", true, [module.file]);
          this.observe("onUnsupported", unknown, token, module);
          return unknown;
        }
        return environment.get(lexicalReceiver) ?? new UnknownValue();
      }
      if ((["URL", "Reflect", "Object", "Number", "String", "BigInt", "Array", "WeakSet", "WeakMap", "RegExp"].includes(token.value) || nativeErrorConstructors.has(token.value)) && module.isUnbound(token.value, token)) return new GlobalIntrinsicValue(token.value, [], [module.file]);
      if (["console", "globalThis", "global"].includes(token.value) && module.isUnbound(token.value, token)) return new BuiltinValue(token.value, [], [module.file]);
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
    return origins ? this.bindingOrigin(module, binding, origins.expressions,
      module.moduleBinding(token.value) === binding && module.bindingWrites([binding]).length === 0 ? emptyEnvironment : environment) : new UnknownValue();
  }

  bindingOrigin(module, binding, expressions, environment, supplied = null) {
    if (this.activeBindings.has(binding)) return supplied ?? (binding instanceof SourceInputBinding ? new UnknownValue()
      : new UnknownValue("unresolved binding origin cycle", true, [module.file]));
    this.activeBindings.add(binding);
    try {
      const values = expressions.map((expression) => {
        const scope = environment instanceof SourceInvocationEnvironment
          ? environment.originEnvironment(expression) : environment;
        const remember = supplied === null && scope instanceof SourceInvocationEnvironment && expressions.length === 1
          && scope.owns(expression) && expression.target.complete && expression.target.members.length === 0
          && expression.target.defaults.length === 0 && module.bindingWrites([binding]).length === 0;
        const recalled = remember ? scope.readOrigin(binding, this.evaluationMode) : null;
        if (recalled !== null) return recalled;
        const value = this.value(expression.module, expression.tokens, scope);
        const projected = this.project(expression.module, expression.target, value, scope);
        if (remember) scope.rememberOrigin(binding, this.evaluationMode, projected);
        return projected;
      });
      if (supplied !== null) values.unshift(supplied);
      const value = values.length === 1 ? values[0]
        : uncertainOrigins(values, "multiple binding writes obscure the capability origin");
      return value;
    } finally { this.activeBindings.delete(binding); }
  }

  project(module, target, origin, environment) {
    const projectMembers = (value, members) => members.reduce((selected, member) => {
      if (member instanceof BindingArrayElement && !(selected instanceof SourceArrayValue && selected.closed && selected.fixed)) {
        const unknown = new UnknownValue("binding iterator has no unchanged native array contract", true, selected.trace);
        this.observe("onUnsupported", unknown, target.token, module);
        return uncertainOrigins([selected, unknown], unknown.reason);
      }
      const projected = this.member(selected, member instanceof BindingArrayElement ? String(member.index) : member, target.token, module, environment);
      // Defaults refine inspected object members. Other sensitive receivers
      // still need their existing whole-origin proof (including class writes).
      if (target.defaults.length > 0 && selected.sensitive && !(selected instanceof ObjectValue)) {
        const unresolved = uncertainOrigins([selected, projected], "binding pattern receiver has unresolved member effects");
        this.observe("onUnsupported", unresolved, target.token, module);
        return unresolved;
      }
      return projected;
    }, value);
    if (!target.complete) {
      const value = projectMembers(origin, target.members);
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
    if (target.defaults.length === 0) return projectMembers(origin, target.members);
    const withDefaults = (selected, depth) => {
      for (const fallback of target.defaults.filter(fallback => fallback.memberDepth === depth)) {
        if (selected instanceof SourceConstructedValue || selected instanceof SourceDefaultValue && selected.defined) continue;
        if (selected instanceof LiteralValue && selected.value !== undefined) continue;
        if (!(selected instanceof LiteralValue || selected instanceof UnknownValue || selected instanceof OperationValue)) continue;
        const replacement = this.value(module, fallback.tokens, environment);
        selected = selected instanceof LiteralValue ? replacement
          : new SourceDefaultValue(selected, replacement);
        if (selected instanceof UncertainValue) this.observe("onUnsupported", selected, target.token, module);
      }
      return selected;
    };
    let selected = withDefaults(origin, 0);
    for (let depth = 0; depth < target.members.length; depth++) {
      selected = projectMembers(selected, [target.members[depth]]);
      selected = withDefaults(selected, depth + 1);
    }
    return selected;
  }

  nativePermissionContract(source) {
    if (!(source instanceof ClassValue) || source.instance) return null;
    for (const state of [source.state, source.prototypeValue?.state]) {
      if (state) this.effectSummary?.readState(state);
      if (state?.hasWrites) return null;
    }
    const declaration = source.module.declaration(source.name);
    if (declaration?.token !== source.declaration.token
      || declaration.tokens.length !== source.declaration.tokens.length
      || !declaration.tokens.every((token, index) => token === source.declaration.tokens[index])) return null;
    const contract = SourceNativePermissionContract.inspect(source.module, declaration, {
      stableClass: (module, declaration) => module.bindingWrites([module.moduleBinding(declaration.name)]).length === 0,
      builtinCall: (module, tokens, builtin, member) => {
        const value = this.value(module, tokens, emptyEnvironment);
        const native = value instanceof PlatformValue ? value.origin : value;
        return native instanceof BuiltinValue && native.builtin === builtin
          && native.members.length === (member === null ? 0 : 1)
          && (member === null || native.member === member) && !this.nativeMutations.affects(native)
          && (native.builtin !== "process" || !["globalThis", "global"].some(global =>
            this.nativeMutations.affects(new BuiltinValue(global, [native.builtin]))));
      },
    });
    // An inherited setter can prevent the constructor's own scalar assignment.
    if (contract !== null && [contract.field, "__proto__"].some(name => this.nativeMutations.affects(new BuiltinValue("Object", ["prototype", name])))) return null;
    return contract;
  }

  nativePermissionDefinition(module, token) {
    for (const name of module.declarationNames()) {
      if (module.declarationHeader(name)?.token.value !== "class") continue;
      const source = this.classValue(module, module.declaration(name), emptyEnvironment);
      const contract = this.nativePermissionContract(source);
      if (contract === null) continue;
      if (contract.memberAt(token) !== null) return contract;
    }
    return null;
  }

  nativePermissionValid(value) {
    if (!(value instanceof SourceNativePermissionInstanceValue)) return false;
    this.effectSummary?.readState(value.state);
    return !value.state.hasWrites && this.nativePermissionContract(value.source) !== null;
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

  initializeBinding(module, pattern, origin, environment) {
    for (const iteration of pattern.iterations) {
      const selected = this.project(module, iteration, origin, environment);
      if (selected instanceof SourceArrayValue && selected.closed && selected.fixed) continue;
      const unknown = new UnknownValue("binding iterator acquisition/close has no unchanged native array contract", true, selected.trace);
      this.observe("onUnsupported", uncertainOrigins([selected, unknown], unknown.reason), iteration.token, module);
    }
  }

  bindArguments(module, parameters, args, environment) {
    parameters.forEach((parameter, index) => {
      const pattern = new BindingPattern(parameter);
      this.initializeBinding(module, pattern, args[index] ?? new LiteralValue(undefined), environment);
      for (const target of pattern.targets) {
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
          const exported = entry.local === "*" && entry.name === "*" ? name : entry.local;
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

  closedSpread(value, active = new Set()) {
    if (value instanceof InvocationOptionsValue) return true;
    if (value instanceof UncertainValue || value instanceof SourceAlternativeValues) {
      if (active.has(value)) return false;
      active.add(value);
      const values = value instanceof UncertainValue ? value.origin.values : value.values;
      try { return values.length > 0 && values.every(part => this.closedSpread(part, active)); }
      finally { active.delete(value); }
    }
    if (!(value instanceof ObjectValue)) return false;
    const state = this.objectState(value).state;
    this.effectSummary?.readState(state);
    // Copying enumerates and reads every own property. After opaque exposure,
    // the original literal no longer proves that those reads cannot run getters.
    return !state.hasOpaqueMutation && new SourceObjectMembers(value.tokens).complete;
  }

  copiedMember(value, name) {
    if (value instanceof UncertainValue || value instanceof SourceAlternativeValues) {
      const values = value instanceof UncertainValue ? value.origin.values : value.values;
      const members = values.map(part => this.copiedMember(part, name));
      return new SourceCopiedMember(members.flatMap(member => member.values), members.some(member => member.absent));
    }
    const member = value instanceof InvocationOptionsValue ? value.member(name) : this.objectMember(value, name);
    return new SourceCopiedMember(member === null ? [] : [member], member === null);
  }

  objectSpread(module, tokens, token, environment) {
    const spread = this.value(module, tokens, environment);
    if (!this.closedSpread(spread)) {
      if (!(spread instanceof ObjectValue)) this.observe("onMember", spread, null, token, module, true);
      if (spread instanceof ObjectValue || !spread.sensitive) this.observe("onUnsupported",
        new UnknownValue("object spread has no inspected data members", true, spread.trace), token, module);
    }
    return spread;
  }

  objectMember(receiver, name) {
    return this.memberProjections.read(new SourceObjectProjection(receiver, name, this), this);
  }

  readMember(receiver, name, token, module, environment) {
    this.observe("onMember", receiver, name, token, module, false);
    return this.member(receiver, name, token, module, environment);
  }

  member(receiver, name, token, module, environment) {
    if (receiver instanceof SourceSuperReferenceValue) {
      if (receiver.frame && !receiver.frame.initialized) {
        const unknown = new UnknownValue("super property receiver is unavailable before super", true, receiver.trace);
        this.observe("onUnsupported", unknown, token, module);
        return unknown;
      }
      const homeState = receiver.home.instance ? receiver.home.source.prototypeValue?.state : receiver.home.source.state;
      if (homeState !== null && homeState !== undefined) {
        this.effectSummary?.readState(homeState);
        if (homeState.hasOpaqueMutation || homeState.alternatives("__proto__").length) {
          const unknown = new UnknownValue("super home prototype may have changed", true, receiver.trace);
          this.observe("onUnsupported", unknown, token, module);
          return unknown;
        }
      }
      const parent = this.classParent(receiver.home.source);
      if (!(parent instanceof ClassValue) || !(receiver.receiver instanceof ClassValue)) {
        const unknown = new UnknownValue("super property has no inspected lexical parent and receiver", true, receiver.trace);
        this.observe("onUnsupported", unknown, token, module);
        return unknown;
      }
      return this.memberProjections.read(new SourceClassProjection(receiver.receiver, name, token, module, environment,
        this, parent, receiver.home.instance), this);
    }
    if (receiver instanceof BuiltinValue) {
      if (["globalThis", "global"].includes(receiver.builtin) && (["Object", "Number", "String", "BigInt", "Reflect", "URL", "Array", "WeakSet", "WeakMap", "RegExp"].includes(name) || nativeErrorConstructors.has(name))) return new GlobalIntrinsicValue(name, [], receiver.trace);
      if (["globalThis", "global"].includes(receiver.builtin) && ["process", "console"].includes(name)) return new BuiltinValue(name, [], receiver.trace);
      const result = new receiver.constructor(receiver.builtin, [...receiver.members, name], receiver.trace);
      if ((receiver.builtin === "process" || receiver.builtin === "os") && platformMembers.has(name)) return new PlatformValue(result);
      if (authorityMembers.has(name) && ["process", "os"].includes(receiver.builtin)) return new AuthorityValue(result);
      if (receiver.builtin === "path" && ["posix", "win32"].includes(name)) return result;
      if (receiver.builtin === "os" && name === "devNull") {
        if (receiver.members.length === 0 && !this.nativeMutations.affects(result)) return new DevNullValue(result);
        const unknown = new UnknownValue("null-device member has no unchanged native os receiver", true, result.trace);
        this.observe("onUnsupported", unknown, token, module);
        return unknown;
      }
      return result;
    }
    if (receiver instanceof NamespaceValue) return this.exported(receiver.file, name, receiver.trace);
    if (receiver instanceof UncertainValue || receiver instanceof SourceAlternativeValues) return new SourceMemberAlternatives((receiver instanceof UncertainValue ? receiver.origin.values : receiver.values).map(value =>
      new SourceMemberCandidate(value, this.member(value, name, token, module, environment))), receiver.reason, receiver);
    if (receiver instanceof SourceAbsentReceiverValue) {
      const unknown = new UnknownValue("member access has no inspected call receiver", true, receiver.trace);
      this.observe("onUnsupported", unknown, token, module);
      return unknown;
    }
    if (receiver instanceof ObjectValue) return this.objectMember(receiver, name) ?? new UnknownValue();
    if (receiver instanceof SourceNativePermissionInstanceValue) {
      if (!this.nativePermissionValid(receiver)) return new UnknownValue("native metadata receiver changed or escaped", true, receiver.trace);
      const contract = receiver.contract;
      if (name === contract.field) return new AuthorityValue(receiver, name);
      const method = [contract.apply, contract.equal, contract.afterWrite].find(member => member.token.value === name);
      return method ? new SourceNativePermissionMethodValue(receiver, contract, method)
        : new UnknownValue("native metadata member has no closed contract", true, receiver.trace);
    }
    if (receiver instanceof ClassValue && !receiver.instance) {
      const contract = this.nativePermissionContract(receiver);
      if (contract !== null && contract.capture.token.value === name) return new SourceNativePermissionMethodValue(receiver, contract, contract.capture);
    }
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
    if (receiver instanceof SourceWeakCollectionMethodValue) {
      const unknown = new UnknownValue("weak collection method indirection has no inspected receiver contract", true, receiver.trace);
      this.observe("onUnsupported", unknown, token, module);
      return unknown;
    }
    if (receiver instanceof SourceWeakCollectionValue) {
      this.effectSummary?.readState(receiver.state);
      this.effectSummary?.readState(receiver.entries);
      const own = receiver.state.alternatives(name);
      if (receiver.closed && own.length === 0 && receiver.methods.includes(name)) return new SourceWeakCollectionMethodValue(receiver, name);
      if (receiver.closed && own.length > 0 && !receiver.methods.includes(name)) {
        return own.length === 1 ? own[0] : uncertainOrigins(own, "weak set own property has possible writes");
      }
      const unknown = new UnknownValue("weak collection member has no unchanged native contract", true, receiver.trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([unknown, ...receiver.state.alternatives(name)], unknown.reason);
    }
    if (receiver instanceof SourceArrayValue) {
      this.effectSummary?.readState(receiver.state);
      if (!receiver.closed) return new UnknownValue("array members changed before native access", true, receiver.trace);
      if (["map", "filter", "some", "every", "includes"].includes(name)) return new SourceArrayMethodValue(receiver, name, token, module);
      if (name === "length") return receiver.fixed ? new LiteralValue(receiver.values.length, receiver.trace) : new UnknownValue();
      if (/^(?:0|[1-9][0-9]*)$/.test(name) && !receiver.fixed) return uncertainOrigins(
        [...receiver.values, new LiteralValue(undefined)], "array selection has no fixed element position");
      if (name === "join") return new JoinMethodValue(receiver);
      if (!/^(?:0|[1-9][0-9]*)$/.test(name)) return new UnknownValue("array member has no inspected native contract", true, receiver.trace);
    }
    if (fixedSequence(receiver) && /^(?:0|[1-9][0-9]*)$/.test(name)) {
      const index = Number(name);
      if (Number.isSafeInteger(index)) return receiver.values[index] ?? new UnknownValue();
    }
    if (receiver instanceof SourceRegexMatchValue) {
      this.effectSummary?.readState(receiver.state);
      const fields = receiver.state.alternatives(name);
      if (fields.length > 0) return fields.length === 1 ? fields[0] : uncertainOrigins(fields, "native match field has possible writes");
      if (name === "input") return receiver.input;
      if (name === "index" || name === "length") return new SourceRegexIntegerValue(receiver.trace);
      if (/^(?:0|[1-9][0-9]*)$/.test(name)) return name === "0" ? receiver.capture
        : new SourceAlternativeValues([receiver.capture, new LiteralValue(undefined)], receiver.trace);
      const unknown = new UnknownValue("regex match member has no inspected capture structure", true, receiver.trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([receiver, unknown], unknown.reason);
    }
    if (receiver instanceof RegexLiteralValue) {
      this.objectState(receiver);
      this.effectSummary?.readState(receiver.state);
      const fields = receiver.state.alternatives(name);
      if (fields.length > 0) return fields.length === 1 ? fields[0] : uncertainOrigins(fields, "regex own field has possible writes");
      if (["test", "exec"].includes(name)) return new SourceRegexMethodValue(receiver, name);
      if (name === "lastIndex") return new SourceRegexIntegerValue(receiver.trace);
      return new UnknownValue("regex member has no inspected native contract", true, receiver.trace);
    }
    if (receiver instanceof SourceNativeErrorValue) {
      this.effectSummary?.readState(receiver.state);
      const fields = receiver.state.alternatives(name);
      if (["message", "cause"].includes(name)) fields.unshift(receiver[name]);
      return fields.length ? fields.length === 1 ? fields[0] : uncertainOrigins(fields, "native error field has possible writes")
        : new UnknownValue("native error member has no inspected contract", true, receiver.trace);
    }
    if (receiver instanceof ClassValue) {
      if (!receiver.instance && name === "prototype") return receiver.prototypeValue
        ?? new UnknownValue("class prototype has no inspected allocation", true, receiver.trace);
      return this.memberProjections.read(new SourceClassProjection(receiver, name, token, module, environment, this), this);
    }
    if (receiver instanceof PrimitiveConversionValue) return name === "toString"
      ? new RetainedStringMethodValue(receiver, name) : new UnknownValue("primitive conversion member is unresolved", receiver.sensitive, receiver.trace);
    if ((receiver instanceof StatValue || receiver instanceof StatfsValue) && (authorityMembers.has(name) || name === "type")) {
      if (receiver instanceof StatValue) this.effectSummary?.readState(receiver.state);
      return new AuthorityValue(receiver, name);
    }
    if (receiver instanceof UserInfoValue && authorityMembers.has(name)) return new AuthorityValue(receiver, name);
    if (receiver instanceof FileUrlValue && name === "pathname") return new UrlPathnameValue(receiver);
    if (receiver instanceof PlatformValue || receiver instanceof UrlPathnameValue || receiver instanceof FileUrlValue || receiver instanceof NativePathValue || receiver instanceof TaggedTemplateValue || receiver instanceof TransformedStringValue || receiver instanceof SourceJoinedTextValue) return new RetainedStringMethodValue(receiver, name);
    if (receiver instanceof FileDescriptorValue) return new DescriptorMethodValue(receiver, name);
    if (receiver instanceof ChildProcessValue) return new ChildMethodValue(receiver, name);
    if (receiver instanceof WindowsPathValue || receiver instanceof PosixPathValue) return new RetainedStringMethodValue(receiver, name);
    if (receiver instanceof LiteralValue && pseudoPathUse(receiver) !== null && !["trim", "split"].includes(name)) return new RetainedStringMethodValue(receiver, name);
    if (receiver instanceof LiteralValue && ["split", "join", "replace", "replaceAll", "trim", "toString"].includes(name)) return new StringMethodValue(receiver, name);
    if (receiver instanceof SequenceValue && name === "join") return new JoinMethodValue(receiver);
    if (receiver instanceof OperationValue) return new UnknownValue("unresolved operator member origin", receiver.sensitive, receiver.trace);
    if ((receiver instanceof ComposedPathValue || receiver instanceof TemplateValue || receiver instanceof ConcatenationValue)
      && hasOsSensitiveOrigin(receiver)) return new UnresolvedCompositionValue(receiver);
    return receiver instanceof UnknownValue ? receiver : new UnknownValue();
  }

  unknownResult(inputs) {
    return new SourceEffectResult(inputs);
  }

  nativeErrorConstructor(value) {
    return value instanceof BuiltinValue && value.members.length === 0 && nativeErrorConstructors.has(value.builtin)
      && !this.nativeMutations.affects(value);
  }

  nativeErrorStringStable(value) {
    return value instanceof SourceNativeErrorValue
      && ![value.builtin, "Error"].some(name => this.nativeMutations.affects(new BuiltinValue(name)))
      && !this.nativeMutations.affects(new BuiltinValue("Object", ["prototype"]))
      && !value.state.hasOpaqueMutation && !["name", "message", "toString", "valueOf"].some(name => value.state.alternatives(name).length);
  }

  stringValue(args, token, module) {
    if (!this.deepCalls) return this.unknownResult(args);
    if (args.length === 0) return new LiteralValue("");
    if (args[0] instanceof LiteralValue) return new LiteralValue(String(args[0].value), args[0].trace);
    if (args[0] instanceof SourceNativeErrorValue) {
      const error = args[0];
      if (this.nativeErrorStringStable(error)) {
        if (error.message instanceof LiteralValue) return new LiteralValue(error.message.value === "" ? error.builtin : `${error.builtin}: ${error.message.value}`, error.trace);
        return new SourceStringValue(error.message);
      }
    }
    // Known objects require their conversion hooks, not just native String
    // identity. Other data retains its original uncertainty and path origins;
    // this grants no sequence, executable or invocation authority.
    if (this.weakObject(args[0])) {
      const unknown = new UnknownValue("string coercion has no inspected primitive result", true, args[0].trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([args[0], unknown], unknown.reason);
    }
    return new SourceStringValue(args[0]);
  }

  nativeError(callee, args, token, module, environment, constructed, source, receiver) {
    const input = args[0] ?? new LiteralValue(undefined);
    const nativeRevision = this.nativeMutations.revision;
    const message = input instanceof LiteralValue && input.value === undefined ? new LiteralValue("")
      : this.stringValue([input], token, module);
    if (source !== null && message.constructor === SourceStringValue && input.constructor === TemplateValue) {
      const context = new SourceErrorMessageContext(source, callee, receiver, environment, [input], [], message.trace, constructed);
      message.withCallContext(context);
      message.messageInterpretation = new SourceErrorMessageInterpretation(context,
        new SourceErrorMessageFootprint(this.nativeMutations, nativeRevision, this.nativeMutations.revision));
    }
    const options = args[1] ?? new LiteralValue(undefined);
    let cause = new LiteralValue(undefined);
    if (options instanceof ObjectValue || options instanceof ClassValue || options instanceof SourceNativeErrorValue) {
      cause = this.member(options, "cause", token, module, environment) ?? cause;
    } else if (!(options instanceof LiteralValue)) {
      cause = new UnknownValue("native error options have unresolved cause access", true, options.trace);
      this.observe("onUnsupported", cause, token, module);
    }
    return new SourceNativeErrorValue(callee.builtin, message, cause, this.allocationState(module, [token], environment));
  }

  staticInitializer(source, field) {
    if (!this.staticFieldEnvironments.has(source)) this.staticFieldEnvironments.set(source, new SourceClassFieldEnvironment(source, source));
    const local = this.staticFieldEnvironments.get(source).refresh();
    const tokens = field instanceof SourceClassFieldInitializer ? field.tokens : field.tokens[1]?.value === "=" ? field.tokens.slice(2) : field.tokens;
    const fieldValue = field instanceof SourceClassFieldInitializer || field.tokens[1]?.value === "=";
    if (!fieldValue && tokens[0]?.value !== "{") {
      const self = source.module.classSelfBinding(source.declaration);
      if (self && tokens.some(token => source.module.bindingAt(token) === self)) {
        const unknown = new UnknownValue("class key accesses its uninitialized lexical self", true, source.trace);
        this.observe("onUnsupported", unknown, field.token, source.module);
        return unknown;
      }
      this.scan(source.module, tokens, source.environment);
      return this.value(source.module, tokens, source.environment);
    }
    this.staticInitializations.push(new SourceStaticInitialization(source, field.fieldToken ?? field.token));
    try {
      if (field instanceof SourceClassFieldInitializer || field.tokens[1]?.value !== "=") this.scan(source.module, tokens, local);
      return this.value(source.module, tokens, local);
    } finally { this.staticInitializations.pop(); }
  }

  initializeStatic(source) {
    if (this.staticInitializations.some(entry => entry.contains(source))) return;
    const members = new SourceClassMembers(source.declaration);
    const fields = [...members.moduleInitializers, ...[...members.staticMembers.values()].filter(field => field.tokens[1]?.value === "=")]
      .sort((left, right) => (left.fieldToken ?? left.token).offset - (right.fieldToken ?? right.token).offset);
    for (const field of fields) this.staticInitializer(source, field);
    if (members.unresolvedStaticMembers.length) this.observe("onUnsupported",
      new UnknownValue("class initialization has unresolved static members", true, source.trace), source.declaration.token, source.module);
  }

  classParent(source) {
    const primary = SourceBodyPrimary.read(source.declaration.tokens);
    return primary.heritageTokens === null ? null : this.value(source.module, primary.heritageTokens, source.environment);
  }

  initializeFields(frame) {
    if (frame.fieldsInitialized) return;
    frame.fieldsInitialized = true;
    const { source, instance } = frame;
    const members = new SourceClassMembers(source.declaration);
    const local = this.constructionInvocations.fieldEnvironment(frame);
    const fields = [...members.instanceInitializers,
      ...[...members.instanceMembers.values()].filter(field => field.tokens[1]?.value === "=")]
      .sort((left, right) => (left.fieldToken ?? left.token).offset - (right.fieldToken ?? right.token).offset);
    for (const field of fields) {
      const tokens = field instanceof SourceClassFieldInitializer ? field.tokens : field.tokens.slice(2);
      // A deferred callable's body is inspected when called or exposed.
      if (field instanceof SourceClassFieldInitializer) this.scan(source.module, tokens, local);
      const value = this.value(source.module, tokens, local);
      instance.state.write(new SourceObjectWrite(field.fieldToken ?? field.token,
        field instanceof SourceClassFieldInitializer ? field.fieldName : field.token.value, value));
    }
    if (members.unresolvedInstanceMembers.length) this.observe("onUnsupported",
      new UnknownValue("class construction has unresolved instance members", true, source.trace), frame.token, frame.module);
  }

  construct(source, instance, args, token, module, environment) {
    const key = source.declaration.token;
    if (this.activeConstructions.has(key)) {
      const unknown = new UnknownValue("recursive class construction remains unresolved", true, source.trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([instance, unknown], unknown.reason);
    }
    this.activeConstructions.add(key);
    try {
      const primary = SourceBodyPrimary.read(source.declaration.tokens);
      const parent = primary.heritageTokens === null ? null
        : this.value(source.module, primary.heritageTokens, source.environment);
      const frame = new SourceConstructionFrame(source, instance, parent, token, module, environment);
      if (source.declaration !== instance.declaration && !instance.ancestors.includes(source)) instance.ancestors.push(source);
      const constructor = new SourceClassMembers(source.declaration).instanceMembers.get("constructor");
      if (parent === null) this.initializeFields(frame);
      else if (!(parent instanceof ClassValue) && !this.nativeErrorConstructor(parent)) {
        this.observe("onUnsupported", new UnknownValue("constructor heritage has no inspected source", true, source.trace), token, module);
      }
      let returned = new LiteralValue(undefined);
      if (constructor) {
        const local = new Map(source.environment);
        local.set(lexicalConstruction, frame);
        returned = this.invoke(new CallableValue(source.module, constructor, local, source.trace, this, instance, new SourceClassHome(source, true)),
          args, token, module, environment, false, instance);
      } else if (parent instanceof ClassValue || this.nativeErrorConstructor(parent)) {
        returned = this.invoke(new SourceSuperConstructorValue(frame), args, token, module, environment);
      }
      if (frame.unprovenControl) {
        const unknown = new UnknownValue("construction has unresolved super control flow", true, source.trace);
        this.observe("onUnsupported", unknown, token, module);
        return uncertainOrigins([instance, returned, unknown], unknown.reason);
      }
      if (this.objectState(returned).allocationState !== null || returned instanceof ClassValue
        || returned instanceof CallableValue || returned instanceof SourceConstructedValue) return returned;
      if (parent !== null && (!frame.initialized || !(returned instanceof LiteralValue && returned.value === undefined))) {
        const unknown = new UnknownValue("derived construction has no normal receiver completion", true, source.trace);
        this.observe("onUnsupported", unknown, token, module);
        return uncertainOrigins([instance, returned, unknown], unknown.reason);
      }
      if (!(returned instanceof LiteralValue)) {
        const unknown = new UnknownValue("constructor return has unresolved object identity", true, source.trace);
        this.observe("onUnsupported", unknown, token, module);
        return uncertainOrigins([instance, returned, unknown], unknown.reason);
      }
      return instance;
    } finally { this.activeConstructions.delete(key); }
  }

  invoke(callee, args, token, module, environment, constructed = false, receiver = null, source = null) {
    if (callee instanceof CommonJsModuleValue) return this.invoke(this.exported(callee.file, "default", callee.trace), args, token, module, environment, constructed);
    const selected = SourceCallableSelection.read(callee);
    if (selected !== null) {
      const value = selected.values.length === 1 ? selected.values[0] : new SourceAlternativeValues(selected.values, callee.trace);
      return this.invoke(value, args, token, module, environment, constructed, receiver);
    }
    if (callee instanceof LiteralValue || callee instanceof OperationValue
      || this.objectState(callee).allocationState !== null && !(callee instanceof ClassValue || callee instanceof SourceWeakCollectionValue)) {
      const unknown = new UnknownValue("selected data has no callable or constructor contract", true, callee.trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([callee, ...args, unknown], unknown.reason);
    }
    if (callee instanceof BuiltinValue && this.nativeMutations.affects(callee)) {
      const value = new UnknownValue("mutated native member has no original call contract", true, callee.trace);
      this.observe("onUnsupported", value, token, module);
      return value;
    }
    if (callee instanceof SourceNativeAlternatives) {
      const results = callee.values.map(candidate => this.invoke(candidate, args, token, module, environment, constructed));
      return new SourceCallResults(results, results.flatMap(value => value.trace));
    }
    if (callee instanceof SourceMemberAlternatives && callee.callsResolved) {
      const results = callee.candidates.map(candidate => this.invoke(candidate.value, args, token, module, environment, constructed,
        receiver === callee.owner ? candidate.receiver : receiver));
      return new SourceCallResults(results, results.flatMap(value => value.trace));
    }
    if (callee instanceof SourceMemberAlternatives) {
      const results = callee.candidates.map(candidate => this.invoke(candidate.value, args, token, module, environment, constructed,
        receiver === callee.owner ? candidate.receiver : receiver));
      const unknown = new UnknownValue("selected method has unresolved callable alternatives", true, callee.trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([...results, unknown], unknown.reason);
    }
    if (callee instanceof SourceAlternativeValues) {
      const results = callee.values.map(value => this.invoke(value, args, token, module, environment, constructed, receiver));
      if (callee.values.every(value => value instanceof CallableValue || value instanceof BuiltinValue
        || constructed && value instanceof ClassValue && !value.instance)) return new SourceCallResults(results, callee.trace);
      const unknown = new UnknownValue("call alternatives include unresolved callable values", true, callee.trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([...results, unknown], unknown.reason);
    }
    this.observe("onCall", callee, args, token, module, environment, constructed);
    if (this.deepCalls && this.scanHelpers && (receiver instanceof ClassValue || receiver instanceof SourceNativeErrorValue) && callee instanceof UnknownValue) {
      const unknown = new UnknownValue("class method has no inspected callable value", true, [...receiver.trace, ...callee.trace]);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([callee, ...args, unknown], unknown.reason);
    }
    if (receiver instanceof UncertainValue || receiver instanceof SourceAlternativeValues) {
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
    if (callee instanceof SourceWeakCollectionValue) {
      const unknown = new UnknownValue("weak collection instance is not callable or constructible", true, callee.trace);
      this.observe("onUnsupported", unknown, token, module);
      return unknown;
    }
    if (callee instanceof SourceRegexMethodValue) {
      const owner = callee.origin, protocol = new SourceRegexProtocol(owner, this);
      const incomplete = reason => {
        const unknown = new UnknownValue(reason, true, callee.trace);
        this.observe("onUnsupported", unknown, token, module);
        return uncertainOrigins([owner, ...args, unknown], reason);
      };
      if (constructed) return incomplete("native regex method is not a constructor");
      if (!(receiver instanceof RegexLiteralValue) || receiver.state !== owner.state || !protocol.unchanged) {
        return incomplete("regex method has no unchanged native receiver and protocol");
      }
      if (!protocol.portableFlags) return incomplete("regex flags have no native contract across supported runtimes");
      const input = this.stringValue([args[0] ?? new LiteralValue(undefined)], token, module);
      if (!SourceStringValue.matches(input)) return incomplete("regex input conversion has no inspected primitive result");
      if (!protocol.unchanged) return incomplete("regex input conversion changed the native protocol");
      if (!protocol.writableLastIndex) return incomplete("frozen regex lastIndex cannot be updated by native execution");
      if (callee.details === "test") return new SourceBooleanValue();
      const result = new SourceAlternativeValues([
        new SourceRegexMatchValue(input, this.allocationState(module, [token], environment)), new LiteralValue(null),
      ], [...callee.trace, ...input.trace]);
      return source === null ? result : result.withCallContext(new SourceRegexExecContext(source,
        new BuiltinValue("RegExp", ["prototype", "exec"], callee.trace), receiver, environment, args, result.values, result.trace, false));
    }
    if (callee instanceof SourceWeakCollectionMethodValue) {
      const owner = callee.owner;
      this.effectSummary?.readState(owner.state);
      this.effectSummary?.readState(owner.entries);
      if (constructed || !(receiver instanceof SourceWeakCollectionValue) || receiver.constructor !== owner.constructor || receiver.state !== owner.state || !owner.closed || owner.state.alternatives(callee.name).length > 0) {
        const unknown = new UnknownValue("weak collection method has no unchanged branded receiver", true, callee.trace);
        this.observe("onUnsupported", unknown, token, module);
        return unknown;
      }
      if (["has", "delete"].includes(callee.name)) return new SourceBooleanValue();
      const key = args[0] ?? new LiteralValue(undefined);
      if (callee.name === "get") return owner.read(key);
      const insertion = SourceWeakInsertionCompletion.inspect(key, this);
      if (insertion === null) {
        const unknown = new UnknownValue("weak collection insertion has no inspected normal completion", true, key.trace);
        this.observe("onUnsupported", unknown, token, module);
        return uncertainOrigins([key, unknown], unknown.reason);
      }
      insertion.apply(owner, args[1] ?? new LiteralValue(undefined), token);
      return receiver;
    }
    if (callee instanceof SourceNativePermissionMethodValue) {
      const owner = callee.owner;
      const contract = callee.contract;
      const valid = owner instanceof SourceNativePermissionInstanceValue
        ? this.nativePermissionValid(owner) : this.nativePermissionContract(owner) !== null;
      if (receiver !== owner || !valid) {
        const tokenAt = owner instanceof SourceNativePermissionInstanceValue
          ? contract.apply.bodyTokens().find(entry => entry.value === contract.field) : token;
        const unknown = new UnknownValue("native metadata method requires its genuine unchanged receiver", true, owner.trace);
        this.observe("onUnsupported", unknown, tokenAt, owner.module);
        return unknown;
      }
      if (callee.member === contract.capture) {
        const captured = this.readMember(args[0] ?? new UnknownValue(), "mode", token, module, environment);
        const primitive = captured instanceof OperationValue ? captured.constantNumber : captured;
        if (!(primitive instanceof LiteralValue && (primitive.value === null
          || ["undefined", "number", "bigint", "string", "boolean"].includes(typeof primitive.value))
          || captured instanceof PrimitiveConversionValue
          || captured instanceof AuthorityValue && captured.origin instanceof StatValue && !captured.origin.state.hasWrites)) {
          const unknown = new UnknownValue("native metadata capture requires an inspected primitive mode", true, owner.trace);
          this.observe("onUnsupported", unknown, token, module);
          return unknown;
        }
        return new SourceNativePermissionInstanceValue(owner, [captured], contract, this.allocationState(module, [token], environment),
          new SourceNativePermissionConstructorInput(captured, false));
      }
      if (callee.member === contract.apply) return new LiteralValue(undefined, owner.trace);
      const other = args[0] ?? new LiteralValue(undefined);
      if (!(this.nativePermissionValid(other) || other instanceof LiteralValue)) {
        const unknown = new UnknownValue("native metadata comparison input has no genuine inspected instance", true, other.trace);
        this.observe("onUnsupported", unknown, token, module);
        return unknown;
      }
      return new SourceBooleanValue(owner.trace);
    }
    if (callee instanceof SourceArrayMethodValue) {
      const owner = callee.origin;
      this.effectSummary?.readState(owner.state);
      if (receiver !== owner || !owner.closed) {
        const unknown = new UnknownValue("array method has no unchanged inspected receiver", true, owner.trace);
        this.observe("onUnsupported", unknown, token, module);
        return unknown;
      }
      if (callee.details === "includes") {
        const index = args[1] ?? new LiteralValue(undefined);
        const primitive = index instanceof OperationValue ? index.constantNumber : index;
        // SameValueZero does not coerce the search value. Only fromIndex has
        // conversion effects; object/unknown inputs retain an incomplete result.
        if (!owner.fixed || !(primitive instanceof LiteralValue)
          || !(primitive.value === null || ["undefined", "string", "number", "boolean"].includes(typeof primitive.value))) {
          const unknown = new UnknownValue("array includes has no fixed contents or primitive fromIndex contract", true, owner.trace);
          this.observe("onUnsupported", unknown, token, module);
          return uncertainOrigins([owner, index, unknown], unknown.reason);
        }
        // The shared expression evaluator has already evaluated every argument.
        // Closed dense arrays have no index getter/prototype observation; no
        // membership truth, callback invocation or new allocation is inferred.
        return new SourceBooleanValue(owner.trace);
      }
      const results = [];
      let fixed = owner.fixed;
      for (let index = 0; index < owner.values.length; index++) {
        const result = this.invoke(args[0] ?? new LiteralValue(undefined),
          [owner.values[index], owner.fixed ? new LiteralValue(index) : new UnknownValue(), owner],
          token, module, environment, false, args[1] ?? null);
        if (callee.details === "filter") {
          const selected = result instanceof OperationValue ? result.constantBoolean : SourceValueTruth.read(result);
          if (selected === null) fixed = false;
          if (selected !== false) results.push(owner.values[index]);
        } else results.push(result);
        if (!owner.closed) {
          const unknown = new UnknownValue("array callback changes later element or species observations", true, owner.trace);
          this.observe("onUnsupported", unknown, token, module);
          return uncertainOrigins([...results, unknown], unknown.reason);
        }
      }
      if (["some", "every"].includes(callee.details)) return new SourceBooleanValue(owner.trace);
      return new SourceArrayValue(callee.module, [callee.token], environment, results, this,
        fixed);
    }
    if (callee instanceof UnresolvedCompositionValue) return callee;
    if (callee instanceof ClassValue) {
      if (!constructed || callee.instance) {
        const unknown = new UnknownValue(callee.instance ? "class instance has no call or construction contract"
          : "source class requires a construction call", true, callee.trace);
        this.observe("onUnsupported", unknown, token, module);
        return unknown;
      }
      const permission = this.nativePermissionContract(callee);
      if (permission !== null) {
        const completion = SourceNativePermissionConstructorInput.inspect(args[0] ?? new LiteralValue(undefined), permission, this);
        if (completion === null) {
          const unknown = new UnknownValue("native metadata constructor has no possible inspected normal input", true, callee.trace);
          this.observe("onUnsupported", unknown, token, module);
          return unknown;
        }
        return new SourceNativePermissionInstanceValue(callee, args, permission,
          this.allocationState(module, [token], environment), completion);
      }
      const contract = this.invocationContract(callee);
      // The existing closed constructor proof already interprets this exact
      // constructor, its parent and validators; retain that nominal result.
      if (contract !== null) return new InvocationInstanceValue(callee, args, contract,
        this.invocationAuthorities.allocation(token, environment, callee.declaration));
      const instance = new ClassValue(callee.module, callee.declaration, true, callee.trace, args, callee.environment, this);
      instance.prototypeValue = callee.prototypeValue;
      if (!this.deepCalls || !this.scanHelpers) return instance;
      instance.state = this.allocationState(module, [token], environment);
      return this.construct(callee, instance, args, token, module, environment);
    }
    if (callee instanceof SourceSuperConstructorValue) {
      const frame = callee.frame;
      if (!(frame.parent instanceof ClassValue) && !this.nativeErrorConstructor(frame.parent) || frame.initialized) {
        const unknown = new UnknownValue("super has no single source construction", true, callee.trace);
        this.observe("onUnsupported", unknown, token, module);
        return unknown;
      }
      const result = frame.parent instanceof ClassValue ? this.construct(frame.parent, frame.instance, args, token, module, environment)
        : this.invoke(frame.parent, args, token, module, environment, true, null, source);
      if (result instanceof SourceNativeErrorValue) {
        for (const name of ["message", "cause"]) frame.instance.state.write(new SourceObjectWrite(token, name, result[name]));
      } else if (result !== frame.instance) {
        const unknown = new UnknownValue("super returns a different receiver", true, callee.trace);
        this.observe("onUnsupported", unknown, token, module);
        return uncertainOrigins([result, unknown], unknown.reason);
      }
      frame.initialized = true;
      this.initializeFields(frame);
      return frame.instance;
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
        const capturedConstruction = callee.environment.get(lexicalConstruction);
        const abstractEntry = this.effectSummary instanceof SourceCallableEffects && this.effectSummary.callable === callee;
        const construction = capturedConstruction instanceof SourceConstructionFrame && abstractEntry
          ? capturedConstruction.fork() : capturedConstruction;
        const local = construction instanceof SourceConstructionFrame && receiver === construction.instance
          && new SourceClassMembers(construction.source.declaration).instanceMembers.get("constructor")?.token === callee.declaration.token
          ? this.constructionInvocations.environment(construction, callee, args, receiver, this)
          : receiver instanceof ClassValue && receiver.state !== null
            ? this.methodInvocations.environment(callee, args, receiver, token, environment, this)
            : this.callInvocations.environment(callee, args, receiver, token, environment, this);
        if (construction !== capturedConstruction) local.set(lexicalConstruction, construction);
        const parameters = readParameters(callee.declaration.tokens);
        this.bindArguments(callee.module, parameters, args, local);
        let route = this.selectCallRoute(callee);
        if (construction instanceof SourceConstructionFrame) {
          const control = new SourceConstructionControl(this, callee, local, route);
          route = control.route;
          if (control.unknown) {
            construction.unprovenControl = true;
            this.observe("onUnsupported", new UnknownValue("super call has an unresolved execution guard", true, callee.trace), token, module);
          }
        }
        const body = callee.declaration.bodyTokens();
        const scanned = this.scanHelpers ? this.scan(callee.module, route?.tokens ?? body ?? [], local) : null;
        if (route) return route.terminal === "return" ? this.returnedValue(callee.module, route.result, local, scanned)
          : route.terminal === null && construction instanceof SourceConstructionFrame ? new LiteralValue(undefined, callee.trace)
            : new UnknownValue("helper has no proven returned value", true, callee.trace);
        const returns = callee.declaration.returns();
        if (returns.length === 1) {
          const result = this.returnedValue(callee.module, returns[0].tokens, local, scanned);
          result.trace = [...new Set([...callee.trace, ...result.trace])];
          const captured = callee.captures.values.filter(value => value.sensitive);
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
    if (SourceStringReplacement.supports(callee)) return new SourceStringReplacement(callee, args, receiver, source, constructed).evaluate(this, token, module, environment);
    if (callee instanceof DerivedValue) {
      if (callee instanceof RetainedStringMethodValue) return new TransformedStringValue(callee.origin);
      if (callee instanceof PlatformValue || callee instanceof AuthorityValue) return callee;
      if (callee instanceof DescriptorMethodValue) return new UnknownValue();
      if (callee instanceof JoinMethodValue) {
        return new SourceJoinedTextValue(callee.origin, args[0] ?? new LiteralValue(undefined));
      }
      if (callee instanceof StringMethodValue) {
        const text = callee.origin.value;
        if (callee.details === "split") return new ShellArgvValue(callee.origin);
        if (callee.details === "trim") return new LiteralValue(String(text).trim(), callee.trace);
      }
      return new UnknownValue();
    }
    if (!(callee instanceof BuiltinValue)) {
      if (!constructed) {
        const result = new SourceUninspectedCallResult([callee, ...args]);
        return source === null ? result : result.withCallContext(new SourceUninspectedCallContext(source,
          callee, receiver, environment, args, [], result.trace, false));
      }
      const inputs = [callee, ...args];
      return new SourceConstructedValue(inputs, this.constructionInvocations.identity(
        this.allocationState(module, [token], environment), inputs, this.nativeMutations.revision));
    }
    const member = callee.member;
    if (["WeakSet", "WeakMap"].includes(callee.builtin)) {
      if (member === undefined && constructed && (args.length === 0 || args[0] instanceof LiteralValue && args[0].value == null)) {
        return callee.builtin === "WeakSet" ? new SourceWeakSetValue(module, token, environment, this)
          : new SourceWeakMapValue(module, token, environment, this);
      }
      const unknown = new UnknownValue("weak collection construction or native method has no inspected contract", true, callee.trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([...args, unknown], unknown.reason);
    }
    if (this.nativeErrorConstructor(callee)) return this.nativeError(callee, args, token, module, environment, constructed, source, receiver);
    if (callee.builtin === "Array" && member === undefined) {
      const only = args[0];
      const length = args.length === 1 && only instanceof LiteralValue && typeof only.value === "number";
      const singleUnresolved = args.length === 1 && !(only instanceof LiteralValue || this.objectState(only).allocationState !== null
        || only instanceof ClassValue || only instanceof SourceConstructedValue);
      if (length) return new SourceArrayValue(module, [token], environment, [], this, only.value === 0, only.value === 0);
      return new SourceArrayValue(module, [token], environment, args, this, !singleUnresolved, !singleUnresolved);
    }
    if (callee.builtin === "Array" && member === "isArray") return args[0] instanceof SourceArrayValue
      ? new LiteralValue(true) : args[0] instanceof LiteralValue || (this.objectState(args[0])?.allocationState ?? null) !== null || args[0] instanceof ClassValue
        ? new LiteralValue(false) : new SourceBooleanValue();
    if (callee.builtin === "Array") return uncertainOrigins(args.length ? args : [new UnknownValue()],
      "array builtin result has no inspected value contract");
    if (callee.builtin === "String" && member === undefined) {
      if (!constructed) {
        const result = this.stringValue(args, token, module);
        return source === null || result instanceof LiteralValue ? result : result.withCallContext(
          new SourceStringCallContext(source, callee, receiver, environment, args, [], result.trace, false));
      }
      const unknown = new UnknownValue("boxed string construction has no inspected primitive receiver contract", true, callee.trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([callee, ...args, unknown], unknown.reason);
    }
    if (callee.builtin === "BigInt" && member === undefined) {
      const input = args[0] ?? new LiteralValue(undefined);
      const result = PrimitiveConversionValue.inspect(input, constructed);
      if (result !== null) return result;
      const unknown = new UnknownValue("BigInt conversion has no inspected normal completion", true, input.trace);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([input, unknown], unknown.reason);
    }
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
      if (/^(?:l?stat|fstat)(?:Sync)?$/.test(member)) return new StatValue(callee, args[0], this.allocationState(module, [token], environment));
      if (/^statfs(?:Sync)?$/.test(member)) return new StatfsValue(callee, args[0]);
      if (/^(?:open|openSync|opendir|opendirSync)$/.test(member)) return new FileDescriptorValue(callee, args);
      if (/^mkdtemp(?:Sync)?$/.test(member)) return new OwnedRootValue(callee, args[0]);
    }
    if (SourceObjectEnumeration.supports(callee)) {
      const enumeration = SourceObjectEnumeration.inspect(callee, args, this);
      const result = enumeration?.result(this, token, module, environment);
      if (result) return result;
      const unknown = new UnknownValue("own-property enumeration has no unchanged finite source shape", true, callee.trace);
      for (const arg of args) this.exposedObject(arg, token);
      this.observe("onUnsupported", unknown, token, module);
      return uncertainOrigins([...args, unknown], unknown.reason);
    }
    const integrity = SourceNativeIntegrityOperation.inspect(callee, args);
    if (integrity !== null) return integrity.result();
    if (callee.builtin === "Object" && ["freeze", "seal"].includes(member)) {
      const input = args[0] ?? new UnknownValue();
      if (member === "freeze") this.objectState(input).allocationState?.freeze();
      return input;
    }
    return this.unknownResult(args);
  }

  returnedValue(module, tokens, environment, scanned) {
    if (tokens.length === 0) return new LiteralValue(undefined, [module.file]);
    return scanned?.read(module, tokens, environment, this)
      ?? this.value(module, tokens, environment);
  }

  value(module, expression, environment = emptyEnvironment, reference = null) {
    const callInputRevision = this.closedCallInputs.queryRevision;
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
    const inputObject = reference === null && environment instanceof SourceInvocationEnvironment
      ? environment.readOrigin(expression[0], this.evaluationMode) : null;
    if (inputObject instanceof InputObjectOrigin && inputObject.hasExpression(module, expression)) return this.objectState(inputObject.copy());
    const callbackInput = this.closedCallInputs.references(module, expression);
    const cacheable = !callbackInput && reference === null && !this.observing && this.deepCalls && environment.size === 0 && this.activeBindings.size === 0 && this.activeExports.size === 0 && this.activeCalls.size === 0 && this.activeCallInputs.size === 0;
    const cache = this.values.entries(environment, module);
    const key = `${this.evaluationMode}:${expression[0]?.offset}:${expression.at(-1)?.offset}`;
    if (cacheable && cache.has(key)) return cache.get(key);
    const constantKey = key;
    const imported = binding && !environment.has(binding) && module.bindingWrites([binding]).length === 0
      && this.importReference(module, leaf, binding);
    // Empty object syntax has no captured fields or initializers. Its cached
    // metadata is context-free; reads create a fresh object in the current
    // environment. Other aggregates and all observed consumers still evaluate.
    const constantEnvironment = EmptyObjectValue.matches(expression) || RegexLiteralValue.matches(expression) || leaf && (["string", "number"].includes(leaf.kind)
      || !binding && literalIdentifierValues.has(leaf.value) || imported) ? emptyEnvironment : environment;
    const constantCacheable = !callbackInput && this.activeCallInputs.size === 0;
    const remembered = constantCacheable ? this.constantValues.read(constantEnvironment, module, constantKey, environment) : null;
    if (remembered) return this.objectState(remembered);
    const observations = this.observations;
    let value = this.intrinsicExpressions.value(module, expression, environment, this);
    if (value === null) {
      this.consumeWork(module, expression[0]);
      value = this.expression(module, expression, environment, reference);
    }
    this.objectState(value);
    // An indirect alias may resolve a closed input without naming its formal
    // in this expression. Preserve that dependency through every enclosing
    // evaluation; only unrelated values remain eligible for stored results.
    const callInputIndependent = callInputRevision === this.closedCallInputs.queryRevision;
    if (constantCacheable && callInputIndependent && (value instanceof LiteralValue || value instanceof RegexLiteralValue || value instanceof BuiltinValue || value instanceof EmptyObjectValue) && observations === this.observations) {
      this.constantValues.remember(constantEnvironment, module, constantKey, value);
    }
    if (observations === this.observations && InputObjectOrigin.matches(value)) {
      const origin = new InputObjectOrigin(value);
      if (origin.environment === environment && origin.hasExpression(module, expression)) {
        environment.rememberOrigin(expression[0], this.evaluationMode, origin);
      }
    }
    if (cacheable && callInputIndependent && !this.closedCallInputs.references(module, expression)) cache.set(key, value);
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
      : new TemplateValue(new SequenceValue(values, [module.file, ...values.flatMap((value) => value.trace)]), text, token, raw);
  }

  expression(module, expression, environment, reference = null) {
    const tokens = strip(expression);
    if (!tokens.length) return new UnknownValue();
    const token = tokens[0];
    const assignment = this.mutations(module).startingAt(token).find(mutation => mutation.supported
      && mutation.operator === "=" && mutation.target.tokens.every((part, index) => part === tokens[index])
      && tokens[mutation.target.tokens.length] === mutation.token);
    // Assignment evaluates the reference and RHS, then PutValue; it does not
    // GetValue from the property being assigned. The shared mutation path owns
    // receiver/getter evaluation, setters and heap/native invalidation.
    if (assignment) return this.inspectMutation(module, assignment, environment);
    const bindingAssignment = token.kind === "identifier" && tokens[1]?.value === "=" ? readAssignmentTarget(tokens, 1) : null;
    if (bindingAssignment?.tokens.length === 1 && bindingAssignment.tokens[0] === token) {
      // Resolving an identifier reference is not GetValue of its old contents.
      // The shared binding write index owns later reads; this expression yields
      // the evaluated RHS, with no property Reference attached to that value.
      const value = this.value(module, tokens.slice(2), environment);
      this.inspectIntrinsicAssignment(module, token, environment);
      this.constantValues.invalidate(environment);
      return value;
    }
    if (tokens.length === 1 && token.kind === "string") return new LiteralValue(token.value, [module.file]);
    const conditional = SourceConditionalExpression.read(tokens);
    if (conditional !== null) {
      const condition = this.value(module, conditional.condition, environment);
      this.observe("onSelection", condition, tokens[0], module);
      const selected = condition instanceof OperationValue ? SourceValueTruth.read(condition) : null;
      if (selected !== null) return this.value(module, selected ? conditional.consequent : conditional.alternate, environment);
      const values = [this.value(module, conditional.consequent, environment),
        this.value(module, conditional.alternate, environment)];
      return uncertainOrigins(values, "conditional helper capability origin cannot be proven",
        new SourceCallInputSelection(new SourceExpression(module, tokens), environment, condition, values));
    }
    let arrow = -1;
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] instanceof SourceTemplateToken) index = templateEnd(tokens, index);
      else if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]);
      else if (tokens[index].value === "=>") { arrow = index; break; }
    }
    const primary = SourceBodyPrimary.read(tokens);
    if (primary === null && arrow >= 0 && (tokens[0].value === "(" || tokens[0].kind === "identifier")) {
      return new CallableValue(module, new SourceDeclaration(`<helper:${token.offset}>`, tokens), environment, [module.file], this);
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
        ? new CallableValue(module, primary.declaration, environment, [module.file], this)
        : this.classValue(module, primary.declaration, environment);
      if (value instanceof ClassValue) this.initializeStatic(value);
      cursor = primary.endIndex + 1;
    } else if (token.kind === "identifier" && token.value === "new") {
      constructed = true;
      const target = SourceBodyPrimary.read(tokens, 1);
      if (target !== null) {
        value = this.classValue(module, target.declaration, environment);
        cursor = target.endIndex + 1;
      } else if (tokens[1]?.value === "(") {
        const end = matching(tokens, 1, "(", ")");
        value = this.value(module, tokens.slice(2, end), environment);
        cursor = end + 1;
      } else { value = this.identifier(module, tokens[1], environment); cursor = 2; }
    }
    else if (token.kind === "string") value = new LiteralValue(token.value, [module.file]);
    else if (token.kind === "number") {
      const numeric = Number(token.value.replaceAll("_", ""));
      value = Number.isNaN(numeric)
        ? new UnknownValue("numeric literal has no supported Number interpretation", true, [module.file])
        : new LiteralValue(numeric, [module.file]);
    }
    else if (token.value === "<template>" && token.chunks) {
      value = this.template(module, token, environment);
      cursor = tokens.findIndex((item) => item === token.endToken) + 1;
      if (cursor === 0) cursor = tokens.length;
    } else if (token.value === "[") {
      const end = matching(tokens, 0, "[", "]");
      let fixed = true;
      let inspected = true;
      const values = readCommaSeparated(tokens, 1, end).flatMap((part) => {
        if (part.length === 0) { fixed = false; return [new UnknownValue("sparse array element is unresolved", true, [module.file])]; }
        if (part.slice(0, 3).every((item) => item.value === ".") && part.length > 3) {
          const spread = this.value(module, part.slice(3), environment);
          if (spread instanceof SourceArrayValue && spread.closed && spread.fixed) return spread.values;
          fixed = false;
          inspected = false;
          const unknown = uncertainOrigins([spread], "array spread iterator has no closed source contract");
          this.observe("onUnsupported", unknown, part[0], module);
          return [unknown];
        }
        return [this.value(module, part, environment)];
      });
      value = new SourceArrayValue(module, tokens.slice(0, end + 1), environment, values, this, fixed, inspected);
      cursor = end + 1;
    } else if (token.value === "{") {
      const end = matching(tokens, 0);
      const values = readCommaSeparated(tokens, 1, end).flatMap((part) => {
        if (part.length > 3 && part.slice(0, 3).every((item) => item.value === ".")) {
          return [this.objectSpread(module, part.slice(3), part[0], environment)];
        }
        const colon = part.findIndex((item) => item.value === ":");
        return colon < 0 ? part.length === 1 ? [this.value(module, part, environment)] : [] : [this.value(module, part.slice(colon + 1), environment)];
      });
      value = end === 1 ? new EmptyObjectValue(module, tokens.slice(0, end + 1), environment, [module.file])
        : new ObjectValue(module, tokens.slice(0, end + 1), environment, [module.file], values, this);
      cursor = end + 1;
    } else if (token.value === "(") {
      const end = matching(tokens, 0, "(", ")");
      const grouped = new SourceCallReference();
      value = this.value(module, tokens.slice(1, end), environment, grouped);
      receiver = grouped.receiver;
      cursor = end + 1;
    } else if (token.value === "import" && tokens[1]?.value === "(") {
      if (!loaded) return new UnknownValue("computed dynamic loading", true, [module.file]);
      value = this.referenceValue(module, loaded);
      cursor = matching(tokens, 1, "(", ")") + 1;
    } else if (loaded?.kind === "require") {
      value = this.referenceValue(module, loaded);
      cursor = matching(tokens, 1, "(", ")") + 1;
    } else if (RegexLiteralValue.matches([token])) value = new RegexLiteralValue(token, module, environment, [module.file]);
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
        receiver = owner instanceof SourceSuperReferenceValue ? owner.receiver : owner instanceof BuiltinValue || owner instanceof ClassValue || this.objectState(owner).allocationState !== null || SourceStringValue.matches(owner) || owner instanceof UncertainValue || owner instanceof SourceAlternativeValues ? owner : null;
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
          && (value instanceof BuiltinValue || this.objectState(value).allocationState !== null || value instanceof ClassValue || value instanceof SourceSuperReferenceValue
            || value instanceof UncertainValue
            || value instanceof SourceAlternativeValues || SourceStringValue.matches(value) || fixedSequence(value))) {
          const name = String(key.value);
          const owner = value;
          value = this.readMember(value, name, tokens[cursor], module, environment);
          receiver = owner instanceof SourceSuperReferenceValue ? owner.receiver : owner;
          cursor = end + 1;
          continue;
        }
        if (key instanceof PlatformValue) this.observe("onUnsupported", new UnknownValue("computed platform dispatch has no inspected implementation paths", true, key.trace), tokens[cursor], module);
        this.observe("onMember", value, null, tokens[cursor], module, true);
        if (value instanceof SourceWeakCollectionValue || value instanceof SourceArrayValue) this.observe("onUnsupported",
          new UnknownValue("computed collection member has no inspected native contract", true, value.trace), tokens[cursor], module);
        value = new UnknownValue("computed capability access", value.sensitive, value.trace); cursor = end + 1;
      } else if (tokens[cursor].value === "(") {
        const end = matching(tokens, cursor, "(", ")");
        const arguments_ = readCommaSeparated(tokens, cursor + 1, end);
        const args = arguments_.map((part) => this.value(module, part, environment));
        const source = SourceCallSyntax.supports(value, this)
          ? new SourceCallSyntax(module, tokens.slice(0, cursor), arguments_, constructed, tokens.slice(0, end + 1)) : null;
        value = this.invoke(value, args, token, module, environment, constructed, receiver, source);
        cursor = end + 1; constructed = false; receiver = null;
      } else if (tokens[cursor].value === ",") {
        // Comma evaluates both sides but GetValue discards the RHS Reference.
        return this.value(module, tokens.slice(cursor + 1), environment);
      } else {
        const operator = SourceOperator.read(tokens, cursor);
        if (operator === null) return new UnknownValue("unsupported expression suffix obscures the capability origin", value.sensitive, value.trace);
        return new OperationValue(operator.operator, [value, this.value(module, tokens.slice(operator.endIndex), environment)]);
      }
    }
    if (reference !== null && !constructed) reference.receiver = receiver;
    return constructed ? this.invoke(value, [], token, module, environment, true, receiver) : value;
  }

  iterate(module, loop, environment) {
    const previous = this.resolvingIterationInputs;
    this.resolvingIterationInputs = true;
    let iterable;
    try { iterable = this.value(module, loop.iterable.tokens, environment); }
    finally { this.resolvingIterationInputs = previous; }
    const pattern = new BindingPattern(loop.bindingTokens);
    const refuse = reason => this.observe("onUnsupported", new UnknownValue(reason, true, iterable.trace), loop.separator, module);
    if (loop.asynchronous || !["const", "let"].includes(loop.declarationKind)
      || !(iterable instanceof SourceArrayValue && iterable.closed && iterable.fixed)) {
      refuse("for-of has no unchanged finite native iterator contract");
      return false;
    }
    // Finite execution does not remove source from the structural audit. An
    // empty iterable still has a deferred body/default source inspection.
    if (iterable.values.length === 0) {
      this.scan(module, loop.bindingTokens, environment);
      this.scan(module, loop.bodyTokens, environment);
    }
    for (const [position, value] of iterable.values.entries()) {
      const local = this.iterationContexts.environment(loop, environment, iterable, value, position, this);
      this.initializeBinding(module, pattern, value, local);
      for (const target of pattern.targets) {
        const binding = module.bindingAt(target.token);
        if (binding) local.set(binding, this.project(module, target, value, local));
      }
      let unknownCondition = false;
      const statements = new SourceStatementRoutes(loop.bodyTokens, condition => {
        this.scan(module, condition, local);
        const result = this.conditionExpression(module, condition, local);
        unknownCondition ||= result.values.some(value => value === null);
        return result;
      }, tokens => {
        const nested = SourceForOf.read(tokens);
        return nested !== null && nested.endIndex === tokens.length - 1;
      });
      const route = statements.routes[0];
      const unsupported = unknownCondition || statements.routes.some(other => other.unknown || other.terminal !== null
        || other.tokens.length !== route.tokens.length || other.tokens.some((token, index) => token !== route.tokens[index])
        || other.statements.some(statement => statement.tokens[0]?.value === "continue"));
      if (unsupported) refuse("finite iteration body has unresolved control or abrupt completion");
      // Keep every source token, including unselected defaults/branches and
      // deferred declarations. Routes prove control; they do not prune scope.
      this.scan(module, loop.bindingTokens, local);
      this.scan(module, loop.bodyTokens, local);
      if (!iterable.closed) refuse("finite iterator input changes during its body");
    }
    return true;
  }

  scan(module, tokens = module.tokens, environment = emptyEnvironment, sensitiveOnly = false) {
    const scanned = tokens.length > 0 && (environment === emptyEnvironment || environment instanceof SourceInvocationEnvironment)
      ? new SourceBodyScan(module, tokens, environment, this) : null;
    const previous = this.scanning;
    this.scanning = scanned;
    if (!this.objectCopies.has(module)) this.objectCopies.set(module, new SourceObjectCopies(module));
    const copies = this.objectCopies.get(module);
    try {
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const loop = !sensitiveOnly && token.value === "for" ? SourceForOf.read(tokens, index) : null;
        if (loop !== null && this.iterate(module, loop, environment)) { index = loop.endIndex; continue; }
        this.index(module);
        for (const initialization of this.bindingInitializations.get(module).get(token) ?? []) {
          this.initializeBinding(module, initialization.pattern, this.value(module, initialization.tokens, environment), environment);
        }
        const copy = sensitiveOnly ? null : copies.at(token);
        if (copy) this.objectSpread(module, copy.tokens, copy.token, environment);
        if (!sensitiveOnly && token.kind === "identifier") this.inspectIntrinsicAssignment(module, token, environment);
        if (!sensitiveOnly && token.value === "this" && environment instanceof SourceInvocationEnvironment
          && environment.get(lexicalConstruction)?.initialized === false && environment.declaration.ownsBodyToken(token)) {
          this.identifier(module, token, environment);
        }
        if (!sensitiveOnly) for (const mutation of this.mutations(module).mutationFor(token)) {
          if (mutation.token === token) this.inspectMutation(module, mutation, environment);
        }
        const delimitedPrimary = !sensitiveOnly && token.value === "[" ? SourceArrayPrimary.read(tokens, index)
          : !sensitiveOnly && token.value === "(" ? SourceGroupPrimary.read(tokens, index) : null;
        const literalMember = !sensitiveOnly && (token.kind === "string" || token instanceof SourceRegexToken)
          && [".", "[", "?"].includes(tokens[index + 1]?.value) && readMemberAccess(tokens, index) !== null;
        if (literalMember || delimitedPrimary !== null && [".", "[", "(", "?"].includes(tokens[delimitedPrimary.endIndex + 1]?.value)) {
          const expression = tokens.slice(index, this.expressionEnd(module, tokens, index));
          if (!scanned?.evaluated(module, expression, environment, this)) {
            const value = this.value(module, expression, environment);
            scanned?.remember(expression, value, this);
          }
        }
        if (token.kind !== "identifier" || [".", "?"].includes(tokens[index - 1]?.value)) continue;
        if (token.value === "super" && environment instanceof SourceInvocationEnvironment
          && !environment.declaration.ownsBodyToken(token)) continue;
        const primary = ["function", "class"].includes(token.value) ? SourceBodyPrimary.read(tokens, index) : null;
        let start = index;
        if (token.value === "new") {
          const expression = tokens.slice(index, this.expressionEnd(module, tokens, index));
          if (!scanned?.evaluated(module, expression, environment, this)) {
            const value = this.value(module, expression, environment);
            scanned?.remember(expression, value, this);
          }
          continue;
        }
        if (tokens[index - 1]?.value === "new") continue;
        if (primary !== null) {
          if (token.value === "class") this.initializeStatic(this.classValue(module, primary.declaration, environment));
          // A declaration alone grants no invocation. A primary's actual
          // postfix use must still be inspected when its result is discarded.
          if (primary.isDeclaration(tokens) || ![".", "[", "(", "?"].includes(tokens[primary.endIndex + 1]?.value)) {
            if (environment !== emptyEnvironment
              && !(environment instanceof SourceIterationEnvironment && environment.inspectDeferred)) index = primary.endIndex;
            continue;
          }
          if (tokens[index - 1]?.kind === "identifier" && tokens[index - 1].value === "async") start--;
        } else {
          if (token.kind !== "identifier" || [".", "?"].includes(tokens[index - 1]?.value)
            || ["import", "export", "from", "const", "let", "var", "function", "class", "return", "if", "switch", "while", "for", "catch"].includes(token.value)) continue;
          if (module.isCallableDeclarationToken(token)) continue;
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
    this.origins.conditionExpression = (module, tokens, environment) => this.platformExpression(module, tokens, environment);
    this.origins.onMember = (...args) => this.member(...args);
    this.origins.onUnsupported = (value, token, module) => {
      if (this.origins.effectSummary !== null) { this.origins.effectSummary.depend(value); return; }
      if (value.sensitive) this.incomplete(this.ruleFor(value), module, token, value, value.reason);
    };
    this.origins.effectObservers = [this.origins.onCall, this.origins.onMember, this.origins.onUnsupported];
    this.origins.onSelection = (value, token, module) => {
      if (!this.origins.observing && valueOrigins(value).some((origin) => origin instanceof PlatformValue)) this.platformSelection(module, token, value);
    };
  }
  incomplete(rule, module, token, value, message) {
    if (this.origins.effectSummary !== null) { this.origins.effectSummary.record(value); return; }
    this.diagnose(rule, module.file, token, [...this.origins.route, module.file, ...value.trace], message, "incomplete");
  }
  violation(rule, module, token, value, message) {
    if (this.origins.effectSummary !== null) { this.origins.effectSummary.record(value); return; }
    this.diagnose(rule, module.file, token, [...this.origins.route, module.file, ...value.trace], message);
  }
  platformExpression(module, tokens, environment = emptyEnvironment) {
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
        const value = this.origins.identifier(module, token, environment);
        if (valueOrigins(value).some((origin) => origin instanceof PlatformValue || origin instanceof BuiltinValue && ["process", "os"].includes(origin.builtin))) { candidate = true; break; }
      }
    } finally { this.origins.scanHelpers = scan; }
    if (environment === emptyEnvironment && !candidate && !(tokens.length === 1 && (tokens[0].kind === "string" || tokens[0].kind === "number" || ["true", "false", "null", "undefined"].includes(tokens[0].value)))) return new PlatformExpression(false, supportedPlatforms.map(() => null));
    // Split logical operators before using the shared value evaluator, whose
    // general provenance contract deliberately does not interpret precedence.
    for (const operator of ["||", "&&"]) {
      for (let index = 0; index < tokens.length - 1; index++) {
        if (tokens[index] instanceof SourceTemplateToken) { index = templateEnd(tokens, index); continue; }
        if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) { index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]); continue; }
        if (`${tokens[index].value}${tokens[index + 1].value}` !== operator) continue;
        const left = this.platformExpression(module, tokens.slice(0, index), environment);
        const right = this.platformExpression(module, tokens.slice(index + 2), environment);
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
    try { return interpret(this.origins.value(module, tokens, environment)); }
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
      const construction = callee.environment.get(lexicalConstruction);
      if (construction instanceof SourceConstructionFrame && !boundary?.dependent) return null;
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
        } else if (!["console", "Object", "String", "path", "os", "url", "URL"].includes(callee.builtin)
          && !this.origins.nativeErrorConstructor(callee)
          && !(callee.builtin === "Array" && (callee.member === undefined || callee.member === "isArray"))) unknown = true;
      } else if (callee instanceof CallableValue) {
        delegations.add(callee);
        const construction = callee.environment.get(lexicalConstruction);
        if (construction instanceof SourceConstructionFrame && this.invocationClass(construction.source)
          && new SourceClassMembers(construction.source.declaration).instanceMembers.get("constructor")?.token === callee.declaration.token) {
          typedDeclarations.add(`${callee.module.file}:${callee.declaration.token.offset}`);
        }
      } else if (callee instanceof UnknownValue || callee instanceof ModuleLoaderValue) unknown = true;
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
        const usage = new SourceModuleCallableUsage(module, name);
        index.usages.set(boundary, usage);
        if (usage.public) index.public.add(boundary);
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
    const definition = this.origins.nativePermissionDefinition(module, boundary.declaration.token);
    if (definition !== null && [definition.equal, definition.afterWrite].some(member => member.token === boundary.declaration.token)) {
      index.resolutions.set(boundary, "done");
      return boundary.classification;
    }
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
    const unresolved = !callers.length || !index.usages.get(boundary)?.closed;
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
      this.origins.invalidateInvocation(receiver, true);
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
        && this.origins.invocationType(args[0])) {
        this.origins.invalidateInvocation(args[0], true);
        this.incomplete("OS02", module, token, args[0], "invocation reflection escapes the closed option-method contract");
      }
      if (["fs", "fs/promises"].includes(callee.builtin)) this.filesystem(callee, args, token, module, environment);
      if (callee.builtin === "Reflect" && ["set", "defineProperty", "deleteProperty", "setPrototypeOf"].includes(name)
        && args[0]?.sensitive) {
        if (args[0] instanceof BuiltinValue) this.origins.nativeMutations.add(args[0], args[1] instanceof LiteralValue && typeof args[1].value === "string" ? args[1].value : null);
        this.incomplete(this.ruleFor(args[0]), module, token, args[0], "reflective mutation obscures an OS-sensitive capability");
      }
      if (callee.builtin === "Reflect" && ["get", "apply", "construct"].includes(name) && args.some((arg) => arg.sensitive)) this.incomplete("OS02", module, token, callee, "reflective access obscures an OS-sensitive capability");
      if (callee.builtin === "path" && ["join", "resolve", "normalize"].includes(name) && args.flatMap((value) => valueOrigins(value, false, true)).some((arg) => arg instanceof UrlPathnameValue)) this.violation("OS04", module, token, callee, "file URL pathname is used as a native path without fileURLToPath");
      const inspectedConsumer = ["fs", "fs/promises", "child_process", "process", "os", "path", "url", "URL", "module", "vm", "console", "Reflect"].includes(callee.builtin)
        || callee.builtin === "Object" && ["freeze", "seal"].includes(name)
        || SourceNativeIntegrityOperation.inspect(callee, args) !== null
        || SourceObjectEnumeration.supports(callee)
        // Reading a descriptor/prototype of a proven source invocation does
        // not call all of its methods. The reflection refusal above still
        // invalidates shared authority; it is not an opaque consumer call.
        || callee.builtin === "Object" && this.origins.invocationType(args[0])
          && (name === "getPrototypeOf" || name === "getOwnPropertyDescriptor" && args[1] instanceof LiteralValue)
        || callee.builtin === "Array" && (name === undefined || name === "isArray")
        || ["WeakSet", "WeakMap"].includes(callee.builtin) && name === undefined && (args.length === 0 || args[0] instanceof LiteralValue && args[0].value == null)
        || this.origins.nativeErrorConstructor(callee)
        || callee.builtin === "String" && name === undefined && (args[0] instanceof LiteralValue || this.origins.nativeErrorStringStable(args[0]))
        || callee.builtin === "BigInt" && name === undefined && args.length === 1 && (
          args[0] instanceof LiteralValue || args[0] instanceof UnknownValue && !args[0].sensitive
          || args[0] instanceof AuthorityValue || args[0] instanceof PrimitiveConversionValue
          || args[0] instanceof BuiltinValue && args[0].builtin === "process" && args[0].member === "pid");
      if (!inspectedConsumer) {
        for (const arg of args) {
          if (this.origins.effectSummary !== null) this.origins.effectSummary.depend(arg);
          else if (arg.sensitive) this.incomplete(this.ruleFor(arg), module, token, arg, "unsupported builtin transform escapes an OS-sensitive capability");
        }
        for (const arg of args) this.origins.exposedObject(arg, token);
      }
      if (callee.builtin === "Reflect" && ["set", "defineProperty", "deleteProperty", "setPrototypeOf"].includes(name)
        && (this.origins.objectState(args[0])?.allocationState ?? null) !== null) {
        const key = args[1] instanceof LiteralValue && typeof args[1].value === "string" ? args[1].value : null;
        const value = name === "set" ? args[2] ?? new LiteralValue(undefined)
          : new UnknownValue("reflective member mutation has no inspected data value", true, args[0].trace);
        this.origins.objectState(args[0]).allocationState.write(new SourceObjectWrite(token, key, value));
      }
    }
    if (callee instanceof ModuleLoaderValue) this.incomplete("OS02", module, token, callee, "created require function has an unsupported dynamic loading contract");
    if (callee instanceof DescriptorMethodValue && ["sync", "datasync"].includes(callee.details)) this.descriptorSync(callee.origin, token, module);
    if (callee instanceof ChildMethodValue && callee.details === "kill" && args.length > 0
      && (!(args[0] instanceof LiteralValue) || !portableChildSignals.has(args[0].value))) this.incomplete("OS01", module, token, callee, "retained ChildProcess kill has no proven portable signal");
    if (!(callee instanceof CallableValue) && !(callee instanceof ClassValue) && !(callee instanceof BuiltinValue)
      && !(callee instanceof SourceSuperConstructorValue && (callee.frame.parent instanceof ClassValue || this.origins.nativeErrorConstructor(callee.frame.parent)))
      && !(callee instanceof SourceNativePermissionMethodValue || callee instanceof InvocationOptionsMethodValue || callee instanceof SourceWeakCollectionMethodValue || callee instanceof SourceRegexMethodValue || callee instanceof SourceArrayMethodValue || callee instanceof JoinMethodValue || callee instanceof StringMethodValue || callee instanceof RetainedStringMethodValue || callee instanceof ChildMethodValue || callee instanceof DescriptorMethodValue)) {
      for (const arg of args) {
        if (this.origins.invocationType(arg)) this.incomplete("OS02", module, token, arg, "invocation constructor or instance escapes to an uninspected consumer");
        else if (this.origins.effectSummary !== null) this.origins.effectSummary.depend(arg);
        else if (arg.sensitive) this.incomplete(this.ruleFor(arg), module, token, arg, "OS-sensitive capability escapes to an uninspected consumer");
        this.origins.exposedObject(arg, token);
        if (arg instanceof BuiltinValue) this.origins.nativeMutations.add(arg);
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
    const nodeArguments = fixedSequence(argv) ? argv.values.map((value) => value instanceof LiteralValue && typeof value.value === "string"
      ? new ExecutionArgument(value.value, false) : new ExecutionArgument("", true)) : [new ExecutionArgument("", true)];
    const nodeBoundary = NodeExecutionBoundary.inspect(nodeExecutable, nodeArguments);
    if (nodeBoundary?.status === "inline") this.incomplete("OS04", module, token, callee, "inline JavaScript execution has no inspected module boundary");
    else if (nodeBoundary?.status === "incomplete") this.incomplete("OS04", module, token, callee, `Node option boundary cannot be proven before the script entry (${nodeBoundary.option})`);
    const fixture = this.ownedFixture(module, token, callee, args);
    if (fixture === null) this.incomplete("OS02", module, token, callee, "test-owned launch has an unsupported cleanup or inline-code contract");
    else if (!fixture) {
      const boundary = this.typedBoundary(module, token, environment, invocation);
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
    const evaluatedOptions = capturedOptions ?? this.origins.value(module, parts[2], environment);
    const captured = evaluatedOptions instanceof ObjectValue
      ? evaluatedOptions.values.filter(value => value instanceof InvocationOptionsValue) : [];
    const binding = module.bindingAt(receiver);
    if (captured.length !== 1 || captured[0].binding !== binding) return null;
    const instance = captured[0].owner;
    if (!(instance instanceof InvocationInstanceValue)) return null;
    if (!this.origins.invocationAuthorities.valid(instance)) {
      this.incomplete("OS02", module, token, instance, "typed invocation authority was mutated or exposed");
      return null;
    }
    // A nominal option owner does not erase unresolved origins in its fields.
    // Use the ordinary origin query so alternatives and returned method values
    // retain the same obligations at the native consumer.
    const unresolved = captured.flatMap(value => valueOrigins(value)).filter(value => value instanceof UnknownValue && value.sensitive);
    if (unresolved.length > 0) {
      for (const value of unresolved) this.incomplete("OS02", module, token, value, value.reason);
      return null;
    }
    const options = new SourceObjectMembers(parts[2]);
    if (!options.complete || options.entries.length < 2) return null;
    const spreads = options.entries.filter(entry => entry instanceof SourceObjectSpread);
    const shell = options.entries.find(entry => !(entry instanceof SourceObjectSpread) && entry.token.value === "shell");
    if (spreads.length !== 1 || !shell || !shell.matches("false")
      || !InvocationClassContract.matches(spreads[0].tokens, `${receiver.value}.processOptions()`)) return null;
    if (options.entries.some(property => property !== shell && !(property instanceof SourceObjectSpread)
      && !(property instanceof SourceInitializer && new ProcessObservationOption(property).accepted))) return null;
    // The three spellings must resolve to the SAME lexical binding; a matching
    // class name or a different instance's closed options confer no proof.
    const same = [parts[1][0], spreads[0].tokens[0]];
    if (!module.bindingAt(receiver) || same.some(reference => module.bindingAt(reference) !== module.bindingAt(receiver))) return null;
    return instance;
  }
  typedBoundary(module, token, environment = emptyEnvironment, invocation = this.constructedInvocationLaunch(module, token, environment)) {
    if (invocation !== null) return true;
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
    if (callee.member === "spawn" && (!fixedSequence(argv)
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
  filesystem(callee, args, token, module, environment = emptyEnvironment) {
    const name = callee.member;
    const visitedFlags = new Set();
    const flags = (value) => {
      if (visitedFlags.has(value)) return [];
      visitedFlags.add(value);
      if (value instanceof BuiltinValue) return value.members.filter(member => osFlags.has(member));
      if (value instanceof SourceArrayValue) return [...value.values, ...value.state.sensitivityInputs].flatMap(flags);
      if (value instanceof SourceValues || value instanceof ObjectValue) return value.values.flatMap(flags);
      return value instanceof ConcatenationValue ? flags(value.origin) : [];
    };
    for (const input of args) if (input instanceof SourceArrayValue) this.origins.effectSummary?.readState(input.state);
    // Node documents UV_FS_O_FILEMAP as an ignored optimization elsewhere;
    // its presence establishes no stronger public filesystem guarantee.
    for (const flag of args.flatMap(flags)) this.capability("OS03", module, token, callee, flag === "UV_FS_O_FILEMAP" ? supportedPlatforms : posixPlatforms, `filesystem flag ${flag} has no corresponding platform guarantee`);
    for (const input of filesystemContract(callee)?.paths(args, (value, key) => this.property(value, key)) ?? []) {
      if (this.origins.effectSummary !== null && SourceEffectDependence.of(input)) this.origins.effectSummary.record(callee);
      this.filesystemPath(callee, input, token, module);
    }
    if (/^(?:chmod|chown|fchmod|fchown|lchmod|lchown)/.test(name)) {
      // Only the exact definition contributes this conditional summary. An
      // actual invocation is classified by its nominal receiver above.
      const definition = name === "fchmodSync" ? this.origins.nativePermissionDefinition(module, token) : null;
      const conditional = environment === emptyEnvironment && definition !== null
        && definition.memberAt(token) === definition.apply;
      if (!conditional) this.capability("OS03", module, token, callee, posixPlatforms, "UID/mode mutation requires a corresponding Windows authority implementation");
    }
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
    // Interpret helper returns before diagnosing their consumers. If this
    // complete traversal cannot finish, retain the existing independent shallow
    // inspection of every source token, within its original separate budget.
    // Neither a successful recovery nor its own failure erases the first error.
    try { this.origins.scan(module); }
    catch (error) {
      this.origins.resetWork();
      this.origins.deepCalls = false;
      try { this.origins.scan(module, tokens, emptyEnvironment, true); }
      catch (independentError) {
        reportOsInspectionFailure(this.diagnose, module, independentError, [module.file], "independent source inspection incomplete");
      } finally { this.origins.deepCalls = true; }
      throw error;
    }
    const exportAssignments = new Set(module.commonJsExports.map(entry => entry.token));
    const exportTargets = new Set(module.commonJsExports.map(entry => entry.target.token));
    const bindingExpressions = new Set([...this.origins.index(module).values()].flatMap((origins) => origins.expressions.map((expression) => expression.tokens[0]?.offset)));
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index].value !== "=" || tokens[index - 1]?.value === "=" || tokens[index + 1]?.value === "="
        || tokens[index - 1]?.kind === "identifier" && tokens[index - 2]?.value !== ".") continue;
      if (exportAssignments.has(tokens[index]) || bindingExpressions.has(tokens[index + 1]?.offset)) continue; // The shared binding projection owns declaration/destructuring validation.
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
      if (token.kind !== "identifier" || [".", "import", "from", "as", "function", "class", "new"].includes(tokens[index - 1]?.value)
        || ["const", "let", "var", "function", "class", "return", "if", "switch", "case", "while", "for", "catch", "throw", "export", "from"].includes(token.value)
        || tokens[index + 1]?.value === "=" && tokens[index + 2]?.value !== "=") continue;
      if (exportTargets.has(token)) continue; // The shared export graph owns this inspected assignment.
      if (module.isCallableDeclarationToken(token)) continue; // Defaults and bodies remain in the complete token traversal.
      const value = this.origins.value(module, tokens.slice(index, this.origins.expressionEnd(module, tokens, index)));
      // An uninspected producer has already passed through call/effect checks.
      // Its possible returned aliases are inspected by actual consumers, not
      // treated as a new unsupported operation when the result is discarded.
      if (value instanceof UnknownValue && !(value instanceof SourceUninspectedCallResult) && value.sensitive) {
        this.incomplete("OS02", module, token, value, value.reason);
      }
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
