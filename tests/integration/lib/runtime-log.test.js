import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { RuntimeLogBlock, RuntimeLogBlockWriter, RuntimeLogFile } from "../../../src/lib/runtime-log.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("sennel-runtime-log-interval-");
  t.after(() => removeTmpDir(root));
  const file = new RuntimeLogFile(root, "sample-flow");
  return { file, writer: (command, runId = "sample-run") => new RuntimeLogBlockWriter({
    root, flowId: "sample-flow", runId, command,
  }) };
}

test("reads the enclosing command's actual end after nested command logs", (t) => {
  const { file, writer } = fixture(t);
  const parent = writer("flow run dispatch");
  parent.capture("stdout", "before nested command\n");
  const child = writer("flow get status");
  child.capture("stderr", "nested diagnostic\n");
  const childMetadata = child.close(7);
  parent.capture("stdout", "await_user_decision\n");
  const parentMetadata = parent.close(0);
  const interval = file.read().trimEnd();
  const later = writer("flow get next-action");
  later.capture("stdout", "outside the completed parent interval\n");
  later.close(0);
  const raw = file.read();

  const selected = file.select({ sequence: parentMetadata.sequence, ownerRunId: "sample-run" });
  assert.equal(selected.complete, true);
  assert.equal(selected.exitCode, 0);
  assert.equal(selected.endedAt, parentMetadata.endedAt);
  assert.equal(selected.text, interval, "The raw interval includes nested writes without claiming their ownership");
  const nested = file.select({ sequence: childMetadata.sequence, runId: "sample-run" });
  assert.equal(nested.complete, true);
  assert.equal(nested.exitCode, 7);
  assert.equal(nested.endedAt, childMetadata.endedAt);
  assert.match(nested.text, /nested diagnostic/);
  assert.doesNotMatch(nested.text, /await_user_decision/);
  assert.equal(file.read(), raw, "Readback never rewrites the observed log");
});

test("pairs interleaved commands by their binding instead of stack order", (t) => {
  const { file, writer } = fixture(t);
  const first = writer("flow run dispatch");
  const second = writer("flow get status");
  first.capture("stdout", "overlapping output has no per-line owner binding\n");
  const firstMetadata = first.close(3);
  const firstInterval = file.read().trimEnd();
  second.capture("stderr", "second still running\n");
  const secondMetadata = second.close(8);

  const blocks = file.blocks();
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => [block.sequence, block.complete, block.exitCode, block.endedAt]), [
    [firstMetadata.sequence, true, 3, firstMetadata.endedAt],
    [secondMetadata.sequence, true, 8, secondMetadata.endedAt],
  ]);
  assert.equal(blocks[0].text, firstInterval);
  assert.match(blocks[1].text, /overlapping output has no per-line owner binding/);
  assert.match(blocks[1].text, /second still running/);
  assert.equal(file.select({ latestNonRuntimeLog: true }).sequence, secondMetadata.sequence);
});

test("keeps an unfinished enclosing command incomplete when its child closes", (t) => {
  const { file, writer } = fixture(t);
  const parent = writer("flow run finalize-sync");
  const child = writer("flow get status");
  child.capture("stdout", "child finished\n");
  child.close(0);
  const raw = file.read();

  const selected = file.select({ sequence: parent.metadata.sequence });
  assert.equal(selected.complete, false);
  assert.equal(selected.exitCode, null);
  assert.equal(selected.endedAt, null);
  assert.equal(selected.text, raw.trimEnd(), "An unfinished interval extends to observed EOF");
  const direct = new RuntimeLogBlock(raw);
  assert.equal(direct.complete, false, "The standalone block parser uses the same matching contract");
  assert.equal(file.blocks()[1].complete, true);
});

test("does not close a command with an end marker for a different invocation binding", (t) => {
  const { file, writer } = fixture(t);
  const command = writer("flow run gate");
  command.capture("stderr", "waiting for the exact completion marker\n");
  const unfinished = file.read();
  const metadata = command.close(5);
  const end = file.read().slice(unfinished.length);
  const mismatches = [
    ["runId=sample-run", "runId=foreign-run"],
    [`sequence=${metadata.sequence}`, `sequence=${metadata.sequence + 1}`],
    ["attempt=1", "attempt=2"],
    ['command="flow run gate"', 'command="flow get status"'],
    [`startedAt="${metadata.startedAt}"`, 'startedAt="2000-01-01T00:00:00.000Z"'],
  ];
  for (const [before, after] of mismatches) {
    fs.writeFileSync(file.filePath, unfinished + end.replace(before, after));
    const selected = file.select({ sequence: metadata.sequence });
    assert.equal(selected.complete, false, before);
    assert.equal(selected.exitCode, null, before);
    assert.equal(selected.endedAt, null, before);
  }
  file.append(end);
  assert.equal(file.select({ sequence: metadata.sequence }).exitCode, 5);
});

test("does not infer completion when duplicate starts have an indistinguishable binding", (t) => {
  const { file, writer } = fixture(t);
  const command = writer("flow run dispatch");
  file.append(command.startLine());
  command.close(0);

  const blocks = file.blocks();
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.equal(block.sequence, command.metadata.sequence);
    assert.equal(block.complete, false);
    assert.equal(block.exitCode, null);
    assert.equal(block.endedAt, null);
  }
});
