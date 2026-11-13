import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FileIdentity, RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const invalid = { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" };

function fixture(t) {
  const root = createTmpDir("directory-identity-");
  t.after(() => removeTmpDir(root));
  const directory = path.join(root, "owned");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "sentinel"), "retained");
  return { directory, parentAuthority: new RealDirectoryAuthority(root) };
}

// These injected native observations test numeric boundaries, not OS support.
function observe(t, directory, transform) {
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (target, options) => {
    const stat = lstat(target, options);
    return target === directory ? transform(stat, options?.bigint === true) : stat;
  });
}

test("directory authorities retain the host's exact bigint identity with safe numeric observations", (t) => {
  const { directory, parentAuthority } = fixture(t);
  const expected = fs.lstatSync(directory, { bigint: true });
  const numeric = fs.lstatSync(directory);
  let bigintCalls = 0;
  observe(t, directory, (stat, bigint) => { if (bigint) bigintCalls++; return stat; });
  const authority = new RealDirectoryAuthority(directory, { parentAuthority });
  assert.equal(authority.assertStable(), directory);
  assert.ok(authority.identity instanceof FileIdentity);
  assert.equal(authority.identity.dev, expected.dev);
  assert.equal(authority.identity.ino, expected.ino);
  if (Number.isSafeInteger(numeric.dev) && numeric.dev >= 0
    && Number.isSafeInteger(numeric.ino) && numeric.ino >= 0) assert.equal(bigintCalls, 0);
  assert.throws(() => new FileIdentity(numeric), TypeError);
});

for (const value of [0, Number.MAX_SAFE_INTEGER]) {
  test(`safe identity boundary ${value} is retained exactly without bigint lstat`, (t) => {
    const { directory, parentAuthority } = fixture(t);
    let bigintCalls = 0;
    observe(t, directory, (stat, bigint) => {
      if (bigint) bigintCalls++;
      stat.dev = bigint ? BigInt(value) : value;
      stat.ino = bigint ? BigInt(value) : value;
      return stat;
    });
    const authority = new RealDirectoryAuthority(directory, { parentAuthority });
    assert.equal(authority.assertStable(), directory);
    assert.equal(authority.identity.dev, BigInt(value));
    assert.equal(authority.identity.ino, BigInt(value));
    assert.equal(bigintCalls, 0);
  });
}

for (const field of ["dev", "ino"]) {
  test(`unsafe ${field} observations cannot alias adjacent exact identities`, (t) => {
    const { directory, parentAuthority } = fixture(t);
    let exact = 9007199254740992n;
    let bigintCalls = 0;
    observe(t, directory, (stat, bigint) => {
      if (bigint) bigintCalls++;
      stat[field] = bigint ? exact : Number(exact);
      return stat;
    });
    const authority = new RealDirectoryAuthority(directory, { parentAuthority });
    assert.equal(authority.assertStable(), directory);
    assert.equal(authority.identity[field], exact);
    assert.ok(bigintCalls > 0);
    exact++;
    assert.equal(Number(exact), Number(exact - 1n));
    assert.throws(() => authority.assertStable(), invalid);
    assert.equal(authority.identity[field], exact - 1n);
    assert.equal(fs.readFileSync(path.join(directory, "sentinel"), "utf8"), "retained");
  });
}

