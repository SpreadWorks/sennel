import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadMergedGuardrails, loadGuardrailFile } from "../../../src/lib/guardrail.js";
import path from "node:path";
import { createTmpDir, removeTmpDir, writeJson } from "../../support/builders/tmp-dir.js";

function installPresetPlugin(root) {
  writeJson(root, ".sennel/config.json", {
    lang: "en",
    type: ["node-cli", "greenfield", "document"],
    docs: { languages: ["en"], defaultLanguage: "en" },
    plugin: {
      sources: [{
        id: "official-presets",
        type: "git",
        url: "git@github.com:SpreadWorks/sennel-presets.git",
      }],
      packages: [{
        id: "official-presets",
        source: "official-presets",
        commit: "31bdd70fecfcde33c32bd75909218b744561c24e",
      }],
    },
  });
  writeJson(root, ".sennel/plugins/official-presets/plugin.json", {
    name: "official-presets",
    type: "preset",
    files: ["plugin.json", "presets/"],
    contributions: {
      presets: [
        { key: "cli", path: "presets/cli", parent: "base" },
        { key: "node-cli", path: "presets/node-cli", parent: "cli" },
        { key: "greenfield", path: "presets/greenfield", parent: "base" },
        { key: "document", path: "presets/document", parent: "base" },
      ],
    },
  });
  writeJson(root, ".sennel/plugins/official-presets/presets/cli/preset.json", {
    parent: "base",
    chapters: [],
  });
  writeJson(root, ".sennel/plugins/official-presets/presets/node-cli/preset.json", {
    parent: "cli",
    chapters: [],
  });
  for (const key of ["greenfield", "document"]) {
    writeJson(root, `.sennel/plugins/official-presets/presets/${key}/preset.json`, {
      parent: "base",
      chapters: [],
    });
  }
  writeJson(root, ".sennel/plugins/official-presets/presets/node-cli/guardrail.json", {
    guardrails: [{
      id: "plugin-preset-guardrail",
      title: "Plugin preset guardrail",
      body: "This guardrail is contributed by the enabled project plugin.",
      meta: { phase: ["spec"], category: "requirements" },
    }],
  });
}

describe("guardrail preset resolution", () => {
  let tmp;

  afterEach(() => {
    if (tmp) removeTmpDir(tmp);
    tmp = null;
  });

  it("rejects an atomic guardrail body at the global hard cap without truncating it", () => {
    tmp = createTmpDir("sennel-guardrail-cap-");
    const entry = { id: "body-boundary", title: "Boundary", body: "x".repeat(119999), meta: { category: "requirements" } };
    writeJson(tmp, "guardrail.json", { guardrails: [entry] });
    assert.equal(loadGuardrailFile(path.join(tmp, "guardrail.json"))[0].body.length, 119999);
    entry.body += "x";
    writeJson(tmp, "guardrail.json", { guardrails: [entry] });
    assert.throws(() => loadGuardrailFile(path.join(tmp, "guardrail.json")), (error) =>
      error.code === "PROMPT_ELEMENT_TOO_LARGE" && error.details.elementId.includes("body-boundary"));
  });

  it("checks the complete body again after adding the canonical exception clause", () => {
    tmp = createTmpDir("sennel-guardrail-augmented-cap-");
    writeJson(tmp, ".sennel/guardrail.json", { guardrails: [{
      id: "bounded-resource-usage", title: "Boundary", body: "x".repeat(119999), meta: { category: "requirements" },
    }] });
    assert.throws(() => loadMergedGuardrails(tmp), (error) =>
      error.code === "PROMPT_ELEMENT_TOO_LARGE" && error.details.elementId.includes("acknowledged-exception augmentation"));
  });

  it("resolves configured plugin preset chains from the execution root", () => {
    tmp = createTmpDir("sennel-guardrail-preset-");
    installPresetPlugin(tmp);

    const guardrails = loadMergedGuardrails(tmp);

    assert.ok(
      guardrails.some((guardrail) => guardrail.id === "plugin-preset-guardrail"),
      "guardrails from the configured leaf preset must be loaded",
    );
  });
});
