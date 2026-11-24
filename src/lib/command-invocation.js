import { types } from 'node:util';

/** Literal process arguments. Display text never grants execution authority. */
export class CommandInvocationError extends TypeError {
  constructor(message, { source = 'command', language = 'en' } = {}) {
    const help = language === 'ja'
      ? 'シェル文字列を廃止しました。例: {"kind":"node-script","script":"tests/run.js","args":[]}。実行ファイルには {"kind":"native","executable":"tool","args":[]} を使い、各引数を配列要素として指定してください。'
      : 'Replace shell text explicitly, for example {"kind":"node-script","script":"tests/run.js","args":[]} or {"kind":"native","executable":"tool","args":[]}; put each literal argument in its own array element.';
    super(`${source}: ${message}. ${help}`);
    this.code = 'COMMAND_INVOCATION_INVALID';
    this.source = source;
  }
}
function token(value, label, empty = false) {
  if (typeof value !== 'string' || (!empty && !value) || value.includes('\0')) throw new CommandInvocationError(`${label} must be a NUL-free string`);
  return value;
}
function tokens(value, label) {
  if (!Array.isArray(value)) throw new CommandInvocationError(`${label} must be an array`);
  return Object.freeze([...value].map((entry) => token(entry, label, true)));
}
export function immutableCommandEnvironment(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new CommandInvocationError('env must be an object or null');
  if (types.isProxy(value)) throw new CommandInvocationError('env must not be a Proxy');
  if (Array.isArray(value)) throw new CommandInvocationError('env must be an object or null');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = new Set();
  const environment = {};
  for (const name of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[name];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, 'value')) throw new CommandInvocationError('env enumerable properties must be data properties');
    const entry = descriptor.value;
    if (typeof name === 'string') {
      if (!name || /[=\0]/.test(name) || names.has(name.toUpperCase())) throw new CommandInvocationError(`env key ${name} is invalid or duplicated ignoring case`);
      names.add(name.toUpperCase());
      token(entry, `env.${name}`, true);
    }
    Object.defineProperty(environment, name, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return Object.freeze(environment);
}

/** Native launchers add inherited variables; keep captured evidence detached. */
export function nativeCommandEnvironment(environment) {
  return environment === null ? null : { ...environment };
}

function stdioValue(value) {
  if (['pipe', 'ignore', 'inherit'].includes(value)) return value;
  if (!Array.isArray(value) || value.length < 3 || [...value].some((entry) => !['pipe', 'ignore', 'inherit', 'ipc', null].includes(entry) && !(Number.isSafeInteger(entry) && entry >= 0))) {
    throw new CommandInvocationError('stdio must describe standard streams and numeric inherited descriptors');
  }
  return Object.freeze([...value]);
}
/** Exact resolved spawn inputs, distinct from user invocation provenance.
 * Ordinary environment is captured here; the runtime adds only its newly
 * authenticated reserved delegation keys when starting the registered child. */
