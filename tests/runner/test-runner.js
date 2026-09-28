import { groupTestFilesByCategory } from "./test-runner-labels.js";
import { TestSelection, renderTestList, validateResolvedFiles } from "./test-selection.js";
import { TEST_SUITE_NAMES } from "./suite-definitions.js";

export class TestRunner {
  constructor({ presetNames = [], resolveFiles, executeFiles, maxDepth = 32, maxFiles = 10000, maxRelativePath = 4096, maxJsonBytes = 16 * 1024 * 1024 }) {
    this.presetNames = presetNames;
    this.resolveFiles = resolveFiles;
    this.executeFiles = executeFiles;
    this.limits = { maxDepth, maxFiles, maxRelativePath, maxJsonBytes };
  }

  async run(args) {
    let selection;
    try {
      selection = TestSelection.parse(args, { presetNames: this.presetNames });
      if (selection.mode === "help") return { exitCode: 0, stdout: usage(), stderr: "" };
      const files = validateResolvedFiles(this.resolveFiles(selection), this.limits);
      if (files.length === 0) throw new Error("No test files found");
      if (selection.list) return { exitCode: 0, stdout: JSON.stringify(renderTestList(selection, groupsFor(files), this.limits)), stderr: "" };
      return { exitCode: (await this.executeFiles(files, selection)) || 0, stdout: "", stderr: "" };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: `Error: ${error.message}\n` };
    }
  }
}

function groupsFor(files) {
  const grouped = groupTestFilesByCategory(files.map((file) => `/${file}`));
  return [
    ...TEST_SUITE_NAMES.map((category) => ({ category, files: grouped[category].map(stripRoot) })),
  ];
}

function stripRoot(file) {
  return file.slice(1);
}

function usage() {
  return `Usage: node tests/run.js [--preset <name> | --scope <${TEST_SUITE_NAMES.join("|")}> | --agent | --all | --jobs <1|2> | --file <path> | --pattern <glob> | <path>...] [--list --json]\n`;
}
