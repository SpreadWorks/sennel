import test from "node:test";
import assert from "node:assert/strict";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { inspectInstructions } from "../support/structure/os-instruction-checker.js";

function inspect(files) {
  const repository = new MemorySourceRepository(files);
  const names = files.map(([file]) => file);
  return inspectInstructions({ repository,
    files: names.filter((file) => /\.(?:js|mjs|cjs)$/.test(file)),
    resources: names.filter((file) => !/\.(?:js|mjs|cjs)$/.test(file)) });
}

const cases = [
  ["and-chain", "src/flow/prompts/run.md", "```sh\nnode --version && chmod 700 private-dir\n```", "OS02"],
  ["semicolon-chain", "src/skills/example/SKILL.md", "```shell\nnode --version; chmod 700 private-dir\n```", "OS02"],
  ["pipe-chain", "src/skills/example/commands.json", JSON.stringify({ command: "node --version | chmod 700 private-dir" }), "OS02"],
  ["or-chain", "src/skills/example/alternative.md", "Run `node --version || chmod 700 private-dir`.", "OS02"],
  ["command-substitution", "src/flow/prompts/substitution.md", '```sh\nnode --version $(chmod 700 private-dir)\n```', "OS04"],
  ["double-quoted-command-substitution", "src/flow/prompts/quoted-substitution.md", '```sh\nnode --version "$(chmod 700 private-dir)"\n```', "OS04"],
  ["backtick-substitution", "src/flow/prompts/backtick-substitution.md", "```sh\nnode --version `chmod 700 private-dir`\n```", "OS04"],
  ["input-process-substitution", "src/flow/prompts/process-substitution-in.md", "```sh\nnode --version <(chmod 700 private-dir)\n```", "OS04"],
  ["output-process-substitution", "src/flow/prompts/process-substitution-out.md", "```sh\nnode --version >(chmod 700 private-dir)\n```", "OS04"],
  ["json-command-newline", "src/skills/example/multiline.json", JSON.stringify({ command: "node --version\nchmod 700 private-dir" }), "OS02"],
  ["comment-newline", "src/skills/example/comment-newline.json", JSON.stringify({ command: "node --version # ; chmod 700 private-dir\nchmod 700 private-dir" }), "OS02"],
  ["escaped-space-comment-boundary", "src/skills/example/escaped-space-comment.md", ["```sh", String.raw`node --version \ # && chmod 700 private-dir`, "```"].join("\n"), "OS02"],
  ["unclosed-quote", "src/skills/example/unclosed-quote.md", '```sh\nnode --version "unfinished\n```', "OS02"],
  ["trailing-escape", "src/skills/example/trailing-escape.md", "```sh\nnode --version \\\n```", "OS02"],
];

for (const [name, file, text, rule] of cases) {
  test(`public shell instruction ${name} stays incomplete`, () => {
    const report = inspect([[file, text]]);
    assert.equal(report.complete, false, file);
    assert.deepEqual(report.diagnostics.map(({ rule: actualRule, classification }) => [actualRule, classification]), [[rule, "incomplete"]], file);
    assert.equal(report.diagnostics[0].file, file);
    assert.equal(report.diagnostics[0].trace[0], file);
  });
}

test("quoted or escaped operators and structured native argv remain inert, and simple commands recover", () => {
  const report = inspect([
    ["src/skills/example/quoted.md", 'Run `node scripts/show.js "&& chmod 700 private-dir; printf literal"`.'],
    ["src/skills/example/quoted-fence.md", "```sh\nnode scripts/show.js '&& chmod 700 private-dir $(literal) `literal`'\n```"],
    ["src/skills/example/quoted-process-substitution.md", "```sh\nnode scripts/show.js '<(literal) >(literal)'\n```"],
    ["src/skills/example/escaped.md", ["```sh", String.raw`node scripts/show.js \&\& \; private-dir`, "node --version # ; chmod 700 private-dir", "```"].join("\n")],
    ["src/presets/example/preset.json", JSON.stringify({ executable: "node", args: ["--message", "&& chmod 700 private-dir; $(literal)"], shell: false })],
    ["src/flow/prompts/simple.md", "Run `node scripts/check.mjs`."],
  ]);

  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.coverage.projections, 7);
});
