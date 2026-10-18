import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MemorySourceRepository, SourceRepository } from "../support/structure/source-repository.js";
import { inspectInstructions, InstructionProjection, InstructionInvocation } from "../support/structure/os-instruction-checker.js";

function inspect(files) {
  const repository = new MemorySourceRepository(files);
  const names = files.map(([file]) => file);
  return inspectInstructions({ repository, files: names.filter((file) => /\.(?:js|mjs|cjs)$/.test(file)), resources: names.filter((file) => !/\.(?:js|mjs|cjs)$/.test(file)) });
}

test("public instruction projections distinguish positive execution slots from diagnostic prose and negative examples", () => {
  const file = "src/skills/example/SKILL.md";
  const report = inspect([[file, [
    "Diagnostic: Linux /proc and chmod are described here.",
    "Never run `chmod 777 target`.",
    "```text", "pkill -f example", "```",
    "```sh", "# negative comment: pkill -f example", "node scripts/check.mjs", "```",
    "Run `sennel flow get status`.",
  ].join("\n")], ["src/unused.js", "const negativeFixture = 'pkill -f example';"],
    ["src/presets/example/tests/fixtures/negative.json", '{"command":"pkill -f fixture"}']]);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.coverage.projections, 2);
  assert.ok(report.projections.every((entry) => entry instanceof InstructionProjection));
  assert.equal(report.projections[0].token.line, 8);
});

test("known OS-only syntax reports its executable resource location and recovers after removal", () => {
  for (const [command, rule] of [["pkill -f worker", "OS02"], ["node check.js /proc/1/status", "OS01"], ["node check.js $(cat command)", "OS04"]]) {
    const file = "src/flow/prompts/phase/run.md";
    const bad = inspect([[file, `Run:\n\n\`\`\`shell\n${command}\n\`\`\``]]);
    assert.ok(bad.diagnostics.some((entry) => entry.rule === rule && entry.file === file && entry.line === 4 && entry.trace[0] === file));
    assert.deepEqual(inspect([[file, "Run `node scripts/worker.js`."]]).diagnostics, []);
  }
});

test("JSON command slots and owned include producers are connected without interpreting arbitrary strings", () => {
  const file = "src/skills/rules.json";
  const report = inspect([[file, JSON.stringify({ command: "taskkill /PID 1", description: "pkill -f example", rules: [{ body: "Run `node worker.js`." }] })],
    ["src/skills/example/SKILL.md", '<!-- include("@skills/partials/shared.md") -->'],
    ["src/skills/partials/shared.md", "Run `node shared.js`."],
  ]);
  assert.deepEqual(report.diagnostics.map((entry) => entry.rule), ["OS02"]);
  assert.equal(report.coverage.projections, 3);
  assert.deepEqual(report.coverage.includes, [{ producer: "src/skills/example/SKILL.md", projection: "include", consumer: "src/skills/partials/shared.md" }]);
  const absent = inspect([["src/skills/example/SKILL.md", '<!-- include("@skills/partials/missing.md") -->']]);
  assert.equal(absent.complete, false);
  assert.match(absent.diagnostics[0].message, /no inspected owned producer/);
  for (const include of ["@presets/nonexistent.md", "@presets/missing/templates/run.md"]) {
    const missingPreset = inspect([["src/skills/example/SKILL.md", `<!-- include("${include}") -->`]]);
    assert.equal(missingPreset.complete, false);
    assert.equal(missingPreset.diagnostics[0].rule, "OS00");
    assert.equal(missingPreset.diagnostics[0].line, 1);
  }
});

test("unreadable JSON and unterminated execution fences make instruction coverage incomplete", () => {
  const report = inspect([["src/skills/rules.json", "{"], ["src/flow/prompts/phase/run.md", "```sh\nnode run.js"]]);
  assert.equal(report.complete, false);
  assert.deepEqual(report.diagnostics.map((entry) => entry.rule), ["OS00", "OS00"]);
});

test("literal JSON invocation preserves argv data and accepts a typed Flow command", () => {
  const file = "src/presets/example/preset.json";
  const report = inspect([[file, JSON.stringify({ instructions: [
    { executable: "node", args: ["worker.mjs", "--message", "$(this-is-data)"], shell: false },
    { command: { group: "run", subcommand: "gate", args: ["--phase", "draft"] } },
  ] })]]);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.projections.length, 2);
  assert.ok(report.projections.every((entry) => entry instanceof InstructionInvocation));
  assert.deepEqual(report.projections[0].args, ["worker.mjs", "--message", "$(this-is-data)"]);
  assert.deepEqual(report.projections[1].args, ["flow", "run", "gate", "--phase", "draft"]);
});

test("structured publication shell, OS-sensitive argv and command shim are independently diagnosed", () => {
  const file = "src/presets/example/preset.json";
  for (const [invocation, rule] of [
    [{ executable: "node", args: ["worker.js"], shell: true }, "OS02"],
    [{ command: "node", args: ["worker.js", "/proc/1/status"] }, "OS01"],
    [{ executable: "pkill", args: ["-f", "worker"] }, "OS02"],
  ]) {
    const source = JSON.stringify({ invocation }, null, 2);
    const report = inspect([[file, source]]);
    assert.deepEqual(report.diagnostics.map((entry) => entry.rule), [rule]);
    assert.equal(report.diagnostics[0].file, file);
    assert.equal(report.diagnostics[0].line, 3);
    assert.deepEqual(report.diagnostics[0].trace, [file, "invocation"]);
    assert.equal(report.diagnostics[0].classification, "violation");
  }
});

