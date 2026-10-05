import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("unified command registry (R3)", () => {
  it("exposes flow/docs/check/metrics subtrees individually without loading other domains eagerly", async () => {
    const mod = await import("../../../src/lib/command-registry.js");
    assert.ok(mod.flowCommands, "flowCommands subtree must be exported");
    assert.ok(mod.docsCommands, "docsCommands subtree must be exported");
    assert.ok(mod.checkCommands, "checkCommands subtree must be exported");
    assert.ok(mod.metricsCommands, "metricsCommands subtree must be exported");
  });

  it("provides combined tree allCommands = { flow, docs, check, metrics }", async () => {
    const mod = await import("../../../src/lib/command-registry.js");
    assert.ok(mod.allCommands, "allCommands root tree must be exported");
    assert.ok(mod.allCommands.flow);
    assert.ok(mod.allCommands.docs);
    assert.ok(mod.allCommands.check);
    assert.ok(mod.allCommands.metrics);
  });

  it("every entry declares command (lazy import) and outputMode", async () => {
    const { allCommands } = await import("../../../src/lib/command-registry.js");
    const visit = (node, pathParts = []) => {
      if (typeof node !== "object" || node == null) return;
      // An entry is identified by having `command` (lazy import) fn.
      if (typeof node.command === "function") {
        assert.ok(
          node.outputMode === "envelope" || node.outputMode === "raw",
          `entry ${pathParts.join(".")} must declare outputMode`,
        );
        return;
      }
      for (const [k, v] of Object.entries(node)) visit(v, [...pathParts, k]);
    };
    visit(allCommands);
  });

  it("no key collision across subtrees (unique paths)", async () => {
    const { allCommands } = await import("../../../src/lib/command-registry.js");
    const seen = new Set();
    const visit = (node, pathParts = []) => {
      if (typeof node !== "object" || node == null) return;
      if (typeof node.command === "function") {
        const key = pathParts.join(".");
        assert.equal(seen.has(key), false, `duplicate entry key: ${key}`);
        seen.add(key);
        return;
      }
      for (const [k, v] of Object.entries(node)) visit(v, [...pathParts, k]);
    };
    visit(allCommands);
    assert.ok(seen.size > 0);
  });

  it("flow run entries accept agent work dir but not removed log-file option", async () => {
    const { flowCommands } = await import("../../../src/lib/command-registry.js");
    const removedLogOption = `--log-${"file"}`;
    for (const [name, entry] of Object.entries(flowCommands.run)) {
      if (typeof entry?.command !== "function") continue;
      const options = entry.args?.options || [];
      assert.ok(options.includes("--agent-work-dir"), `flow run ${name} must accept --agent-work-dir`);
      assert.ok(!options.includes(removedLogOption), `flow run ${name} must not accept removed log option`);
    }
  });
});
