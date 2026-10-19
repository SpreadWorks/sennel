import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { NativeAbsolutePath } from "../../../src/lib/native-path.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { MigrationSpecRoot, resolveMigrationSpecRoot } from "../../../src/lib/migration-spec-root.js";
import { FlowArtifactCanonicalPath } from "../../../src/lib/flow-artifact-contract.js";
import { Logger } from "../../../src/lib/log.js";
import { todayLocal, readJsonl } from "../../support/infrastructure/log-fixtures.js";

function fixture(t) {
  const root = createTmpDir("portable-path-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("native/logical round trips validate authority without creating missing targets", (t) => {
  const root = fixture(t);
  const authority = new RealDirectoryAuthority(root);
  const native = NativeAbsolutePath.fromLogical(authority, "資料/space name.bin");
  assert.equal(String(native), path.join(root, "資料", "space name.bin"));
  assert.equal(String(native.toLogical(authority)), "資料/space name.bin");
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => new NativeAbsolutePath(`${root}-neighbor/file`).toLogical(authority), { code: "PORTABLE_PATH_INVALID" });
});

test("a replaced directory authority cannot authorize native conversion", (t) => {
  const root = fixture(t);
  const directory = path.join(root, "owned");
  fs.mkdirSync(directory);
  const authority = new RealDirectoryAuthority(directory);
  fs.renameSync(directory, path.join(root, "old"));
  fs.mkdirSync(directory);
  assert.throws(() => NativeAbsolutePath.fromLogical(authority, "file"), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
});

test("native conversion refuses final links and ancestor junctions", (t) => {
  const root = fixture(t);
  const outside = path.join(root, "outside");
  const owned = path.join(root, "owned");
  fs.mkdirSync(outside);
  fs.mkdirSync(owned);
  fs.writeFileSync(path.join(outside, "file"), "outside bytes");
  fs.symlinkSync(outside, path.join(owned, "link"), "junction");
  const authority = new RealDirectoryAuthority(owned);
  assert.throws(() => NativeAbsolutePath.fromLogical(authority, "link"), { code: "PORTABLE_PATH_INVALID" });
  assert.throws(() => NativeAbsolutePath.fromLogical(authority, "link/file"), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.equal(fs.readFileSync(path.join(outside, "file"), "utf8"), "outside bytes");
});

test("logical names reject unrepresentable migration roots and resolved artifact parameters", (t) => {
  const root = fixture(t);
  assert.throws(() => new MigrationSpecRoot({ root, relativePath: "C:specs", authority: "default" }), { code: "PORTABLE_PATH_INVALID" });
  fs.mkdirSync(path.join(root, ".sennel"));
  fs.writeFileSync(path.join(root, ".sennel", "config.json"), JSON.stringify({ flow: { specDir: "specs/AUX" } }));
  assert.equal(resolveMigrationSpecRoot(root).blocker.code, "SPEC_ROOT_CONFIG_INVALID");
  fs.writeFileSync(path.join(root, ".sennel", "config.json"), JSON.stringify({ flow: { specDir: "specs\\nested" } }));
  assert.equal(resolveMigrationSpecRoot(root).root.relativePath, "specs/nested");
  const template = new FlowArtifactCanonicalPath("artifacts/:{sourcePath}");
  assert.equal(template.resolve({ sourcePath: "資料/file.bin" }), "artifacts/資料/file.bin");
  assert.throws(() => template.resolve({ sourcePath: "AUX/file.bin" }), { code: "PORTABLE_PATH_INVALID" });
});

test("Logger decodes escaped file URL frames to native caller paths", async (t) => {
  const root = fixture(t);
  const caller = path.join(root, "caller space % 日本語.mjs");
  fs.writeFileSync(caller, "export function log(logger) { return logger.event('native-caller'); }\n");
  const module = await import(pathToFileURL(caller).href);
  const logger = new Logger({ logDir: root, cwd: root, enabled: true });
  await module.log(logger);
  await logger.flush();
  const entry = readJsonl(path.join(root, `sennel-${todayLocal()}.jsonl`))[0];
  assert.equal(entry.callerFile, caller);
  assert.equal(entry.callerLine, 1);
});
