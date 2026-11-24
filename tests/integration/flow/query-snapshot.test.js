import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { CanonicalFlowVersionReader, QueryRequest, FLOW_QUERY_LIMITS } from "../../../src/flow/query.js";
import { createFlowQueryFixture } from "../../support/builders/flow-query-fixture.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

it("recaptures a committed query after a real Version publication changes its inventory", async (t) => {
  const fixture = createFlowQueryFixture();
  t.after(() => removeTmpDir(fixture.root));
  let captures = 0;
  class PublishingReader extends CanonicalFlowVersionReader {
    async open(...args) {
      const captured = await super.open(...args);
      captures += 1;
      if (captures === 1) fixture.materializeVersion(2);
      return captured;
    }
  }
  const request = new QueryRequest(fixture.request());
  const result = await new PublishingReader({ repositoryRoot: fixture.root }).read(fixture.specId, 1, request);
  assert.equal(captures, 2);
  assert.deepEqual(result.available, [1, 2]);
  assert.deepEqual(result.version.response.availableFlowVersions, [1, 2]);
  assert.equal(result.version.response.ok, true);
  assert.equal(result.version.response.selectedFlowVersion.flowVersion, 1);
  assert.equal(result.version.artifactBytes.size, 1, "metadata retains only the confirmed ledger for detail provenance");
  assert.equal(result.version.artifactBytes.has("activities.jsonl"), true);
});

it("stops with SNAPSHOT_UNSTABLE after its finite inventory capture budget", async (t) => {
  const fixture = createFlowQueryFixture();
  t.after(() => removeTmpDir(fixture.root));
  let captures = 0;
  class PublishingReader extends CanonicalFlowVersionReader {
    async open(...args) {
      const captured = await super.open(...args);
      captures += 1;
      fixture.materializeVersion(captures + 1);
      return captured;
    }
  }
  const request = new QueryRequest(fixture.request());
  await assert.rejects(
    new PublishingReader({ repositoryRoot: fixture.root }).read(fixture.specId, 1, request),
    (error) => {
      assert.equal(error.code, "SNAPSHOT_UNSTABLE");
      assert.equal(error.jsonPath, "/snapshot");
      assert.equal(error.reason, "SNAPSHOT_RETRY_EXHAUSTED");
      return true;
    },
  );
  assert.equal(captures, FLOW_QUERY_LIMITS.MAX_SNAPSHOT_ATTEMPTS);
  assert.deepEqual(await new CanonicalFlowVersionReader({ repositoryRoot: fixture.root }).listAvailableVersions(fixture.specId), [1, 2, 3, 4]);
});


it("pins the query projection across live source edits and changes it in a fresh runtime", (t) => {
  const fixture = createFlowQueryFixture();
  const packageRoot = createTmpDir("query-pinned-package-");
  t.after(() => { removeTmpDir(fixture.root); removeTmpDir(packageRoot); });
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  fs.cpSync(path.join(repository, "src"), path.join(packageRoot, "src"), { recursive: true });
  fs.copyFileSync(path.join(repository, "package.json"), path.join(packageRoot, "package.json"));
  const probe = path.join(packageRoot, "src/query-projection-probe.js");
  fs.writeFileSync(probe, 'export const version = "captured";\n');
  const run = (edit) => {
    const source = `
      import fs from 'node:fs';
      import { CanonicalFlowVersionReader, QueryRequest } from './src/flow/query.js';
      const reader = new CanonicalFlowVersionReader({ repositoryRoot: ${JSON.stringify(fixture.root)} });
      const request = new QueryRequest(${JSON.stringify(fixture.request())});
      const read = async () => (await reader.read(${JSON.stringify(fixture.specId)}, 1, request)).version.response.snapshot;
      const before = await read();
      if (${edit}) fs.writeFileSync(${JSON.stringify(probe)}, 'export const version = "edited";\\n');
      const after = await read();
      console.log(JSON.stringify({ before, after }));
    `;
    const result = spawnSync(process.execPath, ["--import", path.join(packageRoot, "src/sennel.js"), "--input-type=module", "-e", source], {
      cwd: packageRoot, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const active = run(true);
  assert.equal(active.before.projectionHash, active.after.projectionHash);
  assert.equal(active.before.id, active.after.id);
  const fresh = run(false);
  assert.notEqual(active.before.projectionHash, fresh.before.projectionHash);
  assert.notEqual(active.before.id, fresh.before.id);
  assert.equal(fresh.before.id, fresh.after.id);
});
