import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceDeclaration, SourceInitializer, readObjectProperty, readTokens } from "../support/structure/source-reader.js";

for (const name of ["ServiceClass", "RenamedDependency"]) {
  test(`static object property ${name} does not treat a ternary value as an explicit key`, () => {
    assert.equal(readObjectProperty(readTokens(`{ other: condition ? ${name} : Impostor }`), name), null);
  });
  test(`static object property ${name} finds its real key after a ternary value`, () => {
    const property = readObjectProperty(readTokens(`{ other: condition ? ${name} : Impostor, ${name}: Selected }`), name);
    assert.ok(property instanceof SourceInitializer);
    assert.equal(property.matches("Selected"), true);
  });
  test(`static object property ${name} retains quoted explicit keys`, () => {
    const property = readObjectProperty(readTokens(`{ '${name}': Selected }`), name);
    assert.ok(property instanceof SourceInitializer);
    assert.equal(property.matches("Selected"), true);
  });
  for (const prefix of ["", "async "]) test(`static object property ${name} retains ${prefix || "ordinary "}methods`, () => {
    const method = readObjectProperty(readTokens(`{ ${prefix}${name}() { return value; } }`), name);
    assert.ok(method instanceof SourceDeclaration);
    assert.equal(method.matchesBody("return value;"), true);
    assert.equal(method.prefix.some((token) => token.value === "async"), prefix === "async ");
  });
  test(`static object property ${name} resolves the original shorthand binding`, () => {
    const property = readObjectProperty(readTokens(`{ before: true, ${name}, after: false }`), name);
    assert.ok(property instanceof SourceInitializer);
    assert.equal(property.matches(name), true);
  });
  for (const content of [`${name}, ${name}`, `${name}: Selected, ${name}`, `${name}, ${name}: Selected`]) {
    test(`static object property ${name} refuses duplicate slots ${content}`, () => {
      assert.equal(readObjectProperty(readTokens(`{ ${content} }`), name), null);
    });
  }
  for (const content of [`nested: { ${name} }`, `...${name}`, `[${name}]: Selected`, `${name} = Selected`]) {
    test(`static object property ${name} does not reinterpret ${content} as shorthand`, () => {
      assert.equal(readObjectProperty(readTokens(`{ ${content} }`), name), null);
    });
  }
}

for (const text of ["{", "}", "[", "]", "(", ")", ","]) {
  test(`object property delimiters in literal data retain exact initializer and following key: ${text}`, () => {
    const literal = JSON.stringify(text);
    const tokens = readTokens(`{ marker: ${literal}, selected: Target }`);
    const marker = readObjectProperty(tokens, "marker");
    const selected = readObjectProperty(tokens, "selected");
    assert.ok(marker instanceof SourceInitializer);
    assert.deepEqual(marker.tokens, tokens.slice(3, 4));
    assert.equal(marker.tokens[0].kind, "string");
    assert.ok(selected instanceof SourceInitializer);
    assert.equal(selected.matches("Target"), true);
    assert.equal(readObjectProperty(readTokens(`{ ${literal}: Target }`), text).matches("Target"), true);
  });
}

test("object property template interpolations use the existing comma-separated expression boundary", () => {
  const tokens = readTokens('{ text: `before ${first, second} after`, selected: Target }');
  const property = readObjectProperty(tokens, "text");
  assert.ok(property instanceof SourceInitializer);
  assert.equal(property.matches('`before ${first, second} after`'), true);
  assert.equal(readObjectProperty(tokens, "selected").matches("Target"), true);
});

test("object property data does not reinterpret a matching identifier inside an initializer as a method", () => {
  assert.equal(readObjectProperty(readTokens('{ other: selected() }'), "selected"), null);
  assert.equal(readObjectProperty(readTokens('{ other: { selected() {} } }'), "selected"), null);
  assert.equal(readObjectProperty(readTokens('{ [selected]: Target }'), "selected"), null);
});

for (const member of ['get slot() { return other; }', 'set slot(value) {}', '*slot() { yield other; }', 'async *slot() { yield other; }', 'get "slot"() { return other; }']) {
  for (const properties of [`slot: safe, ${member}`, `${member}, slot: safe`]) {
    test(`direct property queries preserve accessor and generator duplicate refusal: ${properties}`, () => {
      assert.equal(readObjectProperty(readTokens(`{ ${properties} }`), "slot"), null);
    });
  }
}
for (const source of ['{ 0: Selected }', '{ "0": Selected }']) {
  test(`direct property queries preserve numeric source property names: ${source}`, () => {
    const property = readObjectProperty(readTokens(source), "0");
    assert.ok(property instanceof SourceInitializer);
    assert.equal(property.matches("Selected"), true);
  });
}
