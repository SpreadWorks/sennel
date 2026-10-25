import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { container } from "../../../../src/lib/container.js";
import { loadDataSources } from "../../../../src/docs/lib/data-source-loader.js";
import { createTmpDir, removeTmpDir } from "../../../support/builders/tmp-dir.js";

test("preset factory loading shares base dependencies and inheritance without initializing ambient project services", async (t) => {
  const root = createTmpDir("data-source-base-api-");
  container.reset();
  t.after(() => { container.reset(); removeTmpDir(root); });
  const parent = path.join(root, "parent");
  const child = path.join(root, "child");
  fs.mkdirSync(parent); fs.mkdirSync(child);
  fs.writeFileSync(path.join(parent, "sample.js"), `export default function register(container) {
    const DataSource = container.get("base.DataSource");
    const Paragraph = container.get("base.Paragraph");
    return class Sample extends DataSource { value() { return new Paragraph("parent value"); } };
  }`);
  fs.writeFileSync(path.join(child, "sample.js"), `export default function register(container) {
    const Parent = container.getPreset("parent").dataSources.sample;
    const Paragraph = container.get("base.Paragraph");
    return class Sample extends Parent { value() { return new Paragraph(super.value().toMarkdown() + " and child"); } };
  }`);
  const parents = await loadDataSources(parent, { presetKey: "parent" });
  const children = await loadDataSources(child, { presetKey: "child", existing: parents });
  assert.equal(parents.get("sample").value().toMarkdown(), "parent value");
  assert.equal(children.get("sample").value().toMarkdown(), "parent value and child");
  assert.ok(children.get("sample") instanceof container.getPreset("parent").dataSources.sample);
  for (const service of ["config", "root", "paths", "logger", "agent", "flowManager"]) {
    assert.equal(container.has(service), false, `${service} must be initialized only at the CLI boundary`);
  }
});
