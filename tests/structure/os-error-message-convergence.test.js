import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
import { SourceModule } from '../support/structure/source-reader.js';

const file = 'src/repeated-construction.mjs';
const source = "class Failure extends TypeError{constructor(message,{source='ordinary'}={}){super(`${source}: ${message}`);this.source=source;}}const value=new Failure('message');";
class MessageFixture {
  constructor() {
    this.checker = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] });
    this.module = this.checker.graph.module(file, { lexicalOnly: true });
    this.origins = this.checker.rules.origins;
    this.environment = new Map();
    this.callee = this.origins.value(this.module, this.module.declaration('Failure').tokens, this.environment);
    this.argument = this.origins.value(this.module, [this.module.tokens.find(token => token.kind === 'string' && token.value === 'message')], this.environment);
    this.token = this.module.tokens.find(token => token.value === 'new');
    this.calls = 0;
    const invoke = this.origins.invoke, fixture = this;
    this.origins.invoke = function(...args) { fixture.calls++; return invoke.apply(this, args); };
  }
  read() {
    const value = this.origins.invoke(this.callee, [this.argument], this.token, this.module, this.environment, true);
    this.value = value;
    this.write = value.state.writes.find(write => write.name === 'message');
    return this.write.values.at(-1);
  }
  template(parts, changes = {}) {
    const input = this.message.origin;
    return new input.constructor(new input.origin.constructor(parts, input.origin.trace),
      changes.details ?? input.details, changes.token ?? input.token, changes.raw ?? input.raw);
  }
  output(input = this.message.origin, changes = {}) {
    const original = this.message.callContext;
    const context = new original.constructor(changes.source ?? original.source, changes.callee ?? original.callee,
      original.receiver, changes.environment ?? original.environment, [input], [], changes.trace ?? original.trace,
      changes.constructed ?? original.constructed);
    const result = new this.message.constructor(input).withCallContext(context);
    result.messageInterpretation = new this.message.messageInterpretation.constructor(context, this.message.messageInterpretation.footprint);
    return result;
  }
  seed() { this.message = this.read(); return this; }
  same(value) { return this.message.constructor.sameOrigins(this.message, value); }
}

test('the original eight constructor interpretations converge without omitting invocation or observation effects', () => {
  const fixture = new MessageFixture();
  let state = null;
  for (let repeat = 0; repeat < 8; repeat++) {
    const calls = fixture.calls, observations = fixture.origins.observations;
    fixture.read();
    assert.equal(fixture.write.values.length, 1);
    assert.equal(fixture.value.state.revision, 3);
    if (state !== null) assert.equal(fixture.value.state, state);
    state = fixture.value.state;
    assert.equal(fixture.calls - calls, repeat === 0 ? 6 : 4);
    assert.equal(fixture.origins.observations - observations, repeat === 0 ? 8 : 5);
  }
});

test('native super invocation keeps actual constructed mode separate from its source syntax', () => {
  const fixture = new MessageFixture().seed(), context = fixture.message.callContext;
  assert.equal(context.constructed, true);
  assert.equal(context.source.constructed, false);
  assert.equal(context.callee.builtin, 'TypeError');
  assert.deepEqual(context.source.expression.tokens.map(token => token.offset), [76, 81, 82, 85, 96, 104, 105]);
  assert.equal(context.inputs[0], fixture.message.origin);
});

test('equal immutable template/default leaves qualify independently of wrapper identity', () => {
  const fixture = new MessageFixture().seed();
  const [fallback, message] = fixture.message.origin.origin.values;
  const [input, literal] = fallback.origin.values;
  const copy = new fallback.constructor(new input.constructor(input.reason, input.isSensitive, input.trace),
    new literal.constructor(literal.value, literal.trace));
  assert.equal(fixture.same(fixture.output(fixture.template([copy, new message.constructor(message.value, message.trace)]))), true);
});

