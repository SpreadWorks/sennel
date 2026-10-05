/**
 * src/flow/lib/set-issue.js
 *
 * Reject active-Flow Issue changes. Issue identity and issue.md are captured
 * together by canonical Flow creation and remain immutable afterwards.
 *
 * ctx.number — issue number (string or number)
 */

import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";

export default class SetIssueCommand extends FlowCommand {
  execute(ctx) {
    const raw = ctx.number;

    if (raw == null || raw === "") {
      return Envelope.fail("set", "issue", "INVALID_USAGE", "usage: flow set issue <number>");
    }

    const str = String(raw);
    if (!/^\d+$/.test(str)) {
      return Envelope.fail(
        "set",
        "issue",
        "INVALID_ARG_VALUE",
        `not a valid positive integer: ${raw}`,
      );
    }

    const num = parseInt(str, 10);
    if (num < 1) {
      return Envelope.fail(
        "set",
        "issue",
        "INVALID_ARG_VALUE",
        `issue number must be a positive integer: ${raw}`,
      );
    }

    return Envelope.fail(
      "set",
      "issue",
      "ISSUE_IMMUTABLE",
      `linked Issue identity is immutable after canonical Flow creation (requested #${num})`,
    );
  }
}
