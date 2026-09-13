import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import SetFilesCommand from "../../../src/flow/lib/set-files.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

describe("flow set files canonical publication", () => {
  let root;
  afterEach(() => root && removeTmpDir(root));

  function scenario() {
    root = createTmpDir("sennel-set-files-canonical-");
    const manager = makeFlowManager(root);
    const fixture = new CanonicalFlowFixture({
      flowManager: manager,
      specId: "001-file-map",
      runId: "run-file-map",
      request: "Publish the implementation file map through the Version Store.",
      specRecord: {
        requirements: [{ id: "R1", desc: "Map implementation files.", priority: "must", task_ids: ["T1"], testable: false }],
      },
    }).create().addTask({
      id: "T1",
      title: "File map fixture",
      goal: "Reach the implementation file-map boundary.",
      origin: "plan",
      added_round: 0,
      status: "pending",
    }).registerActive().activate("implement");
    return { fixture, manager };
  }

  it("merges and deduplicates paths in the cataloged file.map artifact", () => {
    const { fixture, manager } = scenario();
    const command = new SetFilesCommand();
    const ctx = {
      root,
      flowManager: manager,
      flowState: fixture.state(),
      reqId: "R1",
      paths: ["src/a.js", "src/a.js"],
    };

    const first = command.execute(ctx);
    ctx.paths = ["src/b.js", "src/a.js"];
    const second = command.execute(ctx);

    assert.deepEqual(first.map, { R1: ["src/a.js"] });
    assert.deepEqual(second.map, { R1: ["src/a.js", "src/b.js"] });
    const artifact = manager.readArtifact({
      specId: fixture.specId,
      logicalKey: "file.map",
      consumerNodeId: "implement",
    });
    assert.deepEqual(JSON.parse(artifact.bytes.toString("utf8")), second.map);
    assert.equal(artifact.relativePath, "steps/impl/file-map.json");
    assert.equal(fs.existsSync(path.join(root, "specs", fixture.specId, "file-map.json")), false);
  });

  it("rejects an unknown requirement without publishing file.map", () => {
    const { fixture, manager } = scenario();
    const result = new SetFilesCommand().execute({
      root,
      flowManager: manager,
      flowState: fixture.state(),
      reqId: "R404",
      paths: ["src/missing.js"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "INVALID_REQ_ID");
    assert.equal(manager.readArtifact({
      specId: fixture.specId,
      logicalKey: "file.map",
      consumerNodeId: "implement",
      optional: true,
    }), null);
  });
});
