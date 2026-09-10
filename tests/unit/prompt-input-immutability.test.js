import assert from "node:assert/strict";
import { it } from "node:test";

import {
  DocumentationRepeatedContextElement,
  ForgeInputReferencePromptElement,
} from "../../src/docs/lib/prompt-elements.js";

it("keeps documentation repeated context immutable at construction", () => {
  const element = new DocumentationRepeatedContextElement({
    id: "documentation-context", sourceRevision: "context-revision", sequence: 0,
    text: "canonical documentation context",
  });
  const prompt = element.toPromptText();

  assert.throws(() => { element.text = "mutated context"; }, TypeError);
  assert.throws(() => { element.id = "mutated-context"; }, TypeError);
  assert.throws(() => { element.sourceRevision = "mutated-revision"; }, TypeError);
  assert.equal(element.toPromptText(), prompt);
});

it("keeps forge input references immutable at construction", () => {
  const element = new ForgeInputReferencePromptElement({
    id: "forge-input:canonical", sourceRevision: "input-revision", sequence: 0,
    path: ".tmp/forge-inputs/canonical.json", digest: "input-digest", byteLength: 128,
    authorization: "read-only",
  });
  const prompt = element.toPromptText();

  assert.throws(() => { element.path = ".tmp/forge-inputs/mutated.json"; }, TypeError);
  assert.throws(() => { element.digest = "mutated-digest"; }, TypeError);
  assert.throws(() => { element.authorization = "write"; }, TypeError);
  assert.equal(element.toPromptText(), prompt);
});
