import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file = 'src/constructor-input-context.mjs';
function setup(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, "import fs from 'node:fs';" + source]]), { files: [file] });
}
test('reinterpreting the same constructor allocation and input allocation keeps its local allocation domain', () => {
  const checker = setup('class Reader{constructor(input){this.inner={file:input.file};}read(){fs.readFileSync(this.inner.file);}}const input={file:"ordinary"};const reader=new Reader(input);reader.read();reader.read();');
  const manager = checker.rules.origins.constructionInvocations;
  const environment = manager.environment;
  const inputs = new Map();
  manager.environment = function(frame, callable, args, receiver, ...rest) {
    const result = environment.call(this, frame, callable, args, receiver, ...rest);
    if (args.length === 1 && args[0].state) {
      if (!inputs.has(receiver.state)) inputs.set(receiver.state, new Map());
      const states = inputs.get(receiver.state);
      if (!states.has(args[0].state)) states.set(args[0].state, []);
      states.get(args[0].state).push(result);
    }
    return result;
  };
  const report = checker.check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), [], report.diagnostics.join('\n'));
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  const repeated = [...inputs.values()].flatMap(states => [...states.values()]).filter(values => values.length > 1);
  assert.ok(repeated.length > 0, 'the original checker must reinterpret an allocation');
  for (const values of repeated) assert.equal(new Set(values).size, 1, 'fresh wrappers of the same input allocation must not create new constructor locals');
});
for (const source of [
  'class Reader{constructor(input){this.file=input.file;}read(){fs.readFileSync(this.file);}}function make(input){return new Reader(input);}make({file:"ordinary"}).read();make({file:"/proc/self/stat"}).read();',
  'class Reader{constructor(input){this.file=input.file;}read(){fs.readFileSync(this.file);}}const input={file:"ordinary"};function make(){return new Reader(input);}make().read();input.file="/proc/self/stat";make().read();',
  'function factory(file){return class Reader{constructor(input){this.file=file;}read(){fs.readFileSync(this.file);}};}const First=factory("ordinary");const Second=factory("/proc/self/stat");new First({}).read();new Second({}).read();',
  'class Reader{constructor(input){this.inner={file:input.file};}read(){fs.readFileSync(this.inner.file);}}const reader=new Reader({file:"ordinary"});reader.read();reader.inner.file="/proc/self/stat";reader.read();',
  'class Reader{constructor(input){this.inner={file:input.file};}read(){fs.readFileSync(this.inner.file);}}const input={file:"ordinary"};const reader=new Reader(input);reader.read();opaque(input);reader.read();',
  'class Reader{constructor(input){this.file=input.file;}read(){fs.readFileSync(this.file);}}const input={file:"ordinary"};const reader=new Reader(input);reader.read();fs.readFileSync=foreign;reader.read();',
]) test('constructor context reuse retains actual input and effect changes: ' + source, () => {
  const report = setup(source).check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), [], report.diagnostics.join('\n'));
  assert.equal(report.ok, false, 'expected an actual refusal');
});

test('a repeated source template with the same input interpretation keeps constructor locals', () => {
  const checker=setup('class Failure extends Error{constructor(message){super(message);}}const input=unknown;const value=new Failure(`failure ${input}`);opaque(value);opaque(value);');
  const manager=checker.rules.origins.constructionInvocations;
  const environment=manager.environment;
  const calls=new Map();
  manager.environment=function(frame,callable,args,receiver,...rest){
    const result=environment.call(this,frame,callable,args,receiver,...rest);
    if(args.length===1&&args[0].constructor.name==='TemplateValue'){
      if(!calls.has(receiver.state))calls.set(receiver.state,[]);
      calls.get(receiver.state).push(result);
    }
    return result;
  };
  const report=checker.check();
  assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));
  assert.equal(report.ok,true,report.diagnostics.join('\n'));
  const repeated=[...calls.values()].filter(values=>values.length>1);
  assert.ok(repeated.length>0,'the original checker must reinterpret the source template');
  for(const values of repeated)assert.equal(new Set(values).size,1,'a fresh template wrapper alone cannot create a new context');
});
