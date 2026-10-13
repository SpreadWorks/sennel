import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { container, initContainer } from "../../../../src/lib/container.js";
import DocsBuildCommand from "../../../../src/docs/commands/build.js";
import DocsScanCommand, { prepareDocumentationScan } from "../../../../src/docs/commands/scan.js";
import DocsEnrichCommand, { prepareDocumentationEnrichment } from "../../../../src/docs/commands/enrich.js";
import DocsInitCommand from "../../../../src/docs/commands/init.js";
import DocsReadmeCommand from "../../../../src/docs/commands/readme.js";
import DocsAgentsCommand from "../../../../src/docs/commands/agents.js";
import DocsTranslateCommand from "../../../../src/docs/commands/translate.js";
import DocsForgeCommand from "../../../../src/docs/commands/forge.js";
import { resolveDocsContext } from "../../../../src/docs/lib/docs-context.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../../support/builders/tmp-dir.js";

class DocumentationRouteAgent {
  constructor(delegate) { this.delegate = delegate; this.calls = []; this.projections = []; }
  get promptCharacterLimit() { return this.delegate.promptCharacterLimit; }
  resolve(...args) { return this.delegate.resolve(...args); }
  projectInvocation(prompt, options) {
    this.projections.push({ prompt, options });
    return this.delegate.projectInvocation(prompt, options);
  }
  async call(prompt, options) {
    this.calls.push({ prompt, options });
    const schema = options.jsonSchema;
    if (schema?.properties?.entries) {
      const entries = [...prompt.matchAll(/^### \[([^\]]+)\] entry=([^:]+):(\d+) file=/gm)].map((match) => ({
        elementId: match[1], category: match[2], index: Number(match[3]),
        summary: "Existing source summary", detail: "Source implementation details.",
        chapter: "overview", role: "other", keywords: ["source", "route", "fixture"], app: null,
      }));
      return JSON.stringify({ entries });
    }
    if (schema?.properties?.chapters) return JSON.stringify({ chapters: schema.properties.chapters.items.enum });
    if (prompt.includes("## Markdown blocks")) {
      const blocks = prompt.slice(prompt.indexOf("blockId: ")).split("\n\n--- block boundary ---\n\n");
      return JSON.stringify(Object.fromEntries(blocks.map((block) => {
        const match = block.match(/^blockId: (.+)\nkind: .+\nprotected: .+\nrange: .+\n([\s\S]*)$/);
        assert.ok(match, "translation fixture must preserve a complete supplied block");
        return [match[1], match[2]];
      })));
    }
    if (schema) return JSON.stringify(Object.fromEntries(schema.required.map((id) => [id, "Generated fixture prose."])));
    return "Project instructions based on the documentation.";
  }
}

