/**
 * tests/agent/acceptance/quality.test.js
 *
 * Opt-in real-provider quality evaluation. This is intentionally the only
 * caller of verifyWithAI: deterministic acceptance never resolves a provider.
 */

import { after, describe, it } from "node:test";
import { copyFixture, runPipeline } from "../../acceptance/lib/pipeline.js";
import { getAcceptanceFixtureDir } from "../../acceptance/lib/targets.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { verifyWithAI } from "./ai-verify.js";

describe("agent acceptance quality", { timeout: 600000 }, () => {
  const configOverrides = {
    type: "base",
    agent: { default: "codex/gpt-5.6-terra-medium", timeout: 240, retryCount: 1 },
  };
  const workRoot = copyFixture(getAcceptanceFixtureDir("base"), configOverrides);
  after(() => workRoot.cleanup());
  const root = workRoot.root;
  initGitRepo(root);
  commitAll(root, "agent acceptance fixture");

  it("evaluates generated base documentation with the configured real provider", async () => {
    const { ctx } = await runPipeline(root);
    await verifyWithAI(root, ctx.config, "base");
  });
});
