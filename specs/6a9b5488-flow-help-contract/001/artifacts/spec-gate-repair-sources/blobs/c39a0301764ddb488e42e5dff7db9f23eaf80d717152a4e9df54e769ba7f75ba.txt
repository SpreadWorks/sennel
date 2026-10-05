/**
 * src/flow/lib/get-qa-count.js
 *
 * Return the number of answered questions in draft phase.
 */

import { FlowCommand } from "./base-command.js";
import { AnsweredQuestion } from "./draft-question-ledger.js";
import { DraftLifecycle } from "./draft-lifecycle.js";

export default class GetQaCountCommand extends FlowCommand {
  execute(ctx) {
    const source = ctx.flowManager.readArtifact({
      specId: ctx.flowState.specId,
      logicalKey: "draft",
      consumerNodeId: "draft-refine",
      optional: true,
    });
    if (source === null) return { count: 0 };
    const ledger = new DraftLifecycle(JSON.parse(source.bytes.toString("utf8"))).questionLedger;
    return { count: ledger.questions.filter((question) => question instanceof AnsweredQuestion).length };
  }
}
