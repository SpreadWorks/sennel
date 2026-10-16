import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { it } from "node:test";
import { buildCurrentFlowDefinition } from "../../src/flow/definition.js";
import { CurrentFlowVersionStore } from "../../src/flow/lib/current-flow-state.js";
import { FlowVersionAuthorityScope, FlowVersionLocation } from "../../src/lib/flow-version.js";
import { ActiveFlowRegistry } from "../../src/lib/active-flow-registry.js";
import { FlowTargetIdentityAuthority } from "../../src/lib/flow-target-identity-authority.js";
import { SpecsMigrationRevisionOne, SpecsMigrationRevisionThree, SpecsMigrationRevisionFour } from "../../src/lib/specs-migration.js";
import { StoredFlowPersistenceSnapshot } from "../support/assertions/canonical-persistence.js";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";

it("bounds revision 2, 3 and 4 dry-run Flow reads as the repository grows without changing persisted input", (t) => {
  const samples = new Map();
  const definition = buildCurrentFlowDefinition();
  for (const size of [8, 16, 32]) {
    const root = createTmpDir("sennel-migration-scaling-");
    t.after(() => removeTmpDir(root));
    writeJson(root, ".sennel/config.json", { flow: { specDir: "specs" } });
    const targets = new FlowTargetIdentityAuthority({ mainRoot: root });
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    for (let ordinal = 0; ordinal < size; ordinal++) {
      const specId = `001-scaling-${ordinal}`;
      const location = new FlowVersionLocation({ repositoryRoot: root,
        authorityScope: FlowVersionAuthorityScope.canonical(), specRoot: "specs", specId, version: 1 });
      const current = new CurrentFlowVersionStore({ location, definition }).createFresh({
        flowId: `flow-${ordinal}`, flowVersionId: `version-${ordinal}`, runId: `run-${ordinal}`,
        request: "Check offline migration preflight cost.", specRecord: { id: specId, title: "Scaling", tasks: [] },
      });
      targets.addActive(current, current.execution.mode);
      registry.add(specId, current.execution.mode);
    }
    const before = new StoredFlowPersistenceSnapshot(root);
    for (const [revision, Runner] of [[2, SpecsMigrationRevisionOne], [3, SpecsMigrationRevisionThree], [4, SpecsMigrationRevisionFour]]) {
      let reads = 0;
      let registryVisits = 0;
      const readEntries = ActiveFlowRegistry.readEntries;
      const registryObservation = t.mock.method(ActiveFlowRegistry, "readEntries", (...args) =>
        new Proxy(readEntries(...args), { get(target, key) {
          if (typeof key === "string" && /^[0-9]+$/.test(key)) registryVisits++;
          return Reflect.get(target, key);
        } }));
      const original = fs.readFileSync;
      const observation = t.mock.method(fs, "readFileSync", (file, ...options) => {
        if (typeof file === "string" && file.startsWith(path.join(root, "specs") + path.sep)
          && path.basename(file) === "flow.json") reads++;
        return original(file, ...options);
      });
      const messages = [];
      const started = performance.now();
      let result;
      try {
        result = new Runner(root, { targetRevision: revision === 2 ? 2 : undefined, dryRun: true,
          logger: { log: (message) => messages.push(message), error: (message) => messages.push(message) } }).run();
      } finally { observation.mock.restore(); registryObservation.mock.restore(); }
      const elapsedMs = performance.now() - started;
      assert.equal(result.complete, true, messages.join("\n"));
      assert.equal(messages.length, size);
      assert.equal(new StoredFlowPersistenceSnapshot(root).digest, before.digest);
      if (!samples.has(revision)) samples.set(revision, []);
      samples.get(revision).push({ size, reads, registryVisits, elapsedMs });
    }
  }
  for (const [revision, measurements] of samples) {
    t.diagnostic(JSON.stringify({ revision, measurements }));
    const first = measurements[0];
    for (const sample of measurements.slice(1)) {
      const proportionalBudget = first.reads * sample.size / first.size + sample.size;
      assert.ok(sample.reads <= proportionalBudget,
        `revision ${revision} Flow reads exceeded linear preflight budget: ${JSON.stringify(measurements)}`);
      assert.ok(sample.registryVisits <= first.registryVisits * sample.size / first.size + sample.size,
        `revision ${revision} active registry visits exceeded linear preflight budget: ${JSON.stringify(measurements)}`);
    }
  }
});
