import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import SetInitCommand from "../../../src/flow/lib/set-init.js";
import {
  IssueSnapshot,
  IssueSnapshotSource,
} from "../../../src/flow/lib/issue-snapshot-source.js";

class FixtureIssueSnapshotSource extends IssueSnapshotSource {
  constructor(snapshot = null) {
    super();
    this.snapshot = snapshot;
    this.inputs = [];
  }

  load(input) {
    this.inputs.push(input);
    return this.snapshot;
  }
}

describe("linked Issue snapshot boundary", () => {
  let tmp;

  afterEach(() => {
    if (tmp) removeTmpDir(tmp);
    tmp = null;
  });

  it("persists the typed immutable snapshot with the matching preparing Issue identity", () => {
    tmp = createTmpDir("issue-snapshot-source-");
    const source = new FixtureIssueSnapshotSource(new IssueSnapshot({
      number: 431,
      body: "Fixture Issue body",
    }));
    const manager = makeFlowManager(tmp);
    const config = { github: { provider: "gh" } };

    const result = new SetInitCommand({ issueSnapshotSource: source }).execute({
      root: tmp,
      flowManager: manager,
      issue: "431",
      config,
    });

    assert.equal(result.runId.length > 0, true);
    assert.deepEqual(source.inputs, [{ number: 431, root: tmp, config }]);
    const preparing = manager.loadPreparingFlow(result.runId);
    assert.equal(preparing.issue, 431);
    assert.equal(preparing.issueBody, "Fixture Issue body");
  });

  it("rejects empty snapshot text before it can reach a Flow creation request", () => {
    assert.throws(
      () => new IssueSnapshot({ number: 434, body: " \n" }),
      /non-empty text/,
    );
  });

  it("fails closed without creating a preparing Flow when the snapshot is unavailable", () => {
    tmp = createTmpDir("issue-snapshot-source-");
    const manager = makeFlowManager(tmp);
    const source = new FixtureIssueSnapshotSource();

    const result = new SetInitCommand({ issueSnapshotSource: source }).execute({
      root: tmp,
      flowManager: manager,
      issue: "432",
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "ISSUE_SNAPSHOT_UNAVAILABLE");
    assert.equal(manager.listPreparingFlows().length, 0);
  });

  it("rejects a source snapshot for a different Issue before creating preparing state", () => {
    tmp = createTmpDir("issue-snapshot-source-");
    const manager = makeFlowManager(tmp);
    const source = new FixtureIssueSnapshotSource(new IssueSnapshot({
      number: 999,
      body: "wrong Issue",
    }));

    assert.throws(
      () => new SetInitCommand({ issueSnapshotSource: source }).execute({
        root: tmp,
        flowManager: manager,
        issue: "433",
      }),
      /does not match the linked Issue/,
    );
    assert.equal(manager.listPreparingFlows().length, 0);
  });
});
