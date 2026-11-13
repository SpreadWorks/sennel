import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LayoutFileContent } from "../../../src/lib/layout-file-content.js";
import { LayoutBeforeImageRequest, LayoutMigrationEvidence } from "../../../src/lib/layout-migration-evidence.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function requests(root) {
  return ["first.txt", "second.txt"].map(name => {
    const source = path.join(root, name);
    fs.writeFileSync(source, `original ${name}\n`);
    return new LayoutBeforeImageRequest(name, LayoutFileContent.capture(source));
  });
}

for (const foreign of [false, true]) {
  test(`failed before-image preparation ${foreign ? "preserves foreign and unconfirmed payloads" : "discards only confirmed payloads"}`, t => {
    const root = createTmpDir("layout-evidence-preparation-");
    t.after(() => removeTmpDir(root));
    const inputs = requests(root);
    const write = LayoutFileContent.prototype.writeBeforeImage;
    let directory;
    let count = 0;
    LayoutFileContent.prototype.writeBeforeImage = function (destination, ...args) {
      directory = path.dirname(destination);
      if (++count !== 2) return write.call(this, destination, ...args);
      if (foreign) {
        write.call(this, destination, ...args);
        fs.writeFileSync(path.join(directory, "foreign.txt"), "foreign bytes\n");
      }
      throw new Error("injected before-image preparation failure");
    };
    try {
      assert.throws(() => LayoutMigrationEvidence.create(root, inputs),
        /injected before-image preparation failure/);
    } finally {
      LayoutFileContent.prototype.writeBeforeImage = write;
    }
    assert.equal(count, 2);
    for (const name of ["first.txt", "second.txt"]) {
      assert.equal(fs.readFileSync(path.join(root, name), "utf8"), `original ${name}\n`);
    }
    if (foreign) {
      assert.deepEqual(fs.readdirSync(directory).sort(), ["0.bytes", "1.bytes", "foreign.txt"]);
      assert.equal(fs.readFileSync(path.join(directory, "0.bytes"), "utf8"), "original first.txt\n");
      assert.equal(fs.readFileSync(path.join(directory, "1.bytes"), "utf8"), "original second.txt\n");
      assert.equal(fs.readFileSync(path.join(directory, "foreign.txt"), "utf8"), "foreign bytes\n");
    } else {
      assert.equal(fs.existsSync(directory), false);
    }
  });
}