for (const kind of ['literal', 'unknown reason', 'unknown trace', 'template raw', 'template text', 'template token', 'native callee', 'native mode', 'source mode', 'environment', 'context trace', 'home declaration', 'home environment', 'home instance']) test(`message duplicate proof rejects changed ${kind}`, () => {
  const fixture = new MessageFixture().seed();
  const input = fixture.message.origin, [fallback, message] = input.origin.values;
  const [unknown, literal] = fallback.origin.values;
  let result;
  if (kind === 'literal') result = fixture.output(fixture.template([fallback, new message.constructor('different', message.trace)]));
  if (kind === 'unknown reason' || kind === 'unknown trace') result = fixture.output(fixture.template([
    new fallback.constructor(new unknown.constructor(kind === 'unknown reason' ? 'different' : unknown.reason,
      unknown.isSensitive, kind === 'unknown trace' ? ['different.mjs'] : unknown.trace), literal), message]));
  if (kind === 'template raw') result = fixture.output(fixture.template(input.origin.values, { raw: !input.raw }));
  if (kind === 'template text') result = fixture.output(fixture.template(input.origin.values, { details: 'different' }));
  if (kind === 'template token') {
    const module = new SourceModule('src/other.mjs', 'const value=`${left}: ${right}`;');
    result = fixture.output(fixture.template(input.origin.values, { token: module.templates[0] }));
  }
  const context = fixture.message.callContext;
  if (kind === 'native callee') result = fixture.output(input, { callee: new context.callee.constructor('RangeError', [], context.callee.trace) });
  if (kind === 'native mode') result = fixture.output(input, { constructed: false });
  if (kind === 'source mode') result = fixture.output(input, { source: new context.source.constructor(fixture.module,
    context.source.callee.tokens, context.source.arguments.map(argument => argument?.tokens ?? []), true, context.source.expression.tokens) });
  if (kind === 'environment') result = fixture.output(input, { environment: new Map(context.environment) });
  if (kind === 'context trace') result = fixture.output(input, { trace: ['different.mjs'] });
  if (kind.startsWith('home ')) {
    const home = context.home;
    const otherModule = new SourceModule('src/other.mjs', 'class Other {}');
    const otherSource = kind === 'home declaration' ? fixture.origins.value(otherModule, otherModule.declaration('Other').tokens, new Map()) : home.source;
    // Use the existing lexical-home API directly; no semantic context key is compared.
    const other = kind === 'home environment' ? new home.constructor(
      new home.source.constructor(home.source.module, home.source.declaration, home.source.instance, home.source.trace, [], new Map()), home.instance)
      : new home.constructor(otherSource, kind === 'home instance' ? !home.instance : home.instance);
    assert.equal(home.matches(other), false);
    return;
  }
  assert.equal(fixture.same(result), false);
});

test('heap, formal, callable and opaque inputs remain outside semantic leaves even by the same reference', () => {
  const fixture = new MessageFixture().seed(), [, message] = fixture.message.origin.origin.values;
  const callable = fixture.callee.effects.evaluate().values.find(value => value.effects?.parameters?.values.length);
  const formal = callable.effects.parameters.values[0];
  const opaqueModule = new SourceModule('src/opaque.mjs', 'foreign(input)');
  const opaque = fixture.origins.value(opaqueModule, opaqueModule.tokens);
  for (const value of [fixture.value, formal, callable, opaque]) {
    assert.equal(fixture.message.origin.constructor.messageLeaf(value), false);
    const template = fixture.template([value, message]), output = fixture.output(template);
    assert.equal(output.constructor.sameOrigins(output, output), false);
  }
  const otherOperation = new fixture.message.constructor(fixture.message.origin);
  assert.equal(fixture.message.constructor.sameOrigins(fixture.message, otherOperation), false);
});

