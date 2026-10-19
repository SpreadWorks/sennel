import { getAcceptanceFixtureDir } from "./lib/targets.js";
import { copyFixture, runPipeline } from "./lib/pipeline.js";
import { createSchemaAwareStubProvider, createStubAgent } from "../support/fakes/stub-agent.js";

export async function runStubAcceptance({
  fixtureName = "base",
  getAcceptanceFixtureDir: fixtureFor = getAcceptanceFixtureDir,
  copyFixture: copy = copyFixture,
  createProvider = createSchemaAwareStubProvider,
  runPipeline: pipeline = runPipeline,
  verifyQuality = (provider) => provider.quality(),
} = {}) {
  const fixture = fixtureFor(fixtureName);
  const workRoot = copy(fixture, { type: "base" });
  const tmp = workRoot.root;
  try {
    const provider = createProvider();
    const result = pipeline === runPipeline
      ? await pipeline(tmp, { agent: createStubAgent(provider) })
      : await pipeline(tmp, provider);
    return { ...result, quality: verifyQuality(provider) };
  } finally {
    workRoot.cleanup();
  }
}

export function createStubPipeline(provider) {
  return (tmp) => runPipeline(tmp, { agent: createStubAgent(provider) });
}
