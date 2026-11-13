import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LayoutMigrationRevisionOne } from "../../src/lib/layout-migration.js";
import { DEFAULT_MAX_FILE_BYTES, visitRegularFileChunks } from "../../src/lib/regular-file-snapshot.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";

test("layout migration streams an aggregate larger than its journal limit while preserving every original byte and the per-file limit", t => {
  const root = createTmpDir("layout-streamed-capacity-");
  t.after(() => removeTmpDir(root));
  writeJson(root, ".senti/config.json", { name: "capacity fixture", lang: "en", type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" } });
  const output = path.join(root, ".senti", "output");
  fs.mkdirSync(output);
  const fileBytes = DEFAULT_MAX_FILE_BYTES / 4;
  const count = 5;
  const aggregateBytes = fileBytes * count;
  assert.ok(aggregateBytes > DEFAULT_MAX_FILE_BYTES);
  const chunk = Buffer.alloc(65536);
  const expected = crypto.createHash("sha256");
  for (let written = 0; written < fileBytes; written += chunk.length) expected.update(chunk);
  const digest = expected.digest("hex");
  for (let index = 0; index < count; index += 1) {
    const file = path.join(output, `${index}.bin`);
    fs.writeFileSync(file, Buffer.alloc(0));
    fs.truncateSync(file, fileBytes);
  }
  const beforeRss = process.memoryUsage().rss;
  let peakRss = beforeRss;
  let sampledReadBytes = 0;
  let journalBytes = 0;
  const readFile = fs.readFileSync;
  const read = fs.readSync;
  const rename = fs.renameSync;
  try {
    fs.readFileSync = function (file, ...args) {
      if (typeof file === "string" && /\.(?:bin|bytes)$/.test(file)) {
        assert.fail("migration must not materialize a complete payload with readFileSync");
      }
      return readFile.call(fs, file, ...args);
    };
    fs.readSync = function (...args) {
      const bytes = read.apply(fs, args);
      sampledReadBytes += bytes;
      if (sampledReadBytes >= 1024 * 1024) {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        sampledReadBytes = 0;
      }
      return bytes;
    };
    fs.renameSync = function (from, to, ...args) {
      const result = rename.call(fs, from, to, ...args);
      if (path.resolve(String(to)) === path.join(root, ".tmp", "sennel-migrate-layout.json")) {
        journalBytes = Math.max(journalBytes, fs.statSync(to).size);
      }
      return result;
    };
    const result = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run();
    assert.equal(result.complete, true);
    assert.equal(result.migrated, true);
    assert.ok(result.receipt);
  } finally { fs.readFileSync = readFile; fs.readSync = read; fs.renameSync = rename; }
  assert.ok(journalBytes > 0 && journalBytes < DEFAULT_MAX_FILE_BYTES);
  assert.ok(peakRss - beforeRss < DEFAULT_MAX_FILE_BYTES / 2,
    `streamed payloads must not add128MiB resident memory: before=${beforeRss},peak=${peakRss}`);
  for (let index = 0; index < count; index += 1) {
    const receipt = visitRegularFileChunks(path.join(root, ".sennel", "output", `${index}.bin`), {
      label: "capacity migrated output", maxBytes: DEFAULT_MAX_FILE_BYTES, visit() {},
    });
    assert.equal(receipt.byteLength, fileBytes);
    assert.equal(receipt.digest, digest);
  }
  assert.equal(fs.existsSync(path.join(root, ".senti")), false);
  assert.equal(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-layout.json")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, ".tmp", "runtime")), ["repository-control"]);
  t.diagnostic(JSON.stringify({ aggregateBytes, fileBytes, count, journalBytes, beforeRss, peakRss,
    nativeMacOSWindows: "unverified in this Linux run" }));
});