export class CommandLaunchDescriptor {
  constructor({ executable, args, cwd, env, stdio, windowsVerbatimArguments }) {
    this.executable = token(executable, 'launch.executable');
    this.args = tokens(args, 'launch.args');
    this.cwd = cwd === null ? null : token(cwd, 'launch.cwd');
    this.env = immutableCommandEnvironment(env);
    this.stdio = stdioValue(stdio);
    if (typeof windowsVerbatimArguments !== 'boolean') throw new CommandInvocationError('launch.windowsVerbatimArguments must be boolean');
    this.windowsVerbatimArguments = windowsVerbatimArguments;
    Object.freeze(this);
  }
  static fromStored(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 7 || ['executable', 'args', 'cwd', 'env', 'stdio', 'windowsVerbatimArguments', 'schemaVersion'].some((key) => !Object.hasOwn(value, key))
      || value.schemaVersion !== 1) throw new CommandInvocationError('invalid resolved launch descriptor');
    return new CommandLaunchDescriptor(value);
  }
  toJSON() {
    return { schemaVersion: 1, executable: this.executable, args: [...this.args], cwd: this.cwd,
      env: this.env === null ? null : { ...this.env }, stdio: Array.isArray(this.stdio) ? [...this.stdio] : this.stdio,
      windowsVerbatimArguments: this.windowsVerbatimArguments };
  }
}
export class CommandInvocation {
  constructor({ executable, args = [], cwd = null, env = null, stdio = 'pipe' }) {
    if (new.target === CommandInvocation) throw new CommandInvocationError('use a concrete invocation class');
    this.executable = token(executable, 'executable');
    this.args = tokens(args, 'args');
    this.cwd = cwd === null ? null : token(cwd, 'cwd');
    this.env = immutableCommandEnvironment(env);
    this.stdio = stdioValue(stdio);
  }
  toString() { return [this.executable, ...this.args].map((entry) => /^[A-Za-z0-9_./:=+-]+$/.test(entry) ? entry : JSON.stringify(entry)).join(' '); }
  processOptions() { return { ...(this.cwd !== null && { cwd: this.cwd }), ...(this.env !== null && { env: nativeCommandEnvironment(this.env) }), stdio: this.stdio }; }
  resolvedLaunch() {
    return new CommandLaunchDescriptor({ executable: this.executable, args: this.args, cwd: this.cwd, env: this.env,
      stdio: this.stdio, windowsVerbatimArguments: this.processOptions().windowsVerbatimArguments === true });
  }
  static fromStored(value, context = {}) {
    if (value instanceof CommandInvocation) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommandInvocationError('expected a structured invocation', context);
    const common = ['kind', 'args', 'cwd', 'env', 'stdio'];
    const keys = value.kind === 'native' ? [...common, 'executable'] : value.kind === 'node-script' ? [...common, 'script', 'nodeArgs'] : [];
    if (!keys.length || Object.keys(value).some((key) => !keys.includes(key)) || !Object.hasOwn(value, 'args')) throw new CommandInvocationError('unknown kind, missing args, or unknown fields', context);
    try { return value.kind === 'native' ? new NativeExecutableInvocation(value) : new NodeScriptInvocation(value); }
    catch (error) { if (error instanceof CommandInvocationError) throw new CommandInvocationError(error.message, context); throw error; }
  }
}
export class NativeExecutableInvocation extends CommandInvocation {
  constructor(input) { super(input); Object.freeze(this); }
  toJSON() { return { kind: 'native', executable: this.executable, args: [...this.args], cwd: this.cwd, env: this.env === null ? null : { ...this.env }, stdio: Array.isArray(this.stdio) ? [...this.stdio] : this.stdio }; }
}
export class NodeScriptInvocation extends CommandInvocation {
  constructor({ script, args = [], nodeArgs = [], ...options }) {
    const entry = token(script, 'script');
    const flags = tokens(nodeArgs, 'nodeArgs');
    const scriptArgs = tokens(args, 'args');
    super({ ...options, executable: process.execPath, args: [...flags, entry, ...scriptArgs] });
    this.script = entry; this.nodeArgs = flags; this.scriptArgs = scriptArgs;
    Object.freeze(this);
  }
  toJSON() { return { kind: 'node-script', script: this.script, nodeArgs: [...this.nodeArgs], args: [...this.scriptArgs], cwd: this.cwd, env: this.env === null ? null : { ...this.env }, stdio: Array.isArray(this.stdio) ? [...this.stdio] : this.stdio }; }
}
/** Explicit executable+argv remains a valid internal API; shell text does not. */
export function normalizeCommandInvocation(command, args, options = {}) {
  if (command instanceof CommandInvocation) {
    if (Array.isArray(args) && args.length) throw new CommandInvocationError('typed invocation cannot receive additional argv');
    for (const key of ['cwd', 'env', 'stdio']) {
      if (options[key] !== undefined) throw new CommandInvocationError(`typed invocation ${key} cannot be overridden`);
    }
    return command;
  }
  if (!Array.isArray(args)) throw new CommandInvocationError('explicit executable requires an args array');
  return new NativeExecutableInvocation({ executable: command, args, cwd: options.cwd ?? null, env: options.env ?? null, stdio: options.stdio ?? 'pipe' });
}

/** Public configuration shape; class constructors enforce NUL and environment invariants. */
export const COMMAND_INVOCATION_SCHEMA = {
  oneOf: ['native', 'node-script'].map((kind) => ({
    type: 'object', additionalProperties: false,
    required: ['kind', kind === 'native' ? 'executable' : 'script', 'args'],
    properties: {
      kind: { type: 'string', enum: [kind] },
      ...(kind === 'native' ? { executable: { type: 'string', minLength: 1 } }
        : { script: { type: 'string', minLength: 1 }, nodeArgs: { type: 'array', items: { type: 'string' } } }),
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: ['string', 'null'], minLength: 1 },
      env: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
      stdio: { oneOf: [
        { type: 'string', enum: ['pipe', 'ignore', 'inherit'] },
        { type: 'array', minItems: 3, items: { oneOf: [
          { type: 'string', enum: ['pipe', 'ignore', 'inherit', 'ipc'] },
          { type: 'integer', minimum: 0 }, { type: 'null' },
        ] } },
      ] },
    },
  })),
};
