import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceModule, SourceObjectCopies, SourceObjectSpread } from '../support/structure/source-reader.js';

for (const source of [
  'const input={}; const copy={...input};',
  'const input={}; ({...input});',
  'const input={}; const wrapper={nested:{...input}};',
  'const input={}; consume({...input});',
  'const input={}; const result=[{...input}];',
]) {
  test('object-copy sites preserve the exact spread expression: ' + source, () => {
    const module = new SourceModule('copies.mjs', source, { lexicalOnly: true });
    const copies = new SourceObjectCopies(module);
    assert.equal(copies.entries.length, 1);
    const copy = copies.entries[0];
    assert.ok(copy instanceof SourceObjectSpread);
    assert.equal(copy.tokens[0].value, 'input');
    assert.equal(copies.at(copy.token), copy);
    assert.ok(module.tokens.includes(copy.token));
  });
}
for (const source of [
  'const {...rest}=input;',
  'const {nested:{...rest}}=input;',
  'function use({...rest}){return rest;}',
  'let rest; ({...rest}=input);',
  'let rest; ({nested:{...rest}}=input);',
  'const input=[]; const copy=[...input];',
]) {
  test('rest and array syntax do not become object-copy reads: ' + source, () => {
    const module = new SourceModule('copies.mjs', source, { lexicalOnly: true });
    assert.deepEqual(new SourceObjectCopies(module).entries, []);
  });
}
