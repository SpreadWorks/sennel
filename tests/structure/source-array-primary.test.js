import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceArrayPrimary, SourceModule } from '../support/structure/source-reader.js';

for (const source of ["[1].map(f);", "const a=[1].map(f);", "return [1].map(f);", "f([1].map(f));", "[[],[1]].map(f);", "class Reader{}[1].map(f);", "function read(){}[1].map(f);", "value ?? [1].map(f);", "value ? [1].map(f) : [];"]) {
  test('array primary extent: ' + source, () => {
    const module = new SourceModule('sample.mjs', source);
    const start = module.tokens.findIndex(token => token.value === '[');
    const primary = SourceArrayPrimary.read(module.tokens, start);
    assert.ok(primary instanceof SourceArrayPrimary);
    assert.equal(module.tokens[primary.endIndex].value, ']');
    assert.equal(module.tokens[primary.endIndex + 1].value, '.');
  });
}
for (const source of ['input[0].map(f);', 'f()[0].map(f);', '[0][0].map(f);', 'const [item]=input;', 'value?.[0].map(f);', 'const Reader=class Named{}[0].map(f);', 'const read=async function named(){}[0].map(f);']) {
  test('computed access and binding are not array primaries: ' + source, () => {
    const module = new SourceModule('sample.mjs', source);
    const start = source === '[0][0].map(f);' ? module.tokens.findIndex((token, index) => token.value === '[' && index > 0)
      : module.tokens.findIndex(token => token.value === '[');
    assert.equal(SourceArrayPrimary.read(module.tokens, start), null);
  });
}
