import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { interruptChildAtCheckpoint } from "../support/infrastructure/interrupted-child.js";
import { failAfterJournalWrite, failDuringLegacyBackupRemoval } from "../support/infrastructure/layout-migration-failure.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../support/builders/tmp-dir.js";
import {
  LayoutMigrationRevisionOne,
} from "../../src/lib/layout-migration.js";
import { AtomicFile } from "../../src/lib/atomic-file.js";
import { LayoutMigrationEvidence } from "../../src/lib/layout-migration-evidence.js";
import { captureRegularFile, DEFAULT_MAX_FILE_BYTES } from "../../src/lib/regular-file-snapshot.js";
import { ProcessExecutionControlFailure } from "../../src/lib/process-execution-values.js";
import { LockOwnerSession } from "../../src/lib/process-lock.js";
import { RepositoryMaintenanceLock } from "../../src/lib/repository-maintenance-lock.js";

const CLI = path.resolve("src/sennel.js");
const MIGRATION_MODULE = pathToFileURL(path.resolve("src/lib/layout-migration.js")).href;
const TEMPLATE_BINARY = Buffer.from([0xff, 0x00, 0x73, 0x65, 0x6e, 0x74, 0x69]);

class FixtureTreeSnapshot {
  constructor(root) {
    this.root = root;
    this.serialized = JSON.stringify(this.#capture(root));
  }

  #capture(directory, relative = "") {
    const entries = [];
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        entries.push({ path: childRelative, kind: "directory", mode: stat.mode & 0o777 });
        entries.push(...this.#capture(target, childRelative));
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: childRelative, kind: "symlink", target: fs.readlinkSync(target) });
      } else {
        entries.push({
          path: childRelative,
          kind: "file",
          mode: stat.mode & 0o777,
          bytes: fs.readFileSync(target).toString("base64"),
        });
      }
    }
    return entries;
  }

  assertUnchanged() {
    assert.equal(JSON.stringify(this.#capture(this.root)), this.serialized);
  }
}

// Real mutation retains the shared empty control namespace. Migration scratch
// and proof must still be fully gone; readonly/no-op tests keep tree invariance.
function assertMigrationScratchAbsent(root) {
  const temporary = path.join(root, ".tmp");
  if (!fs.existsSync(temporary)) return;
  assert.deepEqual(fs.readdirSync(temporary).sort(), ["runtime"]);
  assert.deepEqual(fs.readdirSync(path.join(temporary, "runtime")).sort(), ["repository-control"]);
  assert.deepEqual(fs.readdirSync(path.join(temporary, "runtime", "repository-control")), []);
}

function readCurrentBeforeImage(root, journal, sourcePath) {
  const entry = journal.beforeImages.files.find(file => file.sourcePath === sourcePath);
  assert.ok(entry, `raw before-image must be retained for ${sourcePath}`);
  const snapshot = captureRegularFile(path.join(root, journal.beforeImages.path, entry.name), {
    label: "test retained raw before-image", maxBytes: DEFAULT_MAX_FILE_BYTES, requireSingleLink: true,
    expectedIdentity: entry.identity,
  });
  assert.equal(snapshot.digest, entry.digest);
  assert.equal(snapshot.byteLength, entry.byteLength);
  return snapshot;
}

function validConfig() {
  return {
    name: "user project senti remains a project name",
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
  };
}

function seedLegacyProject(root, directory) {
  writeJson(root, `${directory}/config.json`, validConfig());
  writeJson(root, `${directory}/config.local.json`, { docs: { mode: "generate" } });
  writeFile(root, `${directory}/templates/senti-note.md`, "Use senti, .senti, sentiDir, SENTI, sentiClient, SentiClient, SENTI_WORK_ROOT, and sentinel unchanged.\n");
  writeFile(root, `${directory}/templates/senti-command.txt`, "Run senti from .senti with SentiClient; keep SENTI_WORK_ROOT and sentinel unchanged.\n");
  fs.writeFileSync(path.join(root, directory, "templates", "image.bin"), TEMPLATE_BINARY);
  writeFile(root, `${directory}/presets/user/templates/en/senti-guide.md`, "Use senti from .senti in this preset template.\n");
  writeFile(root, `${directory}/output/review.md`, "historical senti log remains raw\n");
  writeFile(root, `${directory}/output/templates/senti-log.md`, "historical senti template log remains raw\n");
  writeFile(root, `${directory}/worktree/templates/senti-work.md`, "worktree senti data remains raw\n");
  writeFile(root, `${directory}/plugins/plugin-data.txt`, "senti plugin data is copied raw\n");
  writeFile(root, ".gitignore", [
    "node_modules",
    `${directory}/*`,
    `!${directory}/config.json`,
    `!${directory}/templates/`,
    `!${directory}/output/`,
    `!${directory}/presets/`,
    `${directory}/output/acceptance-report-*.json`,
    "user-rule",
    "",
  ].join("\n"));
  writeFile(root, ".gitattributes", `${directory}/output/analysis.json merge=ours\n*.png binary\n`);
  for (const base of [".agents", ".claude"]) {
    writeFile(root, `${base}/skills/sdd-forge.flow/SKILL.md`, "old\n");
    writeFile(root, `${base}/skills/senti.flow/SKILL.md`, "old\n");
    writeFile(root, `${base}/skills/user.skill/SKILL.md`, "user\n");
  }
}

function runLayoutMigration(root, args) {
  const result = spawnSync(process.execPath, [CLI, "migrate", "layout", "--to", "1", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
  });
  return result;
}

function addPluginConfigAndSkill(root, directory) {
  const config = validConfig();
  config.type = "fixture-preset";
  config.plugin = {
    sources: [{ id: "fixture", type: "local", path: ".sennel/plugins/fixture" }],
    packages: [{
      id: "fixture",
      source: "fixture",
      commit: "0000000000000000000000000000000000000000",
    }],
  };
  config.fixtureSetting = "enabled";
  writeJson(root, `${directory}/config.json`, config);
  writeJson(root, `${directory}/plugins/fixture/plugin.json`, {
    name: "fixture",
    files: ["plugin.json", "skills/", "presets/", "config.schema.json"],
    contributions: {
      skills: [{ name: "external.skill", path: "skills/external.skill/SKILL.md" }],
      presets: [{ key: "fixture-preset", path: "presets/fixture-preset" }],
      config: { schema: "config.schema.json" },
    },
  });
  writeJson(root, `${directory}/plugins/fixture/presets/fixture-preset/preset.json`, {
    parent: "base",
    chapters: [],
  });
  writeJson(root, `${directory}/plugins/fixture/config.schema.json`, {
    properties: {
      fixtureSetting: { type: "string", minLength: 1 },
    },
  });
  writeFile(root, `${directory}/plugins/fixture/skills/external.skill/SKILL.md`, "external plugin\n");
}

function addMalformedPluginConfig(root, directory) {
  const config = validConfig();
  config.plugin = {
    sources: [{ id: "fixture", type: "local", path: ".sennel/plugins/fixture" }],
    packages: [{
      id: "fixture",
      source: "fixture",
      commit: "0000000000000000000000000000000000000000",
    }],
  };
  writeJson(root, `${directory}/config.json`, config);
  const malformedManifest = Buffer.from("{ malformed plugin manifest remains raw\n", "utf8");
  fs.mkdirSync(path.join(root, directory, "plugins", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, directory, "plugins", "fixture", "plugin.json"), malformedManifest);
  return malformedManifest;
}

function interruptMigration(root, script) {
  const source = `
    import fs from "node:fs";
    function pauseMigration() { fs.writeSync(1, "migration-paused\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
    ${script}
  `;
  return interruptChildAtCheckpoint(process.execPath, ["--import", pathToFileURL(CLI).href, "--input-type=module", "-e", source], {
    cwd: root, checkpoint: "migration-paused\n",
  });
}

function crashAfterJournalWrite(root, writeNumber) {
  const script = `
    import path from "node:path";
    import { LayoutMigrationRevisionOne } from ${JSON.stringify(MIGRATION_MODULE)};
    import { AtomicFile } from ${JSON.stringify(pathToFileURL(path.resolve("src/lib/atomic-file.js")).href)};
    const journalPath = path.join(${JSON.stringify(root)}, ".tmp", "sennel-migrate-layout.json");
    const originalPublish = AtomicFile.prototype.publishStage;
    let journalWrites = 0;
    AtomicFile.prototype.publishStage = function (...args) {
      const result = originalPublish.apply(this, args);
      if (this.filePath === journalPath && ++journalWrites === ${writeNumber}) pauseMigration();
      return result;
    };
    new LayoutMigrationRevisionOne(${JSON.stringify(root)}, { logger: { log() {}, error() {} } }).run();
  `;
  return interruptMigration(root, script);
}

function failAfterCanonicalRename(root, { concurrentWrite = false } = {}) {
  const rename = fs.renameSync;
  let injected = false;
  try {
    fs.renameSync = function (from, to, ...rest) {
      const result = rename.call(fs, from, to, ...rest);
      if (!injected && path.resolve(String(to)) === path.join(root, ".sennel")) {
        injected = true;
        if (concurrentWrite) fs.writeFileSync(path.join(root, ".sennel", "concurrent.txt"), "retained writer data\n");
        throw Object.assign(new Error("injected canonical rename response loss"), { code: "EIO" });
      }
      return result;
    };
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /injected canonical rename response loss|migration and rollback both failed/);
  } finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), "utf8")).owner.released, true);
}

// Reach the cutoff through the real migration and let its finally block alone
// release the writer. Faults occur at actual filesystem effects, not by editing
// a successful receipt or an owner capability.
function failAtCleanupCutoff(root, { timing = "payload", rollback = false, foreign = false } = {}) {
  const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
  const cutoff = rollback ? "rollback-complete" : "cleanup-complete";
  const rename = fs.renameSync;
  const remove = AtomicFile.prototype.remove;
  let injected = false;
  let forcedRollback = false;
  const fault = () => Object.assign(new Error("injected layout cutoff I/O failure"), { code: "EIO" });
  try {
    fs.renameSync = function (from, to, ...rest) {
      if (rollback && !forcedRollback && path.basename(String(to)) === "legacy-source-backup") {
        forcedRollback = true;
        throw Object.assign(new Error("injected commit failure before rollback"), { code: "EIO" });
      }
      const selected = !injected && timing !== "payload" && path.resolve(String(to)) === journalPath
        && JSON.parse(fs.readFileSync(from, "utf8")).phase === cutoff;
      if (selected && timing === "before") { injected = true; throw fault(); }
      const result = rename.call(fs, from, to, ...rest);
      if (selected && timing === "after") { injected = true; throw fault(); }
      return result;
    };
    AtomicFile.prototype.remove = function (...args) {
      const result = remove.apply(this, args);
      if (!injected && timing === "payload" && path.basename(path.dirname(this.filePath)).startsWith("sennel-layout-evidence-")
        && path.basename(this.filePath).endsWith(".bytes")) {
        injected = true;
        if (foreign) fs.writeFileSync(path.join(path.dirname(this.filePath), "foreign.txt"), "foreign cleanup bytes\n");
        throw fault();
      }
      return result;
    };
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /injected layout cutoff I\/O failure|migration and rollback both failed/);
  } finally { fs.renameSync = rename; AtomicFile.prototype.remove = remove; }
  assert.equal(injected, true, "the genuine cleanup cutoff must be reached");
  if (rollback) assert.equal(forcedRollback, true);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(journal.owner.released, true);
  assert.equal(journal.phase, timing === "before" ? "cleanup-source-verified" : cutoff);
  return journal;
}

