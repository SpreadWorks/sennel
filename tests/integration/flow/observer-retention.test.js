import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SENNEL_BOOTSTRAP } from "../../support/infrastructure/node-bootstrap.js";

test("typed publication observations release old producer Stores after two real Draft dispatcher saves following module initialization", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--import", SENNEL_BOOTSTRAP,
    fileURLToPath(new URL("./observer-retention-producer.js", import.meta.url))], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.equal(child.signal, null);
  assert.deepEqual(JSON.parse(child.stdout), { actualTypedSaveProduced: true, actualTypedSaveCount: 3, warmupSaveCount: 1, measuredSaveCount: 2, observerEnabled: process.env.SENNEL_RETENTION_DISABLE_OBSERVER !== "1", oldStoreRetained: false });
});
