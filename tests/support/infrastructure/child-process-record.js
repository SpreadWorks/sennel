import {
  ChildProcessExecutionRecordCodec,
  processResultFromSpawnSync,
} from "../../../src/flow/lib/test-regression.js";
import { shellQuote } from "./shell-argument.js";

const CODEC = new ChildProcessExecutionRecordCodec();

export function childProcessRecord({
  command = ["node", "--test", "tests/unit/nested.test.js"],
  status = 1,
  signal = null,
  error = null,
  stdout = "",
  stderr = "",
} = {}) {
  return processResultFromSpawnSync(command, {
    status,
    signal,
    error,
    stdout,
    stderr,
  }).toRecord();
}

export function shellPrintChildProcessRecord(options = {}) {
  return `printf '%s\\n' ${shellQuote(CODEC.encode(childProcessRecord(options)))} >&2`;
}
