import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceModule } from '../support/structure/source-reader.js';
test('binding declaration ownership distinguishes nested shadows and references', () => {
  const module = new SourceModule('ownership.mjs', 'const file=outer; function make(file){const retained=file;return ()=>retained;} consume(file);', {lexicalOnly:true});
  const uses = module.tokens.filter(token => token.value === 'file');
  const outer = module.bindingAt(uses[0]);
  const inner = module.bindingAt(uses[1]);
  assert.notEqual(outer, inner);
  assert.deepEqual(module.bindingDeclarations(outer), [uses[0]]);
  assert.deepEqual(module.bindingDeclarations(inner), [uses[1]]);
  assert.deepEqual(module.bindingReferences(inner), [uses[2]]);
  const retained = module.tokens.filter(token => token.value === 'retained');
  assert.deepEqual(module.bindingDeclarations(module.bindingAt(retained[1])), [retained[0]]);
  const returned = module.bindingDeclarations(inner); returned.length=0;
  assert.deepEqual(module.bindingDeclarations(inner), [uses[1]]);
});
