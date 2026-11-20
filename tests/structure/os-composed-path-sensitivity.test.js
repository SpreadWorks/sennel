import assert from "node:assert/strict";
import {test} from "node:test";
import {file,source,PathSensitivityFixture} from "../support/structure/composed-path-fixture.js";
function fixture(name,representation){const p=new PathSensitivityFixture(name),input=p.input(name);p.produce(input);return {p,input,value:representation==='singleActualProducer'?p.write.values[0]:p.write.value};}
function effects(t,name,p){const counts=new Map();for(const row of p.calls){const key=JSON.stringify(row);counts.set(key,(counts.get(key)??0)+1);}t.diagnostic(JSON.stringify({name,calls:[...counts]}));}
function has(entries,rule,line,column,classification='incomplete'){return entries.some(d=>d.rule===rule&&d.file===file&&d.line===line&&d.column===column&&d.classification===classification);}
for(const representation of ['singleActualProducer','fullActualWriteJoin'])test('pseudo path sensitivity reaches the same uninspected consumer: '+representation,t=>{
 const {p,value}=fixture('pseudo',representation);const diagnostics=p.consume(value,'escape');effects(t,'escape '+representation,p);
 assert.equal(has(diagnostics,'OS02',14,31),true,JSON.stringify(diagnostics));
});
for(const representation of ['singleActualProducer','fullActualWriteJoin'])test('unknown transform retains both the escape and downstream FS refusal: '+representation,t=>{
 const {p,value}=fixture('pseudo',representation);const diagnostics=p.consume(value,'round');effects(t,'round '+representation,p);
 assert.equal(has(diagnostics,'OS02',17,46),true,JSON.stringify(diagnostics));assert.equal(has(diagnostics,'OS01',17,30),true,JSON.stringify(diagnostics));
});
for(const name of ['formal','relative','rooted','drive'])test('ordinary abstract path consumer retains its classification: '+name,t=>{
 for(const representation of ['singleActualProducer','fullActualWriteJoin']){const {p,value}=fixture(name,representation);const diagnostics=p.consume(value);effects(t,name+' '+representation,p);assert.deepEqual(diagnostics,[]);}
});
test('a late real alias write retains the live FS capability for both representations',t=>{
 for(const representation of ['singleActualProducer','fullActualWriteJoin']){const {p,value}=fixture('lateHeap',representation);p.invoke(p.named('late'));const diagnostics=p.consume(value,'escape');effects(t,'lateHeap '+representation,p);assert.equal(has(diagnostics,'OS02',14,31),true,JSON.stringify(diagnostics));}
});
test('native replacement leaves the saved path value and refuses the new producer',t=>{
 const {p,input,value}=fixture('pseudo','singleActualProducer');p.invoke(p.named('replace'));const fresh=p.invoke(p.make,[input]).state.writes.find(w=>w.name==='GIT_CEILING_DIRECTORIES').values.at(-1);
 assert.equal(value.constructor.name,'ComposedPathValue');assert.equal(fresh.constructor.name,'UnknownValue');
 const saved=p.consume(value),current=p.consume(fresh);effects(t,'nativeReplacement',p);assert.equal(has(saved,'OS01',13,28),true,JSON.stringify(saved));assert.equal(has(current,'OS01',13,28),true,JSON.stringify(current));
});
