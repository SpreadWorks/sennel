import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceModule, SourceBodyPrimary } from '../support/structure/source-reader.js';

for (const source of [
  'class Renamed { static copy(){return new Renamed();} same(value){return value instanceof Renamed;} }',
  'const value=class Renamed { static copy(){return new Renamed();} same(value){return value instanceof Renamed;} };',
  'function make(){class Renamed { static copy(){return new Renamed();} same(value){return value instanceof Renamed;} }return Renamed;}',
]) test('class self references share the existing inner lexical binding: ' + source, () => {
  const module=new SourceModule('self.mjs',source,{lexicalOnly:true});
  const index=module.tokens.findIndex(token=>token.value==='class');
  const primary=SourceBodyPrimary.read(module.tokens,index);
  const self=module.classSelfBinding(primary.declaration);
  assert.ok(self);
  for (const token of primary.declaration.tokens.filter(token=>token.value==='Renamed').slice(1)) assert.equal(module.bindingAt(token),self);
  if (source.startsWith('class')) assert.notEqual(self,module.moduleBinding('Renamed'));
});
for (const body of [
  'copy(Renamed){return new Renamed();}',
  'copy(){const Renamed=foreign;return new Renamed();}',
  'copy(){class Renamed {} return new Renamed();}',
]) test('shadowed class names do not impersonate the self binding: ' + body, () => {
  const module=new SourceModule('self.mjs',`class Renamed {${body}}`,{lexicalOnly:true});
  const primary=SourceBodyPrimary.read(module.tokens);
  const self=module.classSelfBinding(primary.declaration);
  const reference=module.tokens.findLast(token=>token.value==='Renamed');
  assert.notEqual(module.bindingAt(reference),self);
});
test('anonymous classes do not invent a self name',()=>{
  const module=new SourceModule('self.mjs','const value=class { copy(){return value;} };',{lexicalOnly:true});
  const primary=SourceBodyPrimary.read(module.tokens,module.tokens.findIndex(token=>token.value==='class'));
  assert.equal(module.classSelfBinding(primary.declaration),null);
});
