import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { CiNodeMatrix } from "../../scripts/ci-node-matrix.js";

const packageManifest = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("CI minimum Node lane derives several legal floors from engines.node", () => {
  for (const [engineRange, expectedMinimum] of [[">=18.19.0", "18.19.0"], [">=20.11.0", "20.11.0"]]) {
    const matrix = new CiNodeMatrix({ engines: { node: engineRange } });
    assert.ok(matrix instanceof CiNodeMatrix);
    assert.equal(matrix.minimumNodeVersion, expectedMinimum);
    assert.deepEqual(matrix.toJSON(), {
      include: [
        { lane: "minimum", "node-version": expectedMinimum },
        { lane: "current-lts", "node-version": "lts/*" },
      ],
    });
  }
});

test("CI matrix generation rejects unsupported engine range syntax", () => {
  assert.throws(() => new CiNodeMatrix({ engines: { node: ">=18 <19" } }), {
    name: "TypeError",
    message: "package.json engines.node must be a single >=MAJOR.MINOR.PATCH minimum",
  });
});
