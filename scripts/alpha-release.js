import crypto from "node:crypto";
await import("../src/sennel.js");
const { runCmd } = await import("../src/lib/process.js");
const { runGit } = await import("../src/lib/git-helpers.js");
const { NativeExecutableInvocation } = await import("../src/lib/command-invocation.js");
import path from "node:path";
const { AtomicJsonFile } = await import("../src/lib/atomic-json-file.js");

const ALPHA_VERSION_PATTERN = /^0\.1\.0-alpha\.(0|[1-9]\d*)$/;
const ALPHA_RELEASE_PACKAGE_NAME = "sennel";

function requireRoot(root) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("alpha release root must be a non-empty string");
  }
  return path.resolve(root);
}

export class AlphaVersion {
  constructor(value) {
    const match = ALPHA_VERSION_PATTERN.exec(String(value || ""));
    if (!match) throw new Error(`package version must use 0.1.0-alpha.N format; received ${JSON.stringify(value)}`);
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence)) throw new Error("alpha version sequence must be a safe integer");
    this.sequence = sequence;
    Object.freeze(this);
  }

  toString() {
    return `0.1.0-alpha.${this.sequence}`;
  }
}

export class ReleaseCommitCount {
  constructor(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("release commit count must be a non-negative safe integer");
    }
    this.value = value;
    Object.freeze(this);
  }

  next() {
    return new ReleaseCommitCount(this.value + 1);
  }
}

export class AlphaReleaseInvariant {
  constructor(version, commitCount) {
    if (!(version instanceof AlphaVersion) || !(commitCount instanceof ReleaseCommitCount)) {
      throw new Error("alpha release invariant requires a version and commit count");
    }
    if (version.sequence !== commitCount.value) {
      throw new Error(
        `package version ${version} does not match HEAD commit count ${commitCount.value}`,
      );
    }
    this.version = version;
    this.commitCount = commitCount;
    Object.freeze(this);
  }
}

export class AlphaVersionSynchronization {
  constructor({ status, version, commitCount }) {
    if (!["updated", "already_synchronized"].includes(status)) {
      throw new Error("alpha version synchronization status is invalid");
    }
    if (!(version instanceof AlphaVersion) || !(commitCount instanceof ReleaseCommitCount)) {
      throw new Error("alpha version synchronization requires a version and commit count");
    }
    this.status = status;
    this.version = version;
    this.commitCount = commitCount;
    Object.freeze(this);
  }
}

export class AlphaReleaseIntent {
  constructor(value) {
    if (value !== "alpha") {
      throw new Error('alpha release commands require the explicit argument "--intent alpha"');
    }
    Object.freeze(this);
  }
}

export class AlphaReleasePackage {
  constructor(name) {
    if (name !== ALPHA_RELEASE_PACKAGE_NAME) {
      throw new Error(`alpha release package must be ${ALPHA_RELEASE_PACKAGE_NAME}; received ${JSON.stringify(name)}`);
    }
    this.name = name;
    Object.freeze(this);
  }

  versionSpec(version) {
    if (!(version instanceof AlphaVersion)) {
      throw new Error("alpha release package version specification requires an AlphaVersion");
    }
    return `${this.name}@${version}`;
  }
}

export class AlphaReleasePackProof {
  constructor(value) {
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error('alpha publishing requires a pack proof in the form "--pack-proof sha256:<64 lowercase hex characters>"');
    }
    this.value = value;
    Object.freeze(this);
  }

  assertMatches(inspection) {
    if (!(inspection instanceof AlphaReleasePackInspection)) {
      throw new Error("alpha pack proof comparison requires a pack inspection");
    }
    if (this.value !== inspection.proof.value) {
      throw new Error("alpha package contents changed since inspection; inspect the current pack output and use its new confirmation proof");
    }
  }

  toString() {
    return this.value;
  }
}

export class AlphaReleaseArguments {
  constructor(argumentsList, { requiresVersion = false, requiresPackProof = false } = {}) {
    if (!Array.isArray(argumentsList)) throw new Error("alpha release arguments must be an array");
    const values = new Map();
    for (let index = 0; index < argumentsList.length;) {
      const name = argumentsList[index];
      const value = argumentsList[index + 1];
      if (!["--intent", "--version", "--pack-proof"].includes(name) || value === undefined || values.has(name)) {
        throw new Error(this.#expected(requiresVersion, requiresPackProof));
      }
      values.set(name, value);
      index += 2;
    }
    if (!values.has("--intent") || (requiresVersion !== values.has("--version")) || (requiresPackProof !== values.has("--pack-proof"))) {
      throw new Error(this.#expected(requiresVersion, requiresPackProof));
    }
    this.intent = new AlphaReleaseIntent(values.get("--intent"));
    this.version = requiresVersion ? new AlphaVersion(values.get("--version")) : null;
    this.packProof = requiresPackProof ? new AlphaReleasePackProof(values.get("--pack-proof")) : null;
    Object.freeze(this);
  }

  #expected(requiresVersion, requiresPackProof) {
    return "expected --intent alpha"
      + (requiresVersion ? " and --version 0.1.0-alpha.N" : "")
      + (requiresPackProof ? " and --pack-proof sha256:<64 lowercase hex characters>" : "");
  }
}

class GitRepository {
  constructor(root) {
    this.root = requireRoot(root);
  }

