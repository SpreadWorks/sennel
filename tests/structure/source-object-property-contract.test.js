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