function oldV6MetadataPlan(name, original) {
  const lines = original.toString("utf8").split("\n");
  const roots = [".sdd-forge", ".senti"];
  if (name === ".gitattributes") {
    const kept = lines.filter((line) => !roots.some((root) => line.trim() === `${root}/output/analysis.json merge=ours`));
    const body = kept.at(-1) === "" ? kept.slice(0, -1) : kept;
    body.push(".senrail/output/analysis.json merge=ours");
    return Buffer.from(`${body.join("\n")}\n`).toString("base64");
  }
  const managed = new Set(roots.flatMap((root) => [
    `${root}/*`, `!${root}/config.json`, `!${root}/templates/`, `!${root}/output/`, `!${root}/presets/`,
    `${root}/output/acceptance-report-*.json`, `${root}/`,
  ]));
  const kept = lines.filter((line) => !managed.has(line.trim()));
  const body = kept.at(-1) === "" ? kept.slice(0, -1) : kept;
  body.push(".senrail/*", "!.senrail/config.json", "!.senrail/templates/", "!.senrail/output/", "!.senrail/presets/", ".senrail/output/acceptance-report-*.json");
  return Buffer.from(`${body.join("\n")}\n`).toString("base64");
}

async function createOldV6Journal(root, { sourceName, phase, canonical = false, partialCleanup = false }) {
  failAfterJournalWrite(root, 1);
  const temp = path.join(root, ".tmp");
  const newJournalPath = path.join(temp, "sennel-migrate-layout.json");
  const current = JSON.parse(fs.readFileSync(newJournalPath, "utf8"));
  const oldRelative = ".tmp/senrail-upgrade-migrate-00000000-0000-4000-8000-000000000000";
  const oldStaging = path.join(root, oldRelative);
  fs.renameSync(path.join(root, current.stagingRelative), oldStaging);
  // Current fixture production also owns independent raw before-images. Keep
  // them as additional protected data when constructing the rejected legacy
  // boundary; moving staging must not delete those sibling payloads.
  for (const file of current.beforeImages.files) readCurrentBeforeImage(root, current, file.sourcePath);
  assert.deepEqual(fs.readdirSync(path.join(temp, "runtime")).sort(), ["migrate-layout", "repository-control"]);
  const staged = path.join(oldStaging, ".senti");
  fs.renameSync(path.join(oldStaging, "managed-directory"), staged);
  if (sourceName === ".senti" && ["legacy-backed-up", "placed-senti", "metadata-updated"].includes(phase)) {
    fs.renameSync(path.join(root, sourceName), path.join(oldStaging, "legacy-source-backup"));
  }
  if (["placed-senti", "metadata-updated"].includes(phase)) fs.renameSync(staged, path.join(root, ".senti"));
  if (canonical) {
    fs.renameSync(staged, path.join(root, ".senrail"));
    const source = path.join(root, sourceName);
    if (fs.existsSync(source)) fs.renameSync(source, path.join(oldStaging, "legacy-source-backup"));
    if (partialCleanup) fs.rmSync(path.join(oldStaging, "legacy-source-backup", "config.local.json"));
  }
  const stagedLocation = canonical ? path.join(root, ".senrail") : ["placed-senti", "metadata-updated"].includes(phase) ? path.join(root, ".senti") : staged;
  const stagedStat = fs.statSync(stagedLocation);
  const old = {
    ...current,
    // Historical v6 writers used OS identity, never a token release capability.
    owner: JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/process-owner-v7/layout-journal.json"), "utf8")).owner,
    version: 6,
    sourceName,
    stagingRelative: oldRelative,
    stagedSentiIdentity: { dev: stagedStat.dev, ino: stagedStat.ino },
    phase,
    metadata: current.metadata.map((entry) => ({ ...entry, planned: oldV6MetadataPlan(entry.name, Buffer.from(entry.original, "base64")) })),
  };
  delete old.stagedManagedIdentity;
  delete old.beforeImages;
  fs.rmSync(newJournalPath);
  fs.writeFileSync(path.join(temp, "senrail-upgrade-migrate.json"), `${JSON.stringify(old, null, 2)}\n`);
  return old;
}


