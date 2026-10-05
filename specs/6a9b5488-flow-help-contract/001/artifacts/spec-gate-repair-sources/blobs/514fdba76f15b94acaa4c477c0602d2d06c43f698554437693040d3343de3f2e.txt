export class TestCommandSource {
  constructor({ priority, kind, source, command, script = null, target = null }) {
    this.priority = priority;
    this.kind = kind;
    this.source = source;
    this.command = command;
    this.script = script;
    this.target = target;
  }
}

export function collectTestCommandSources({
  configuredTestCommand = null,
  scripts = null,
  composerScripts = null,
  makefileTest = false,
  makefileTestTarget = null,
} = {}) {
  const sources = [];
  if (configuredTestCommand !== null && configuredTestCommand !== undefined) {
    sources.push(new TestCommandSource({
      priority: 10,
      kind: "config",
      source: "test.command",
      command: configuredTestCommand,
    }));
  }
  if (scripts?.test) {
    sources.push(new TestCommandSource({
      priority: 20,
      kind: "package",
      source: "package.json:scripts.test",
      command: "npm test --",
      script: scripts.test,
    }));
  }
  if (composerScripts?.test) {
    sources.push(new TestCommandSource({
      priority: 30,
      kind: "composer",
      source: "composer.json:scripts.test",
      command: "composer run-script test --",
      script: composerScripts.test,
    }));
  }
  if (makefileTest || makefileTestTarget) {
    sources.push(new TestCommandSource({
      priority: 40,
      kind: "makefile",
      source: "Makefile:test",
      command: "make test",
      target: makefileTestTarget,
    }));
  }
  return sources;
}

export function selectTestCommandSource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const ordered = [...sources].sort((a, b) => a.priority - b.priority);
  if (ordered.length > 1 && ordered[0].priority === ordered[1].priority) {
    const err = new Error(`ambiguous selected-source candidates for project-level regression command: ${ordered
      .filter((candidate) => candidate.priority === ordered[0].priority)
      .map((candidate) => candidate.source)
      .join(", ")}`);
    err.commandCandidates = ordered.map((candidate) => candidate.source);
    throw err;
  }
  return ordered[0];
}
