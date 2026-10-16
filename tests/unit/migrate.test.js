import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMigrateArgs } from "../../src/migrate.js";
import { coreCommandRegistry } from "../../src/lib/command-registry.js";
import { MigrationSpecRoot, MigrationSpecSelection } from "../../src/lib/migration-spec-root.js";
import {
  MigrationBlocker,
  MigrationComponentExecutor,
  MigrationInput,
  MigrationMapping,
  MigrationPlan,
  MigrationRegistry,
  MigrationReport,
  MigrationRevision,
} from "../../src/lib/migration.js";

describe("migrate CLI grammar", () => {
  it("accepts only a revisioned layout or specs route", () => {
    assert.deepEqual(parseMigrateArgs(["layout", "--to", "1"]), {
      component: "layout", to: 1, specId: null, dryRun: false, help: false,
    });
    assert.deepEqual(parseMigrateArgs(["specs", "--dry-run", "--to", "1"]), {
      component: "specs", to: 1, specId: null, dryRun: true, help: false,
    });
  });

  it("does not accept compatibility aliases or an implicit target revision", () => {
    assert.throws(() => parseMigrateArgs(["upgrade", "--to", "1"]), /Usage: sennel migrate/);
    assert.throws(() => parseMigrateArgs(["layout"]), /Missing required option: --to/);
    assert.throws(() => parseMigrateArgs(["layout", "--to", "01"]), /positive revision number/);
    assert.throws(() => parseMigrateArgs(["layout", "--migrate", "--to", "1"]), /Unknown option: --migrate/);
  });

  it("retains one literal spec selector across every supported revision", () => {
    for (const revision of [1, 2, 3, 4]) {
      assert.deepEqual(parseMigrateArgs(["specs", "--spec", "515-active", "--to", String(revision), "--dry-run"]), {
        component: "specs", to: revision, specId: "515-active", dryRun: true, help: false,
      });
    }
  });

  it("rejects missing, duplicate, unsafe and non-spec selectors", () => {
    for (const value of ["", "../515-active", "/515-active", "515/active", "515\\active", "515..active", "515-active.lock", "515-active.", " 515-active", "515-active "]) {
      assert.throws(() => parseMigrateArgs(["specs", "--to", "2", "--spec", value]), /literal identifier/);
    }
    for (const args of [[], ["--dry-run"], ["--to", "2"]]) {
      assert.throws(() => parseMigrateArgs(["specs", "--spec", ...args]), /Missing required value: --spec/);
    }
    assert.throws(() => parseMigrateArgs(["specs", "--to", "2", "--spec", "515-active", "--spec", "516-other"]), /only be supplied once/);
    assert.throws(() => parseMigrateArgs(["layout", "--to", "1", "--spec", "515-active"]), /only available for specs/);
  });

  it("publishes the selector and configured-root default in shared help metadata", () => {
    const help = coreCommandRegistry.find(["migrate"]).helpConfig;
    assert.match(help.usage, /--to <revision>/);
    assert.match(help.usage, /--spec <specId>/);
    assert.ok(help.options.includes("--spec <specId> (specs only; omit for all specs)"));
  });
});

