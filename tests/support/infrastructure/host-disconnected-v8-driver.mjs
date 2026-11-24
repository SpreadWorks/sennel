import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, targetRoot, factsPath, mode, mainRoot] = process.argv.slice(2);
assert.equal(mode, "closed");
assert.equal(mainRoot, targetRoot);
const load = relative => import(pathToFileURL(path.join(packageRoot, relative)));
// The runner preloads this exact package's genuine src/sennel.js. Importing
// unproven runtime modules instead must continue to refuse execution.
const { currentRuntimePackage } = await load("src/lib/runtime-package.js");
const sourcePackageRevision = currentRuntimePackage().revision;
assert.equal(sourcePackageRevision, "1f06da0d3a4426ad41cf2980bee7693bf8362149142e4759db1ded65240cf20a");
const { ProcessExecutionCoordinator } = await load("src/lib/process-execution-runtime.js");
const { ReadOnlyInvocationWorkspace } = await load("src/lib/readonly-invocation-workspace.js");
const { ProcessExecutionControlEndpoint } = await load("src/lib/process-execution-endpoint.js");
const { AtomicFile } = await load("src/lib/atomic-file.js");

fs.mkdirSync(targetRoot);
const workspace = ReadOnlyInvocationWorkspace.create();
const endpoint = ProcessExecutionControlEndpoint.create(workspace.processRuntimeStorage(), targetRoot).toJSON();
const coordinator = new ProcessExecutionCoordinator({ mainRoot: targetRoot, endpoint,
  publishResponse(response) {
    new AtomicFile(path.join(endpoint.mailbox.responses, `${response.requestId}.json`))
      .write(JSON.stringify(response), { exclusive: true });
  } });

// Exercise the in-process production host-loss entry before any request. The
// producer's observed native exit is separate from coordinator IPC death.
await coordinator.hostDisconnected();
assert.equal(coordinator.closed, true);
assert.equal(coordinator.released, true);
assert.equal(coordinator.store.ownerLock.inspect(), null);
const directory = coordinator.store.authority.directory;
const bytes = fs.readFileSync(path.join(directory, "registry.json"));
const stored = JSON.parse(bytes).payload;
assert.equal(stored.version, 8);
assert.equal(stored.slot, null);
assert.equal(stored.executions.length, 1);
assert.deepEqual(stored.executions[0].calls, []);
assert.deepEqual(stored.executions[0].requests, []);
assert.equal(stored.executions[0].status, "closed");
assert.equal(stored.executions[0].closure.recovery, true);
assert.equal(fs.existsSync(path.join(directory, "requests")), false);
assert.equal(workspace.pendingExecutionCount, 0);
const generation = workspace.generation;
// No child execution was begun in this endpoint-only workspace. The actual
// in-process invocation returned and released its physical exclusion.
workspace.complete({ generation, normalExit: true, resourcesReleased: true });
workspace.cleanup({ generation });
assert.equal(fs.existsSync(workspace.path), false);
fs.writeFileSync(factsPath, JSON.stringify({ sourcePackageRevision, directory,
  registryBytesBase64: bytes.toString("base64"), endpointWorkspaceCleaned: true,
  producerRoute: "in-process-coordinator-host-disconnection-before-requests" }) + "\n", { flag: "wx" });