test("unsafe native high-bit identity retains Node's signed bigint token", (t) => {
  const { directory, parentAuthority } = fixture(t);
  const unsigned = (1n << 63n) + 5n;
  const exact = BigInt.asIntN(64, unsigned);
  let observed = exact;
  observe(t, directory, (stat, bigint) => {
    stat.ino = bigint ? observed : Number(unsigned);
    return stat;
  });
  const authority = new RealDirectoryAuthority(directory, { parentAuthority });
  assert.equal(authority.assertStable(), directory);
  assert.equal(authority.identity.ino, exact);
  assert.ok(authority.identity.ino < 0n);
  const stored = path.join(directory, "identity.json");
  fs.writeFileSync(stored, JSON.stringify(authority.identity), { mode: 0o600 });
  const restored = FileIdentity.fromStored(JSON.parse(fs.readFileSync(stored, "utf8")));
  assert.equal(restored.ino, exact);
  assert.equal(authority.identity.equals(restored), true);
  assert.equal(restored.equals(new FileIdentity({ dev: restored.dev, ino: unsigned })), false);
  observed = exact - 1n;
  assert.equal(Number(observed), Number(exact));
  assert.throws(() => authority.assertStable(), invalid);
  assert.equal(authority.identity.ino, exact);
  assert.equal(restored.equals(authority.identity), true);
  assert.equal(fs.readFileSync(path.join(directory, "sentinel"), "utf8"), "retained");
});

for (const numeric of [-1, 0.5, NaN, Infinity]) {
  test(`nonnormal numeric identity ${numeric} obtains a fresh exact observation`, (t) => {
    const { directory, parentAuthority } = fixture(t);
    const expected = fs.lstatSync(directory, { bigint: true });
    observe(t, directory, (stat, bigint) => { if (!bigint) stat.ino = numeric; return stat; });
    const authority = new RealDirectoryAuthority(directory, { parentAuthority });
    assert.equal(authority.assertStable(), directory);
    assert.equal(authority.identity.ino, expected.ino);
  });
}

for (const kind of ["S_IFLNK", "S_IFREG"]) {
  test(`initial observed ${kind} is rejected before an exact fallback can conceal it`, (t) => {
    const { directory, parentAuthority } = fixture(t);
    let bigintCalls = 0;
    observe(t, directory, (stat, bigint) => {
      if (bigint) bigintCalls++;
      else { stat.mode = fs.constants[kind]; stat.ino = 2 ** 53; }
      return stat;
    });
    assert.throws(() => new RealDirectoryAuthority(directory, { parentAuthority }), invalid);
    assert.equal(bigintCalls, 0);
    assert.equal(fs.readFileSync(path.join(directory, "sentinel"), "utf8"), "retained");
  });

  test(`exact fallback rechecks changed kind ${kind}`, (t) => {
    const { directory, parentAuthority } = fixture(t);
    observe(t, directory, (stat, bigint) => {
      if (bigint) stat.mode = BigInt(fs.constants[kind]);
      else stat.ino = 2 ** 53;
      return stat;
    });
    assert.throws(() => new RealDirectoryAuthority(directory, { parentAuthority }), invalid);
    assert.equal(fs.readFileSync(path.join(directory, "sentinel"), "utf8"), "retained");
  });
}

for (const code of ["ENOENT", "EACCES"]) {
  test(`exact fallback ${code} after an initial presence refuses without adopting absence`, (t) => {
    const { directory, parentAuthority } = fixture(t);
    const failure = Object.assign(new Error("exact observation failed"), { code });
    observe(t, directory, (stat, bigint) => {
      if (bigint) throw failure;
      stat.ino = 2 ** 53;
      return stat;
    });
    assert.throws(() => new RealDirectoryAuthority(directory, { parentAuthority }),
      (error) => error.code === invalid.code && error.cause === failure);
    assert.equal(fs.readFileSync(path.join(directory, "sentinel"), "utf8"), "retained");
  });
}

test("exact fallback rejects replacement of a pinned real directory and preserves foreign bytes", (t) => {
  const { directory, parentAuthority } = fixture(t);
  const authority = new RealDirectoryAuthority(directory, { parentAuthority });
  let replaced = false;
  observe(t, directory, (stat, bigint) => {
    if (!bigint && !replaced) {
      stat.ino = 2 ** 53;
      fs.renameSync(directory, `${directory}.old`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "sentinel"), "foreign");
      replaced = true;
    }
    return stat;
  });
  assert.throws(() => authority.assertStable(), invalid);
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(path.join(directory, "sentinel"), "utf8"), "foreign");
  assert.equal(fs.readFileSync(path.join(`${directory}.old`, "sentinel"), "utf8"), "retained");
});
