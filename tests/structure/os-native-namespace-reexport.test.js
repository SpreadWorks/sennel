import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/mixed.mjs',bridge='src/bridge.mjs';
const moduleSource="export * as disk from 'node:fs';export * as paths from 'node:path';export * as system from 'node:os';";
const imports="import {disk,paths,system} from './bridge.mjs';";
for(const [name,body,expected] of [
 ['ordinary native path',"disk.readFileSync(paths.join('ordinary','file'));",true],
 ['portable null device',"disk.readFileSync(system.devNull);",true],
 ['actual pseudo-path consumer',"disk.readFileSync(paths.posix.join('/proc','self/stat'));",false],
 ['changed native constant consumer',"system.devNull=foreign;disk.readFileSync(system.devNull);",false],
])test('mixed builtin namespace reexports preserve '+name,()=>{
 const source=imports+body,checker=new OsIndependenceChecker(new MemorySourceRepository([[file,source],[bridge,moduleSource]]),{files:[file]});
 const module=checker.graph.module(file,{lexicalOnly:true});
 for(const [name,builtin] of [['disk','fs'],['paths','path'],['system','os']]){
  const value=checker.rules.origins.exported(bridge,name,[file]);
  assert.equal(value.builtin,builtin);assert.deepEqual(value.members,[]);
 }
 const report=checker.check();
 if(expected){assert.equal(report.ok,true,JSON.stringify(report.diagnostics));assert.equal(report.complete,true);assert.deepEqual(report.diagnostics,[]);}
 else{const column=source.indexOf('disk.readFileSync')+1;assert.ok(report.diagnostics.some(d=>d.file===file&&d.rule==='OS01'&&d.line===1&&d.column===column&&d.classification===(name==='actual pseudo-path consumer'?'violation':'incomplete')),JSON.stringify(report.diagnostics));}
});

test('anonymous builtin star still selects the requested actual member',()=>{
 const source="import {readFileSync as read} from './bridge.mjs';read('/proc/self/stat');",checker=new OsIndependenceChecker(new MemorySourceRepository([[file,source],[bridge,"export * from 'node:fs';"]]),{files:[file]});
 const module=checker.graph.module(file,{lexicalOnly:true}),token=module.tokens.findLast(t=>t.value==='read'),reader=checker.rules.origins.identifier(module,token);
 assert.equal(reader.builtin,'fs');assert.deepEqual(reader.members,['readFileSync']);
 const report=checker.check();assert.ok(report.diagnostics.some(d=>d.file===file&&d.rule==='OS01'&&d.line===1&&d.column===source.indexOf("read('/proc")+1&&d.classification==='violation'),JSON.stringify(report.diagnostics));
});

test('non-builtin namespace reexport still selects its actual value consumer',()=>{
 const source="import {entries} from './bridge.mjs';import fs from 'node:fs';fs.readFileSync(entries.file);";
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source],[bridge,"export * as entries from './values.mjs';"],['src/values.mjs',"export const file='/proc/self/stat';"]]),{files:[file]}).check();
 assert.ok(report.diagnostics.some(d=>d.file===file&&d.rule==='OS01'&&d.line===1&&d.column===source.indexOf('fs.readFileSync')+1&&d.classification==='violation'),JSON.stringify(report.diagnostics));
});
