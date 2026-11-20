import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/renamed-callable-receivers.mjs';
function check(source){
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();
 assert.ok(!report.diagnostics.some(entry=>entry.rule==='OS00'),report.diagnostics.join('\n'));
 return report;
}
for(const source of [
 "const first={read(){return 'first';}};const second={read(){return 'second';}};const selected=choice?first:second;opaque(selected.read());",
 "const first={file:'first.json',read(){return fs.readFileSync(this.file);}};const second={file:'second.json',read(){return fs.readFileSync(this.file);}};const selected=choice?first:second;selected.read();",
 "const first={file:'first.json',get read(){return function(){return fs.readFileSync(this.file);};}};const second={file:'second.json',read(){return fs.readFileSync(this.file);}};const selected=choice?first:second;selected.read();",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}} const selected=choice?new Reader('first.json'):new Reader('second.json');selected.read();",
]) test('each finite source method receives its actual inspected owner: '+source,()=>{
 const report=check(`import fs from 'node:fs';${source}`);
 assert.equal(report.ok,true,report.diagnostics.join('\n'));
 assert.equal(report.complete,true);
});
for(const source of [
 "const first={file:'first.json',read(){return fs.readFileSync(this.file);}};const second={file:'/proc/self/stat',read(){return fs.readFileSync(this.file);}};const selected=choice?first:second;selected.read();",
 "const first={file:'/proc/self/stat',read(){return fs.readFileSync(this.file);}};const second={file:'second.json',read(){return fs.readFileSync(this.file);}};const selected=choice?first:second;selected.read();",
 "const first={file:'first.json',read(){return fs.readFileSync(this.file);}};const second={file:'/proc/self/stat',get read(){return function(){return fs.readFileSync(this.file);};}};const selected=choice?first:second;selected.read();",
 "const first={file:'first.json',read(){return fs.readFileSync(this.file);}};const second={file:'/proc/self/stat',get read(){return ()=>fs.readFileSync(this.file);}};const selected=choice?first:second;selected.read();",
 "class Reader{constructor(file){this.file=file;}read(){return fs.readFileSync(this.file);}}const selected=choice?new Reader('first.json'):new Reader('/proc/self/stat');selected.read();",
 "const first={read(){return fs.readFileSync;}};const second={read(){return ordinary;}};const selected=choice?first:second;opaque(selected.read());",
 "const first={read(){return '/proc/self/stat';}};const second={read(){return 'second.json';}};const selected=choice?first:second;fs.readFileSync(selected.read());",
 "const first={read(){return fs.readFileSync('/proc/self/stat');}};const selected=choice?first:opaque();selected.read();",
 "const first={read(){return fs.readFileSync('/proc/self/stat');}};const selected=choice?first:{};selected.read();",
 "const first={read(){return 'first';}};const second={read(){return 'second';}};opaque(first);const selected=choice?first:second;selected.read();",
 "const first={read(){return 'first';}};const second={read(){return 'second';}};first.read=foreign;const selected=choice?first:second;selected.read();",
]) test('finite method selection retains every path, escape, and unresolved member: '+source,()=>{
 const report=check(`import fs from 'node:fs';${source}`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
