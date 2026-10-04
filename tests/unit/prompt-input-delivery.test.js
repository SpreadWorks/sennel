import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PromptInputDeliveryDecision } from "../../src/lib/prompt-input-delivery.js";
import { PromptLogicalFootprint, PromptRequestLimit, ResolvedAgentInvocationProjection } from "../../src/lib/prompt-batching.js";

describe("shared prompt input delivery", () => {
  it("chooses inline at the completed request boundary and file immediately above it", () => {
    const inlineRequest = { systemPrompt: "system", userPrompt: "selected body",
      jsonSchema: { type: "object", properties: { result: { type: "string" } } }, fmtFallback: "JSON only" };
    const characters = PromptLogicalFootprint.measure(inlineRequest).total;
    const fileRequest = { userPrompt: "reference" };
    for (const [maximum, expected] of [[characters, "inline"], [characters - 1, "file"]]) {
      const decide = () => PromptInputDeliveryDecision.select({ inlineRequest, fileRequest,
        limit: new PromptRequestLimit({ maxCharacters: maximum }) });
      assert.equal(decide().mode, expected);
      assert.equal(decide().request, expected === "inline" ? inlineRequest : fileRequest);
      assert.equal(decide().mode, decide().mode);
    }
  });

  it("includes provider command expansion when selecting the same logical input delivery", () => {
    const inlineRequest = { userPrompt: "\\\"".repeat(20) };
    const fileRequest = { userPrompt: "read file" };
    const projectInvocation = (request) => new ResolvedAgentInvocationProjection({
      providerKey: "fixture", profileKey: "worker", command: "fixture-worker",
      promptCharacterCount: JSON.stringify(request.userPrompt).length, systemPromptCharacterCount: 0,
      schemaCharacterCount: 0, finalArgs: [JSON.stringify(request.userPrompt)], inlineArgvByteCount: 0,
      schemaMode: "none", usesStdin: false,
    });
    const decision = PromptInputDeliveryDecision.select({ inlineRequest, fileRequest,
      limit: new PromptRequestLimit({ maxCharacters: 50 }), projectInvocation });
    assert.equal(PromptLogicalFootprint.measure(inlineRequest).total, 40);
    assert.equal(decision.mode, "file");
    assert.equal(decision.request, fileRequest);
  });

  it("rejects a reference whose completed logical or command prompt still exceeds the limit", () => {
    for (const projectInvocation of [null, () => ({ fits: () => false })]) {
      assert.throws(() => PromptInputDeliveryDecision.select({ inlineRequest: "large input".repeat(100),
        fileRequest: { systemPrompt: "fixed".repeat(20), userPrompt: "reference" },
        limit: new PromptRequestLimit({ maxCharacters: 30 }), projectInvocation }),
      { code: "PROMPT_FIXED_CONTEXT_TOO_LARGE" });
    }
  });

  it("retains the provider overflow cause when a bounded file reference cannot fit its command", () => {
    const projectInvocation = () => new ResolvedAgentInvocationProjection({
      providerKey: "fixture", profileKey: "worker", command: "fixture-worker",
      promptCharacterCount: 101, systemPromptCharacterCount: 0, schemaCharacterCount: 0,
      finalArgs: ["reference"], inlineArgvByteCount: 0, schemaMode: "none", usesStdin: false,
    });
    assert.throws(() => PromptInputDeliveryDecision.select({ inlineRequest: "selected input",
      fileRequest: "reference", limit: new PromptRequestLimit({ maxCharacters: 100 }), projectInvocation }),
    { code: "PROMPT_INVOCATION_PROJECTION_OVERFLOW" });
  });

  it("does not ask a file owner to create storage when the inline request fits", () => {
    const decision = PromptInputDeliveryDecision.select({ inlineRequest: "body",
      fileRequest: () => assert.fail("file lifetime is owned only after a file decision"),
      limit: new PromptRequestLimit({ maxCharacters: 10 }) });
    assert.equal(decision.mode, "inline");
  });
});
