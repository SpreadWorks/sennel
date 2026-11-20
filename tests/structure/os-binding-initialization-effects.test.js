import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/binding-initialization.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'const []=[];',
 'const [,]=["ordinary"];',
 'const [[]]=[[]];',
 'const {items:[]}={items:[]};',
 'function consume([]){}consume([]);',
 'function consume([,]){}consume(["ordinary"]);',
 'function consume({items:[]}){}consume({items:[]});',
 'const [unused]=["ordinary"];',
])test(`native binding initialization completes even without consumed names: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 'const []=foreign();',
 'const [,]=foreign();',
 'const [[]]=[foreign()];',
 'const {items:[]}={items:foreign()};',
 'function consume([]){}consume(foreign());',
 'function consume([,]){}consume(foreign());',
 'function consume({items:[]}){}consume({items:foreign()});',
 'Array.prototype[Symbol.iterator]=foreign;const []=[];',
 'const values=[];values[Symbol.iterator]=foreign;const []=values;',
 'const values=[];opaque(values);const []=values;',
 'const []=new Proxy([],{});',
 'Object.prototype.return=foreign;const []=[];',
 'Object.getPrototypeOf([][Symbol.iterator]()).return=foreign;const []=[];',
 'Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())).return=foreign;const []=[];',
 'const [unused]=foreign();',
 'const []={ [Symbol.iterator]:foreign };',
 'const {items:[]}={get items(){return fs.readFileSync("/proc/self/stat");}};',
])test(`binding initialization retains iterator acquisition and close obligations: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
