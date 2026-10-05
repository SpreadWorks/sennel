/**
 * src/flow/lib/get-issue.js
 *
 * Get GitHub issue content.
 *
 * ctx.number — issue number (string or number)
 */

import { FlowCommand } from "./base-command.js";
import { fetchIssue } from "./fetch-issue.js";

export default class GetIssueCommand extends FlowCommand {
  constructor() {
    super({ requiresFlow: false });
  }

  execute(ctx) {
    const { root } = ctx;
    const number = String(ctx.number ?? "");

    if (!number || !/^\d+$/.test(number)) {
      throw new Error("issue number required (positive integer)");
    }

    const data = fetchIssue(number, root, { strict: true });
    return {
      number: Number(number),
      title: data.title,
      body: data.body,
      labels: data.labels,
      state: data.state,
    };
  }
}
