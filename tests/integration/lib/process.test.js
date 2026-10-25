import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCmd, runCmdAsync, formatError } from "../../../src/lib/process.js";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";

class ProcessFixture {
  constructor(t) {
    this.root = createTmpDir("process-api-");
    this.retained = false;
    t.after(() => { if (!this.retained) fs.rmSync(this.root, { recursive: true, force: true }); });
  }

  runCmd(command, args, options = {}) {
    try { return runCmd(command, args, { cwd: this.root, ...options }); }
    catch (error) {
      this.retained = testTemporaryRoot().retainOnUnconfirmedExecution(error) || this.retained;
      throw error;
    }
  }

  async runCmdAsync(command, args, options = {}) {
    try { return await runCmdAsync(command, args, { cwd: this.root, ...options }); }
    catch (error) {
      this.retained = testTemporaryRoot().retainOnUnconfirmedExecution(error) || this.retained;
      throw error;
    }
  }
}


describe("runCmd", () => {
  it("returns ok=true for successful command", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "console.log('hello')"]);
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /hello/);
  });

  it("returns ok=false for failing command", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "process.exit(1)"]);
    assert.equal(result.ok, false);
    assert.equal(result.status, 1);
  });

  it("captures stderr on failure", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "console.error('err'); process.exit(1)"]);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /err/);
  });

  it("respects cwd option", (t) => {
    const fixture = new ProcessFixture(t);
    const selected = path.join(fixture.root, "selected-cwd");
    fs.mkdirSync(selected);
    const result = fixture.runCmd(process.execPath, ["-e", "console.log(process.cwd())"], { cwd: selected });
    assert.equal(result.ok, true);
    assert.equal(result.stdout.trim(), fs.realpathSync(selected));
  });

  it("returns string for stdout and stderr", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "console.log('test')"]);
    assert.equal(typeof result.stdout, "string");
    assert.equal(typeof result.stderr, "string");
  });

  it("preserves stdout and stderr bytes when buffer encoding is requested", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xff])); process.stderr.write(Buffer.from([0xfe]))"], {
      encoding: "buffer",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.stdout, Buffer.from([0xff]));
    assert.deepEqual(result.stderr, Buffer.from([0xfe]));
  });

  it("handles non-existent command gracefully", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd("nonexistent_command_xyz_12345", []);
    assert.equal(result.ok, false);
    assert.notEqual(result.status, 0);
  });

  it("returns status code other than 0 or 1", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "process.exit(42)"]);
    assert.equal(result.ok, false);
    assert.equal(result.status, 42);
  });

  it("respects timeout option", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
      timeout: 100,
    });
    assert.equal(result.ok, false);
  });

  it("handles empty args", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, []);
    assert.equal(result.ok, true);
    assert.equal(typeof result.stdout, "string");
  });

  it("handles large output", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, [
      "-e",
      "for(let i=0;i<1000;i++)console.log('line'+i)",
    ]);
    assert.equal(result.ok, true);
    assert.ok(result.stdout.includes("line999"));
  });

  it("defaults to utf8 encoding", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "console.log('café')"]);
    assert.equal(result.ok, true);
    assert.ok(result.stdout.includes("café"));
  });

  it("captures stderr on success", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "console.error('ERR')"]);
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /ERR/);
  });

  it("returns signal=null and killed=false on success", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "console.log('hello')"]);
    assert.equal(result.signal, null);
    assert.equal(result.killed, false);
  });

  it("returns signal=null and killed=false on non-signal failure", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "process.exit(1)"]);
    assert.equal(result.ok, false);
    assert.equal(result.signal, null);
    assert.equal(result.killed, false);
  });

  it("returns signal name on timeout (killed may be false for ETIMEDOUT)", (t) => {
    const fixture = new ProcessFixture(t);
    const result = fixture.runCmd(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
      timeout: 100,
    });
    assert.equal(result.ok, false);
    assert.ok(result.signal !== null, "signal should be non-null on timeout");
    assert.equal(typeof result.killed, "boolean");
  });
});

describe("runCmdAsync", () => {
  it("returns ok=true for successful command", async (t) => {
    const fixture = new ProcessFixture(t);
    const result = await fixture.runCmdAsync(process.execPath, ["-e", "console.log('hello')"]);
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /hello/);
  });

  it("returns ok=false for failing command", async (t) => {
    const fixture = new ProcessFixture(t);
    const result = await fixture.runCmdAsync(process.execPath, ["-e", "process.exit(1)"]);
    assert.equal(result.ok, false);
  });

  it("handles non-existent command gracefully", async (t) => {
    const fixture = new ProcessFixture(t);
    const result = await fixture.runCmdAsync("nonexistent_command_xyz_12345", []);
    assert.equal(result.ok, false);
  });

  it("returns signal=null and killed=false on success", async (t) => {
    const fixture = new ProcessFixture(t);
    const result = await fixture.runCmdAsync(process.execPath, ["-e", "console.log('hello')"]);
    assert.equal(result.signal, null);
    assert.equal(result.killed, false);
  });

  it("returns signal=null and killed=false on non-signal failure", async (t) => {
    const fixture = new ProcessFixture(t);
    const result = await fixture.runCmdAsync(process.execPath, ["-e", "process.exit(1)"]);
    assert.equal(result.ok, false);
    assert.equal(result.signal, null);
    assert.equal(result.killed, false);
  });

  it("returns numeric status for ENOENT error", async (t) => {
    const fixture = new ProcessFixture(t);
    const result = await fixture.runCmdAsync("nonexistent_command_xyz_12345", []);
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
