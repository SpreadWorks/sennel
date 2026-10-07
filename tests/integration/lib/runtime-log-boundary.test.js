import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeLogBlock, RuntimeLogFile } from "../../../src/lib/runtime-log.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const STARTED_AT = "2026-10-07T00:21:55.256Z";
const ENDED_AT = "2026-10-07T00:21:55.257Z";
const START = `===== start runId=same-run sequence=1 attempt=1 command="flow run finalize-sync" startedAt="${STARTED_AT}" exitCode="" endedAt="" =====`;
const END = `===== end runId=same-run sequence=1 attempt=1 command="flow run finalize-sync" startedAt="${STARTED_AT}" exitCode=0 endedAt="${ENDED_AT}" =====`;

function read(t, raw) {
  const root = createTmpDir("runtime-log-boundary-");
  t.after(() => removeTmpDir(root));
  const file = new RuntimeLogFile(root, "boundary");
  file.append(raw);
  return file;
}

const invalidStarts = [
  ["exitCode", START.replace('exitCode=""', "exitCode=0")],
  ["endedAt", START.replace('endedAt=""', `endedAt="${ENDED_AT}"`)],
  ["both", START.replace('exitCode="" endedAt=""', `exitCode=0 endedAt="${ENDED_AT}"`)],
];

for (const [field, invalidStart] of invalidStarts) {
  test(`ignores a start carrying ${field} even when a matching end follows`, (t) => {
    const raw = `${invalidStart}\n${END}\n`;
    const file = read(t, raw);
    const standalone = new RuntimeLogBlock(raw);
    assert.deepEqual({ standaloneComplete: standalone.complete, fileBlockCount: file.blocks().length }, {
      standaloneComplete: false,
      fileBlockCount: 0,
    });
    assert.equal(standalone.runId, null);
    assert.equal(standalone.exitCode, null);
    assert.equal(standalone.endedAt, null);
    assert.deepEqual(file.blocks(), []);
    assert.equal(file.select({ sequence: 1 }), null);
    assert.equal(file.read(), raw);
  });

  test(`does not count a later start carrying ${field} as a duplicate of a valid invocation`, (t) => {
    const interval = `${START}\n[stdout] observed body\n${END}`;
    const raw = `${interval}\n${invalidStart}\n${END}\n`;
    const file = read(t, raw);
    const blocks = file.blocks();
    const standalone = new RuntimeLogBlock(raw);
    assert.deepEqual({ standaloneComplete: standalone.complete, fileCompletions: blocks.map((block) => block.complete) }, {
      standaloneComplete: true,
      fileCompletions: [true],
    });
    assert.equal(standalone.exitCode, 0);
    assert.equal(standalone.startedAt, STARTED_AT);
    assert.equal(standalone.endedAt, ENDED_AT);
    assert.equal(standalone.text, interval);
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].toJSON(), standalone.toJSON());
    assert.deepEqual(file.select({ sequence: 1 }).toJSON(), standalone.toJSON());
    assert.equal(file.read(), raw);
  });
}

const separators = [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"], ["LS", "\u2028"], ["PS", "\u2029"]];
const fields = [["runId", "same-run"], ["command", "flow run finalize-sync"], ["startedAt", STARTED_AT]];

for (const [name, separator] of separators) {
  for (const [field, value] of fields) {
    test(`rejects ${name} inside the ${field} of a marker`, (t) => {
      const raw = `${START}\n${END}\n`.replaceAll(value, `${value}${separator}extra`);
      const file = read(t, raw);
      const standalone = new RuntimeLogBlock(raw);
      assert.deepEqual({ standaloneComplete: standalone.complete, fileBlockCount: file.blocks().length }, {
        standaloneComplete: false,
        fileBlockCount: 0,
      });
      assert.equal(standalone.runId, null);
      assert.equal(standalone.exitCode, null);
      assert.equal(standalone.endedAt, null);
      assert.deepEqual(file.blocks(), []);
      assert.equal(file.read(), raw);
    });
  }

  test(`rejects ${name} inside endedAt instead of completing the valid start`, (t) => {
    const raw = `${START}\n${END.replace(ENDED_AT, `${ENDED_AT}${separator}extra`)}\n`;
    const file = read(t, raw);
    const standalone = new RuntimeLogBlock(raw);
    const blocks = file.blocks();
    assert.deepEqual({ standaloneComplete: standalone.complete, fileCompletions: blocks.map((block) => block.complete) }, {
      standaloneComplete: false,
      fileCompletions: [false],
    });
    assert.equal(standalone.exitCode, null);
    assert.equal(standalone.endedAt, null);
    assert.equal(standalone.text, raw.trimEnd());
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].toJSON(), standalone.toJSON());
    assert.equal(file.read(), raw);
  });
}

for (const [name, eol] of separators.slice(0, 2)) {
  test(`accepts normal ${name} marker endings in standalone and file reads`, (t) => {
    const raw = [START, "[stdout] body", END, ""].join(eol);
    const file = read(t, raw);
    const standalone = new RuntimeLogBlock(raw);
    assert.equal(standalone.complete, true);
    assert.equal(standalone.exitCode, 0);
    assert.equal(standalone.startedAt, STARTED_AT);
    assert.equal(standalone.endedAt, ENDED_AT);
    assert.equal(standalone.text, raw.trimEnd());
    assert.deepEqual(file.blocks()[0].toJSON(), standalone.toJSON());
    assert.equal(file.read(), raw);
  });
}

const childStart = START.replace("sequence=1", "sequence=2").replace("flow run finalize-sync", "flow get status");
const childEnd = END.replace("sequence=1", "sequence=2").replace("flow run finalize-sync", "flow get status");
const nested = [START, childStart, childEnd, "[stdout] parent resumed", END].join("\n");
const interleavedInterval = [START, childStart, END].join("\n");
const unfinished = [START, childStart, childEnd].join("\n");
const foreign = [START, END.replace("same-run", "foreign-run")].join("\n");
const duplicate = [START, END, START].join("\n");

for (const [name, raw, complete, interval] of [
  ["nested", nested, true, nested],
  ["interleaved", `${interleavedInterval}\n${childEnd}`, true, interleavedInterval],
  ["unfinished", unfinished, false, unfinished],
  ["foreign end", foreign, false, foreign],
  ["valid duplicate after end", duplicate, false, duplicate],
]) {
  test(`standalone and file reads preserve the same ${name} interval`, (t) => {
    const file = read(t, raw);
    const standalone = new RuntimeLogBlock(raw);
    assert.equal(standalone.complete, complete);
    assert.equal(standalone.exitCode, complete ? 0 : null);
    assert.equal(standalone.endedAt, complete ? ENDED_AT : null);
    assert.equal(standalone.text, interval);
    assert.deepEqual(file.blocks()[0].toJSON(), standalone.toJSON());
    assert.equal(file.read(), raw);
  });
}
