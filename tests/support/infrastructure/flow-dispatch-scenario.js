import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";

import { Container, container } from "../../../src/lib/container.js";
import { createTmpDir, removeTmpDir } from "../builders/tmp-dir.js";
import { commitAll, initGitRepo } from "./git-repo.js";
import { WorkerArtifactHandoffRequest } from "../../../src/flow/lib/worker-artifact-handoff.js";

/** Bind a canonical manager and external worker to the production dispatcher. */
export function dispatchContainer({ root, flowManager, agent }) {
  const container = new Container();
  container.register("paths", { root, agentWorkDir: path.join(root, ".tmp") });
  container.register("mainRoot", root);
  container.register("config", {});
  container.register("inWorktree", false);
  container.register("flowManager", flowManager);
  container.register("agent", agent);
  return container;
}

/** Create an isolated repository for a dispatch scenario. */
export function fixtureRepository(prefix) {
  const root = createTmpDir(prefix);
  try {
    fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
    initGitRepo(root);
    fs.writeFileSync(path.join(root, "README.md"), "flow dispatcher fixture\n");
    commitAll(root, "flow dispatcher fixture");
    return root;
  } catch (error) {
    removeTmpDir(root);
    throw error;
  }
}

export function requestInput(request, name) {
  const input = request.inputs.find((entry) => entry.name === name);
  assert.notEqual(input, undefined, `${request.stepId} request must contain ${name}`);
  if (request.stepId === "spec-gate-repair") {
    const payloadPath = requestPayloadPath(request, "spec-gate-repair.json");
    return WorkerArtifactHandoffRequest.readInput({
      requestPath: path.join(path.dirname(path.dirname(payloadPath)), "request.json"), name,
    });
  }
  return input;
}

export function requestPayloadPath(request, logicalName) {
  const payload = request.payloads.find((entry) => entry.logicalName === logicalName);
  assert.notEqual(payload, undefined, `${request.stepId} request must contain ${logicalName}`);
  return payload.payloadPath;
}

/** Fake external Gate responses while preserving real provider admission accounting. */
export function installGateProviderFake(respond, { projectInvocation = null } = {}) {
  const originalGet = container.get.bind(container);
  return mock.method(container, "get", (name) => {
    if (name !== "agent") return originalGet(name);
    return {
      resolve() { return { providerKey: "fixture", profileKey: "fixture" }; },
      ...(projectInvocation === null ? {} : { projectInvocation }),
      async call(prompt, options) {
        const admission = options.providerCallAdmission;
        admission?.claim();
        try {
          await admission?.beforeProviderAttempt({
            attempt: 1, index: 0, maxAttempts: 1,
            providerKey: "fixture", profileKey: "fixture",
          });
          return await respond(prompt, options);
        } finally {
          admission?.settle();
        }
      },
    };
  });
}
