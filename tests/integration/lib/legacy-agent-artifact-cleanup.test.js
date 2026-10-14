import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  LegacyAgentArtifactCleanup,
} from "../../../src/lib/legacy-agent-artifact-cleanup.js";

function temporaryRoot() {
  return createTestDirectory("sennel-legacy-agent-artifact-");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("legacy agent-host artifact cleanup", () => {
  let root;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes only the legacy Flow handler and preserves project-owned hooks", () => {
    root = temporaryRoot();
    const handler = path.join(root, ".codex/hooks/sennel-flow-final-response-guard.mjs");
    const config = path.join(root, ".codex/hooks.json");
    fs.mkdirSync(path.dirname(handler), { recursive: true });
    fs.writeFileSync(handler, "legacy handler\n");
    writeJson(config, {
      description: "project hooks",
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "node project-stop.mjs" }] },
          { hooks: [{ type: "command", command: "node .codex/hooks/sennel-flow-final-response-guard.mjs" }] },
        ],
      },
    });

    const result = new LegacyAgentArtifactCleanup(root).run();

    assert.deepEqual(result, {
      removedHandler: true,
      updatedConfig: true,
      removedConfig: false,
    });
    assert.equal(fs.existsSync(handler), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(config, "utf8")), {
      description: "project hooks",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node project-stop.mjs" }] }],
      },
    });
  });

  it("removes an empty legacy-only configuration", () => {
    root = temporaryRoot();
    const config = path.join(root, ".codex/hooks.json");
    writeJson(config, {
      hooks: {
        Stop: [{
          hooks: [{
            type: "command",
            command: "node .codex/hooks/sennel-flow-final-response-guard.mjs",
          }],
        }],
      },
    });

    const result = new LegacyAgentArtifactCleanup(root).run();

    assert.equal(result.removedConfig, true);
    assert.equal(fs.existsSync(config), false);
  });

  it("reports cleanup in dry-run without changing files", () => {
    root = temporaryRoot();
    const handler = path.join(root, ".codex/hooks/sennel-flow-final-response-guard.mjs");
    const config = path.join(root, ".codex/hooks.json");
    fs.mkdirSync(path.dirname(handler), { recursive: true });
    fs.writeFileSync(handler, "legacy handler\n");
    writeJson(config, {
      hooks: {
        Stop: [{
          hooks: [{
            type: "command",
            command: "node .codex/hooks/sennel-flow-final-response-guard.mjs",
          }],
        }],
      },
    });

    const result = new LegacyAgentArtifactCleanup(root).run({ dryRun: true });

    assert.equal(result.removedHandler, true);
    assert.equal(result.updatedConfig, true);
    assert.equal(fs.existsSync(handler), true);
    assert.equal(fs.existsSync(config), true);
  });
});
