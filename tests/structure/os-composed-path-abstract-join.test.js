import assert from 'node:assert/strict';
import {test} from 'node:test';
import {file,source,PathSensitivityFixture,sharedPathSource} from '../support/structure/composed-path-fixture.js';
function counts(p){const out=new Map();for(const row of p.calls){const key=JSON.stringify(row);out.set(key,(out.get(key)??0)+1);}return [...out];}

for(const name of ['formal','relative','rooted','drive','default','literal body'])test('repeated abstract path write converges: '+name,t=>{
 let text=source;
 if(name==='default')text=text.replace('make(repositoryRoot)',"make(repositoryRoot='relative-project')");
 if(name==='literal body')text=text.replace('path.resolve(repositoryRoot)',"path.resolve('relative-project')");
 const p=new PathSensitivityFixture(name,text),input=p.input(['default','literal body'].includes(name)?'formal':name),rows=[];
 for(let i=0;i<8;i++){const value=p.invoke(p.make,[input]);const write=value.state.writes.find(w=>w.name==='GIT_CEILING_DIRECTORIES');rows.push({alternatives:write.values.length,revision:value.state.revision});}
 t.diagnostic(JSON.stringify({name,rows,calls:counts(p)}));assert.deepEqual(rows.map(r=>r.alternatives),Array(8).fill(1));assert.ok(rows.every(r=>r.revision===rows[0].revision));
});
test('shared nested path DAG converges without losing its ordered shared edges',t=>{
 const text=sharedPathSource(7);
 const p=new PathSensitivityFixture('DAG',text),input=p.input('formal'),rows=[];
 for(let i=0;i<2;i++){const value=p.invoke(p.make,[input]),write=value.state.writes.find(w=>w.name==='GIT_CEILING_DIRECTORIES');rows.push({alternatives:write.values.length,revision:value.state.revision});let node=write.values.at(-1).interpretations[0].values[0];for(let depth=0;depth<7;depth++){assert.equal(node.interpretations[0].values[0],node.interpretations[0].values[1]);node=node.interpretations[0].values[0];}}
 t.diagnostic(JSON.stringify({name:'DAG',rows,calls:counts(p)}));assert.deepEqual(rows.map(r=>r.alternatives),[1,1]);
});
