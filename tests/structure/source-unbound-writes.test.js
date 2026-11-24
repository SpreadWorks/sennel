import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceModule, SourceUnboundWrite } from '../support/structure/source-reader.js';
for(const source of ['Object = value;', 'Object += value;', '++Object;', '(Object)++;', '({Object}=value);', '[Object]=value;', 'for(Object of values){}']){
 test('the existing binding write grammar exposes unbound writes: '+source,()=>{
  const module=new SourceModule('source.mjs',source); const writes=module.unboundWrites();
  assert.equal(writes.length,1);assert.ok(writes[0] instanceof SourceUnboundWrite);assert.equal(writes[0].name,'Object');assert.equal(writes[0].token,module.tokens.find(t=>t.value==='Object'));
  assert.deepEqual(module.bindingWrites(['Object']),[]);
 });
}
for(const source of ['const Object=1; Object++;','function update(Object){++Object;}','class Value { Object=1; static Reflect=2; }','object.Object=1;','Object.member++;']){
 test('local bindings and member names are not unbound binding writes: '+source,()=>{
  assert.deepEqual(new SourceModule('source.mjs',source).unboundWrites(),[]);
 });
}