  commitCount() {
    const output = this.#run(["rev-list", "--count", "HEAD"], "read HEAD commit count");
    if (!/^\d+$/.test(output)) throw new Error(`git returned an invalid HEAD commit count: ${output}`);
    return new ReleaseCommitCount(Number(output));
  }

  assertClean(operation = "alpha release target") {
    if (typeof operation !== "string" || operation === "") {
      throw new Error("clean worktree inspection requires an operation name");
    }
    const output = this.#run(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "inspect release target worktree",
    );
    if (output !== "") {
      throw new Error(`${operation} requires a clean worktree after the release target HEAD is finalized`);
    }
  }

  #run(args, operation) {
    const result = runGit(args, { cwd: this.root, encoding: "utf8" });
    if (result.error) throw new Error(`failed to ${operation}: ${result.error.message}`, { cause: result.error });
    if (result.status !== 0) {
      throw new Error(`failed to ${operation}: ${(result.stderr || result.stdout || "git failed").trim()}`);
    }
    return result.stdout.trim();
  }
}

class PackageManifest {
  constructor(root) {
    this.root = requireRoot(root);
    this.filePath = path.join(this.root, "package.json");
  }

  read() {
    let value;
    try {
      value = new AtomicJsonFile(this.filePath).read();
    } catch (cause) {
      throw new Error(`failed to read package.json: ${cause.message}`, { cause });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("package.json must contain an object");
    }
    return value;
  }

  version() {
    return new AlphaVersion(this.read().version);
  }

  writeVersion(version) {
    if (!(version instanceof AlphaVersion)) throw new Error("package version update requires an AlphaVersion");
    const value = this.read();
    value.version = version.toString();
    new AtomicJsonFile(this.filePath).write(value);
  }
}

class NpmCommand {
  constructor(root, spawn = runCmd) {
    this.root = requireRoot(root);
    this.spawn = spawn;
  }

  run(args, operation) {
    const invocation = new NativeExecutableInvocation({ executable: "npm", args, cwd: this.root });
    const result = this.spawn(invocation, [], { encoding: "utf8" });
    if (result.error) throw new Error(`failed to ${operation}: ${result.error.message}`, { cause: result.error });
    if (result.status !== 0) {
      throw new Error(`failed to ${operation}: ${(result.stderr || result.stdout || "npm failed").trim()}`);
    }
    return result.stdout.trim();
  }
}

export class AlphaReleaseValidator {
  constructor(root = process.cwd()) {
    this.repository = new GitRepository(root);
    this.manifest = new PackageManifest(root);
  }

  validate() {
    return new AlphaReleaseInvariant(
      this.manifest.version(),
      this.repository.commitCount(),
    );
  }

  assertClean(operation) {
    this.repository.assertClean(operation);
  }
}

export class AlphaReleasePreflight {
  constructor(root = process.cwd()) {
    this.validator = new AlphaReleaseValidator(root);
  }

  run() {
    return this.validator.validate();
  }
}

export class AlphaReleaseVerifier {
  constructor(root = process.cwd(), npm = new NpmCommand(root)) {
    this.npm = npm;
  }

  verify() {
    this.npm.run(["test"], "run alpha release verification");
  }
}

export class AlphaReleasePackInspector {
  constructor(root = process.cwd(), { validator = new AlphaReleaseValidator(root), npm = new NpmCommand(root) } = {}) {
    this.validator = validator;
    this.npm = npm;
  }

  inspect() {
    return this.inspectValidated(this.validator.validate());
  }

  inspectValidated(invariant) {
    if (!(invariant instanceof AlphaReleaseInvariant)) throw new Error("alpha pack inspection requires a validated invariant");
    this.validator.assertClean("alpha pack inspection");
    const output = this.npm.run(["pack", "--dry-run", "--json"], "inspect alpha release package contents");
    return new AlphaReleasePackInspection(invariant, output);
  }
}

export class AlphaReleasePackFile {
  constructor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.path !== "string" || value.path === ""
      || !Number.isSafeInteger(value.size) || value.size < 0
      || !Number.isSafeInteger(value.mode) || value.mode < 0) {
      throw new Error("npm pack returned an invalid package file entry");
    }
    this.path = value.path;
    this.size = value.size;
    this.mode = value.mode;
    Object.freeze(this);
  }

  identity() {
    return [this.path, this.size, this.mode];
  }

  toDisplayLine() {
    return `- ${this.path} (${this.size} bytes, mode ${this.mode.toString(8)})`;
  }

  static compare(left, right) {
    if (!(left instanceof AlphaReleasePackFile) || !(right instanceof AlphaReleasePackFile)) {
      throw new Error("alpha package file comparison requires package files");
    }
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  }
}

