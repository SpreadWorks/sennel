import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/array-binding.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'const [file]=["ordinary"];fs.readFileSync(file);',
 'const [,file]=["/proc/self/stat","ordinary"];fs.readFileSync(file);',
 'const [[file]]=[["ordinary"]];fs.readFileSync(file);',
 'function read([file]){fs.readFileSync(file);}read(["ordinary"]);',
 'Object.entries({file:"ordinary"}).map(([name,file])=>fs.readFileSync(file));',
 'const [file="ordinary"]=[];fs.readFileSync(file);',
 'const [file]=["ordinary",fs.readFileSync];fs.readFileSync(file);',
])test(`array binding selects a proven native iterator element: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 'const [file]=["/proc/self/stat"];fs.readFileSync(file);',
 'const [,file]=["ordinary","/proc/self/stat"];fs.readFileSync(file);',
 'const [[file]]=[["/proc/self/stat"]];fs.readFileSync(file);',
 'function read([file]){fs.readFileSync(file);}read(["/proc/self/stat"]);',
 'Object.entries({file:"/proc/self/stat"}).map(([name,file])=>fs.readFileSync(file));',
 'const [file="/proc/self/stat"]=[];fs.readFileSync(file);',
 'const [read]=[fs.readFileSync];opaque(read);',
 'const [file]={0:"ordinary"};fs.readFileSync(file);',
 'const [read]={0:null,[Symbol.iterator]:foreign};opaque(read);',
 'Array.prototype[Symbol.iterator]=foreign;const [file]=["ordinary"];fs.readFileSync(file);',
 'const values=["ordinary"];opaque(values);const [file]=values;fs.readFileSync(file);',
 'const values=["ordinary"];values[Symbol.iterator]=foreign;const [file]=values;fs.readFileSync(file);',
 'const [file]=new Proxy(["ordinary"],{});fs.readFileSync(file);',
])test(`array binding retains actual element paths and rejects unproven iteration: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
