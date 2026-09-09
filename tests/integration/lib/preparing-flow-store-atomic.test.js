import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { PreparingFlowStore } from "../../../src/lib/preparing-flow-store.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

describe("PreparingFlowStore atomic persistence", () => {
  it("keeps old bytes on a write fault and cleans its lock and temp files", () => {
    const root = createTmpDir("preparing-flow-atomic-");
    try {
      const runId = "run-420-preparing";
      const setup = new PreparingFlowStore({ mainRoot: root });
      const file = setup.create(runId, { request: "before" });
      const before = fs.readFileSync(file);
      const store = new PreparingFlowStore({
        mainRoot: root,
        faultInjector(event) {
          if (event.phase === "before-json-rename") throw new Error("preparing rename fault");
        },
      });

      assert.throws(
        () => store.mutate(runId, (state) => { state.request = "after"; }),
        /preparing rename fault/,
      );

      assert.deepEqual(fs.readFileSync(file), before);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
    } finally {
      removeTmpDir(root);
    }
  });

  it("rejects same-process writer reentry and unsafe run identifiers", () => {
    const root = createTmpDir("preparing-flow-lock-");
    try {
      const runId = "run-420-lock";
      const first = new PreparingFlowStore({ mainRoot: root });
      const second = new PreparingFlowStore({ mainRoot: root });
      const file = first.create(runId, { request: "before" });
      const before = fs.readFileSync(file);

      assert.throws(
        () => first.mutate(runId, () => second.mutate(runId, (state) => { state.request = "lost"; })),
        (error) => error.code === "PREPARING_FLOW_LOCK_REENTRANT"
          && error.lockStatus === "reentrant",
      );
      assert.deepEqual(fs.readFileSync(file), before);
      assert.throws(() => first.load("../outside"), /runId/);
    } finally {
      removeTmpDir(root);
    }
  });

  it("rejects an out-of-band revision change before atomic replacement", () => {
    const root = createTmpDir("preparing-flow-revision-");
    try {
      const runId = "run-420-revision";
      const store = new PreparingFlowStore({ mainRoot: root });
      const file = store.create(runId, { request: "before" });
      let winner;

      assert.throws(
        () => store.mutate(runId, (state) => {
          state.request = "loser";
          winner = { ...state, request: "concurrent winner" };
          fs.writeFileSync(file, `${JSON.stringify(winner, null, 2)}\n`);
        }),
        (error) => error.code === "PREPARING_FLOW_REVISION_CONFLICT",
      );

      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), winner);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
    } finally {
      removeTmpDir(root);
    }
  });
});
