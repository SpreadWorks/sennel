import assert from "node:assert/strict";
import { it } from "node:test";
import { FileIdentity } from "../../src/lib/file-identity.js";
import { FilePermissionHint } from "../../src/lib/regular-file-snapshot.js";
import { SourceWorkingFile } from "../../src/flow/lib/source-working-file.js";
import { SourceWorkingFileCapture } from "../../src/flow/lib/source-working-file-capture.js";

const working = () => new SourceWorkingFile({ kind: "file", digest: "a".repeat(64), generation: new FileIdentity({ dev: 1n, ino: 2n }) });

it("matches the native POSIX owner-execute contract independently of group and other bits", () => {
  for (const platform of ["linux", "darwin"]) {
    for (const execute of [0, 1, 8, 9, 64, 65, 72, 73]) {
      const observed = new SourceWorkingFileCapture(working(), null, new FilePermissionHint(0o6644 | execute));
      assert.equal(observed.observeGitMode({ platform, observeNative: () => assert.fail("POSIX metadata is sufficient") }),
        execute >= 64 ? "100755" : "100644");
    }
  }
});

it("uses the full native Windows observation even when Node permissions suggest another mode", () => {
  for (const [permission, native] of [[0o755, "100644"], [0o644, "100755"]]) {
    const observed = new SourceWorkingFileCapture(working(), null, new FilePermissionHint(permission));
    let calls = 0;
    assert.equal(observed.observeGitMode({ platform: "win32", observeNative: () => { calls++; return native; } }), native);
    assert.equal(calls, 1);
  }
  const observed = new SourceWorkingFileCapture(working(), null, new FilePermissionHint(0o644));
  const failure = new Error("native Git mode acquisition refused");
  assert.throws(() => observed.observeGitMode({ platform: "win32", observeNative() { throw failure; } }), (error) => error === failure);
});

it("refuses to infer Git mode from a source value without its captured permission metadata", () => {
  const observed = new SourceWorkingFileCapture(working(), null);
  assert.throws(() => observed.observeGitMode({ platform: "linux", observeNative: () => assert.fail("not a fresh regular-file observation") }),
    /requires captured regular-file permission metadata/);
  assert.throws(() => new SourceWorkingFileCapture(working(), null, { mode: 0o755 }), /requires a regular-file observation/);
});
