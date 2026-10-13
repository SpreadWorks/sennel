import assert from "node:assert/strict";
import { it } from "node:test";

import { CanonicalFlowVersionReader, QueryRequest, FLOW_QUERY_LIMITS } from "../../../src/flow/query.js";
import { createFlowQueryFixture } from "../../support/builders/flow-query-fixture.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

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
