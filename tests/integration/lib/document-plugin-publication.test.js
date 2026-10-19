import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { DocumentUpdatePlan, DocumentUpdateTransaction, DocumentValidationResult } from "../../../src/docs/lib/document-update-plan.js";
import { PluginConfigTransaction } from "../../../src/lib/plugin-installer.js";

function files(t) {
  const root = createTmpDir("document-plugin-publication-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "first.json");
  const second = path.join(root, "second.json");
  for (const file of [first, second]) fs.writeFileSync(file, '{"value":"original"}\n');
  return { root, first, second };
}

function documentPlan(file) {
  return new DocumentUpdatePlan({ filePath: file, originalBytes: fs.readFileSync(file), proposedBytes: Buffer.from('{"value":"proposed"}\n'), validationResult: DocumentValidationResult.accepted() });
}

test("document transaction preserves a competing prepublication write and restores its own earlier publication", (t) => {
  const { root, first, second } = files(t);
  const original = fs.readFileSync(first);
  const competitor = '{"value":"competitor"}\n';
  const transaction = new DocumentUpdateTransaction([documentPlan(first), documentPlan(second)], {
    faultInjector(event) {
      if (event.filePath === second && event.phase === "before-file-rename") fs.writeFileSync(second, competitor);
    },
  });
  let failure;
  try { transaction.commit(); } catch (error) { failure = error; }
  assert.deepEqual(fs.readFileSync(first), original);
  assert.equal(fs.readFileSync(second, "utf8"), competitor);
  assert.deepEqual(fs.readdirSync(root).sort(), ["first.json", "second.json"]);
  assert.equal(failure?.code, "ATOMIC_FILE_WRITE_FAILED");
  assert.equal(failure.cause?.code, "DOCUMENT_REVISION_CONFLICT");
});

test("document rollback refuses to overwrite a competing change to an earlier publication", (t) => {
  const { first, second } = files(t);
  const originalSecond = fs.readFileSync(second);
  const transaction = new DocumentUpdateTransaction([documentPlan(first), documentPlan(second)], {
    faultInjector(event) {
      if (event.filePath === second && event.phase === "before-file-rename") {
        fs.writeFileSync(first, "competing actor\n");
        throw new Error("second publication stopped");
      }
    },
  });
  let failure;
  try { transaction.commit(); } catch (error) { failure = error; }
  assert.equal(fs.readFileSync(first, "utf8"), "competing actor\n");
  assert.deepEqual(fs.readFileSync(second), originalSecond);
  assert.ok(failure instanceof AggregateError);
  assert.ok(failure.errors.some((nested) => nested.cause?.code === "DOCUMENT_REVISION_CONFLICT"));
});

test("document postpublication failure retains uncertainty and restores bytes before a new plan is constructed", (t) => {
  const { first } = files(t);
  const original = fs.readFileSync(first);
  const transaction = new DocumentUpdateTransaction([documentPlan(first)], {
    faultInjector(event) { if (event.phase === "before-file-readback") throw new Error("readback stopped"); },
  });
  assert.throws(() => transaction.commit(), { code: "ATOMIC_FILE_PUBLICATION_UNCERTAIN", committedToVisibleName: true });
  assert.deepEqual(fs.readFileSync(first), original);
  new DocumentUpdateTransaction([documentPlan(first)]).commit();
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).value, "proposed");
});

test("plugin config rollback restores published updates and preserves a competing prepublication write", (t) => {
  const { root, first, second } = files(t);
  const original = fs.readFileSync(first);
  const competitor = '{"value":"competitor"}\n';
  const transaction = new PluginConfigTransaction([first, second].map((filePath) => ({ filePath, value: { value: "proposed" } })));
  let failure;
  try {
    transaction.commit((event) => {
      if (event.filePath === second && event.phase === "before-json-rename") fs.writeFileSync(second, competitor);
    });
  } catch (error) { failure = error; }
  assert.deepEqual(transaction.rollback(), []);
  assert.deepEqual(fs.readFileSync(first), original);
  assert.equal(fs.readFileSync(second, "utf8"), competitor);
  assert.deepEqual(fs.readdirSync(root).sort(), ["first.json", "second.json"]);
  assert.equal(failure?.code, "ATOMIC_JSON_WRITE_FAILED");
  assert.equal(failure.cause?.code, "PLUGIN_CONFIG_REVISION_CONFLICT");
});
