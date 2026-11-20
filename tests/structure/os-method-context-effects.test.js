import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';

const file='src/method-context.mjs';
function inspect(source){
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,`import fs from 'node:fs';${source}`]]),{files:[file]}).check();
 assert.ok(!report.diagnostics.some(entry=>entry.rule==='OS00'),report.diagnostics.join('\n'));
 return report;
}
for(const source of [
 "class Reader{read(file){fs.readFileSync(file);}}const reader=new Reader();reader.read('ordinary.json');reader.read('/proc/self/stat');",
 "class Reader{set(file){this.file=file;}read(){fs.readFileSync(this.file);}}const reader=new Reader();reader.set('ordinary.json');reader.read();reader.set('/proc/self/stat');reader.read();",
 "class Reader{snapshot(value){return {value};}}const reader=new Reader();function deliver(value){return reader.snapshot(value);}opaque(deliver('ordinary.json'));opaque(deliver(fs.readFileSync));",
 "class Reader{snapshot(value){return [value];}}const reader=new Reader();reader.snapshot('ordinary.json').map(value=>fs.readFileSync(value));reader.snapshot('/proc/self/stat').map(value=>fs.readFileSync(value));",
 "function create(file){return class Reader{read(){fs.readFileSync(file);}};}const First=create('ordinary.json');const Second=create('/proc/self/stat');new First().read();new Second().read();",
 "class Reader{constructor(file){this.file=file;}read(){fs.readFileSync(this.file);}}function run(file){new Reader(file).read();}run('ordinary.json');run('/proc/self/stat');",
 "class Reader{read(value){return value.file;}}const reader=new Reader();const value={file:'ordinary.json'};fs.readFileSync(reader.read(value));value.file='/proc/self/stat';fs.readFileSync(reader.read(value));",
 "class Reader{read(value){return value.file;}}const reader=new Reader();const value={file:'ordinary.json'};fs.readFileSync(reader.read(value));opaque(value);fs.readFileSync(reader.read(value));",
 "class Reader{read(values){return values.map(value=>fs.readFileSync(value));}}const reader=new Reader();reader.read(['ordinary.json']);Array.prototype.map=foreign;reader.read(['ordinary.json']);",
])test(`method context reinterprets changed inputs and effects: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
for(const source of [
 "class Reader{read(file){fs.readFileSync(file);}}const reader=new Reader();reader.read('ordinary.json');reader.read('another.json');",
 "class Reader{set(file){this.file=file;}read(){fs.readFileSync(this.file);}}const reader=new Reader();reader.set('ordinary.json');reader.read();reader.set('another.json');reader.read();",
 "class Reader{read(value){return value.file;}}const reader=new Reader();const value={file:'ordinary.json'};fs.readFileSync(reader.read(value));value.file='another.json';fs.readFileSync(reader.read(value));",
])test(`method context preserves ordinary repeated source evaluation: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
