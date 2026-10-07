import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { FlowArtifactDescriptor, FlowVersionAuthorityScope, FlowVersionLocation } from "../../../src/lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { captureRegularFile } from "../../../src/lib/regular-file-snapshot.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("flow-artifact-bounded-read-");
  t.after(() => removeTmpDir(root));
  const location = new FlowVersionLocation({ repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(), specId: "bounded-read", version: 1 });
  fs.mkdirSync(location.directory, { recursive: true });
  const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("issue.snapshot");
  const bytes = Buffer.from("\uFEFFComplete 漢🧭 evidence.\r\n", "utf8");
  const filePath = location.resolve(artifact.relativePath);
  fs.writeFileSync(filePath, bytes);
  const descriptor = FlowArtifactDescriptor.fromFile({ location,
    ...artifact.publication({ mediaType: "text/markdown" }) });
  return { root, location, bytes, filePath, descriptor };
}

it("refuses the descriptor byte budget before accessing a missing canonical artifact", (t) => {
  const { location, bytes, filePath, descriptor } = fixture(t);
  fs.unlinkSync(filePath);
  assert.throws(() => descriptor.readBytes(location, { maxBytes: bytes.length - 1 }),
    /canonical artifact bytes exceed the read limit/);
});

it("preserves exact UTF-8 and BOM bytes while accounting hash refusal and leaving pre-read refusal uncharged", (t) => {
  const { location, bytes, filePath, descriptor } = fixture(t);
  const consumption = [];
  const options = { maxBytes: bytes.length, onRead: (byteLength) => consumption.push(byteLength) };
  assert.deepEqual(descriptor.readBytes(location, options), bytes);
  assert.deepEqual(consumption, [bytes.length]);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  fs.writeFileSync(filePath, changed);
  assert.throws(() => descriptor.readBytes(location, options), /artifact content does not match the catalog/);
  assert.deepEqual(consumption, [bytes.length, bytes.length], "hash refusal happens after a complete physical read");
  assert.throws(() => descriptor.readBytes(location, { ...options, maxBytes: bytes.length - 1 }),
    /canonical artifact bytes exceed the read limit/);
  assert.deepEqual(consumption, [bytes.length, bytes.length], "descriptor size refusal consumes no read bytes");
});

it("refuses a new hardlink after descriptor capture and resumes exact reads after its removal", (t) => {
  const { root, location, bytes, filePath, descriptor } = fixture(t);
  const alias = path.join(root, "alias.md");
  fs.linkSync(filePath, alias);
  assert.deepEqual(captureRegularFile(filePath, { label: "ordinary source", maxBytes: bytes.length }).bytes, bytes);
  assert.throws(() => descriptor.readBytes(location), /must not be hard linked/);
  fs.unlinkSync(alias);
  assert.deepEqual(descriptor.readBytes(location), bytes);
});
