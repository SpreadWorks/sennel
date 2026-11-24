import assert from "node:assert/strict";
import { test } from "node:test";
import { LayoutTemplateEncodingError, LayoutTemplateTransformation } from "../../src/lib/layout-template-transformation.js";

const examples = [
  ["sdd-forge sddForge SddForge senti Senti senrail Senrail SDD_FORGE SENTI SENRAIL",
    "sennel sennel Sennel sennel Sennel sennel Sennel SENNEL SENNEL SENNEL"],
  ["sentiDir xsentiDir SentiDir sentiThing sddForgeThing sdd-forgeThing",
    "managedDir xmanagedDir SennelDir sennelThing sennelThing sdd-forgeThing"],
  ["SENTI_KEEP senti_keep mysenti aSenti sentient sdd-forge_suffix",
    "SENTI_KEEP senti_keep mysenti aSenti sentient sdd-forge_suffix"],
  [".senti/output ../.sdd-forge/templates .senrail/config SENTI-SENTI",
    ".sennel/output ../.sennel/templates .sennel/config SENNEL-SENNEL"],
  ["\uFEFF日本語🙂senti: Senti🙌\r\nSDD_FORGE\n", "\uFEFF日本語🙂sennel: Sennel🙌\r\nSENNEL\n"],
  ["", ""],
];

for (const [source, expected] of examples) {
  test(`layout transformation preserves the complete legacy token contract: ${JSON.stringify(source)}`, () => {
    const transform = new LayoutTemplateTransformation();
    assert.deepEqual(transform.transform(Buffer.from(source)), Buffer.from(expected));
    assert.equal(transform.transformText(source), expected);
  });

  test(`every byte split preserves tokens, UTF-8 and BOM: ${JSON.stringify(source)}`, () => {
    const bytes = Buffer.from(source);
    for (let split = 0; split <= bytes.length; split += 1) {
      const chunks = [];
      const stream = new LayoutTemplateTransformation().createStream(chunk => chunks.push(chunk));
      stream.write(bytes.subarray(0, split));
      stream.write(bytes.subarray(split));
      stream.finish();
      assert.deepEqual(Buffer.concat(chunks), Buffer.from(expected), `split=${split}`);
    }
  });
}

test("one-byte reads preserve multibyte characters, surrogate pairs and ordered replacements", () => {
  const source = "\uFEFF🙂sentiDir 日本語sentiThing🧪 SddForge SENRAIL_KEPT SENTI".repeat(7);
  const expected = "\uFEFF🙂managedDir 日本語sennelThing🧪 Sennel SENRAIL_KEPT SENNEL".repeat(7);
  const output = [];
  const stream = new LayoutTemplateTransformation().createStream(chunk => output.push(chunk));
  for (const byte of Buffer.from(source)) stream.write(Buffer.from([byte]));
  stream.finish();
  assert.deepEqual(Buffer.concat(output), Buffer.from(expected));
});

test("invalid UTF-8 retains the complete original raw bytes in whole-byte migration", () => {
  for (const bytes of [Buffer.from([0x73, 0x65, 0x6e, 0x74, 0x69, 0xff]),
    Buffer.from([0xef, 0xbb, 0xbf, 0xe3, 0x81]), Buffer.from([0xc0, 0xaf])]) {
    assert.deepEqual(new LayoutTemplateTransformation().transform(bytes), bytes);
  }
});

test("a truncated UTF-8 sequence refuses stream completion", () => {
  const stream = new LayoutTemplateTransformation().createStream(() => {});
  stream.write(Buffer.from([0xe3]));
  stream.write(Buffer.from([0x81]));
  assert.throws(() => stream.finish(), LayoutTemplateEncodingError);
});

test("a byte-consumer failure is not reclassified as an encoding failure", () => {
  const failure = new Error("owned stage write failed");
  const stream = new LayoutTemplateTransformation().createStream(() => { throw failure; });
  assert.throws(() => stream.write(Buffer.from("senti ".repeat(128))), error => error === failure);
});
