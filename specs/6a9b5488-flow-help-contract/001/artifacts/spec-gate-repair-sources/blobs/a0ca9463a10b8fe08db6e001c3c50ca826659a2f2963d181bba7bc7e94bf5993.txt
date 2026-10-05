/**
 * src/flow/lib/set-init.js
 *
 * Initialize a preparing flow state before flow prepare.
 * Creates .sennel/.active-flow.<runId> with a flow.json-compatible schema.
 * Accepts --issue and --request to seed the preparing state so that a later
 * `flow prepare --run-id <id>` can inherit them.
 */

import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";
import {
  GitHubIssueSnapshotSource,
  IssueSnapshot,
  IssueSnapshotSource,
} from "./issue-snapshot-source.js";

export default class SetInitCommand extends FlowCommand {
  constructor({ issueSnapshotSource = new GitHubIssueSnapshotSource() } = {}) {
    super({ requiresFlow: false });
    if (!(issueSnapshotSource instanceof IssueSnapshotSource)) {
      throw new TypeError("issueSnapshotSource must be an IssueSnapshotSource");
    }
    this.issueSnapshotSource = issueSnapshotSource;
  }

  execute(ctx) {
    const { flowManager } = ctx;

    const extra = {};
    if (ctx.issue != null && ctx.issue !== "") {
      const n = Number(ctx.issue);
      if (!Number.isInteger(n) || n <= 0) {
        return Envelope.fail(
          "set",
          "init",
          "INVALID_ARG_VALUE",
          `--issue must be a positive integer: ${ctx.issue}`,
        );
      }
      const snapshot = this.issueSnapshotSource.load({ number: n, root: ctx.root });
      if (snapshot === null) {
        return Envelope.fail(
          "set",
          "init",
          "ISSUE_SNAPSHOT_UNAVAILABLE",
          `cannot initialize linked Issue #${n}: its immutable Issue snapshot could not be retrieved`,
        );
      }
      if (!(snapshot instanceof IssueSnapshot)) {
        throw new TypeError("issueSnapshotSource must return an IssueSnapshot or null");
      }
      snapshot.assertIdentity(n);
      extra.issue = n;
      extra.issueBody = snapshot.body;
    }
    if (ctx.request) extra.request = ctx.request;

    const remaining = flowManager.listPreparingFlows();
    if (remaining.length > 0) {
      console.error(
        `[flow] WARN: ${remaining.length} preparing flow(s) already exist: ${remaining.join(", ")}`
      );
    }

    const operationLock = new RepositoryFlowOperationLock({
      mainRoot: ctx.mainRoot || flowManager._mainRoot || ctx.root,
    });
    const operationOwnerToken = operationLock.acquire();
    try {
      const runId = flowManager.generateRunId();
      flowManager.createPreparingFlow(runId, extra, { operationOwnerToken });
      return { runId, ...extra };
    } finally {
      operationLock.release();
    }
  }
}
