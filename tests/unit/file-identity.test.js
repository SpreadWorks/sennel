import assert from "node:assert/strict";
import { test } from "node:test";
import { FileIdentity } from "../../src/lib/file-identity.js";

test("stored physical generations preserve distinctions beyond Number precision", () => {
  const identity = new FileIdentity({ dev: 9007199254740993n, ino: 18446744073709551615n });
  const restored = FileIdentity.fromStored(JSON.parse(JSON.stringify(identity)));
  assert.deepEqual(restored.toJSON(), { dev: "9007199254740993", ino: "18446744073709551615" });
  assert.equal(identity.equals(restored), true);
  assert.equal(identity.equals(new FileIdentity({ dev: 9007199254740992n, ino: identity.ino })), false);
  assert.equal(identity.equals(new FileIdentity({ dev: identity.dev, ino: identity.ino - 1n })), false);
});

test("native signed file identities round-trip without unsigned aliasing or Number rounding", () => {
  // Node's BigIntStats preserves signed native fields; negative decimal tokens are valid.
  const identity = FileIdentity.capture({ dev: -1n, ino: -9223372036854775803n });
  assert.deepEqual(identity.toJSON(), { dev: "-1", ino: "-9223372036854775803" });
  const restored = FileIdentity.fromStored(JSON.parse(JSON.stringify(identity)));
  assert.equal(restored.dev, -1n);
  assert.equal(restored.ino, -9223372036854775803n);
  assert.equal(identity.equals(restored), true);
  assert.equal(identity.equals(new FileIdentity({ dev: 18446744073709551615n, ino: identity.ino })), false);
  assert.equal(identity.equals(new FileIdentity({ dev: identity.dev, ino: 9223372036854775813n })), false);
  assert.equal(identity.equals(new FileIdentity({ dev: -2n, ino: identity.ino })), false);
  assert.equal(identity.equals(new FileIdentity({ dev: identity.dev, ino: identity.ino - 1n })), false);
  assert.throws(() => FileIdentity.capture({ dev: -1, ino: identity.ino }), TypeError);
  assert.throws(() => FileIdentity.capture({ dev: identity.dev, ino: Number(identity.ino) }), TypeError);
  assert.deepEqual(FileIdentity.fromStored({ dev: "0", ino: "-1" }).toJSON(), { dev: "0", ino: "-1" });
});

test("a stored generation refuses ambiguous numbers, alternate spellings and unknown fields", () => {
  // "-1" was previously rejected here, but Node can legitimately return that signed token.
  for (const value of [{ dev: 1, ino: "2" }, { dev: "01", ino: "2" }, { dev: "-0", ino: "2" },
    { dev: "-01", ino: "2" }, { dev: "+1", ino: "2" }, { dev: " 1", ino: "2" }, { dev: "1 ", ino: "2" },
    { dev: "1e3", ino: "2" }, { dev: "1.0", ino: "2" }, { dev: "0x10", ino: "2" }, { dev: "", ino: "2" },
    { dev: "1\n", ino: "2" }, { dev: "-1\r", ino: "2" }, { dev: "1\u2028", ino: "2" }, { dev: "1\u2029", ino: "2" },
    { dev: "1", ino: "-01" }, { dev: "1", ino: "2", mode: 0o600 }, { dev: "1" }]) {
    assert.throws(() => FileIdentity.fromStored(value), TypeError);
  }
});
