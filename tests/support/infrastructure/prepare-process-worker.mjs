import fs from "node:fs";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import RunPrepareSpecCommand from "../../../src/flow/lib/run-prepare-spec.js";

const input = JSON.parse(process.argv[2]);
const flowManager = new FlowManager({ root: input.root, mainRoot: input.mainRoot, inWorktree: false });
await new RunPrepareSpecCommand().execute({ ...input, flowManager, worktreePrepareFaultInjector(event) {
  if (event.phase !== "after-worktree-add") return;
  fs.writeSync(1, JSON.stringify(event));
  process.exit(73);
} });
throw new Error("Prepare did not reach after-worktree-add");
