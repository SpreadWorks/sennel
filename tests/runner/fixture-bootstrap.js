// The runner registers this Node test host. Fixtures model independent user
// invocations and mint their own checkout authority; the host registration
// remains owned by the runner until this process actually exits.
await import("../../src/sennel.js");
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase() === "SENNEL_PROCESS_EXECUTION_SCOPE") delete process.env[key];
}