describe("migrate layout --to 1", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) removeTmpDir(root);
  });

  it("preserves a foreign backup directory replaced after durable cleanup validation", (t) => {
    const root = createTmpDir("sennel-layout-cleanup-generation-race-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const foreign = path.join(root, "external-directory");
    const retained = path.join(root, "retained-legacy-backup");
    fs.mkdirSync(foreign);
    const evidence = Buffer.from("external layout evidence\n");
    fs.writeFileSync(path.join(foreign, "external.bin"), evidence);
    const foreignIdentity = fs.lstatSync(foreign, { bigint: true });
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const publish = AtomicFile.prototype.publishStage;
    let replaced = false;
    let backup;
    let backupBefore;
    const replacement = t.mock.method(AtomicFile.prototype, "publishStage", function (...args) {
      const result = Reflect.apply(publish, this, args);
      if (this.filePath === journalPath && !replaced) {
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
        if (journal.phase === "cleanup-source-verified") {
          backup = path.join(root, journal.stagingRelative, "legacy-source-backup");
          backupBefore = new FixtureTreeSnapshot(backup).serialized;
          replaced = true;
          fs.renameSync(backup, retained);
          fs.renameSync(foreign, backup);
        }
      }
      return result;
    });
    let failure;
    try { new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(); }
    catch (error) { failure = error; }
    finally { replacement.mock.restore(); }
    assert.equal(replaced, true, "replacement occurs after the actual cleanup phase publication");
    assert.equal(fs.existsSync(path.join(backup, "external.bin")), true,
      "cleanup must retain the external directory after durable source validation");
    assert.deepEqual(fs.readFileSync(path.join(backup, "external.bin")), evidence);
    const actual = fs.lstatSync(backup, { bigint: true });
    assert.equal(actual.dev, foreignIdentity.dev);
    assert.equal(actual.ino, foreignIdentity.ino);
    assert.ok(failure, "a replaced backup must refuse cleanup");
    assert.equal(new FixtureTreeSnapshot(retained).serialized, backupBefore);
    assert.equal(fs.existsSync(journalPath), true, "recovery journal stays available");
    assert.equal(fs.existsSync(path.join(root, ".sennel", "config.json")), true,
      "the published canonical tree stays in place");
  });

  it("documents the revisioned public layout migration", () => {
    const root = createTmpDir("sennel-migrate-layout-help-");
    roots.push(root);

    const result = runLayoutMigration(root, ["--help"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Usage: sennel migrate layout --to 1 \[--dry-run\]/);
    assert.match(result.stdout, /Migrate the managed project layout to a target revision/);
  });

  it("does not retain upgrade --migrate as a compatibility route", () => {
    const root = createTmpDir("sennel-migrate-layout-no-upgrade-alias-");
    roots.push(root);

    const result = spawnSync(process.execPath, [CLI, "upgrade", "--migrate"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option: --migrate/);
  });

  for (const legacyDirectory of [".sdd-forge", ".senti", ".senrail"]) {
    it(`migrates ${legacyDirectory} transactionally`, () => {
      const root = createTmpDir("sennel-migrate-layout-");
      roots.push(root);
      seedLegacyProject(root, legacyDirectory);
      const originalConfig = fs.readFileSync(path.join(root, legacyDirectory, "config.json"));

      const result = runLayoutMigration(root, []);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(fs.existsSync(path.join(root, legacyDirectory)), false);
      assert.equal(fs.existsSync(path.join(root, ".sdd-forge")), false);
      assert.equal(fs.existsSync(path.join(root, ".senti")), false);
      assert.equal(fs.existsSync(path.join(root, ".senrail")), false);
      assert.equal(fs.readFileSync(path.join(root, ".sennel", "config.json"), "utf8"), originalConfig.toString("utf8"));
      assert.equal(
        fs.readFileSync(path.join(root, ".sennel", "templates", "sennel-note.md"), "utf8"),
        "Use sennel, .sennel, managedDir, SENNEL, sennelClient, SennelClient, SENTI_WORK_ROOT, and sentinel unchanged.\n",
      );
      assert.equal(
        fs.readFileSync(path.join(root, ".sennel", "templates", "sennel-command.txt"), "utf8"),
        "Run sennel from .sennel with SennelClient; keep SENTI_WORK_ROOT and sentinel unchanged.\n",
      );
      assert.equal(
        fs.readFileSync(path.join(root, ".sennel", "presets", "user", "templates", "en", "sennel-guide.md"), "utf8"),
        "Use sennel from .sennel in this preset template.\n",
      );
      assert.equal(fs.existsSync(path.join(root, ".sennel", "plugin-sources", "local-presets")), false);
      assert.deepEqual(
        fs.readFileSync(path.join(root, ".sennel", "templates", "image.bin")),
        TEMPLATE_BINARY,
      );
      assert.equal(
        fs.readFileSync(path.join(root, ".sennel", "plugins", "plugin-data.txt"), "utf8"),
        "senti plugin data is copied raw\n",
      );
      assert.equal(
        fs.readFileSync(path.join(root, ".sennel", "output", "review.md"), "utf8"),
        "historical senti log remains raw\n",
      );
      assert.equal(
        fs.readFileSync(path.join(root, ".sennel", "output", "templates", "senti-log.md"), "utf8"),
        "historical senti template log remains raw\n",
      );
      assert.equal(
        fs.readFileSync(path.join(root, ".sennel", "worktree", "templates", "senti-work.md"), "utf8"),
        "worktree senti data remains raw\n",
      );
      const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
      assert.match(ignore, /^\.sennel\/\*/m);
      assert.doesNotMatch(ignore, new RegExp(`${legacyDirectory.replace(".", "\\.")}\\/\\*`));
      assert.match(ignore, /node_modules/);
      assert.match(ignore, /user-rule/);
      const attributes = fs.readFileSync(path.join(root, ".gitattributes"), "utf8");
      assert.match(attributes, /^\.sennel\/output\/analysis\.json merge=ours/m);
      assert.match(attributes, /\*\.png binary/);
      for (const base of [".agents", ".claude"]) {
        // Layout revision 1 is deliberately independent from normal upgrade
        // and must not mutate an agent-host directory.
        assert.equal(fs.existsSync(path.join(root, base, "skills", "sdd-forge.flow")), true);
        assert.equal(fs.existsSync(path.join(root, base, "skills", "senti.flow")), true);
        assert.equal(fs.readFileSync(path.join(root, base, "skills", "user.skill", "SKILL.md"), "utf8"), "user\n");
        assert.equal(fs.existsSync(path.join(root, base, "skills", "sennel.flow", "SKILL.md")), false);
      }
    });
  }

  for (const directories of [[".sdd-forge", ".senti"], [".sdd-forge", ".senrail"], [".senti", ".senrail"], [".sdd-forge", ".senti", ".senrail"]]) {
    it(`fails closed for legacy-directory collision: ${directories.join(", ")}`, () => {
      const root = createTmpDir("sennel-migrate-layout-collision-");
      roots.push(root);
      for (const directory of directories) seedLegacyProject(root, directory);

      const result = runLayoutMigration(root, []);

      assert.notEqual(result.status, 0);
      for (const directory of directories) assert.ok(fs.existsSync(path.join(root, directory)));
      assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
      assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    });
  }

  it("does nothing when a canonical managed directory already exists", () => {
    const root = createTmpDir("sennel-migrate-layout-canonical-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeFile(root, ".sennel/keep.txt", "canonical\n");

    const result = runLayoutMigration(root, []);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.existsSync(path.join(root, ".senti")));
    assert.equal(fs.readFileSync(path.join(root, ".sennel", "keep.txt"), "utf8"), "canonical\n");
    assert.ok(fs.existsSync(path.join(root, ".agents", "skills", "senti.flow", "SKILL.md")));
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  });

  it("leaves a project without any managed directory and its root metadata untouched", () => {
    const root = createTmpDir("sennel-migrate-layout-none-");
    roots.push(root);
    writeFile(root, ".gitignore", "node_modules\n");
    writeFile(root, ".gitattributes", "*.png binary\n");
    const beforeIgnore = fs.readFileSync(path.join(root, ".gitignore"));
    const beforeAttributes = fs.readFileSync(path.join(root, ".gitattributes"));

    const result = runLayoutMigration(root, []);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitignore")), beforeIgnore);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitattributes")), beforeAttributes);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  });

  it("rejects an active or preparing legacy Flow before creating staging", () => {
    const root = createTmpDir("sennel-migrate-layout-active-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeFile(root, ".senti/.active-flow.pending", "{}\n");

    const result = runLayoutMigration(root, []);

    assert.notEqual(result.status, 0);
    assert.ok(fs.existsSync(path.join(root, ".senti")));
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  });

  it("rejects a managed writer lock and broken journals without changing source data", () => {
    const root = createTmpDir("sennel-migrate-layout-safety-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const configPath = path.join(root, ".senti", "config.json");
    const before = fs.readFileSync(configPath);
    writeFile(root, ".senti/.repository-maintenance.lock", "writer\n");

    const locked = runLayoutMigration(root, []);

    assert.notEqual(locked.status, 0);
    assert.deepEqual(fs.readFileSync(configPath), before);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    fs.rmSync(path.join(root, ".senti", ".repository-maintenance.lock"));
    writeFile(root, ".senti/.active-flow.lock", "writer\n");

    const activeFlowLock = runLayoutMigration(root, []);

    assert.notEqual(activeFlowLock.status, 0);
    assert.deepEqual(fs.readFileSync(configPath), before);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    fs.rmSync(path.join(root, ".senti", ".active-flow.lock"));
    writeFile(root, ".tmp/sennel-migrate-layout.json", "{broken\n");

    const broken = runLayoutMigration(root, []);

    assert.notEqual(broken.status, 0);
    assert.deepEqual(fs.readFileSync(configPath), before);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), "utf8"), "{broken\n");

    const unsafeJournal = JSON.stringify({
      version: 1,
      root,
      sourceName: ".senti",
      stagingRelative: ".tmp/sennel-migrate-layout-00000000-0000-4000-8000-000000000000/../outside",
      sourceIdentity: { dev: 1, ino: 1 },
      stagedSentiIdentity: { dev: 1, ino: 1 },
      metadata: [],
      tempRootCreated: false,
      phase: "staged",
    }, null, 2);
    writeFile(root, ".tmp/sennel-migrate-layout.json", unsafeJournal);

    const unsafe = runLayoutMigration(root, []);

    assert.notEqual(unsafe.status, 0);
    assert.deepEqual(fs.readFileSync(configPath), before);
    assert.ok(fs.existsSync(path.join(root, ".senti")));
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), "utf8"), unsafeJournal);
  });

  for (const linkTarget of ["config.json", "templates", "missing"]) {
    it(`rejects native link ${linkTarget} before staging without changing source or metadata`, () => {
      const root = createTmpDir("sennel-migrate-layout-native-link-");
      roots.push(root);
      seedLegacyProject(root, ".sdd-forge");
      fs.symlinkSync(linkTarget, path.join(root, ".sdd-forge", "native-link"));
      const before = new FixtureTreeSnapshot(root);
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        (error) => error instanceof ProcessExecutionControlFailure && error.reason === "input-invalid");
      before.assertUnchanged();
      assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
      assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    });
  }

  it("rejects a transformed template-name collision before creating a staging directory", () => {
    const root = createTmpDir("sennel-migrate-layout-template-collision-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeFile(root, ".senti/templates/sennel-note.md", "collision\n");

    const result = runLayoutMigration(root, []);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /migration path collision/);
    assert.ok(fs.existsSync(path.join(root, ".senti")));
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  });

  it("rejects a config reference that template renaming would break", () => {
    const root = createTmpDir("sennel-migrate-layout-template-reference-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeFile(root, ".senti/templates/en/docs/senti-guide.md", "Use senti.\n");
    writeJson(root, ".senti/config.json", {
      ...validConfig(),
      chapters: [{ chapter: "senti-guide.md" }],
    });

    const result = runLayoutMigration(root, []);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /migration would break a managed template reference/);
    assert.ok(fs.existsSync(path.join(root, ".senti")));
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  });

  it("validates canonical config references against future transformed templates", () => {
    const root = createTmpDir("sennel-migrate-layout-future-template-reference-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeFile(root, ".senti/templates/en/docs/senti-guide.md", "Use senti.\n");
    writeJson(root, ".senti/config.json", {
      ...validConfig(),
      chapters: [{ chapter: "sennel-guide.md" }],
    });

    const dryRun = runLayoutMigration(root, ["--dry-run"]);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);

    const migrated = runLayoutMigration(root, []);
    assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
    assert.ok(fs.existsSync(path.join(root, ".sennel", "templates", "en", "docs", "sennel-guide.md")));
  });

  it("detects a concurrent managed-directory writer before starting commit", () => {
    const root = createTmpDir("sennel-migrate-layout-concurrent-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const configPath = path.join(root, ".senti", "config.json");
    const originalPublish = AtomicFile.prototype.publishStage;
    let changed = false;
    AtomicFile.prototype.publishStage = function (stage, ...rest) {
      const result = originalPublish.call(this, stage, ...rest);
      const to = this.filePath;
      if (!changed && path.basename(String(to)) === "config.json" && String(to).includes("sennel-migrate-layout-")) {
        changed = true;
        fs.writeFileSync(configPath, `${JSON.stringify({ ...validConfig(), concurrency: 2 })}\n`);
      }
      return result;
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /changed while migration staging was in progress/,
      );
    } finally {
      AtomicFile.prototype.publishStage = originalPublish;
    }

    assert.equal(changed, true);
    assert.ok(fs.existsSync(path.join(root, ".senti")));
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assertMigrationScratchAbsent(root);
  });

  it("restores the legacy source and preserves a write to the staged canonical path", () => {
    const root = createTmpDir("sennel-migrate-layout-temporary-writer-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const originalConfig = fs.readFileSync(path.join(root, ".senti", "config.json"));
    const originalRename = fs.renameSync;
    let changed = false;
    fs.renameSync = (from, to, ...rest) => {
      const result = originalRename(from, to, ...rest);
      if (!changed && path.resolve(to) === path.join(root, ".sennel")) {
        changed = true;
        writeFile(root, ".sennel/concurrent.txt", "temporary writer data\n");
      }
      return result;
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /migration and rollback both failed/,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(changed, true);
    assert.deepEqual(fs.readFileSync(path.join(root, ".senti", "config.json")), originalConfig);
    assert.equal(fs.existsSync(path.join(root, ".sennel", "concurrent.txt")), false);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    const journal = JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), "utf8"));
    const preserved = path.join(root, journal.stagingRelative, "concurrent-managed-write", "concurrent.txt");
    assert.equal(fs.readFileSync(preserved, "utf8"), "temporary writer data\n");
    assert.throws(
      () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /concurrent managed write was preserved at/,
    );
    assert.equal(fs.readFileSync(preserved, "utf8"), "temporary writer data\n");
  });

  it("preserves a foreign empty quarantine directory arriving after the absence observation", () => {
    const root = createTmpDir("sennel-migrate-layout-quarantine-foreign-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const originalConfig = fs.readFileSync(path.join(root, ".senti", "config.json"));
    const rename = fs.renameSync;
    const lstat = fs.lstatSync;
    let changed = false;
    let foreign = null;
    fs.renameSync = function (from, to, ...rest) {
      const result = rename.call(fs, from, to, ...rest);
      if (!changed && path.resolve(String(to)) === path.join(root, ".sennel")) {
        changed = true;
        fs.writeFileSync(path.join(root, ".sennel", "concurrent.txt"), "retained canonical writer\n");
      }
      return result;
    };
    fs.lstatSync = function (target, ...rest) {
      try { return lstat.call(fs, target, ...rest); }
      catch (error) {
        if (changed && foreign === null && error.code === "ENOENT"
          && path.basename(String(target)) === "concurrent-managed-write") {
          fs.mkdirSync(target);
          const identity = lstat.call(fs, target, { bigint: true });
          foreign = { path: String(target), dev: identity.dev, ino: identity.ino };
        }
        throw error;
      }
    };
    try {
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /migration and rollback both failed/);
    } finally { fs.renameSync = rename; fs.lstatSync = lstat; }
    assert.equal(changed, true);
    assert.notEqual(foreign, null);
    const identity = fs.lstatSync(foreign.path, { bigint: true });
    assert.equal(identity.dev, foreign.dev);
    assert.equal(identity.ino, foreign.ino);
    assert.deepEqual(fs.readdirSync(foreign.path), []);
    assert.equal(fs.readFileSync(path.join(root, ".sennel", "concurrent.txt"), "utf8"), "retained canonical writer\n");
    const journal = JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json")));
    assert.equal(journal.receipt, null);
    assert.equal(journal.owner.released, true);
    assert.deepEqual(fs.readFileSync(path.join(root, journal.stagingRelative, "legacy-source-backup", "config.json")), originalConfig);
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    const retained = new FixtureTreeSnapshot(root);
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run());
    retained.assertUnchanged();
  });

  it("preserves a staged canonical write across released-writer recovery", async () => {
    const root = createTmpDir("sennel-migrate-layout-crash-writer-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const originalConfig = fs.readFileSync(path.join(root, ".senti", "config.json"));

    failAfterCanonicalRename(root, { concurrentWrite: true });
    assert.throws(
      () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /concurrent managed write was preserved at/,
    );
    assert.deepEqual(fs.readFileSync(path.join(root, ".senti", "config.json")), originalConfig);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    const journal = JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), "utf8"));
    const preserved = path.join(root, journal.stagingRelative, "concurrent-managed-write", "concurrent.txt");
    assert.equal(fs.readFileSync(preserved, "utf8"), "retained writer data\n");
    assert.equal(path.dirname(path.join(root, journal.stagingRelative)), path.join(root, ".tmp", "runtime", "migrate-layout"));
  });

  it("completes cleanup after canonical rename response loss and explicit writer release", async () => {
    const root = createTmpDir("sennel-migrate-layout-canonical-boundary-");
    roots.push(root);
    seedLegacyProject(root, ".senrail");

    failAfterCanonicalRename(root);
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    assert.ok(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-layout.json")));
    new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run();
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    assert.equal(fs.existsSync(path.join(root, ".senrail")), false);
    assertMigrationScratchAbsent(root);
  });

  it("preserves a managed-directory write that races with final cleanup", () => {
    const root = createTmpDir("sennel-migrate-layout-cleanup-writer-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const originalRename = fs.renameSync;
    let changed = false;
    fs.renameSync = (from, to, ...rest) => {
      const result = originalRename(from, to, ...rest);
      if (!changed && path.resolve(to) === path.join(root, ".sennel")) {
        changed = true;
        writeFile(root, ".sdd-forge/concurrent.txt", "late writer data\n");
      }
      return result;
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /legacy managed directory and its cleanup backup both exist/,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(changed, true);
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    assert.equal(fs.readFileSync(path.join(root, ".sdd-forge", "concurrent.txt"), "utf8"), "late writer data\n");
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const backup = path.join(root, journal.stagingRelative, "legacy-source-backup");
    assert.ok(fs.existsSync(path.join(backup, "config.json")));
    assert.throws(
      () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /legacy managed directory and its cleanup backup both exist/,
    );
    assert.equal(fs.readFileSync(path.join(root, ".sdd-forge", "concurrent.txt"), "utf8"), "late writer data\n");
    assert.equal(fs.existsSync(path.join(root, ".sennel", "config.json")), true);
    assert.ok(JSON.parse(fs.readFileSync(journalPath)).receipt);
  });

  it("preserves receipt-confirmed canonical and backup generations when a foreign legacy source blocks cleanup recovery", () => {
    const root = createTmpDir("sennel-migrate-layout-published-foreign-source-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const remove = fs.rmSync;
    let injected = false;
    fs.rmSync = (target, ...rest) => {
      if (!injected && path.basename(String(target)) === "legacy-source-backup") {
        injected = true;
        writeFile(root, ".senti/foreign.txt", "foreign source generation\n");
        throw new Error("injected cleanup interruption after publication");
      }
      return remove(target, ...rest);
    };
    try {
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /injected cleanup interruption after publication/);
    } finally { fs.rmSync = remove; }
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const saved = JSON.parse(fs.readFileSync(journalPath));
    assert.notEqual(saved.receipt, null);
    assert.equal(saved.phase, "cleanup-source-verified");
    const metadata = fs.readFileSync(path.join(root, ".gitignore"));
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(), Error);
    assert.equal(fs.existsSync(path.join(root, ".sennel", "config.json")), true);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitignore")), metadata);
    assert.equal(fs.readFileSync(path.join(root, ".senti", "foreign.txt"), "utf8"), "foreign source generation\n");
    assert.equal(fs.existsSync(path.join(root, saved.stagingRelative, "legacy-source-backup", "config.json")), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(journalPath)).receipt, saved.receipt);
  });

  it("refuses completion when the published target changes during cleanup and preserves its receipt and raw before-image", () => {
    const root = createTmpDir("sennel-migrate-layout-published-cleanup-readback-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const remove = fs.rmSync;
    let injected = false;
    fs.rmSync = (target, ...rest) => {
      const result = remove(target, ...rest);
      if (!injected && path.basename(String(target)) === "legacy-source-backup") {
        injected = true;
        writeFile(root, ".sennel/output/review.md", "external published-tree write\n");
      }
      return result;
    };
    try {
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /migrated managed directory changed before commit completed/);
    } finally { fs.rmSync = remove; }
    assert.equal(injected, true);
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const saved = JSON.parse(fs.readFileSync(journalPath));
    assert.notEqual(saved.receipt, null);
    const original = readCurrentBeforeImage(root, saved, "output/review.md");
    assert.equal(original.text(), "historical senti log remains raw\n");
    assert.equal(fs.readFileSync(path.join(root, ".sennel", "output", "review.md"), "utf8"), "external published-tree write\n");
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /migrated managed directory changed before commit completed/);
    assert.equal(fs.readFileSync(path.join(root, ".sennel", "output", "review.md"), "utf8"), "external published-tree write\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(journalPath)).receipt, saved.receipt);
  });

  it("refuses its own cwd inside a recovery stage before changing any migration proof", () => {
    const root = createTmpDir("sennel-migrate-layout-recovery-cwd-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const saved = failAfterJournalWrite(root, 1);
    const before = new FixtureTreeSnapshot(root);
    const originalCwd = process.cwd();
    try {
      process.chdir(path.join(root, saved.stagingRelative, "managed-directory"));
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        (error) => error instanceof ProcessExecutionControlFailure && error.reason === "input-invalid");
    } finally { process.chdir(originalCwd); }
    before.assertUnchanged();
  });

  it("preserves a legacy path recreated after its source is isolated for cleanup", () => {
    const root = createTmpDir("sennel-migrate-layout-recreated-source-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const originalRename = fs.renameSync;
    let changed = false;
    fs.renameSync = (from, to, ...rest) => {
      const result = originalRename(from, to, ...rest);
      if (!changed && path.basename(path.resolve(to)) === "legacy-source-backup") {
        changed = true;
        writeFile(root, ".sdd-forge/concurrent.txt", "recreated writer data\n");
      }
      return result;
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /directory move readback found a source replacement/,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(changed, true);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.readFileSync(path.join(root, ".sdd-forge", "concurrent.txt"), "utf8"), "recreated writer data\n");
    const journal = JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), "utf8"));
    const backup = path.join(root, journal.stagingRelative, "legacy-source-backup");
    assert.ok(fs.existsSync(path.join(backup, "config.json")));
    assert.throws(
      () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /cannot restore legacy directory because its original path is occupied: \.sdd-forge/,
    );
    assert.equal(fs.readFileSync(path.join(root, ".sdd-forge", "concurrent.txt"), "utf8"), "recreated writer data\n");
    assert.ok(fs.existsSync(path.join(backup, "config.json")));
  });

  it("rejects a staged-copy mutation before publishing a journal or changing the source", () => {
    const root = createTmpDir("sennel-migrate-layout-staged-verification-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const configPath = path.join(root, ".senti", "config.json");
    const originalConfig = fs.readFileSync(configPath);
    const originalIgnore = fs.readFileSync(path.join(root, ".gitignore"));
    const originalAttributes = fs.readFileSync(path.join(root, ".gitattributes"));
    const originalPublish = AtomicFile.prototype.publishStage;
    let tampered = false;
    AtomicFile.prototype.publishStage = function (stage, ...rest) {
      const result = originalPublish.call(this, stage, ...rest);
      const to = this.filePath;
      if (!tampered && path.basename(String(to)) === "config.json" && String(to).includes("sennel-migrate-layout-")) {
        tampered = true;
        fs.writeFileSync(to, "{\"tampered\":true}\n");
      }
      return result;
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /staged tree does not match the source-derived transformation/,
      );
    } finally {
      AtomicFile.prototype.publishStage = originalPublish;
    }

    assert.equal(tampered, true);
    assert.deepEqual(fs.readFileSync(configPath), originalConfig);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitignore")), originalIgnore);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitattributes")), originalAttributes);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assertMigrationScratchAbsent(root);
  });

  it("uses bytes and captured generation rather than permission changes as migration authority", () => {
    const root = createTmpDir("sennel-migrate-layout-permission-hint-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const originalPublish = AtomicFile.prototype.publishStage;
    let changed = false;
    AtomicFile.prototype.publishStage = function (...args) {
      const result = originalPublish.apply(this, args);
      if (!changed && this.filePath.includes("managed-directory") && path.basename(this.filePath) === "config.json") {
        changed = true;
        fs.chmodSync(path.join(root, ".sdd-forge", "config.json"), 0o640);
      }
      return result;
    };
    try {
      const result = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run();
      assert.equal(result.migrated, true);
    } finally { AtomicFile.prototype.publishStage = originalPublish; }
    assert.equal(changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".sennel", "config.json"))), validConfig());
    assert.deepEqual(fs.readFileSync(path.join(root, ".sennel", "templates", "image.bin")), TEMPLATE_BINARY);
  });

  it("preserves a raw executable tool's copy hint without making it snapshot authority", () => {
    const root = createTmpDir("sennel-migrate-layout-executable-copy-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const source = path.join(root, ".senti", "plugins", "tool.js");
    fs.writeFileSync(source, "#!/usr/bin/env node\nprocess.stdout.write('native tool works\\n');\n");
    fs.chmodSync(source, 0o755);
    const options = { label: "executable copy hint", maxBytes: DEFAULT_MAX_FILE_BYTES };
    const before = captureRegularFile(source, options);
    if (process.platform !== "win32") {
      const original = spawnSync(source, [], { encoding: "utf8" });
      assert.equal(original.status, 0, original.error?.message || original.stderr);
    }
    const publish = AtomicFile.prototype.publishStage;
    let storedEntry = null;
    AtomicFile.prototype.publishStage = function (...args) {
      const result = publish.apply(this, args);
      if (this.filePath === path.join(root, ".tmp", "sennel-migrate-layout.json")) {
        storedEntry = JSON.parse(fs.readFileSync(this.filePath)).sourceSnapshot.entries.find((entry) => entry.path === "plugins/tool.js");
      }
      return result;
    };
    try { new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(); }
    finally { AtomicFile.prototype.publishStage = publish; }
    const target = path.join(root, ".sennel", "plugins", "tool.js");
    if (process.platform !== "win32") {
      const copied = spawnSync(target, [], { encoding: "utf8" });
      assert.equal(copied.status, 0, copied.error?.message || copied.stderr);
      assert.equal(copied.stdout, "native tool works\n");
    }
    const after = captureRegularFile(target, options);
    assert.deepEqual(after.bytes, before.bytes);
    assert.equal(before.permissionHint.matchesAfterWrite(after.permissionHint), true);
    assert.equal(Object.hasOwn(storedEntry, "permissionHint"), false);
    assert.equal(Object.hasOwn(storedEntry, "mode"), false);
  });

  it("retains raw disk before-images and exact generations before source effects and returns the readback publication receipt", () => {
    const root = createTmpDir("sennel-migrate-layout-byte-proof-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const config = fs.readFileSync(path.join(root, ".senti", "config.json"));
    const publish = AtomicFile.prototype.publishStage;
    let initial = null;
    let initialBeforeImage = null;
    let final = null;
    AtomicFile.prototype.publishStage = function (...args) {
      const result = publish.apply(this, args);
      if (this.filePath === path.join(root, ".tmp", "sennel-migrate-layout.json")) {
        const saved = JSON.parse(fs.readFileSync(this.filePath));
        if (initial === null) {
          initial = saved;
          initialBeforeImage = readCurrentBeforeImage(root, saved, "config.json");
          assert.equal(fs.existsSync(path.join(root, ".senti")), true);
          assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
        }
        if (saved.receipt !== null) final = saved;
      }
      return result;
    };
    let result;
    try { result = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(); }
    finally { AtomicFile.prototype.publishStage = publish; }
    assert.equal(initial.version, 10);
    assert.equal(initial.sourceSnapshot.version, 3);
    assert.equal(initial.receipt, null);
    const entry = initial.sourceSnapshot.entries.find((entry) => entry.path === "config.json");
    assert.deepEqual(initialBeforeImage.bytes, config);
    assert.equal(Object.hasOwn(entry, "bytes"), false);
    assert.deepEqual(Object.keys(entry.generation).sort(), ["dev", "ino"]);
    assert.equal(typeof entry.generation.ino, "string");
    assert.equal(Object.hasOwn(entry, "mode"), false);
    assert.equal(Object.hasOwn(initial.sourceSnapshot, "rootMode"), false);
    assert.deepEqual(result.receipt, final.receipt);
    assert.equal(result.receipt.operation, initial.operation);
    assert.equal(result.receipt.targetFingerprint, initial.stagedSnapshotFingerprint);
    assertMigrationScratchAbsent(root);
  });

  it("migrates and strictly reads back signed native high-bit generations without changing source bytes", () => {
    const root = createTmpDir("sennel-migrate-layout-signed-generation-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const source = path.join(root, ".senti");
    const configPath = path.join(source, "config.json");
    const config = fs.readFileSync(configPath);
    const lstat = fs.lstatSync;
    const fstat = fs.fstatSync;
    const publish = AtomicFile.prototype.publishStage;
    const sourceStat = lstat(source, { bigint: true });
    const configStat = lstat(configPath, { bigint: true });
    const generations = new Map();
    const key = (stat) => `${stat.dev}:${stat.ino}`;
    const signedStat = (stat, native, bigint) => {
      const identity = key(native);
      if (!generations.has(identity)) {
        const unsigned = (1n << 63n) + 5n + BigInt(generations.size);
        generations.set(identity, { unsigned, signed: unsigned - (1n << 64n) });
      }
      const generation = generations.get(identity);
      // Simulate Node's signed BigIntStats token and the unsafe numeric observation
      // of the same native high-bit inode. Preserve every other native stat field.
      stat.ino = bigint ? generation.signed : Number(generation.unsigned);
      return stat;
    };
    let initial = null;
    let initialBeforeImage = null;
    let final = null;
    let result;
    fs.lstatSync = function (target, options) {
      const stat = lstat.call(this, target, options);
      const bigint = options?.bigint === true;
      return signedStat(stat, bigint ? stat : lstat.call(this, target, { bigint: true }), bigint);
    };
    fs.fstatSync = function (descriptor, options) {
      const stat = fstat.call(this, descriptor, options);
      const bigint = options?.bigint === true;
      return signedStat(stat, bigint ? stat : fstat.call(this, descriptor, { bigint: true }), bigint);
    };
    AtomicFile.prototype.publishStage = function (...args) {
      const receipt = publish.apply(this, args);
      if (this.filePath === path.join(root, ".tmp", "sennel-migrate-layout.json")) {
        const saved = JSON.parse(fs.readFileSync(this.filePath));
        if (initial === null) {
          initial = saved;
          initialBeforeImage = readCurrentBeforeImage(root, saved, "config.json");
        }
        if (saved.receipt !== null) final = saved;
      }
      return receipt;
    };
    try { result = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(); }
    finally {
      AtomicFile.prototype.publishStage = publish;
      fs.fstatSync = fstat;
      fs.lstatSync = lstat;
    }
    assert.equal(result.migrated, true);
    assert.equal(result.complete, true);
    assert.equal(initial.version, 10);
    assert.equal(initial.sourceSnapshot.version, 3);
    assert.equal(initial.sourceSnapshot.rootIdentity.ino, generations.get(key(sourceStat)).signed.toString());
    const entry = initial.sourceSnapshot.entries.find((item) => item.path === "config.json");
    assert.equal(entry.generation.ino, generations.get(key(configStat)).signed.toString());
    assert.ok(BigInt(entry.generation.ino) < 0n);
    assert.deepEqual(initialBeforeImage.bytes, config);
    assert.deepEqual(fs.readFileSync(path.join(root, ".sennel", "config.json")), config);
    assert.deepEqual(fs.readFileSync(path.join(root, ".sennel", "templates", "image.bin")), TEMPLATE_BINARY);
    assert.deepEqual(result.receipt, final.receipt);
    assert.equal(result.receipt.operation, initial.operation);
    assert.equal(result.receipt.sourceFingerprint, initial.sourceSnapshotFingerprint);
    assert.equal(result.receipt.targetFingerprint, initial.stagedSnapshotFingerprint);
    assert.equal(fs.existsSync(source), false);
    assertMigrationScratchAbsent(root);
  });

  for (const durable of [false, true]) it(`preserves a same-byte root metadata replacement without adopting its generation; journal durable=${durable}`, () => {
    const root = createTmpDir("sennel-migrate-layout-metadata-generation-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const metadata = path.join(root, ".gitignore");
    const original = fs.readFileSync(metadata);
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const publish = AtomicFile.prototype.publishStage;
    let foreign = null;
    AtomicFile.prototype.publishStage = function (...args) {
      const result = publish.apply(this, args);
      const boundary = durable ? this.filePath === journalPath
        : this.filePath.includes("managed-directory") && path.basename(this.filePath) === "config.json";
      if (foreign === null && boundary) {
        const replacement = path.join(root, "foreign-ignore");
        fs.writeFileSync(replacement, original);
        fs.renameSync(replacement, metadata);
        foreign = fs.lstatSync(metadata, { bigint: true }).ino;
      }
      return result;
    };
    try {
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /identity changed before reading|cannot restore root metadata changed/);
    } finally { AtomicFile.prototype.publishStage = publish; }
    assert.notEqual(foreign, null);
    assert.equal(fs.lstatSync(metadata, { bigint: true }).ino, foreign);
    assert.deepEqual(fs.readFileSync(metadata), original);
    assert.equal(fs.existsSync(path.join(root, ".senti")), true);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(journalPath), durable);
    if (durable) {
      const journal = JSON.parse(fs.readFileSync(journalPath));
      assert.equal(journal.owner.released, true);
      const evidence = LayoutMigrationEvidence.fromJSON(root, journal.metadataImages);
      const retained = journal.metadata.find(entry => entry.name === ".gitignore");
      assert.deepEqual(evidence.readBytes(retained.original), original);
      evidence.assertIntact();
      assert.equal(fs.existsSync(path.join(root, journal.stagingRelative, "managed-directory", "config.json")), true);
    } else assertMigrationScratchAbsent(root);
  });

  it("strictly rejects a reloaded raw before-image whose bytes disagree with its hash before changing any evidence", () => {
    const root = createTmpDir("sennel-migrate-layout-byte-tamper-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    failAfterJournalWrite(root, 1);
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const journal = JSON.parse(fs.readFileSync(journalPath));
    const retained = journal.beforeImages.files.find(entry => entry.sourcePath === "config.json");
    fs.writeFileSync(path.join(root, journal.beforeImages.path, retained.name), "foreign bytes");
    const before = new FixtureTreeSnapshot(root);
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /layout raw before-image bytes changed/);
    before.assertUnchanged();
  });

  it("refuses a same-byte journal replacement after exclusion acquisition before removing any staged proof", () => {
    const root = createTmpDir("sennel-migrate-layout-journal-generation-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const saved = failAfterJournalWrite(root, 1);
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const bytes = fs.readFileSync(journalPath);
    const acquire = RepositoryMaintenanceLock.prototype.acquire;
    let replacement = null;
    RepositoryMaintenanceLock.prototype.acquire = function (...args) {
      const result = acquire.apply(this, args);
      new AtomicFile(journalPath).write(bytes);
      replacement = fs.lstatSync(journalPath, { bigint: true }).ino;
      return result;
    };
    let failure;
    try {
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        (error) => { failure = error; return error instanceof Error; });
    } finally { RepositoryMaintenanceLock.prototype.acquire = acquire; }
    assert.notEqual(replacement, null);
    assert.equal(fs.lstatSync(journalPath, { bigint: true }).ino, replacement);
    assert.deepEqual(fs.readFileSync(journalPath), bytes);
    assert.equal(fs.existsSync(path.join(root, saved.stagingRelative, "managed-directory", "config.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".senti", "config.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.match(failure.message, /layout migration input changed after preflight/);
  });

  for (const metadataName of [".gitignore", ".gitattributes"]) {
    it(`retains raw non-UTF8 ${metadataName} and applies the original replacement-decoded plan`, () => {
      const root = createTmpDir("sennel-migrate-layout-metadata-encoding-");
      roots.push(root);
      seedLegacyProject(root, ".senti");
      const original = Buffer.from([0xff, 0, 0xfe, 10]);
      fs.writeFileSync(path.join(root, metadataName), original);
      const before = new FixtureTreeSnapshot(root);
      const logger = { log() {}, error() {} };
      const preview = new LayoutMigrationRevisionOne(root, { dryRun: true, logger }).run();
      assert.equal(preview.migrated, false);
      before.assertUnchanged();
      const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
      const publish = AtomicFile.prototype.publishStage;
      let first = null;
      AtomicFile.prototype.publishStage = function (...args) {
        const result = publish.apply(this, args);
        if (this.filePath === journalPath && first === null) {
          first = JSON.parse(fs.readFileSync(journalPath));
          const evidence = LayoutMigrationEvidence.fromJSON(root, first.metadataImages);
          const retained = first.metadata.find(entry => entry.name === metadataName);
          assert.deepEqual(evidence.readBytes(retained.original), original);
          evidence.assertIntact();
        }
        return result;
      };
      let result;
      try { result = new LayoutMigrationRevisionOne(root, { logger }).run(); }
      finally { AtomicFile.prototype.publishStage = publish; }
      assert.equal(result.complete, true);
      assert.equal(result.migrated, true);
      assert.equal(result.receipt.operation, first.operation);
      assert.ok(fs.readFileSync(path.join(root, metadataName), "utf8").startsWith("\ufffd\0\ufffd\n"));
      assert.equal(fs.existsSync(path.join(root, ".senti")), false);
      assert.equal(fs.existsSync(path.join(root, ".sennel", "config.json")), true);
      assertMigrationScratchAbsent(root);
    });
  }

  it("explicitly refuses the immediately preceding producer journal without supplementing its baseline proof", () => {
    const root = createTmpDir("sennel-migrate-layout-v8-refusal-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const previous = fs.readFileSync(path.resolve("tests/fixtures/layout-migration-v8/journal.json"));
    writeFile(root, ".tmp/sennel-migrate-layout.json", previous);
    const before = new FixtureTreeSnapshot(root);
    assert.equal(JSON.parse(previous).version, 8);
    assert.equal(JSON.parse(previous).owner.released, true);
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      (error) => error instanceof ProcessExecutionControlFailure && error.reason === "legacy-owner-format");
    before.assertUnchanged();
  });

  it("rejects a competing initial journal publication without touching source or metadata", () => {
    const root = createTmpDir("sennel-migrate-layout-journal-race-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const configPath = path.join(root, ".senti", "config.json");
    const beforeConfig = fs.readFileSync(configPath);
    const beforeIgnore = fs.readFileSync(path.join(root, ".gitignore"));
    const beforeAttributes = fs.readFileSync(path.join(root, ".gitattributes"));
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const originalLink = fs.linkSync;
    let competing = false;
    fs.linkSync = (from, target, ...rest) => {
      if (!competing && path.resolve(String(target)) === journalPath) {
        competing = true;
        fs.writeFileSync(journalPath, "{\"competing\":true}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      }
      return originalLink(from, target, ...rest);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /journal was created by another migration/,
      );
    } finally {
      fs.linkSync = originalLink;
    }

    assert.equal(competing, true);
    assert.deepEqual(fs.readFileSync(configPath), beforeConfig);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitignore")), beforeIgnore);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitattributes")), beforeAttributes);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-layout.json")), true);
    assert.equal(fs.readFileSync(journalPath, "utf8"), "{\"competing\":true}\n");
    assert.deepEqual(fs.readdirSync(path.join(root, ".tmp")).sort(), ["runtime", "sennel-migrate-layout.json"]);
    assert.deepEqual(fs.readdirSync(path.join(root, ".tmp", "runtime")), ["repository-control"]);
    assert.deepEqual(fs.readdirSync(path.join(root, ".tmp", "runtime", "repository-control")), []);
  });

  it("does not delete a staging path created by another process during directory allocation", () => {
    const root = createTmpDir("sennel-migrate-layout-staging-mkdir-race-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const beforeConfig = fs.readFileSync(path.join(root, ".senti", "config.json"));
    const originalMkdtemp = fs.mkdtempSync;
    let competingPath = null;
    fs.mkdtempSync = (target, options) => {
      if (!competingPath && path.basename(String(target)).startsWith("sennel-migrate-layout-")) {
        competingPath = originalMkdtemp(target, options);
        fs.writeFileSync(path.join(competingPath, "owned-by-another-process.txt"), "keep\n");
        const error = new Error("injected staging mkdir collision");
        error.code = "EEXIST";
        throw error;
      }
      return originalMkdtemp(target, options);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /injected staging mkdir collision/,
      );
    } finally {
      fs.mkdtempSync = originalMkdtemp;
    }

    assert.notEqual(competingPath, null);
    assert.equal(fs.readFileSync(path.join(competingPath, "owned-by-another-process.txt"), "utf8"), "keep\n");
    assert.deepEqual(fs.readFileSync(path.join(root, ".senti", "config.json")), beforeConfig);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-layout.json")), false);
  });

  it("does not overwrite a journal replaced by another process during phase advancement", () => {
    const root = createTmpDir("sennel-migrate-layout-journal-phase-race-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const beforeConfig = fs.readFileSync(path.join(root, ".sdd-forge", "config.json"));
    const beforeIgnore = fs.readFileSync(path.join(root, ".gitignore"));
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const competingPayload = "{\"competing\":\"phase\"}\n";
    const originalRename = fs.renameSync;
    let replaced = false;
    fs.renameSync = (from, to, ...rest) => {
      const result = originalRename(from, to, ...rest);
      if (!replaced && path.resolve(String(to)) === path.join(root, ".sennel")) {
        replaced = true;
        const replacement = path.join(root, ".tmp", "competing-journal.json");
        fs.writeFileSync(replacement, competingPayload);
        originalRename(replacement, journalPath);
      }
      return result;
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /migration journal changed while the migration was active/,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(replaced, true);
    assert.equal(fs.existsSync(path.join(root, ".sdd-forge")), false);
    assert.equal(fs.readFileSync(journalPath, "utf8"), competingPayload);
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
  });

  it("refuses to recover a journal owned by a live migration process", () => {
    const root = createTmpDir("sennel-migrate-layout-live-owner-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const secondResultPath = path.join(root, "second-migration.json");
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { spawnSync } from "node:child_process";
      import { LayoutMigrationRevisionOne } from ${JSON.stringify(MIGRATION_MODULE)};
      const root = ${JSON.stringify(root)};
      const secondResultPath = ${JSON.stringify(secondResultPath)};
      const originalRename = fs.renameSync;
      let invoked = false;
      fs.renameSync = (from, to, ...rest) => {
        if (!invoked && path.resolve(String(to)) === path.join(root, ".sennel")) {
          invoked = true;
          const second = spawnSync(process.execPath, [${JSON.stringify(CLI)}, "migrate", "layout", "--to", "1"], {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
          });
          fs.writeFileSync(secondResultPath, JSON.stringify({
            status: second.status,
            stdout: second.stdout,
            stderr: second.stderr,
          }));
        }
        return originalRename(from, to, ...rest);
      };
      new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run();
    `;

    const first = spawnSync(process.execPath, ["--import", pathToFileURL(CLI).href, "--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
    });
    const second = JSON.parse(fs.readFileSync(secondResultPath, "utf8"));

    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 1, second.stderr || second.stdout);
    assert.match(second.stderr, /Migration journal has no explicit writer release/);
    assert.equal(fs.existsSync(path.join(root, ".sdd-forge")), false);
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    assertMigrationScratchAbsent(root);
  });

  it("refuses an exited journal writer without an explicit release and preserves the source", async () => {
    const root = createTmpDir("sennel-migrate-layout-abandoned-owner-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const crashed = await crashAfterJournalWrite(root, 1);
    assert.equal(crashed.interrupted, true, crashed.stderr || crashed.stdout);
    const journal = JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), "utf8"));
    assert.equal(journal.owner.released, false);
    assert.equal(new LockOwnerSession(journal.owner).ownerToken, journal.owner.ownerToken);
    const before = new FixtureTreeSnapshot(root);
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      (error) => error instanceof ProcessExecutionControlFailure && error.reason === "owner-unknown");
    before.assertUnchanged();
    assert.equal(fs.existsSync(path.join(root, ".sdd-forge")), true);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
  });

  it("publishes a token and session owner with no OS process identity dependency", () => {
    const root = createTmpDir("sennel-migrate-layout-portable-owner-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const publish = AtomicFile.prototype.publishStage;
    let owner = null;
    AtomicFile.prototype.publishStage = function (...args) {
      const result = publish.apply(this, args);
      if (this.filePath === path.join(root, ".tmp", "sennel-migrate-layout.json")) {
        owner = JSON.parse(fs.readFileSync(this.filePath, "utf8")).owner;
      }
      return result;
    };
    let outcome;
    try { outcome = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(); }
    finally { AtomicFile.prototype.publishStage = publish; }
    assert.deepEqual(Object.keys(owner).sort(), ["ownerSession", "ownerToken", "released"]);
    assert.equal(new LockOwnerSession(owner).ownerToken, owner.ownerToken);
    assert.equal(outcome.migrated, true);
    assert.equal(fs.existsSync(path.join(root, ".sdd-forge")), false);
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    assertMigrationScratchAbsent(root);
  });

  it("discards its own failed journal reservation and staging before source changes", () => {
    const root = createTmpDir("sennel-migrate-layout-journal-write-failure-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const configPath = path.join(root, ".senti", "config.json");
    const beforeConfig = fs.readFileSync(configPath);
    const beforeIgnore = fs.readFileSync(path.join(root, ".gitignore"));
    const beforeAttributes = fs.readFileSync(path.join(root, ".gitattributes"));
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeSync;
    let journalDescriptor = null;
    fs.openSync = (target, flags, ...rest) => {
      const descriptor = originalOpen(target, flags, ...rest);
      if (path.dirname(path.resolve(String(target))) === path.dirname(journalPath) && path.basename(String(target)).startsWith(".sennel-migrate-layout.json.")) {
        journalDescriptor = descriptor;
      }
      return descriptor;
    };
    fs.writeSync = (target, content, ...rest) => {
      if (target === journalDescriptor) throw new Error("injected journal authoritative write failure");
      return originalWrite(target, content, ...rest);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /injected journal authoritative write failure/,
      );
    } finally {
      fs.openSync = originalOpen;
      fs.writeSync = originalWrite;
    }

    assert.notEqual(journalDescriptor, null);
    assert.deepEqual(fs.readFileSync(configPath), beforeConfig);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitignore")), beforeIgnore);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitattributes")), beforeAttributes);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assertMigrationScratchAbsent(root);
  });

  it("does not overwrite a root metadata file changed during AtomicFile commit", () => {
    const root = createTmpDir("sennel-migrate-layout-metadata-cas-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const configPath = path.join(root, ".sdd-forge", "config.json");
    const beforeConfig = fs.readFileSync(configPath);
    const beforeAttributes = fs.readFileSync(path.join(root, ".gitattributes"));
    const userIgnore = "user change during migration\n";
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const descriptorPaths = new Map();
    let injected = false;
    fs.openSync = (target, flags, ...rest) => {
      const descriptor = originalOpen(target, flags, ...rest);
      const resolved = path.resolve(String(target));
      if (path.dirname(resolved) === root && /^\.\.gitignore\..+\.tmp$/.test(path.basename(resolved))) {
        descriptorPaths.set(descriptor, resolved);
      }
      return descriptor;
    };
    fs.fsyncSync = (descriptor, ...rest) => {
      if (!injected && descriptorPaths.has(descriptor)) {
        injected = true;
        fs.writeFileSync(path.join(root, ".gitignore"), userIgnore);
      }
      return originalFsync(descriptor, ...rest);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /migration and rollback both failed/,
      );
    } finally {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalFsync;
    }

    assert.equal(injected, true);
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), userIgnore);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitattributes")), beforeAttributes);
    const journal = JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), "utf8"));
    assert.deepEqual(fs.readFileSync(path.join(root, journal.stagingRelative, "legacy-source-backup", "config.json")), beforeConfig);
    assert.equal(fs.existsSync(path.join(root, ".sdd-forge")), false);
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.ok(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-layout.json")));
  });

  it("rejects staged root metadata changed before commit and restores the legacy source", () => {
    const root = createTmpDir("sennel-migrate-layout-staged-metadata-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const beforeConfig = fs.readFileSync(path.join(root, ".senti", "config.json"));
    const beforeIgnore = fs.readFileSync(path.join(root, ".gitignore"));
    const originalLink = fs.linkSync;
    let injected = false;
    fs.linkSync = (from, target, ...rest) => {
      if (!injected
        && path.resolve(String(target)) === path.join(root, ".tmp", "sennel-migrate-layout.json")) {
        injected = true;
        const stagingParent = path.join(root, ".tmp", "runtime", "migrate-layout");
        const stagingName = fs.readdirSync(stagingParent)
          .find((name) => name.startsWith("sennel-migrate-layout-"));
        fs.writeFileSync(path.join(stagingParent, stagingName, ".gitignore"), "tampered\n");
      }
      return originalLink(from, target, ...rest);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /staged root metadata changed before migration commit: \.gitignore/,
      );
    } finally {
      fs.linkSync = originalLink;
    }

    assert.equal(injected, true);
    assert.deepEqual(fs.readFileSync(path.join(root, ".senti", "config.json")), beforeConfig);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitignore")), beforeIgnore);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    const journal = JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json")));
    assert.equal(journal.owner.released, true);
    assert.equal(fs.readFileSync(path.join(root, journal.stagingRelative, ".gitignore"), "utf8"), "tampered\n");
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /staged root metadata changed before migration commit/);
  });

  it("refuses invalid configuration in dry-run and apply before creating migration effects", () => {
    const root = createTmpDir("sennel-migrate-layout-invalid-config-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeJson(root, ".senti/config.json", { ...validConfig(), chapters: ["old-shape"], plugin: { repos: [] } });
    const before = new FixtureTreeSnapshot(root);
    for (const args of [["--dry-run"], []]) {
      const result = runLayoutMigration(root, args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Config validation failed/);
      before.assertUnchanged();
    }
  });

  for (const fileName of ["config.json", "config.local.json"]) {
    it(`refuses a legacy shell command in ${fileName} through the shared typed config boundary`, () => {
      const root = createTmpDir("sennel-migrate-layout-shell-config-");
      roots.push(root);
      seedLegacyProject(root, ".senti");
      writeJson(root, `.senti/${fileName}`, { ...(fileName === "config.json" ? validConfig() : {}), test: { command: "npm test && echo unsafe" } });
      const before = new FixtureTreeSnapshot(root);
      for (const args of [["--dry-run"], []]) {
        const result = runLayoutMigration(root, args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /test.command/);
        assert.match(result.stderr, /structured|shell|invocation|executable/i);
        before.assertUnchanged();
      }
    });
  }

  it("does not inspect or mutate agent-host hooks during a layout-only dry-run", () => {
    const root = createTmpDir("sennel-migrate-layout-dry-hook-cleanup-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeJson(root, ".codex/hooks.json", {
      hooks: {
        Stop: [{
          hooks: [{
            type: "command",
            command: "node .codex/hooks/sennel-flow-final-response-guard.mjs",
          }],
        }],
      },
    });
    writeFile(root, ".codex/hooks/sennel-flow-final-response-guard.mjs", "legacy\n");
    const beforeConfig = fs.readFileSync(path.join(root, ".senti", "config.json"));
    const beforeHooks = fs.readFileSync(path.join(root, ".codex", "hooks.json"));
    const tree = new FixtureTreeSnapshot(root);

    const result = runLayoutMigration(root, ["--dry-run"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /\.codex\/hooks|replace canonical skill|copy bundled preset/);
    assert.deepEqual(fs.readFileSync(path.join(root, ".senti", "config.json")), beforeConfig);
    assert.deepEqual(fs.readFileSync(path.join(root, ".codex", "hooks.json")), beforeHooks);
    assert.ok(fs.existsSync(path.join(root, ".codex", "hooks", "sennel-flow-final-response-guard.mjs")));
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    tree.assertUnchanged();
  });

  it("does not resolve preset chains during a layout-only dry-run", () => {
    const root = createTmpDir("sennel-migrate-layout-dry-preset-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeJson(root, ".senti/config.json", { ...validConfig(), type: "missing-preset" });
    const before = fs.readFileSync(path.join(root, ".senti", "config.json"));

    const result = runLayoutMigration(root, ["--dry-run"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr, /normal upgrade validation|missing-preset/);
    assert.deepEqual(fs.readFileSync(path.join(root, ".senti", "config.json")), before);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  });

  it("refuses invalid plugin configuration before transferring the managed layout", () => {
    const root = createTmpDir("sennel-migrate-layout-invalid-plugin-boundary-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeJson(root, ".senti/config.json", {
      ...validConfig(),
      plugin: {
        sources: [{ id: "bad", type: "local", path: "." }],
        packages: [{
          id: "../../outside",
          source: "bad",
          commit: "0000000000000000000000000000000000000000",
        }],
      },
    });
    writeJson(root, "outside/plugin.json", {
      name: "outside",
      files: ["plugin.json", "skills/"],
      contributions: {
        skills: [{ name: "outside.skill", path: "skills/outside.skill/SKILL.md" }],
      },
    });
    writeFile(root, "outside/skills/outside.skill/SKILL.md", "outside\n");

    const before = new FixtureTreeSnapshot(root);
    const result = runLayoutMigration(root, ["--dry-run"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /plugin\.packages\[0\]/);
    assert.doesNotMatch(result.stdout, /outside\.skill|deploy enabled plugin skill|replace canonical skill/);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    before.assertUnchanged();
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
  });

  it("refuses an invalid local configuration overlay before transferring the layout", () => {
    const root = createTmpDir("sennel-migrate-layout-overlay-warning-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeJson(root, ".senti/config.local.json", { chapters: ["old-shape"] });

    const before = new FixtureTreeSnapshot(root);
    const result = runLayoutMigration(root, ["--dry-run"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Config validation failed/);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    before.assertUnchanged();
  });

  it("refuses an invalid base configuration before transferring the layout", () => {
    const root = createTmpDir("sennel-migrate-layout-overlay-base-warning-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    writeJson(root, ".senti/config.json", {
      ...validConfig(),
      docs: { languages: [], defaultLanguage: "en" },
    });
    writeJson(root, ".senti/config.local.json", { docs: { mode: "generate" } });

    const before = new FixtureTreeSnapshot(root);
    const result = runLayoutMigration(root, ["--dry-run"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Config validation failed/);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
    before.assertUnchanged();
  });

  it("copies plugin data without resolving schemas or deploying host skills", () => {
    const root = createTmpDir("sennel-migrate-layout-plugin-dry-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    addPluginConfigAndSkill(root, ".senti");

    const result = runLayoutMigration(root, ["--dry-run"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /stage file plugins\/fixture\/skills\/external\.skill\/SKILL\.md/);
    assert.doesNotMatch(result.stderr, /config warning/);
    assertMigrationScratchAbsent(root);

    const applied = runLayoutMigration(root, []);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.equal(
      fs.readFileSync(path.join(root, ".sennel", "plugins", "fixture", "skills", "external.skill", "SKILL.md"), "utf8"),
      "external plugin\n",
    );
    for (const base of [".agents", ".claude"]) {
      assert.equal(fs.existsSync(path.join(root, base, "skills", "external.skill", "SKILL.md")), false);
    }
  });

  it("copies malformed plugin contents raw without interpreting them during directory migration", () => {
    const root = createTmpDir("sennel-migrate-layout-raw-plugin-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const malformedManifest = addMalformedPluginConfig(root, ".senti");

    const outcome = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run();

    assert.equal(outcome.migrated, true);
    assert.deepEqual(
      fs.readFileSync(path.join(root, ".sennel", "plugins", "fixture", "plugin.json")),
      malformedManifest,
    );
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    assertMigrationScratchAbsent(root);
  });

  it("keeps malformed plugin handling opaque during layout dry-run", () => {
    const root = createTmpDir("sennel-migrate-layout-raw-plugin-dry-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const malformedManifest = addMalformedPluginConfig(root, ".senti");

    const result = runLayoutMigration(root, ["--dry-run"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /DRY-RUN: \.senti -> \.sennel/);
    assert.match(result.stdout, /stage file plugins\/fixture\/plugin\.json/);
    assert.doesNotMatch(result.stdout, /normal upgrade plan|replace canonical skill/);
    assert.doesNotMatch(result.stdout, /deploy enabled plugin skill/);
    assert.deepEqual(
      fs.readFileSync(path.join(root, ".senti", "plugins", "fixture", "plugin.json")),
      malformedManifest,
    );
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp")), false);
  });

  it("treats a canonical managed directory as a layout no-op without parsing its config", () => {
    const root = createTmpDir("sennel-upgrade-normal-no-config-migrate-");
    roots.push(root);
    writeJson(root, ".sennel/config.json", {
      ...validConfig(),
      chapters: ["old-shape"],
      plugin: { repos: [] },
    });
    const configPath = path.join(root, ".sennel", "config.json");
    const before = fs.readFileSync(configPath);

    const result = runLayoutMigration(root, []);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, "migrate layout reached revision 1\n");
    assert.match(result.stderr, /\.sennel already exists; layout revision 1 is already applied/);
    assert.deepEqual(fs.readFileSync(configPath), before);
    assert.equal(fs.existsSync(path.join(root, ".sennel", "plugin-sources", "local-presets")), false);
  });

  it("preserves malformed config and unrelated project bytes until the original config is repaired", () => {
    const root = createTmpDir("sennel-migrate-layout-malformed-config-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const malformed = "{ not json\n";
    writeFile(root, ".senti/config.json", malformed);
    writeFile(root, "package.json", "{\"name\":\"user-package\",\"scripts\":{\"x\":\"SENTI_WORK_ROOT=x\"}}\n");
    writeFile(root, ".git/config", "[remote \"origin\"]\n\turl = git@example.test:user/project.git\n");
    writeFile(root, "specs/001/flow.json", "historical senti data\n");
    writeFile(root, ".env", "SENTI_WORK_ROOT=project-owned\n");

    const before = new FixtureTreeSnapshot(root);
    const refused = runLayoutMigration(root, []);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /migrate failed:/);
    before.assertUnchanged();
    assert.equal(fs.readFileSync(path.join(root, ".senti", "config.json"), "utf8"), malformed);
    writeJson(root, ".senti/config.json", validConfig());
    const migrated = runLayoutMigration(root, []);

    assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".sennel", "config.json"))), validConfig());
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), "{\"name\":\"user-package\",\"scripts\":{\"x\":\"SENTI_WORK_ROOT=x\"}}\n");
    assert.equal(
      fs.readFileSync(path.join(root, ".git", "config"), "utf8"),
      "[remote \"origin\"]\n\turl = git@example.test:user/project.git\n",
    );
    assert.equal(fs.readFileSync(path.join(root, "specs/001/flow.json"), "utf8"), "historical senti data\n");
    assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "SENTI_WORK_ROOT=project-owned\n");

    const rerunMigrate = runLayoutMigration(root, []);
    assert.equal(rerunMigrate.status, 0, rerunMigrate.stderr || rerunMigrate.stdout);
    writeJson(root, ".sennel/config.json", validConfig());
    const noOpAfterRepair = runLayoutMigration(root, []);
    assert.equal(noOpAfterRepair.status, 0, noOpAfterRepair.stderr || noOpAfterRepair.stdout);
  });

  it("creates missing managed root metadata and restores its absence if final rename fails", () => {
    const root = createTmpDir("sennel-migrate-layout-metadata-rollback-");
    roots.push(root);
    writeJson(root, ".sdd-forge/config.json", validConfig());
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to, ...rest) => {
      if (path.resolve(to) === path.join(root, ".sennel")) throw new Error("injected final rename failure");
      return originalRename(from, to, ...rest);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /injected final rename failure/,
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.ok(fs.existsSync(path.join(root, ".sdd-forge")));
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".gitignore")), false);
    assert.equal(fs.existsSync(path.join(root, ".gitattributes")), false);
    assertMigrationScratchAbsent(root);

    const migrated = runLayoutMigration(root, []);
    assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
    assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^\.sennel\/\*/m);
    assert.match(fs.readFileSync(path.join(root, ".gitattributes"), "utf8"), /^\.sennel\/output\/analysis\.json merge=ours/m);
  });

  it("rolls back a pre-final commit failure without leaving staging residue", () => {
    const root = createTmpDir("sennel-migrate-layout-rollback-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to, ...rest) => {
      if (path.resolve(to) === path.join(root, ".sennel")) throw new Error("injected staging placement failure");
      return originalRename(from, to, ...rest);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /injected staging placement failure/,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.ok(fs.existsSync(path.join(root, ".sdd-forge")));
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assertMigrationScratchAbsent(root);
  });

  it("restores both root metadata files when metadata commit fails", () => {
    const root = createTmpDir("sennel-migrate-layout-metadata-commit-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const originalIgnore = fs.readFileSync(path.join(root, ".gitignore"));
    const originalAttributes = fs.readFileSync(path.join(root, ".gitattributes"));
    const originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = (from, to, ...rest) => {
      if (!injected && path.resolve(to) === path.join(root, ".gitattributes")) {
        injected = true;
        throw new Error("injected metadata update failure");
      }
      return originalRename(from, to, ...rest);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /injected metadata update failure/,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.ok(fs.existsSync(path.join(root, ".sdd-forge")));
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitignore")), originalIgnore);
    assert.deepEqual(fs.readFileSync(path.join(root, ".gitattributes")), originalAttributes);
    assertMigrationScratchAbsent(root);
  });

  it("recovers final-rename cleanup without rolling back the canonical directory", () => {
    const root = createTmpDir("sennel-migrate-layout-recover-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const originalRemove = fs.rmSync;
    fs.rmSync = (target, ...rest) => {
      if (path.basename(path.resolve(target)) === "legacy-source-backup") throw new Error("injected legacy cleanup failure");
      return originalRemove(target, ...rest);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /injected legacy cleanup failure/,
      );
    } finally {
      fs.rmSync = originalRemove;
    }
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    assert.equal(fs.existsSync(path.join(root, ".sdd-forge")), false);
    assert.ok(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-layout.json")));

    new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run();

    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    assert.equal(fs.existsSync(path.join(root, ".sdd-forge")), false);
    assertMigrationScratchAbsent(root);
  });

  it("finishes cleanup after a released writer encounters partial legacy-backup deletion", async () => {
    const root = createTmpDir("sennel-migrate-layout-partial-cleanup-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");

    failDuringLegacyBackupRemoval(root);
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    const journalPath = path.join(root, ".tmp", "sennel-migrate-layout.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    assert.equal(journal.phase, "cleanup-source-verified");
    const backup = path.join(root, journal.stagingRelative, "legacy-source-backup");
    assert.ok(fs.existsSync(backup));
    assert.equal(fs.existsSync(path.join(backup, "config.local.json")), false);

    // A dry-run cannot remove the journal or prove that the resumed normal
    // preflight will succeed, so it must fail closed without touching the
    // partial-cleanup state rather than report a reached target.
    const beforeDryRun = new FixtureTreeSnapshot(root);
    const dryRun = runLayoutMigration(root, ["--dry-run"]);
    assert.equal(dryRun.status, 1, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, /valid migration journal would be recovered/);
    assert.equal(dryRun.stderr, "");
    beforeDryRun.assertUnchanged();

    const recovered = runLayoutMigration(root, []);

    // The canonical directory is already authoritative.  Completing its
    // private cleanup must be a successful public migration, not an exit-1
    // recovery-only result.
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(recovered.stdout, "migrate layout reached revision 1\n");
    assert.match(recovered.stderr, /\.sennel already exists; layout revision 1 is already applied/);
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    assert.equal(fs.existsSync(path.join(root, ".sdd-forge")), false);
    assert.ok(fs.existsSync(path.join(root, ".agents", "skills", "senti.flow", "SKILL.md")));
    assertMigrationScratchAbsent(root);
  });

  it("replays rollback recovery through normal preflight and reaches the target in one public invocation", async () => {
    const root = createTmpDir("sennel-migrate-layout-public-rollback-replay-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    failAfterJournalWrite(root, 1);
    assert.ok(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-layout.json")));

    const resumed = runLayoutMigration(root, []);

    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.equal(resumed.stdout, "migrate layout reached revision 1\n");
    assert.equal(resumed.stderr, "");
    assert.ok(fs.existsSync(path.join(root, ".sennel", "config.json")));
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    assertMigrationScratchAbsent(root);
  });

  // Retired v6/PID recovery cannot acquire a new token release authority.
  // Retain each historical effect boundary as a byte-preserving refusal;
  // current-schema rollback and partial cleanup are exercised separately.
  for (const options of [
    { sourceName: ".sdd-forge", phase: "staged" },
    { sourceName: ".senti", phase: "legacy-backed-up" },
    { sourceName: ".senti", phase: "placed-senti" },
    { sourceName: ".senti", phase: "metadata-updated" },
    { sourceName: ".sdd-forge", phase: "final-renamed", canonical: true },
    { sourceName: ".sdd-forge", phase: "cleanup-source-verified", canonical: true, partialCleanup: true },
  ]) {
    it(`preserves old v6 ${options.sourceName} ${options.phase} without inventing owner authority`, async () => {
      const root = createTmpDir("sennel-old-v6-owner-refusal-");
      roots.push(root);
      seedLegacyProject(root, options.sourceName);
      await createOldV6Journal(root, options);
      const before = new FixtureTreeSnapshot(root);
      for (const dryRun of [false, true]) {
        assert.throws(() => new LayoutMigrationRevisionOne(root, { dryRun, logger: { log() {}, error() {} } }).run(),
          (error) => error instanceof ProcessExecutionControlFailure && error.reason === "legacy-owner-format");
        before.assertUnchanged();
      }
    });
  }

  for (const contents of ["{broken\n", "{\"version\":99}\n"]) {
    it("leaves malformed or unsupported old v6 journals byte-for-byte untouched", () => {
      const root = createTmpDir("sennel-old-v6-invalid-");
      roots.push(root);
      seedLegacyProject(root, ".sdd-forge");
      const journalPath = path.join(root, ".tmp", "senrail-upgrade-migrate.json");
      writeFile(root, ".tmp/senrail-upgrade-migrate.json", contents);
      assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run());
      assert.equal(fs.readFileSync(journalPath, "utf8"), contents);
      assert.ok(fs.existsSync(path.join(root, ".sdd-forge")));
    });
  }

  it("preserves an external write made after legacy-backup cleanup was authorized", () => {
    const root = createTmpDir("sennel-migrate-layout-cleanup-authorized-writer-");
    roots.push(root);
    seedLegacyProject(root, ".sdd-forge");
    const originalRemove = fs.rmSync;
    let backup = null;
    fs.rmSync = (target, ...rest) => {
      if (!backup && path.basename(path.resolve(String(target))) === "legacy-source-backup") {
        backup = String(target);
        fs.writeFileSync(path.join(backup, "config.json"), "late external write\n");
        throw new Error("injected cleanup interruption after external write");
      }
      return originalRemove(target, ...rest);
    };
    try {
      assert.throws(
        () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
        /injected cleanup interruption after external write/,
      );
    } finally {
      fs.rmSync = originalRemove;
    }

    assert.notEqual(backup, null);
    assert.throws(
      () => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /legacy managed directory changed during cleanup: config\.json/,
    );
    assert.equal(fs.readFileSync(path.join(backup, "config.json"), "utf8"), "late external write\n");
    assert.ok(fs.existsSync(path.join(root, ".sennel")));
    assert.ok(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-layout.json")));
  });

  for (const timing of ["before", "after", "payload"]) {
    it(`resumes ${timing} terminal cleanup publication without rewriting the receipt-confirmed canonical tree`, () => {
      const root = createTmpDir("sennel-layout-terminal-cleanup-");
      roots.push(root);
      seedLegacyProject(root, ".senti");
      const journal = failAtCleanupCutoff(root, { timing });
      const canonical = path.join(root, ".sennel");
      const tree = new FixtureTreeSnapshot(canonical);
      const identity = fs.lstatSync(canonical, { bigint: true });
      const metadata = [".gitignore", ".gitattributes"].map(name => fs.readFileSync(path.join(root, name)));
      const evidence = path.join(root, journal.beforeImages.path);
      assert.equal(fs.existsSync(path.join(root, journal.stagingRelative)), false);
      assert.notEqual(journal.receipt, null);
      assert.equal(fs.readdirSync(evidence).length, journal.beforeImages.files.length - (timing === "payload" ? 1 : 0));
      const result = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run();
      assert.equal(result.complete, true);
      assert.equal(result.recovered, true);
      assert.deepEqual(result.receipt, journal.receipt);
      tree.assertUnchanged();
      const after = fs.lstatSync(canonical, { bigint: true });
      assert.equal(after.dev, identity.dev);
      assert.equal(after.ino, identity.ino);
      for (const [index, name] of [".gitignore", ".gitattributes"].entries()) {
        assert.deepEqual(fs.readFileSync(path.join(root, name)), metadata[index]);
      }
      assert.equal(fs.existsSync(evidence), false);
      assertMigrationScratchAbsent(root);
    });
  }

  it("resumes a real released rollback cutoff after partial raw-evidence cleanup and migrates the restored source", () => {
    const root = createTmpDir("sennel-layout-terminal-rollback-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const original = new FixtureTreeSnapshot(path.join(root, ".senti"));
    const journal = failAtCleanupCutoff(root, { rollback: true });
    assert.equal(journal.receipt, null);
    original.assertUnchanged();
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.readdirSync(path.join(root, journal.beforeImages.path)).length, journal.beforeImages.files.length - 1);
    const result = new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run();
    assert.equal(result.complete, true);
    assert.equal(result.recovered, true);
    assert.equal(result.migrated, true);
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    assert.equal(fs.readFileSync(path.join(root, ".sennel", "output", "review.md"), "utf8"), "historical senti log remains raw\n");
    assertMigrationScratchAbsent(root);
  });

  for (const rollback of [false, true]) {
    for (const changed of ["managed", "metadata", "competing-root"]) {
      it(`terminal readback preserves all evidence after ${rollback ? "rollback" : "publication"} with changed ${changed}`, () => {
        const root = createTmpDir("sennel-layout-terminal-readback-");
        roots.push(root);
        seedLegacyProject(root, ".senti");
        const journal = failAtCleanupCutoff(root, { rollback });
        if (changed === "managed") {
          fs.appendFileSync(path.join(root, rollback ? ".senti" : ".sennel", "config.json"), " ");
        } else if (changed === "metadata") {
          fs.appendFileSync(path.join(root, ".gitignore"), "foreign-rule\n");
        } else {
          const foreignRoot = path.join(root, rollback ? ".sennel" : ".senti");
          fs.mkdirSync(foreignRoot);
          fs.writeFileSync(path.join(foreignRoot, "foreign.txt"), "foreign bytes\n");
        }
        const before = new FixtureTreeSnapshot(root);
        assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
          /changed|reappeared|canonical directory/);
        before.assertUnchanged();
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"))).receipt,
          journal.receipt);
      });
    }
  }

  it("preserves a foreign raw-evidence entry and the published receipt when terminal cleanup resumes", () => {
    const root = createTmpDir("sennel-layout-terminal-foreign-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const journal = failAtCleanupCutoff(root, { foreign: true });
    const before = new FixtureTreeSnapshot(root);
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /foreign or missing evidence/);
    before.assertUnchanged();
    assert.equal(fs.readFileSync(path.join(root, journal.beforeImages.path, "foreign.txt"), "utf8"), "foreign cleanup bytes\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"))).receipt, journal.receipt);
  });

  it("refuses an incoming rollback cutoff with unfinished staging without deleting its evidence", () => {
    const root = createTmpDir("sennel-layout-forged-terminal-cutoff-");
    roots.push(root);
    seedLegacyProject(root, ".senti");
    const journal = failAfterJournalWrite(root, 1);
    // Malformed boundary input claims completion while its genuine staged tree
    // is still present. No successful receipt or owner release is fabricated.
    journal.phase = "rollback-complete";
    fs.writeFileSync(path.join(root, ".tmp", "sennel-migrate-layout.json"), JSON.stringify(journal));
    const before = new FixtureTreeSnapshot(root);
    assert.throws(() => new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run(),
      /migration cleanup cutoff requires completed staging cleanup/);
    before.assertUnchanged();
  });

  for (const [legacyDirectory, writes] of [
    [".sdd-forge", [1, 2, 3, 4]],
    [".senti", [1, 2, 3, 4]],
  ]) {
    for (const journalWrite of writes) {
      const phase = journalWrite === writes.at(-1) ? "final-renamed" : `pre-final-${journalWrite}`;
      it(`recovers ${legacyDirectory} journal phase ${phase}`, async () => {
        const root = createTmpDir("sennel-migrate-layout-phase-");
        roots.push(root);
        seedLegacyProject(root, legacyDirectory);

        failAfterJournalWrite(root, journalWrite);
        assert.ok(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-layout.json")));
        new LayoutMigrationRevisionOne(root, { logger: { log() {}, error() {} } }).run();

        // Pre-final journal phases roll back to the legacy source, then the
        // same invocation re-enters normal preflight and commits it.  This
        // confirms recovery is resumptive rather than leaving a successful
        // caller stranded at the retired layout.
        assert.ok(fs.existsSync(path.join(root, ".sennel")));
        assert.equal(fs.existsSync(path.join(root, legacyDirectory)), false);
        assertMigrationScratchAbsent(root);
      });
    }
  }
});