describe("migration selection identity", () => {
  it("uses the same literal identifier contract and distinct recovery identities per revision and configured root", () => {
    const selected = MigrationSpecSelection.from("515-active");
    assert.equal(MigrationSpecSelection.from(selected), selected);
    assert.equal(MigrationSpecSelection.from(null).specId, null);
    assert.throws(() => MigrationSpecSelection.from("../515-active"), /literal identifier/);
    const root = new MigrationSpecRoot({ root: "/project", relativePath: "nested/specs", authority: "canonical" });
    const other = new MigrationSpecRoot({ root: "/project", relativePath: "specs", authority: "canonical" });
    const names = [1, 2, 3, 4].map((revision) => selected.journalFileName(root, revision));
    assert.equal(new Set(names).size, 4);
    assert.ok(names.every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
    assert.notEqual(selected.journalFileName(root), selected.journalFileName(other));
    assert.throws(() => MigrationSpecSelection.from(null).journalFileName(root), /requires one spec/);
  });
});

function revision(component, number, apply = () => ({ complete: true })) {
  return new MigrationRevision({ component, revision: number, apply });
}

describe("migration typed foundation", () => {
  it("enforces revision route, report pointer, and mutually-exclusive mapping invariants", () => {
    const one = revision("fixture", 1);
    const two = revision("fixture", 2);
    const plan = new MigrationPlan({ component: "fixture", toRevision: 2, revisions: [one, two] });
    assert.equal(plan.executable, true);
    assert.throws(
      () => new MigrationPlan({ component: "fixture", toRevision: 2, revisions: [one] }),
      /contiguous route/,
    );
    const registry = new MigrationRegistry({ revisions: [one] });
    assert.deepEqual(registry.route("fixture", { toRevision: 1 }), [one]);
    assert.throws(() => registry.route("fixture", { toRevision: 2 }), /unsupported migration revision/);
    assert.equal(registry.revisions, undefined);

    const input = new MigrationInput({ source: "flow.json", pointer: "/state/a~1b~0c", hash: "a".repeat(64) });
    assert.deepEqual(input.toJSON(), { source: "flow.json", pointer: "/state/a~1b~0c", hash: "a".repeat(64) });
    assert.equal(new MigrationInput({ source: "flow.json", pointer: "", hash: "b".repeat(64) }).pointer, "");
    assert.equal(new MigrationInput({ source: "flow.json", pointer: null, hash: "c".repeat(64) }).pointer, null);
    for (const pointer of ["not-a-pointer", "field", "/bad~2escape", "/trailing~"]) {
      assert.throws(() => new MigrationInput({ source: "flow.json", pointer, hash: "d".repeat(64) }), /JSON Pointer|RFC 6901/);
    }

    const converted = new MigrationMapping({
      classification: "converted", source: "flow.json", pointer: "/state", destination: "flow.json", reason: "CANONICAL",
    });
    assert.throws(() => new MigrationReport({
      migration: { component: "fixture" },
      target: { revision: 1 },
      mappings: [converted, new MigrationMapping({
        classification: "preserved", source: "flow.json", pointer: "/state", destination: "artifacts/raw.json", reason: "RAW",
      })],
    }), /more than once/);
    assert.throws(() => new MigrationReport({
      migration: { component: "fixture" },
      target: { revision: 1 },
      mappings: [
        new MigrationMapping({ classification: "converted", source: "flow.json", pointer: null, destination: "flow.json", reason: "CANONICAL" }),
        new MigrationMapping({ classification: "preserved", source: "flow.json", pointer: "/other", destination: "artifacts/raw.json", reason: "RAW" }),
      ],
    }), /explicit JSON pointers/);
    const report = new MigrationReport({
      migration: { component: "fixture" },
      sourceFiles: [{ path: "flow.json", hash: "e".repeat(64) }],
      target: { revision: 1 },
      mappings: [converted, new MigrationMapping({
        classification: "generated", destination: "artifact-catalog.json", reason: "CATALOG", inputs: [input],
      })],
    }).toJSON();
    assert.deepEqual(Object.keys(report).sort(), [
      "schemaRevision", "migration", "sourceFiles", "target", "converted", "preserved", "omitted",
      "relocatedTransient", "missingTransient", "generated",
    ].sort());
    assert.throws(() => new MigrationBlocker({ code: "bad-code", message: "bad" }), /invalid/);
  });

  it("hands an entire multi-revision plan to one component transaction so a later fault cannot commit an earlier revision", () => {
    const source = ["source"];
    let executorCalls = 0;
    const one = revision("fixture", 1, ({ staged }) => staged.push("revision-1"));
    const two = revision("fixture", 2, () => { throw new Error("revision-2 fault"); });
    const executor = new MigrationComponentExecutor({
      component: "fixture",
      executePlan({ plan }) {
        executorCalls += 1;
        const staged = [...source];
        for (const entry of plan.revisions) entry.apply({ staged });
        source.splice(0, source.length, ...staged);
        return { complete: true };
      },
    });
    const registry = new MigrationRegistry({ revisions: [one, two], executors: [executor] });
    const plan = new MigrationPlan({ component: "fixture", toRevision: 2, revisions: registry.route("fixture", { toRevision: 2 }) });
    assert.throws(() => registry.execute(plan), /revision-2 fault/);
    assert.equal(executorCalls, 1);
    assert.deepEqual(source, ["source"]);
  });
});
