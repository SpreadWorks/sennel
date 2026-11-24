/**
 * tests/acceptance/lib/test-template.js
 *
 * Shared test factory for acceptance tests.
 * Creates a standard test suite for a given preset.
 * Collects pipeline, directive, and quality data into a report JSON.
 */

import { after, describe, it } from "node:test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { copyFixture, runPipeline } from "./pipeline.js";
import {
  assertStructure,
  detectUnfilledDirectives,
  detectExposedDirectives,
} from "./assertions.js";

function resolveFixtureDir(presetName, opts) {
  const fixtureDir = opts?.fixtureDir;
  if (!fixtureDir) {
    throw new Error(`fixtureDir is required for acceptance preset: ${presetName}`);
  }
  if (fixtureDir instanceof URL) {
    return path.resolve(fileURLToPath(fixtureDir));
  }
  return path.resolve(String(fixtureDir));
}

export function writeReport(reportPath, report) {
  const dir = path.dirname(reportPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

export function persistReport(projectRoot, report) {
  const reportPath = path.join(
    projectRoot,
    ".sennel",
    "output",
    `acceptance-report-${report.preset}.json`,
  );
  writeReport(reportPath, report);
  return reportPath;
}

/**
 * Preserve fixture-specific docs and scan settings in deterministic acceptance
 * tests. Real provider evaluation belongs exclusively to tests/agent.
 */
export function acceptanceFixtureConfigOverrides(configOverrides = {}) {
  return { ...configOverrides, agent: null };
}

export function acceptanceTest(presetName, opts) {
  const { configOverrides, agent = null } = opts || {};
  const fixtureDir = resolveFixtureDir(presetName, opts);

  describe(`acceptance: ${presetName}`, { timeout: 600000 }, () => {
    let tmp;
    let workRoot;
    after(() => {
      workRoot?.cleanup();
      workRoot = null;
      tmp = null;
    });

    it("pipeline completes and passes all checks", async () => {
      workRoot = copyFixture(fixtureDir, acceptanceFixtureConfigOverrides(configOverrides));
      tmp = workRoot.root;

      const { ctx, steps } = await runPipeline(tmp, { agent });

      const { files } = assertStructure(ctx.docsDir);
      const unfilled = detectUnfilledDirectives(ctx.docsDir, files);
      const exposed = detectExposedDirectives(ctx.docsDir, files);

      if (unfilled.length > 0) {
        console.log(`  [directives] ${unfilled.length} unfilled directive(s):`);
        for (const d of unfilled) {
          console.log(`    ${d.file}:${d.line}`);
        }
      }
      if (exposed.length > 0) {
        console.log(`  [directives] ${exposed.length} exposed directive(s):`);
        for (const d of exposed) {
          console.log(`    ${d.file}:${d.line}`);
        }
      }

      const report = {
        preset: presetName,
        timestamp: new Date().toISOString(),
        pipeline: { steps },
        directives: { unfilled, exposed },
        quality: "deterministic checks passed",
      };

      const reportPath = path.join(
        tmp,
        ".sennel",
        "output",
        "acceptance-report.json",
      );
      writeReport(reportPath, report);
      console.log(`  [report] written to ${reportPath}`);


    });

  });
}
