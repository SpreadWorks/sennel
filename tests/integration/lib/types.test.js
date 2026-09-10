import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../src/lib/config.js";

describe("validate (config)", () => {
  const validConfig = {
    lang: "ja",
    type: "sample-node-command",
    docs: { languages: ["ja"], defaultLanguage: "ja" },
  };

  it("accepts minimal valid config", () => {
    const result = validate({ ...validConfig });
    assert.equal(result.lang, "ja");
    assert.equal(result.type, "sample-node-command");
  });

  it("throws on non-object input", () => {
    assert.throws(() => validate(null), /non-null object/);
    assert.throws(() => validate("string"), /non-null object/);
  });

  it("throws when lang is missing", () => {
    assert.throws(() => validate({ type: "sample-command", docs: { languages: ["ja"], defaultLanguage: "ja" } }), /lang/);
  });

  it("throws when type is missing", () => {
    assert.throws(() => validate({ lang: "ja", docs: { languages: ["ja"], defaultLanguage: "ja" } }), /type/);
  });

  it("throws when docs is missing", () => {
    assert.throws(() => validate({ lang: "ja", type: "sample-command" }), /docs/);
  });

  it("accepts type as array of strings", () => {
    const cfg = { ...validConfig, type: ["sample-preset", "sample-db"] };
    const result = validate(cfg);
    assert.deepEqual(result.type, ["sample-preset", "sample-db"]);
  });

  it("rejects empty type array", () => {
    assert.throws(
      () => validate({ ...validConfig, type: [] }),
      /type/,
    );
  });

  it("rejects non-string entries in type array", () => {
    assert.throws(
      () => validate({ ...validConfig, type: ["sample-preset", 123] }),
      /type/,
    );
  });

  it("validates docs.style", () => {
    const cfg = {
      ...validConfig,
      docs: { ...validConfig.docs, style: { purpose: "developer-guide", tone: "polite" } },
    };
    const result = validate(cfg);
    assert.equal(result.docs.style.purpose, "developer-guide");
  });

  it("rejects invalid docs.style tone", () => {
    assert.throws(
      () => validate({
        ...validConfig,
        docs: { ...validConfig.docs, style: { purpose: "x", tone: "invalid" } },
      }),
      /tone/,
    );
  });

  it("validates agent.providers", () => {
    const cfg = {
      ...validConfig,
      agent: { providers: { claude: { command: "claude", args: ["-p", "{{PROMPT}}"] } } },
    };
    const result = validate(cfg);
    assert.deepEqual(result.agent.providers.claude.args, ["-p", "{{PROMPT}}"]);
  });

  it("validates agent.retryCount", () => {
    const cfg = {
      ...validConfig,
      agent: { retryCount: 3 },
    };
    const result = validate(cfg);
    assert.equal(result.agent.retryCount, 3);
  });

  it("rejects invalid agent.retryCount", () => {
    assert.throws(
      () => validate({ ...validConfig, agent: { retryCount: 0 } }),
      /retryCount/i,
    );
  });

  it("validates agent.promptCharacterLimit as an integer from 1000 through 120000", () => {
    assert.equal(
      validate({ ...validConfig, agent: { promptCharacterLimit: 1_000 } }).agent.promptCharacterLimit,
      1_000,
    );
    assert.equal(
      validate({ ...validConfig, agent: { promptCharacterLimit: 120_000 } }).agent.promptCharacterLimit,
      120_000,
    );

    for (const promptCharacterLimit of [999, 120_001, 1_000.5]) {
      assert.throws(
        () => validate({ ...validConfig, agent: { promptCharacterLimit } }),
        /promptCharacterLimit/,
      );
    }
  });

  it("rejects the retired agent.batchTokenLimit field", () => {
    assert.throws(
      () => validate({ ...validConfig, agent: { batchTokenLimit: 10_000 } }),
      /agent\.batchTokenLimit.*agent\.promptCharacterLimit/,
    );
  });

  it("rejects agent.providers entry without command", () => {
    assert.throws(
      () => validate({ ...validConfig, agent: { providers: { bad: { args: [] } } } }),
      /command/,
    );
  });

  it("validates flow config", () => {
    const cfg = { ...validConfig, flow: { merge: "squash" } };
    assert.equal(validate(cfg).flow.merge, "squash");
  });

  it("rejects invalid flow merge strategy", () => {
    assert.throws(
      () => validate({ ...validConfig, flow: { merge: "rebase" } }),
      /merge/i,
    );
  });

  it("validates docs config with multiple languages", () => {
    const cfg = {
      ...validConfig,
      docs: { languages: ["ja", "en"], defaultLanguage: "ja" },
    };
    const result = validate(cfg);
    assert.deepEqual(result.docs.languages, ["ja", "en"]);
  });

  it("rejects docs.defaultLanguage not in languages", () => {
    assert.throws(
      () => validate({
        ...validConfig,
        docs: { languages: ["ja"], defaultLanguage: "en" },
      }),
      /defaultLanguage/,
    );
  });

  it("rejects unknown fields", () => {
    assert.throws(
      () => validate({ ...validConfig, unknownField: "value" }),
      /unknownField/,
    );
  });

  it("rejects deprecated fields", () => {
    assert.throws(
      () => validate({ ...validConfig, output: { default: "ja" } }),
      /deprecated/i,
    );
  });
});
