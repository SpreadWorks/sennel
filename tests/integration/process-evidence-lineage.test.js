import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ProcessEvidenceArtifactMigration, ProcessEvidenceMigrationRefusal } from "../../src/lib/process-evidence-artifact-migration.js";
import { CanonicalProcessEvidenceFixture } from "../support/infrastructure/canonical-process-evidence-fixture.js";

const seed = new CanonicalProcessEvidenceFixture(new URL("../fixtures/process-evidence-consumed-v1/", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const options = { skip: process.platform === "win32" ? "Immutable Linux producer has POSIX absolute checkout paths; Windows native acceptance is unverified" : false };
const isProgress = entry => entry.descriptor.logicalKey === "prompt.execution.progress";
const isEvent = entry => entry.descriptor.logicalKey === "prompt.execution.event";

function assertRejectedWithoutMutation(entries, expected) {
  const before = entries.map(entry => hash(entry.bytes));
  assert.throws(() => new ProcessEvidenceArtifactMigration(entries), expected);
  assert.deepEqual(entries.map(entry => hash(entry.bytes)), before);
  assert.ok(new ProcessEvidenceArtifactMigration(seed.processArtifacts()).replacements.length > 0,
    "restoring the genuine source resolves this boundary failure");
}

test("a consumed immutable event cannot replace its missing authoritative scope frontier", options, () => {
  const entries = seed.processArtifacts().filter(entry => !isProgress(entry));
  assertRejectedWithoutMutation(entries, error => error instanceof ProcessEvidenceMigrationRefusal
    && error.code === "UNSAFE_SOURCE_FORMAT" && error.message.includes("no canonical scope frontier"));
});

test("a consumed frontier cannot migrate when its earlier pending predecessor document is missing", options, () => {
  const entries = seed.processArtifacts().filter(entry => !(isEvent(entry) && entry.json.record.event === "reservation-reconciled"));
  assertRejectedWithoutMutation(entries, error => error instanceof TypeError
    && error.message.includes("missing predecessor document"));
});

test("a hash-bound frontier that skips its pending predecessor is rejected before any replacement is returned", options, () => {
  const source = seed.processArtifacts();
  const first = source.find(entry => isEvent(entry) && entry.json.sequence === 1).json;
  const entries = source.map(entry => {
    const value = entry.json;
    if ((isEvent(entry) || isProgress(entry)) && value.record.event === "reservation-consumed") {
      return entry.withJSON({ ...value, previousDigest: first.digest });
    }
    return entry;
  });
  assertRejectedWithoutMutation(entries, error => error instanceof TypeError
    && error.message.includes("complete original predecessor chain"));
});

test("a frontier and immutable event with the same record digest cannot disagree on their original sequence", options, () => {
  const entries = seed.processArtifacts().map(entry => isProgress(entry)
    ? entry.withJSON({ ...entry.json, sequence: entry.json.sequence + 1 }) : entry);
  assertRejectedWithoutMutation(entries, error => error instanceof TypeError
    && error.message.includes("conflicting original event identities"));
});
