import assert from "node:assert/strict";
import { test } from "node:test";
import * as reader from "../support/structure/source-reader.js";

for (const [literal, pattern, flags] of [
  ["/plain/", "plain", ""],
  [String.raw`/a\/b/g`, String.raw`a\/b`, "g"],
  ["/[a/b]/gi", "[a/b]", "gi"],
  [String.raw`/\p{Letter}+/u`, String.raw`\p{Letter}+`, "u"],
  ["/((a+)+)$/dy", "((a+)+)$", "dy"],
]) test(`regex lexer preserves raw metadata and source location: ${literal}`, () => {
  const source = `\nconst expression = ${literal};`;
  const tokens = reader.readTokens(source);
  const token = tokens.find(value => value.value === "<regex>");
  assert.ok(token instanceof reader.SourceToken);
  assert.equal(token.kind, "literal");
  assert.equal(token.pattern, pattern);
  assert.equal(token.flags, flags);
  assert.equal(token.offset, source.indexOf(literal));
  assert.equal(token.line, 2);
  assert.equal(token.column, 20);
  assert.equal(tokens.at(-1).value, ";");
});

for (const expected of ["/different/g", "/expected/i", "/expected/", "/expected/gi"]) {
  test(`source grammar matching distinguishes regex patterns and flags: ${expected}`, () => {
    const declaration = new reader.SourceDeclaration("choose", reader.readTokens("choose(value) { return /expected/g.test(value); }"));
    assert.equal(declaration.matchesBody(`return ${expected}.test(value);`), false);
    assert.equal(declaration.matchesBody("return /expected/g.test(value);"), true);
  });
}

test("regex metadata stays separate from division, inert text and template contents", () => {
  const module = new reader.SourceModule("regex.js", "const ratio = count / total; const text = '/inert/g'; const label = `fixed ${/actual/m.test(value)}`;");
  const regex = module.tokens.filter(token => token.pattern !== undefined);
  assert.equal(regex.length, 1);
  assert.equal(regex[0].pattern, "actual");
  assert.equal(regex[0].flags, "m");
});