export class AlphaReleasePackInspection {
  constructor(invariant, output) {
    if (!(invariant instanceof AlphaReleaseInvariant) || typeof output !== "string") {
      throw new Error("alpha pack inspection requires an invariant and command output");
    }
    const metadata = AlphaReleasePackInspection.#parse(output);
    if (metadata.version !== invariant.version.toString()) {
      throw new Error(`npm pack reported version ${JSON.stringify(metadata.version)}, not the validated release version ${invariant.version}`);
    }
    const files = metadata.files.map((file) => new AlphaReleasePackFile(file));
    if (files.length === 0 || new Set(files.map((file) => file.path)).size !== files.length) {
      throw new Error("npm pack returned an invalid complete package file list");
    }
    if (!/^[0-9a-f]{40}$/i.test(metadata.shasum)
      || typeof metadata.integrity !== "string" || !/^sha(?:256|384|512)-/.test(metadata.integrity)) {
      throw new Error("npm pack returned invalid package content metadata");
    }
    this.invariant = invariant;
    this.package = new AlphaReleasePackage(metadata.name);
    this.files = Object.freeze(files.sort(AlphaReleasePackFile.compare));
    this.shasum = metadata.shasum.toLowerCase();
    this.integrity = metadata.integrity;
    const digest = crypto.createHash("sha256")
      .update(JSON.stringify({
        name: this.package.name,
        version: invariant.version.toString(),
        shasum: this.shasum,
        integrity: this.integrity,
        files: this.files.map((file) => file.identity()),
      }))
      .digest("hex");
    this.proof = new AlphaReleasePackProof(`sha256:${digest}`);
    Object.freeze(this);
  }

  confirmationInstructions() {
    return `After reviewing this exact file list, publish with:\nnpm run release:publish -- --intent alpha --pack-proof ${this.proof}`;
  }

  static #parse(output) {
    let records;
    try {
      records = JSON.parse(output);
    } catch (cause) {
      throw new Error(`npm pack returned invalid JSON output: ${cause.message}`, { cause });
    }
    if (!Array.isArray(records) || records.length !== 1 || !records[0] || typeof records[0] !== "object" || Array.isArray(records[0]) || !Array.isArray(records[0].files)) {
      throw new Error("npm pack returned invalid JSON package metadata");
    }
    return records[0];
  }
}

export class AlphaReleasePublisher {
  constructor(root = process.cwd(), {
    validator = new AlphaReleaseValidator(root),
    packInspector = new AlphaReleasePackInspector(root),
    npm = new NpmCommand(root),
  } = {}) {
    this.validator = validator;
    this.packInspector = packInspector;
    this.npm = npm;
  }

  publish(intent, packProof) {
    if (!(intent instanceof AlphaReleaseIntent) || !(packProof instanceof AlphaReleasePackProof)) {
      throw new Error("alpha publish requires explicit release intent and pack proof");
    }
    const inspection = this.packInspector.inspectValidated(this.validator.validate());
    packProof.assertMatches(inspection);
    this.validator.assertClean("alpha publish");
    const invariant = this.validator.validate();
    this.npm.run(["publish", "--tag", "alpha"], "publish alpha release");
    return invariant;
  }
}

export class AlphaReleasePromotion {
  constructor(root = process.cwd(), npm = new NpmCommand(root)) {
    this.npm = npm;
    this.releasePackage = new AlphaReleasePackage(ALPHA_RELEASE_PACKAGE_NAME);
  }

  promote(intent, version) {
    if (!(intent instanceof AlphaReleaseIntent) || !(version instanceof AlphaVersion)) {
      throw new Error("alpha promotion requires explicit release intent and version");
    }
    this.npm.run(["dist-tag", "add", this.releasePackage.versionSpec(version), "latest"], "promote alpha release to latest");
    return version;
  }
}

export class AlphaReleaseSynchronizer {
  constructor(root = process.cwd()) {
    this.repository = new GitRepository(root);
    this.manifest = new PackageManifest(root);
  }

  synchronize() {
    this.repository.assertClean("alpha version synchronization");
    const commitCount = this.repository.commitCount();
    const currentVersion = this.manifest.version();
    if (currentVersion.sequence === commitCount.value) {
      return new AlphaVersionSynchronization({
        status: "already_synchronized",
        version: currentVersion,
        commitCount,
      });
    }
    const finalCommitCount = commitCount.next();
    const version = new AlphaVersion(`0.1.0-alpha.${finalCommitCount.value}`);
    this.manifest.writeVersion(version);
    return new AlphaVersionSynchronization({ status: "updated", version, commitCount: finalCommitCount });
  }
}

export class AlphaReleaseCommand {
  constructor({ label, execute, render }) {
    if (typeof label !== "string" || typeof execute !== "function" || typeof render !== "function") {
      throw new Error("alpha release command configuration is invalid");
    }
    this.label = label;
    this.execute = execute;
    this.render = render;
  }

  run() {
    try {
      const result = this.execute();
      process.stdout.write(`${this.render(result)}\n`);
    } catch (error) {
      process.stderr.write(`[${this.label}] ${error.message || error}\n`);
      process.exitCode = 1;
    }
  }
}