describe("documentation AI command routes", () => {
  let root;
  let agent;
  const originalEnv = { work: process.env.SENNEL_WORK_ROOT, source: process.env.SENNEL_SOURCE_ROOT };
  afterEach(() => {
    container.reset();
    if (originalEnv.work === undefined) delete process.env.SENNEL_WORK_ROOT;
    else process.env.SENNEL_WORK_ROOT = originalEnv.work;
    if (originalEnv.source === undefined) delete process.env.SENNEL_SOURCE_ROOT;
    else process.env.SENNEL_SOURCE_ROOT = originalEnv.source;
    if (root) removeTmpDir(root);
  });

  function fixture({ chapters = [{ chapter: "overview.md" }], languages = ["en"], threshold = 1 } = {}) {
    root = createTmpDir("sennel-docs-ai-routes-");
    writeJson(root, ".sennel/config.json", {
      lang: "en", type: "sample-node-command", chapters,
      docs: { languages, defaultLanguage: languages[0], ai: { confirmationThresholdCharacters: threshold } },
      scan: { include: ["src/**/*.js"], exclude: [] }, concurrency: 2,
      agent: { default: "fixture", providers: { fixture: { command: "node", args: ["-e", "throw new Error('Provider dispatch is forbidden in this fixture')", "{{PROMPT}}"] } } },
      logs: { enabled: false },
    });
    writeJson(root, "package.json", { name: "route-fixture", version: "1.0.0" });
    writeFile(root, "src/index.js", "export function hello() { return 'one'; }\n");
    process.env.SENNEL_WORK_ROOT = root;
    process.env.SENNEL_SOURCE_ROOT = root;
    container.reset();
    initContainer({ flowAttribution: "none" });
    agent = new DocumentationRouteAgent(container.get("agent"));
    container.set("agent", agent);
  }

  function reports() {
    const dir = path.join(root, ".sennel/output/docs-ai-usage");
    return fs.existsSync(dir) ? fs.readdirSync(dir).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) : [];
  }
  function analysis() { return JSON.parse(fs.readFileSync(path.join(root, ".sennel/output/analysis.json"), "utf8")); }
  function run(CommandClass, args = []) { return new CommandClass().run(container, { _rawArgs: args }); }

  it("uses scan persistence and readback for no-change and changed-source dry-run planning", async () => {
    fixture();
    await run(DocsScanCommand);
    await run(DocsEnrichCommand, ["--yes"]);
    assert.equal(agent.calls.length, 1);
    assert.equal(analysis().modules.entries[0].summary, "Existing source summary");
    await run(DocsScanCommand);
    const before = fs.readFileSync(path.join(root, ".sennel/output/analysis.json"), "utf8");
    await run(DocsEnrichCommand, ["--yes"]);
    assert.equal(agent.calls.length, 1, "unchanged persisted enrichments are reused");
    const reportCount = reports().length;
    await run(DocsBuildCommand, ["--dry-run"]);
    assert.equal(agent.calls.length, 1);
    assert.equal(reports().length, reportCount, "dry-run saves no usage report");
    assert.equal(fs.readFileSync(path.join(root, ".sennel/output/analysis.json"), "utf8"), before);
    writeFile(root, "src/index.js", "export function hello() { return 'changed'; }\n");
    const ctx = resolveDocsContext(container, { dryRun: true }, { commandId: "docs.enrich" });
    const scan = await prepareDocumentationScan(ctx);
    const prepared = prepareDocumentationEnrichment({ ...ctx, preparedAnalysis: scan.analysis });
    assert.equal(scan.stats.changed, 1);
    assert.equal(prepared.pending.length, 2, "both registered source categories become pending");
    assert.ok(prepared.pending.every((entry) => entry.essential.includes("changed")));
    await run(DocsBuildCommand, ["--dry-run", "--yes"]);
    assert.equal(agent.calls.length, 1);
    assert.equal(reports().length, reportCount);
    assert.equal(fs.readFileSync(path.join(root, ".sennel/output/analysis.json"), "utf8"), before);
  });

  it("applies the real DataSource revision comparison to dry-run pending selection", async () => {
    fixture();
    await run(DocsScanCommand);
    await run(DocsEnrichCommand, ["--yes"]);
    const stored = fs.readFileSync(path.join(root, ".sennel/output/analysis.json"), "utf8");
    const source = path.join(root, ".sennel/plugins/legacy-test-presets/presets/sample-node-command/data/modules.js");
    fs.appendFileSync(source, "\n// revision changed\n");
    const ctx = resolveDocsContext(container, { dryRun: true });
    const scan = await prepareDocumentationScan(ctx);
    const prepared = prepareDocumentationEnrichment({ ...ctx, preparedAnalysis: scan.analysis });
    assert.equal(prepared.pending.length, 2, "the real scan reparses every matching category when any DataSource invalidates the file");
    assert.ok(prepared.pending.some((entry) => entry.category === "modules"));
    assert.equal(fs.readFileSync(path.join(root, ".sennel/output/analysis.json"), "utf8"), stored);
    assert.equal(agent.calls.length, 1);
  });

  it("keeps --force independent from approval and prevents init fallback publication", async () => {
    fixture({ chapters: undefined });
    // Explicitly remove authoritative chapters so this route selects them with AI.
    delete container.get("config").chapters;
    await run(DocsScanCommand);
    await assert.rejects(run(DocsInitCommand, ["--force"]), (error) => error.code === "DOCS_AI_CONFIRMATION_REQUIRED");
    assert.equal(agent.calls.length, 0);
    assert.equal(fs.existsSync(path.join(root, "docs")), false);
    assert.equal(reports().length, 1);
    assert.equal(reports()[0].status, "confirmation-required");
  });

  it("propagates README cancellation through the normal text fallback", async () => {
    fixture();
    writeFile(root, ".sennel/plugins/legacy-test-presets/presets/sample-node-command/templates/en/README.md", "# Fixture\n\n<!-- {{text({prompt: \"Describe the project\"})}} -->\n<!-- {{/text}} -->\n");
    writeFile(root, "README.md", "Existing README bytes.\n");
    await assert.rejects(run(DocsReadmeCommand), (error) => error.code === "DOCS_AI_CONFIRMATION_REQUIRED");
    assert.equal(agent.calls.length, 0);
    assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "Existing README bytes.\n");
    assert.equal(reports().length, 1);
  });

  it("propagates agents cancellation without rewriting the source document", async () => {
    fixture();
    await run(DocsScanCommand);
    const original = "# Fixture\n\n<!-- {{data(\"base.agents.project\")}} -->\n<!-- {{/data}} -->\n";
    writeFile(root, "AGENTS.md", original);
    await assert.rejects(run(DocsAgentsCommand), (error) => error.code === "DOCS_AI_CONFIRMATION_REQUIRED");
    assert.equal(agent.calls.length, 0);
    assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), original);
    assert.equal(reports().length, 1);
  });

  it("stops forge assist before review instead of continuing its AI failure fallback", async () => {
    fixture();
    writeFile(root, "docs/overview.md", "# Overview\n");
    await assert.rejects(run(DocsForgeCommand, ["--prompt", "Improve prose", "--mode", "assist", "--review-cmd", "node nonexistent-review.js"]), (error) => error.code === "DOCS_AI_CONFIRMATION_REQUIRED");
    assert.equal(agent.calls.length, 0);
    assert.equal(reports().length, 1);
    assert.deepEqual(reports()[0].unobservedExternalCommands, [], "review never starts after cancellation");
  });

  it("prepares standalone agents, README and translation dry-runs without providers or writes", async () => {
    fixture({ languages: ["en", "ja"] });
    await run(DocsScanCommand);
    writeFile(root, "docs/overview.md", "# Overview\n\nSource prose.\n");
    writeFile(root, "README.md", "Existing README.\n");
    writeFile(root, "AGENTS.md", "# Fixture\n\n<!-- {{data(\"base.agents.project\")}} -->\n<!-- {{/data}} -->\n");
    const agentsBefore = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    await run(DocsAgentsCommand, ["--dry-run"]);
    await run(DocsReadmeCommand, ["--dry-run"]);
    await run(DocsTranslateCommand, ["--dry-run", "--force"]);
    assert.equal(agent.calls.length, 0);
    assert.equal(reports().length, 0);
    assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), agentsBefore);
    assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "Existing README.\n");
    assert.equal(fs.existsSync(path.join(root, "docs/ja")), false);
  });

  it("prepares init fallback translation without creating documentation in dry-run", async () => {
    fixture({ languages: ["fr"] });
    await run(DocsInitCommand, ["--dry-run", "--force"]);
    assert.equal(agent.calls.length, 0);
    assert.equal(reports().length, 0);
    assert.equal(fs.existsSync(path.join(root, "docs")), false);
  });

  it("prepares forge dry-run without materializing its input reference", async () => {
    fixture();
    writeFile(root, "docs/overview.md", "# Overview\n");
    await run(DocsForgeCommand, ["--dry-run", "--prompt", "Improve prose", "--mode", "agent"]);
    assert.equal(agent.calls.length, 0);
    assert.equal(reports().length, 0);
    assert.equal(fs.existsSync(path.join(root, ".tmp/forge-inputs")), false);
    assert.equal(fs.readFileSync(path.join(root, "docs/overview.md"), "utf8"), "# Overview\n");
  });

  it("previews forge text prefill from the same deterministic data rendering used by execution", async () => {
    fixture();
    await run(DocsScanCommand);
    const source = [
      "# Overview", "",
      '<!-- {{data("base.project.name")}} -->StaleData<!-- {{/data}} -->', "",
      '<!-- {{text({prompt: "Describe the project", id: "intro"})}} -->',
      "<!-- {{/text}} -->", "",
    ].join("\n");
    writeFile(root, "docs/overview.md", source);
    writeFile(root, "review.cjs", "process.exit(0);\n");
    await run(DocsForgeCommand, ["--dry-run", "--prompt", "Improve prose", "--mode", "local"]);
    const dryText = agent.projections.filter((entry) => entry.options.commandId === "docs.text");
    assert.equal(dryText.length, 1, "the deterministic prefill has a real prepared text plan");
    assert.match(dryText[0].prompt, /route-fixture/);
    assert.doesNotMatch(dryText[0].prompt, /StaleData/);
    assert.equal(agent.calls.length, 0);
    assert.equal(reports().length, 0);
    assert.equal(fs.readFileSync(path.join(root, "docs/overview.md"), "utf8"), source);
    assert.equal(fs.existsSync(path.join(root, ".tmp/forge-inputs")), false);
    await run(DocsForgeCommand, ["--yes", "--prompt", "Improve prose", "--mode", "local", "--review-cmd", `node ${path.join(root, "review.cjs")}`]);
    const actualText = agent.calls.filter((entry) => entry.options.commandId === "docs.text");
    assert.equal(actualText.length, 1);
    assert.equal(actualText[0].prompt, dryText[0].prompt, "dry-run and normal execution use exactly the same prepared source");
    assert.equal(reports().length, 1);
    assert.match(fs.readFileSync(path.join(root, "docs/overview.md"), "utf8"), /Generated fixture prose/);
  });

  it("refuses queued translation input changes after approval without publishing sibling results", async () => {
    fixture({ languages: ["en", "ja"], chapters: [{ chapter: "overview.md" }, { chapter: "project_structure.md" }] });
    container.get("config").concurrency = 1;
    writeFile(root, "docs/overview.md", "# Overview\n\nOriginal overview.\n");
    writeFile(root, "docs/project_structure.md", "# Structure\n\nOriginal structure.\n");
    writeFile(root, "docs/ja/overview.md", "Existing translated overview.\n");
    writeFile(root, "docs/ja/project_structure.md", "Existing translated structure.\n");
    const originalCall = agent.call.bind(agent);
    agent.call = async (prompt, options) => {
      if (agent.calls.length === 0) writeFile(root, "docs/project_structure.md", "# Structure\n\nExternally changed evidence.\n");
      return originalCall(prompt, options);
    };
    await assert.rejects(run(DocsTranslateCommand, ["--yes", "--force"]), (error) => error.code === "DOCS_AI_CONFIRMATION_REQUIRED");
    assert.equal(agent.calls.length, 1, "the queued changed input receives no provider dispatch");
    assert.equal(fs.readFileSync(path.join(root, "docs/ja/overview.md"), "utf8"), "Existing translated overview.\n");
    assert.equal(fs.readFileSync(path.join(root, "docs/ja/project_structure.md"), "utf8"), "Existing translated structure.\n");
    assert.equal(reports().length, 1);
    assert.equal(reports()[0].status, "confirmation-required");
  });

  it("passes build --yes through multiple languages and finalizes one shared report", async () => {
    fixture({ languages: ["en", "ja"] });
    await run(DocsBuildCommand, ["--yes"]);
    assert.ok(agent.calls.length >= 2, "enrich and translation both execute");
    const sessions = new Set(agent.calls.map((call) => call.options.providerAttemptObserver));
    assert.equal(sessions.size, 1, "all nested provider calls share the run observer");
    assert.equal(reports().length, 1);
    assert.equal(reports()[0].command, "docs.build");
    assert.equal(reports()[0].approvalMethod, "--yes");
    assert.ok(fs.existsSync(path.join(root, "docs/ja/overview.md")));
  });

  it("shares approval with independently generated language text stages", async () => {
    fixture({ languages: ["en", "ja"] });
    container.get("config").docs.mode = "generate";
    for (const lang of ["en", "ja"]) {
      writeFile(root, `.sennel/plugins/legacy-test-presets/presets/sample-node-command/templates/${lang}/overview.md`, "# Overview\n\n<!-- {{text({prompt: \"Explain the source\"})}} -->\n<!-- {{/text}} -->\n");
    }
    await run(DocsBuildCommand, ["--yes"]);
    assert.equal(agent.calls.filter((call) => call.options.commandId === "docs.text").length, 2);
    assert.equal(new Set(agent.calls.map((call) => call.options.providerAttemptObserver)).size, 1);
    assert.equal(reports().length, 1);
    assert.match(fs.readFileSync(path.join(root, "docs/overview.md"), "utf8"), /Generated fixture prose/);
    assert.match(fs.readFileSync(path.join(root, "docs/ja/overview.md"), "utf8"), /Generated fixture prose/);
  });

  it("accepts --yes through the CLI and observes its deterministic provider attempt", async () => {
    fixture();
    await run(DocsScanCommand);
    writeFile(root, "provider.cjs", [
      "const prompt = process.argv.at(-1);",
      "const entries = [...prompt.matchAll(/^### \\[([^\\]]+)\\] entry=([^:]+):(\\d+) file=/gm)].map(m => ({elementId:m[1],category:m[2],index:Number(m[3]),summary:'CLI summary',detail:'CLI source details',chapter:'overview',role:'other',keywords:['cli','fixture','source'],app:null}));",
      "process.stdout.write(JSON.stringify({entries}));",
    ].join("\n"));
    const configPath = path.join(root, ".sennel/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.agent.providers.fixture.args = [path.join(root, "provider.cjs"), "{{PROMPT}}"];
    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "src/sennel.js"), "docs", "enrich", "--yes"], {
      encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(analysis().modules.entries[0].summary, "CLI summary");
    assert.equal(reports().length, 1);
    assert.equal(reports()[0].providerAttemptCount, 1);
    assert.equal(reports()[0].approvalMethod, "--yes");
    assert.equal(reports()[0].tokens.input_tokens.complete, false, "plain provider token usage remains unknown");
  });

  it("shares forge's session with internal README and translation commands", async () => {
    fixture({ languages: ["en", "ja"] });
    writeFile(root, "docs/overview.md", "# Overview\n\nSource prose.\n");
    writeFile(root, "review.cjs", "process.exit(0);\n");
    await run(DocsForgeCommand, ["--yes", "--prompt", "Improve prose", "--mode", "assist", "--review-cmd", `node ${path.join(root, "review.cjs")}`]);
    assert.ok(fs.existsSync(path.join(root, "README.md")), "internal README Command.run publishes its output");
    assert.ok(fs.existsSync(path.join(root, "docs/ja/overview.md")), "internal translation Command.run publishes its output");
    assert.equal(reports().length, 1);
    assert.equal(reports()[0].command, "docs.forge");
    assert.equal(reports()[0].unobservedExternalCommands.length, 1);
    assert.equal(new Set(agent.calls.map((call) => call.options.providerAttemptObserver)).size, 1);
  });
});
