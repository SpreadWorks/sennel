import assert from "node:assert/strict";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import { installCommandProcessFake } from "./command-process-fake.js";

/** Replace only the public external-process dependency; execute all Review logic. */
export function installReviewProcessFake(runCommand) {
  return installCommandProcessFake(RunReviewCommand, (command, childArgs, options) => {
    assert.equal(command, "node");
    assert.ok(String(childArgs[0]).endsWith("/flow/commands/review.js"));
    return runCommand(command, childArgs, options);
  });
}
