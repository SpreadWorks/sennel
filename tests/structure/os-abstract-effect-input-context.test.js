import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/abstract-effect-inputs.mjs';
function setup(source,extra=[]){
  const checker=new OsIndependenceChecker(new MemorySourceRepository([[file,source],...extra]),{files:[file]});
  const module=checker.graph.module(file,{lexicalOnly:true});
  return {checker,module,origins:checker.rules.origins};
}
test('one callable summary retains its formal-input and local allocation identities across reinterpretation',()=>{
  const {module,origins}=setup('export function pair(first,second){return {first,second};}');
  const callable=origins.value(module,module.declaration('pair').tokens,new Map());
  const observations=[];
  for(let index=0;index<4;index++){
    callable.effects.resolve();
    const output=callable.effects.exposureInputs.at(-1);
    const first=origins.readMember(output,'first',output.tokens[0],module,output.environment);
    const second=origins.readMember(output,'second',output.tokens[0],module,output.environment);
    assert.notEqual(first,second,'different formal positions retain separate abstract inputs');
    observations.push({state:output.state,first,second});
  }
  assert.equal(new Set(observations.map(value=>value.first)).size,1);
  assert.equal(new Set(observations.map(value=>value.second)).size,1);
  assert.equal(new Set(observations.map(value=>value.state)).size,1,
    'reinterpreting one summary must not create another local allocation domain');
});
test('one class summary retains its abstract receiver without granting an actual construction',()=>{
  const {module,origins}=setup('export class Reader{constructor(file){this.file=file;}read(){return this.file;}}');
  const value=origins.value(module,module.declaration('Reader').tokens,new Map());
  const receivers=[],summaries=[];
  for(let index=0;index<4;index++){
    value.effects.resolve();
    const callable=value.effects.exposureInputs.at(-1).values.find(member=>member.declaration?.token.value==='read');
    assert.ok(callable,'source method effects remain present');
    const receiver=callable.effects.receiver;
    assert.equal(receiver.state,null,'an abstract class receiver is not an actual constructed allocation');
    receivers.push(receiver);summaries.push(callable.effects);
  }
  assert.equal(new Set(receivers).size,1);
  assert.equal(new Set(summaries).size,1);
});
for(const source of [
  'function make(file){return {file};}fs.readFileSync(make("ordinary").file);fs.readFileSync(make("/proc/self/stat").file);',
  'function make(file){return {file};}["ordinary","/proc/self/stat"].map(make).forEach(value=>fs.readFileSync(value.file));',
  'let file="ordinary";function make(){return {file};}make();file="/proc/self/stat";fs.readFileSync(make().file);',
  'function make(file){return {file};}const value=make("ordinary");opaque(value);fs.readFileSync(value.file);',
  'function read(file){return fs.readFileSync(file);}read("ordinary");fs.readFileSync=foreign;read("ordinary");',
  'class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}function make(file){return new Reader(file);}make("ordinary").read();make("/proc/self/stat").read();',
  'class Reader{read(){return fs.readFileSync;}}opaque(Reader);',
])test('abstract-summary identity cannot merge actual inputs or discard effects: '+source,()=>{
  const report=setup("import fs from 'node:fs';"+source).checker.check();
  assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));
  assert.equal(report.ok,false,'actual unsupported or OS-specific effects must remain rejected');
});
test('ordinary actual inputs remain ordinary with shared abstract-summary identities',()=>{
  const report=setup('import fs from "node:fs";function make(file){return {file};}fs.readFileSync(make("first").file);fs.readFileSync(make("second").file);').checker.check();
  assert.equal(report.ok,true,report.diagnostics.join('\n'));
});

for(const [name,source,mutation] of [
  ['captured heap','export const holder={value:"ordinary"};export class Reader{static read(){return holder.value;}}','import fs from "node:fs";import {holder} from "./abstract-effect-inputs.mjs";holder.value=fs.readFileSync;'],
  ['static parent','export class Parent{static value(){return "ordinary";}}export class Reader extends Parent{static read(){return super.value();}}','import fs from "node:fs";import {Parent} from "./abstract-effect-inputs.mjs";Parent.value=()=>fs.readFileSync;'],
  ['instance parent','export class Parent{value(){return "ordinary";}}export class Reader extends Parent{read(){return super.value();}}','import fs from "node:fs";import {Parent} from "./abstract-effect-inputs.mjs";Parent.prototype.value=()=>fs.readFileSync;'],
  ['home prototype replacement','export class Parent{static value(){return "ordinary";}}export class Reader extends Parent{static read(){return super.value();}}','import {Reader} from "./abstract-effect-inputs.mjs";Object.setPrototypeOf(Reader,foreign);'],
])test('a retained child summary observes later '+name+' mutation before the outer summary is revisited',()=>{
  const change='src/change.mjs';
  const {checker,module,origins}=setup(source,[[change,mutation]]);
  const receiver=origins.value(module,module.declaration('Reader').tokens);
  const readSummary=()=>receiver.effects.exposureInputs.at(-1).values.find(value=>value.declaration?.token.value==='read').effects;
  const before=readSummary();
  assert.equal(before.sensitive,false);
  assert.equal(before.current,true);
  origins.scan(checker.graph.module(change,{lexicalOnly:true}));
  assert.equal(before.sensitive,true,'the previously obtained child must observe heap/home changes without relying on an outer re-query');
  receiver.effects.resolve();
  const after=readSummary();
  assert.equal(after,before,'the same child summary retains its invalidation obligations');
  assert.equal(after.sensitive,true);
});
