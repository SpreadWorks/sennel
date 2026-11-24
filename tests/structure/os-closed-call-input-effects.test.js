import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/closed-call-input.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
const body='function read(values){for(const file of values){fs.readFileSync(file);}}';
for(const source of [
 body+'read(["ordinary"]);',
 'read(["ordinary"]);'+body,
 body+'{const read=foreign;read(input);}read(["ordinary"]);',
 'function read(values){for(const file of values){fs.readFileSync(file);}}read(Object.values({file:"ordinary"}));',
])test(`closed module call inputs retain the actual ordinary array: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 body+'read(["/proc/self/stat"]);',
 body+'read(["ordinary"]);read(["/proc/self/stat"]);',
 body+'read(foreign());',
 'export '+body+'read(["ordinary"]);',
 'export default '+body+'read(["ordinary"]);',
 body+'module.exports={read};read(["ordinary"]);',
 body+'const holder={read};read(["ordinary"]);',
 body+'function expose(){return read;}opaque(expose());read(["ordinary"]);',
 body+'read.bind(null)(["ordinary"]);',
 body+'(read)(["ordinary"]);',
 body+'export {read};read(["ordinary"]);',
 body+'opaque(read);read(["ordinary"]);',
 body+'const alias=read;alias(["ordinary"]);',
 body+'read=foreign;read(["ordinary"]);',
 body+'read?.(["ordinary"]);',
 body+'new read(["ordinary"]);',
 body+'read(...foreign());',
 'function read(values){for(const file of values){fs.readFileSync(file);}}function call(input){read(input);}call(["ordinary"]);opaque(call);',
 'function read(values){for(const file of values){fs.readFileSync(file);}read(values);}read(["ordinary"]);',
 body+'read([fs.readFileSync("/proc/self/stat")]);',
 body+'read(["ordinary"],fs.readFileSync("/proc/self/stat"));',
 body+'const values=["ordinary"];read(values,opaque(values));',

])test(`open or changed helper inputs retain incompleteness and actual effects: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
