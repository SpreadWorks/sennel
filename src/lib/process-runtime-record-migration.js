/** Explicit predecessor-to-current orchestration; Store owns physical effects. */
import path from "node:path";
import { ProcessExecutionRuntime, ProcessExecutionPreparedPublication, ProcessExecutionRuntimeRecordMigrationPrepared,
  ProcessRuntimeRecordMigrationStorage } from "./process-execution-runtime.js";
import { ProcessExecutionValueEncoding, executionValueSnapshot, freezeExecutionValue } from "./process-execution-values.js";
import { MigrationProcessOwner } from "./migration-process-owner.js";
import { withRepositoryMigrationExclusion } from "./migration.js";
import { combineProcessExecutionFailures } from "./process-execution-completion.js";

/** Writer release is semantic evidence, separate from the immutable physical plan. */
class RuntimeRecordMigrationJournal {
  constructor(value) {
    const keys = ["schemaVersion", "component", "from", "to", "owner", "publication"].sort();
    if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) || value.schemaVersion !== 1
      || value.component !== "runtime" || ![8, 9].includes(value.from) || value.to !== 10) throw new TypeError("Runtime migration journal binding is invalid");
    this.schemaVersion = 1; this.component = "runtime"; this.from = value.from; this.to = 10;
    this.owner = value.owner instanceof MigrationProcessOwner ? value.owner : MigrationProcessOwner.fromJSON(value.owner);
    this.publication = freezeExecutionValue(executionValueSnapshot(value.publication));
    Object.freeze(this);
  }
  static fromSelected(plan) {
    if (!(plan instanceof ProcessExecutionRuntimeRecordMigrationPrepared)) throw new TypeError("Migration journal requires the exact selected physical plan");
    return new this(plan.metadata);
  }
  toJSON() { return { schemaVersion: this.schemaVersion, component: this.component, from: this.from, to: this.to,
    owner: this.owner.toJSON(), publication: this.publication }; }
}

export class ProcessRuntimeRecordMigration {
  constructor({ mainRoot, executionRoot = mainRoot, dryRun = false, recover = false, logger = console, faultInjector = () => {} }) {
    this.root = path.resolve(mainRoot); this.executionRoot = path.resolve(executionRoot);
    this.dryRun = dryRun; this.recover = recover; this.logger = logger;
    this.storage = new ProcessRuntimeRecordMigrationStorage({ mainRoot: this.root, executionRoot: this.executionRoot, faultInjector });
    Object.freeze(this);
  }
  #exclusive(callback) {
    return this.storage.runExclusive(() => withRepositoryMigrationExclusion(this.root,
      { quiescence: this.storage, revalidate: () => this.storage.assertQuiescent() }, callback));
  }
  #withWriter(from, operation) {
    let writer = MigrationProcessOwner.current(); writer.activate();
    const context = {
      encodeMetadata: (publication) => new ProcessExecutionValueEncoding(new RuntimeRecordMigrationJournal({
        schemaVersion: 1, component: "runtime", from, to: 10, owner: writer, publication })),
      assertWriter: () => writer.released ? writer.assertInactive() : writer.assertActive(),
    };
    try { return operation(context); }
    catch (cause) {
      // Use only a selection already confirmed by the common publisher. Never
      // recapture/adopt a possibly foreign transition after an unexpected error.
      const selected = this.storage.lastSelectedPlan();
      writer = writer.release();
      if (selected !== null) {
        try { this.storage.replaceMetadata(selected, context); }
        catch (cleanup) { throw combineProcessExecutionFailures(cause, cleanup); }
      }
      throw cause;
    } finally { if (!writer.released) writer = writer.release(); }
  }
  run() {
    const selected = this.storage.inspectTransition();
    if (selected instanceof ProcessExecutionPreparedPublication) {
      if (!this.recover) throw new Error("Prepared runtime result requires explicit --recover; retain the selected evidence");
      if (this.dryRun) { this.logger.log("[migrate] DRY-RUN: inspect selected prepared runtime data recovery; worker ownership remains unconfirmed"); return { complete: false, requiresRecovery: true, dataOnly: true }; }
      const recovery = ProcessExecutionRuntime.recoverPreparedPublication(selected);
      return { complete: true, recovered: true, dataOnly: true, recovery };
    }
    if (selected !== null) {
      const journal = RuntimeRecordMigrationJournal.fromSelected(selected);
      journal.owner.assertInactive();
      if (!this.recover) throw new Error("Runtime record migration requires explicit --recover; retain the selected journal");
      if (this.dryRun) { this.logger.log(`[migrate] DRY-RUN: recover the exact selected runtime${journal.from}→10 publication`); return { complete: false, requiresRecovery: true }; }
      return this.#exclusive(() => {
        this.storage.assertPlanCurrent(selected);
        return this.#withWriter(journal.from, (context) => {
          const active = this.storage.replaceMetadata(selected, context);
          this.storage.recover(active, context);
          this.storage.validateCurrent();
          return { complete: true, recovered: true, migrated: active.targets.length };
        });
      });
    }
    if (this.recover) throw new Error("Runtime storage has no selected transition to recover");
    const version = this.storage.version;
    if (version === null) return { complete: true, migrated: 0 };
    if (version === 10) { this.storage.inspectCurrent(); return { complete: true, migrated: 0 }; }
    const captured = this.storage.capture();
    if (this.dryRun) { this.logger.log(`[migrate] DRY-RUN: convert ${captured.targets.length} runtime records from${version} to10 in ${this.executionRoot}`); return { complete: true, migrated: 0, preview: captured.toJSON() }; }
    return this.#exclusive(() => {
      captured.assertCurrent();
      return this.#withWriter(version, (context) => {
        this.storage.publish(captured, context);
        this.storage.validateCurrent();
        return { complete: true, migrated: captured.targets.length };
      });
    });
  }
}