test('a changed native input footprint cannot reuse an earlier semantic interpretation', () => {
  const fixture = new MessageFixture().seed(), footprint = fixture.message.messageInterpretation.footprint;
  assert.equal(fixture.same(fixture.output()), true);
  fixture.origins.nativeMutations.add(new fixture.message.callContext.callee.constructor('Object', ['prototype']));
  assert.equal(footprint.same(footprint), false);
  assert.equal(fixture.same(fixture.output()), false);
});

for (const [expression, constructed, owner] of [
  ['TypeError(`${input}`)', false, null],
  ['new TypeError(`${input}`)', true, null],
  ['globalThis.TypeError(`${input}`)', false, 'globalThis'],
  ["globalThis['TypeError'](`${input}`)", false, 'globalThis'],
]) test(`native message metadata preserves source member receiver: ${expression}`, () => {
  const module = new SourceModule('src/error-receiver.mjs', `const value=${expression};`);
  const fixture = new MessageFixture();
  const tokens = module.tokens.slice(3, -1), environment = new Map();
  for (const interpret of [() => fixture.origins.expression(module, tokens, environment),
    () => fixture.origins.value(module, tokens, environment)]) {
    const result = interpret(), context = result.message.callContext;
    assert.ok(context);
    assert.equal(context.constructed, constructed);
    assert.equal(context.source.constructed, constructed);
    assert.equal(context.receiver?.builtin ?? null, owner);
    assert.deepEqual(context.source.expression.tokens, tokens);
    assert.equal(context.inputs[0], result.message.origin);
  }
});

test('an ordinary native Error member call retains the actual source object receiver', () => {
  const expression = 'bound.create(`${input}`)', text = `const bound={create:TypeError};const value=${expression};`;
  const module = new SourceModule('src/bound-error.mjs', text), fixture = new MessageFixture(), environment = new Map();
  const start = text.indexOf(expression), tokens = module.tokens.filter(token => token.offset >= start && token.offset < start + expression.length);
  const result = fixture.origins.expression(module, tokens, environment), context = result.message.callContext;
  assert.equal(context.constructed, false);
  assert.equal(context.receiver.constructor.name, 'ObjectValue');
  assert.ok(context.receiver.allocationState);
  assert.equal(context.callee.builtin, 'TypeError');
  assert.deepEqual(context.source.expression.tokens, tokens);
});

const consumerFixtures = [
  [
    "path",
    "import fs from 'node:fs';class Failure extends TypeError{constructor(message,{source='ordinary'}={}){super(`${source}: ${message}`);this.source=source;}}const value=new Failure('/proc/self/stat');fs.readFileSync(value.message);",
    "OS01",
    197
  ],
  [
    "native",
    "import fs from 'node:fs';class Failure extends TypeError{constructor(message,{source='ordinary'}={}){super(`${source}: ${message}`);this.source=source;}}const value=new Failure(fs.readFileSync);opaque(value.message);",
    "OS02",
    195
  ],
  [
    "late native",
    "import fs from 'node:fs';class Failure extends TypeError{constructor(message,{source='ordinary'}={}){super(`${source}: ${message}`);this.source=source;}}const value=new Failure('ordinary');value.message=fs.readFileSync;opaque(value.message);",
    "OS02",
    220
  ],
  [
    "changed native",
    "import fs from 'node:fs';class Failure extends TypeError{constructor(message,{source='ordinary'}={}){super(`${source}: ${message}`);this.source=source;}}globalThis.TypeError=foreign;const value=new Failure('/proc/self/stat');fs.readFileSync(value.message);",
    "OS01",
    226
  ]
];
for (const [name, text, rule, column] of consumerFixtures) test(`message convergence retains the actual consumer: ${name}`, () => {
  const file = 'src/error-consumer.mjs';
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, text]]), { files: [file] }).check();
  assert.equal(report.ok, false);
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), []);
  assert.ok(report.diagnostics.some(entry => entry.file === file && entry.rule === rule && entry.line === 1
    && entry.column === column && entry.classification === 'incomplete'), JSON.stringify(report.diagnostics));
});