test("node inline JavaScript and unknown executable shapes cannot silently pass publication inspection", () => {
  const file = "src/presets/example/preset.json";
  for (const invocation of [
    { executable: "node", args: ["--eval", 'require("node:fs").readFileSync("/proc/1/status")'] },
    { command: "node", args: ["-e", 'const fixture = "/proc/1/status";'] },
    { command: { computed: "selected executable" } },
    { executable: "{{selectedExecutable}}", args: [] },
    { executable: "node", args: { spread: "selectedArgs" } },
  ]) {
    const report = inspect([[file, JSON.stringify({ invocation })]]);
    assert.equal(report.complete, false, JSON.stringify(invocation));
    assert.ok(report.diagnostics.some((entry) => entry.rule === "OS04" && entry.classification === "incomplete"));
    assert.equal(report.diagnostics.some((entry) => entry.rule === "OS01"), false, "inline JavaScript effects are not decided by grep");
  }
  const markdown = inspect([["src/flow/prompts/example/run.md", 'Run `node --eval "process.platform"`.']]);
  assert.equal(markdown.complete, false);
  assert.deepEqual(markdown.diagnostics.map((entry) => entry.rule), ["OS04"]);
});

test("public shell forms and native JSON argv use the shared executable policy at their own boundaries", () => {
  const shell = inspect([["src/skills/example/SKILL.md", "Run `npm test`."]]);
  assert.deepEqual(shell.diagnostics, []);
  const native = inspect([["src/presets/example/preset.json", JSON.stringify({ executable: "npm", args: ["test"], shell: false })]]);
  assert.equal(native.complete, false);
  assert.deepEqual(native.diagnostics.map((entry) => [entry.rule, entry.classification]), [["OS02", "incomplete"]]);
  const unknown = inspect([["src/skills/example/SKILL.md", "Run `apt-get update`."]]);
  assert.equal(unknown.complete, false);
  assert.deepEqual(unknown.diagnostics.map((entry) => [entry.rule, entry.classification]), [["OS02", "incomplete"]]);
});

test("fixed snapshot saved representation reaches readback and loader consumers and fails on a broken connection", () => {
  const sources = [
    ["src/lib/runtime-package-snapshot.js", `export class RuntimePackageSnapshot {
      constructor(root, delivery) {
        this.#files = new Map(delivery.resources.map(([key, encoded]) => [key, Buffer.from(encoded, "base64")]));
        visit("src");
        this.identity = new RuntimePackageIdentity({ files: this.#files });
        const expected = new RuntimePackageIdentity(delivery.identity);
        if (expected.revision !== this.identity.revision) throw new Error("changed bytes");
      }
      resourcePayload() { return [...this.#files].map(([key, snapshot]) => [key, snapshot.bytes.toString("base64")]); }
      static fromDelivery(delivery) { return new RuntimePackageSnapshot(delivery.root, delivery); }
      read(file) { const key = file; const snapshot = this.#files.get(key); return snapshot; }
    }`],
    ["src/lib/runtime-loader.js", 'export function load(url) { return snapshot.read(fileURLToPath(url)).bytes; } export function delivery() { return { resources: snapshot.resourcePayload() }; }'],
    ["src/lib/runtime-package.js", 'const resources = new Map(proof?.resources || []); export function read(key) { const encoded = resources.get(key); return Buffer.from(encoded, "base64"); }'],
    ["src/lib/runtime-bootstrap-loader.js", 'export function initialize(delivery) { resources = new Map(delivery.resources); } export function load(name) { return Buffer.from(resources.get(name), "base64"); }'],
  ];
  const valid = inspect(sources);
  assert.deepEqual(valid.diagnostics, []);
  assert.equal(valid.coverage.boundaries.length, 7);
  assert.ok(valid.coverage.boundaries.every((entry) => entry.inspected));
  const broken = inspect(sources.map(([file, text]) => [file, file.endsWith("runtime-bootstrap-loader.js") ? text.replace('"base64"', '"hex"') : text]));
  assert.equal(broken.complete, false);
  assert.deepEqual(broken.diagnostics.map((entry) => [entry.rule, entry.file]), [["OS04", "src/lib/runtime-bootstrap-loader.js"]]);
  assert.deepEqual(inspect(sources).diagnostics, []);
});

test("instruction audit rejects a typed consumer that discards its selected registry entry", () => {
  const disk = new SourceRepository(fileURLToPath(new URL("../..", import.meta.url)));
  const original = new Map(disk.list("src").map((file) => [file, disk.read(file)]));
  const consumer = "src/flow/lib/run-dispatch.js";
  const before = "await dispatch({\n      container: this.container,\n      entry,";
  assert.equal(original.get(consumer).split(before).length, 2, "inject exactly one real typed dispatch boundary");
  const run = (sources) => inspectInstructions({ repository: new MemorySourceRepository(sources),
    files: ["src/flow/lib/flow-execution-command.js"], resources: [] });
  const broken = new Map(original);
  broken.set(consumer, original.get(consumer).replace(before, "await dispatch({\n      container: this.container,"));
  const report = run(broken);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS04" && entry.file === consumer
    && entry.classification === "incomplete" && entry.message.includes("registry entry")));
  assert.equal(report.coverage.boundaries.find((entry) => entry.consumer === "RunDispatchCommand.runRegisteredFlowCommand").inspected, false);
  const restored = run(original);
  assert.deepEqual(restored.diagnostics, []);
  assert.equal(restored.coverage.boundaries.find((entry) => entry.consumer === "RunDispatchCommand.runRegisteredFlowCommand").inspected, true);
});
