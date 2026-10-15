import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, readTypeInvariants } from "../support/structure/source-reader.js";

function invariants(parameters, body = 'if (!(writer instanceof Writer)) throw new TypeError("typed writer");') {
  const module = new SourceModule("preparation.js", `function prepare(${parameters}) { ${body} return writer; }`);
  return readTypeInvariants(module.declaration("prepare")).map(({ parameter, typeName }) => [parameter, typeName]);
}

test("named acquired argument bindings retain the same unconditional instanceof proof", () => {
  assert.deepEqual(invariants("{ selection, writer }, Connector, stepId"), [["writer", "Writer"]]);
  assert.deepEqual(invariants("writer, Connector, stepId"), [["writer", "Writer"]]);
});

for (const parameters of ["{ writer = anything }", "{ source: writer }", "{ ...writer }", "{ nested: { writer } }"]) {
  test(`unresolved acquired binding ${parameters} provides no type proof`, () => {
    assert.deepEqual(invariants(parameters), []);
  });
}

test("acquired writer validation remains mandatory before any early return or reassignment", () => {
  assert.deepEqual(invariants("{ writer }", 'if (true) return; if (!(writer instanceof Writer)) throw new TypeError("typed");'), []);
  assert.deepEqual(invariants("{ writer }", 'writer = anything; if (!(writer instanceof Writer)) throw new TypeError("typed");'), []);
  assert.deepEqual(invariants("{ writer }", 'if (!(writer instanceof Writer) && false) throw new TypeError("typed");'), []);
});
