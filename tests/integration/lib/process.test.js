import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCmd, runCmdAsync, formatError } from "../../../src/lib/process.js";

describe("runCmd", () => {
  it("returns ok=true for successful command", () => {
    const result = runCmd("echo", ["hello"]);
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /hello/);
  });

  it("returns ok=false for failing command", () => {
    const result = runCmd("node", ["-e", "process.exit(1)"]);
    assert.equal(result.ok, false);
    assert.equal(result.status, 1);
  });

  it("captures stderr on failure", () => {
    const result = runCmd("node", ["-e", "console.error('err'); process.exit(1)"]);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /err/);
  });

  it("respects cwd option", () => {
    const result = runCmd("pwd", [], { cwd: "/tmp" });
    assert.equal(result.ok, true);
    assert.match(result.stdout, /tmp/);
  });

  it("returns string for stdout and stderr", () => {
    const result = runCmd("echo", ["test"]);
    assert.equal(typeof result.stdout, "string");
    assert.equal(typeof result.stderr, "string");
  });

  it("preserves stdout and stderr bytes when buffer encoding is requested", () => {
    const result = runCmd("node", ["-e", "process.stdout.write(Buffer.from([0xff])); process.stderr.write(Buffer.from([0xfe]))"], {
      encoding: "buffer",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.stdout, Buffer.from([0xff]));
    assert.deepEqual(result.stderr, Buffer.from([0xfe]));
  });

  it("handles non-existent command gracefully", () => {
    const result = runCmd("nonexistent_command_xyz_12345", []);
    assert.equal(result.ok, false);
    assert.notEqual(result.status, 0);
  });

  it("returns status code other than 0 or 1", () => {
    const result = runCmd("node", ["-e", "process.exit(42)"]);
    assert.equal(result.ok, false);
    assert.equal(result.status, 42);
  });

  it("respects timeout option", () => {
    const result = runCmd("node", ["-e", "setTimeout(()=>{},10000)"], {
      timeout: 100,
    });
    assert.equal(result.ok, false);
  });

  it("handles empty args", () => {
    const result = runCmd("echo", []);
    assert.equal(result.ok, true);
    assert.equal(typeof result.stdout, "string");
  });

  it("handles large output", () => {
    const result = runCmd("node", [
      "-e",
      "for(let i=0;i<1000;i++)console.log('line'+i)",
    ]);
    assert.equal(result.ok, true);
    assert.ok(result.stdout.includes("line999"));
  });

  it("defaults to utf8 encoding", () => {
    const result = runCmd("echo", ["café"]);
    assert.equal(result.ok, true);
    assert.ok(result.stdout.includes("café"));
  });

  it("captures stderr on success", () => {
    const result = runCmd("node", ["-e", "console.error('ERR')"]);
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /ERR/);
  });

  it("returns signal=null and killed=false on success", () => {
    const result = runCmd("echo", ["hello"]);
    assert.equal(result.signal, null);
    assert.equal(result.killed, false);
  });

  it("returns signal=null and killed=false on non-signal failure", () => {
    const result = runCmd("node", ["-e", "process.exit(1)"]);
    assert.equal(result.ok, false);
    assert.equal(result.signal, null);
    assert.equal(result.killed, false);
  });

  it("returns signal name on timeout (killed may be false for ETIMEDOUT)", () => {
    const result = runCmd("node", ["-e", "setTimeout(()=>{},10000)"], {
      timeout: 100,
    });
    assert.equal(result.ok, false);
    assert.ok(result.signal !== null, "signal should be non-null on timeout");
    assert.equal(typeof result.killed, "boolean");
  });
});

describe("runCmdAsync", () => {
  it("returns ok=true for successful command", async () => {
    const result = await runCmdAsync("echo", ["hello"]);
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /hello/);
  });

  it("returns ok=false for failing command", async () => {
    const result = await runCmdAsync("node", ["-e", "process.exit(1)"]);
    assert.equal(result.ok, false);
  });

  it("handles non-existent command gracefully", async () => {
    const result = await runCmdAsync("nonexistent_command_xyz_12345", []);
    assert.equal(result.ok, false);
  });

  it("returns signal=null and killed=false on success", async () => {
    const result = await runCmdAsync("echo", ["hello"]);
    assert.equal(result.signal, null);
    assert.equal(result.killed, false);
  });

  it("returns signal=null and killed=false on non-signal failure", async () => {
    const result = await runCmdAsync("node", ["-e", "process.exit(1)"]);
    assert.equal(result.ok, false);
    assert.equal(result.signal, null);
    assert.equal(result.killed, false);
  });

  it("returns numeric status for ENOENT error", async () => {
    const result = await runCmdAsync("nonexistent_command_xyz_12345", []);
    assert.equal(result.ok, false);
    assert.equal(typeof result.status, "number");
    assert.equal(result.status, 1);
  });
});

describe("formatError", () => {
  it("formats signal with killed flag", () => {
    const res = { signal: "SIGKILL", killed: true, status: 137, stderr: "Killed" };
    const out = formatError(res);
    assert.equal(out, "signal=SIGKILL (killed) | exit=137 | Killed");
  });

  it("formats signal without killed flag", () => {
    const res = { signal: "SIGTERM", killed: false, status: 143, stderr: "Terminated" };
    const out = formatError(res);
    assert.equal(out, "signal=SIGTERM | exit=143 | Terminated");
  });

  it("formats exit code only when no signal", () => {
    const res = { signal: null, killed: false, status: 1, stderr: "error output" };
    const out = formatError(res);
    assert.equal(out, "exit=1 | error output");
  });

  it("omits stderr part when stderr is empty", () => {
    const res = { signal: null, killed: false, status: 1, stderr: "" };
    const out = formatError(res);
    assert.equal(out, "exit=1");
  });

  it("omits stderr part for signal with empty stderr", () => {
    const res = { signal: "SIGKILL", killed: true, status: 137, stderr: "" };
    const out = formatError(res);
    assert.equal(out, "signal=SIGKILL (killed) | exit=137");
  });
});
