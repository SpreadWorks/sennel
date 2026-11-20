import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/renamed-constructor-effects.mjs';
function check(source){
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,`import fs from 'node:fs'; ${source}`]]),{files:[file]}).check();
 assert.ok(!report.diagnostics.some(entry=>entry.rule==='OS00'),report.diagnostics.join('\n'));
 return report;
}
for (const source of [
 "class Reader{constructor(file){fs.readFileSync(file);}} new Reader('/proc/self/stat');",
 "class Reader{constructor(file){this.data=fs.readFileSync(file);}} new Reader('/proc/self/stat');",
 "class Reader{constructor(file){this.file=file;fs.readFileSync(this.file);}} new Reader('/proc/self/stat');",
 "class Reader{file='ordinary.json';constructor(file){this.file=file;fs.readFileSync(this.file);}}new Reader('/proc/self/stat');",
 "class Reader{file='/proc/self/stat';data=fs.readFileSync(this.file);}new Reader();",
 "class Reader{#file;constructor(file){this.#file=file;fs.readFileSync(this.#file);}}new Reader('/proc/self/stat');",
 "class Parent{constructor(file){fs.readFileSync(file);}}class Reader extends Parent{}new Reader('/proc/self/stat');",
 "class Parent{constructor(file){fs.readFileSync(file);}}class Reader extends Parent{constructor(file){super(file);}}new Reader('/proc/self/stat');",
 "class Parent{constructor(file){this.file=file;}}class Reader extends Parent{data=fs.readFileSync(this.file);}new Reader('/proc/self/stat');",
 "class Reader{constructor(file){return {read(){return fs.readFileSync(file);}};}}new Reader('/proc/self/stat').read();",
 "class Reader{static make(file){return new Reader(file);}constructor(file){fs.readFileSync(file);}}Reader.make('/proc/self/stat');",
 "const Reader=class {constructor(file){fs.readFileSync(file);}};new Reader('/proc/self/stat');",
 "new class Reader{constructor(file){fs.readFileSync(file);}}('/proc/self/stat');",
 "new (class Reader{constructor(file){fs.readFileSync(file);}})('/proc/self/stat');",
 "function create(file){class Reader{constructor(){fs.readFileSync(file);}}return new Reader();}create('/proc/self/stat');",
 "class Reader{constructor(file){fs.readFileSync(file);}}new Reader('ordinary.json');new Reader('/proc/self/stat');",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}const selected=new Reader('ordinary.json');const alias=selected;alias.file='/proc/self/stat';selected.read();",
 "class Reader{file='ordinary.json';read(){return fs.readFileSync(this.file);}}const selected=new Reader();opaque(selected);selected.read();",
 "class Reader{read(){return 'ordinary';}}const selected=new Reader();selected.read=foreign;selected.read();",
 "class Reader{constructor(file){opaque(this);this.file=file;}read(){return fs.readFileSync(this.file);}}new Reader('ordinary.json').read();",
 "class Reader{constructor(file){this.file=file;}set file(value){fs.readFileSync(value);}}new Reader('/proc/self/stat');",
 "class Parent{set file(value){fs.readFileSync(value);}}class Reader extends Parent{constructor(file){super();this.file=file;}}new Reader('/proc/self/stat');",
 "class Parent{constructor(file){this.file=file;}}class Reader extends Parent{constructor(file){this.file='ordinary.json';super(file);}}new Reader('ordinary.json');",
 "class Parent{}class Reader extends Parent{constructor(){return 1;}}new Reader();",
 "class Reader{constructor(file){new Other(file);}}class Other{constructor(file){fs.readFileSync(file);}}new Reader('/proc/self/stat');",
 "class Reader{constructor(file){this[foreign]=file;}read(){return fs.readFileSync(this.file);}}new Reader('/proc/self/stat').read();",
 "class Parent{file='/proc/self/stat';}class Reader extends Parent{data=fs.readFileSync(this.file);file='ordinary.json';}new Reader();",
 "class Reader{file='/proc/self/stat';data=fs.readFileSync(this.file);constructor(){this.file='ordinary.json';}}new Reader();",
 "class Reader{constructor(file){this.file=file;}}const first=new Reader('ordinary.json');const second=new Reader('ordinary.json');second.file='/proc/self/stat';fs.readFileSync(second.file);",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}function create(file){return new Reader(file);}create('ordinary.json').read();create('/proc/self/stat').read();",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}['ordinary.json','/proc/self/stat'].map(file=>new Reader(file)).map(reader=>reader.read());",
 "class Reader{constructor(file){fs.readFileSync(file);}}function create(file){return new Reader(file);}create('ordinary.json');create('/proc/self/stat');",
 "class Reader{constructor(file){fs.readFileSync(file);}}['ordinary.json','/proc/self/stat'].map(file=>new Reader(file));",
 "class Reader{constructor(file){this.file=file;}get file(){return 'ordinary.json';}set file(value){fs.readFileSync(value);}}new Reader('/proc/self/stat');",
 "class Reader{constructor(file){this.file=file;}set file(value){this.inner=value;}get file(){return this.inner;}}fs.readFileSync(new Reader('/proc/self/stat').file);",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}function create(file){return new Reader(file);}const first=create('/proc/self/stat');const second=create('ordinary.json');first.read();",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}const selected=['/proc/self/stat','ordinary.json'].map(file=>new Reader(file));selected[0].read();",
 "class Parent{}class Reader extends Parent{constructor(){this;return {};}}new Reader();",
 "class Parent{}class Reader extends Parent{constructor(){const later=()=>this;later();return {};}}new Reader();",
]) test('construction executes inspected effects with actual inputs: '+source,()=>{
 const report=check(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
for (const source of [
 "class Reader{constructor(file){fs.readFileSync(file);}}new Reader('ordinary.json');",
 "class Reader{constructor(file){this.file=file;fs.readFileSync(this.file);}}new Reader('ordinary.json');",
 "class Reader{file='ordinary.json';data=fs.readFileSync(this.file);}new Reader();",
 "class Parent{constructor(file){this.file=file;}}class Reader extends Parent{constructor(file){super(file);fs.readFileSync(this.file);}}new Reader('ordinary.json');",
 "class Reader{static make(file){return new Reader(file);}constructor(file){fs.readFileSync(file);}}Reader.make('ordinary.json');",
 "class Reader{constructor(file){return {read(){return fs.readFileSync(file);}};}}new Reader('ordinary.json').read();",
 "class Reader{#file;constructor(file){this.#file=file;fs.readFileSync(this.#file);}}new Reader('ordinary.json');",
 "class Reader{constructor(){return 123;}}new Reader();",
 "class Parent{}class Reader extends Parent{constructor(file){return {file};}}fs.readFileSync(new Reader('ordinary.json').file);",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}const first=new Reader('ordinary.json');const second=new Reader('other.json');second.file='/proc/self/stat';first.read();",
 "class Reader{constructor(file){this.file=file;}set file(value){fs.readFileSync(value);}}new Reader('ordinary.json');",
 "class Parent{set file(value){fs.readFileSync(value);}}class Reader extends Parent{constructor(file){super();this.file=file;}}new Reader('ordinary.json');",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}function create(file){return new Reader(file);}create('first.json').read();create('second.json').read();",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}['first.json','second.json'].map(file=>new Reader(file)).map(reader=>reader.read());",
 "class Reader{constructor(file){this.file=file;}set file(value){this.inner=value;}get file(){return this.inner;}}fs.readFileSync(new Reader('ordinary.json').file);",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}function create(file){return new Reader(file);}const first=create('ordinary.json');const second=create('/proc/self/stat');first.read();",
 "class Parent{constructor(read){this.read=read;}}class Reader extends Parent{}const selected=new Reader(fs.readFileSync);fs.readFileSync('ordinary.json');",
 "class Parent{}class Reader extends Parent{constructor(){const later=()=>this;return {};}}new Reader();",
]) test('ordinary constructor paths retain normal behavior: '+source,()=>{
 const report=check(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
