import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/object-enumeration.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'Object.keys({read:fs.readFileSync}).map(name=>fs.readFileSync(name));',
 'Object.keys({get read(){return fs.readFileSync;}}).map(name=>fs.readFileSync(name));',
 'Object.values({file:"ordinary"}).map(file=>fs.readFileSync(file));',
 'Object.entries({file:"ordinary"}).map(entry=>fs.readFileSync(entry[1]));',
 'Object.values({set read(value){return fs.readFileSync;}}).map(value=>opaque(value));',
 'Object.values({get read(){return "ordinary";},set read(value){return fs.readFileSync;}}).map(value=>fs.readFileSync(value));',
 'const source={left:"ordinary",right:"another"};Object.entries(source).map(entry=>fs.readFileSync(entry[1]));',
 'Object.entries({first:"ordinary",second:"another"})[0].extra="metadata";',
 'Object.keys({"10":"ordinary","2":"ordinary"}).map(name=>fs.readFileSync(name));',
 'const read=Object.keys;read({read:fs.readFileSync}).map(name=>fs.readFileSync(name));',
 'Object.values({}).map(value=>fs.readFileSync(value));',
])test(`native own-property enumeration retains normal data and does not read keys' values: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 'Object.values({file:"/proc/self/stat"}).map(file=>fs.readFileSync(file));',
 'Object.entries({file:"/proc/self/stat"}).map(entry=>fs.readFileSync(entry[1]));',
 'Object.keys({"/proc/self/stat":"ordinary"}).map(file=>fs.readFileSync(file));',
 'Object.values({read:fs.readFileSync}).map(read=>read("/proc/self/stat"));',
 'opaque(Object.values({read:fs.readFileSync}));',
 'opaque(Object.entries({read:fs.readFileSync}));',
 'opaque(Object.values({get read(){return fs.readFileSync;}}));',
 'opaque(Object.entries({get read(){return fs.readFileSync;}}));',
 'Object.values({get read(){return fs.readFileSync("/proc/self/stat");}});',
 'const value={read:null};opaque(value);Object.values(value);',
 'Object.values(new Proxy({read:fs.readFileSync},{}));',
 'Object.values(unknown);',
 'Object.keys({[unknown]:fs.readFileSync});',
 'Object.values({read:null,read:fs.readFileSync});',
 'Object.values=foreign;Object.values({read:fs.readFileSync});',
 'Object.keys=foreign;Object.keys({read:fs.readFileSync});',
 'Object.entries=foreign;Object.entries({read:fs.readFileSync});',
 'Object.prototype.read=fs.readFileSync;Object.entries({});',
 'const value={file:"ordinary"};value.file="/proc/self/stat";Object.values(value).map(file=>fs.readFileSync(file));',
 'const value={get first(){delete value.next;return "ordinary";},next:"/proc/self/stat"};Object.values(value).map(file=>fs.readFileSync(file));',
])test(`enumeration retains getters, source provenance and unknown shape obligations: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
for(const source of [
 'fs.readFileSync(Object.entries({"10":"/proc/self/stat","2":"ordinary"})[0][1]);',
 'const pairs=Object.entries({first:"ordinary",second:"another"});pairs[0][1]="/proc/self/stat";fs.readFileSync(pairs[1][1]);',
 'const source={file:"ordinary"};Object.values({...source}).map(file=>fs.readFileSync(file));',
 'Object.values(["ordinary","another"]).map(file=>fs.readFileSync(file));',
])test(`enumeration keeps integer ordering, tuple identity and finite source copies: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
for(const source of [
 'fs.readFileSync(Object.entries({"10":"/proc/self/stat","2":"ordinary"})[1][1]);',
 'const pairs=Object.entries({first:"ordinary",second:"another"});pairs[0][1]="/proc/self/stat";fs.readFileSync(pairs[0][1]);',
 'const source={file:"/proc/self/stat"};Object.values({...source}).map(file=>fs.readFileSync(file));',
 'Object.values(["ordinary","/proc/self/stat"]).map(file=>fs.readFileSync(file));',
])test(`ordered and copied enumeration keeps each actual OS path source: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
for(const source of [
 'const lookup={"0":"ordinary",length:"/proc/self/stat"};Object.keys(["ordinary"]).map(key=>fs.readFileSync(lookup[key]));',
 'fs.readFileSync(Object.entries({"01":"/proc/self/stat","1":"ordinary"})[0][1]);',
 'Object.keys({read(){return fs.readFileSync;}}).map(key=>fs.readFileSync(key));',
])test(`enumeration distinguishes own enumerable string keys without executing methods: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
for(const source of [
 'Object.values([,"/proc/self/stat"]).map(file=>fs.readFileSync(file));',
 'fs.readFileSync(Object.entries({"01":"/proc/self/stat","1":"ordinary"})[1][1]);',
 'opaque(Object.values({read(){return fs.readFileSync;}}));',
])test(`holes, key ordering and returned methods cannot erase an OS-sensitive value: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
