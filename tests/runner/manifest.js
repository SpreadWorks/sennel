import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { TEST_SUITE_NAMES } from "./suite-definitions.js";

export class TestSuiteManifest {
  constructor({ root, files, readSource = (file) => readFileSync(join(root, file), "utf8") }) {
    this.root = root;
    this.readSource = readSource;
    this.files = [...new Set(files)].sort();
    if (this.files.length !== files.length) throw new Error("duplicate test file discovered");
    for (const file of this.files) this.#suiteFor(file);
    this.#validateUnitBoundaries();
  }

  #suiteFor(file) {
    const normalized = file.replaceAll("\\", "/");
    const matches = TEST_SUITE_NAMES.filter((suite) => new RegExp(`^tests/${suite}/`).test(normalized));
    if (/^src\/presets\/[^/]+\/tests\/acceptance\/.*\.acceptance\.test\.js$/.test(normalized) && matches.length === 0) matches.push("acceptance");
    if (matches.length !== 1) throw new Error(`test must have exactly one suite: ${file}`);
    return matches[0];
  }

  suiteFiles(suite) {
    if (!TEST_SUITE_NAMES.includes(suite)) throw new Error(`unknown suite: ${suite}`);
    return this.files.filter((file) => this.#suiteFor(file) === suite);
  }

  #validateUnitBoundaries() {
    const forbidden = [
      /^\s*import\s+.*?\s+from\s+["'](?:node:)?child_process["']/m,
      /^\s*(?:const|let)\s+.*?=\s+await\s+import\(["'](?:node:)?child_process["']\)/m,
      /^\s*import\s+.*?\s+from\s+.*support\/infrastructure\/git-repo\.js["']/m,
      /^\s*import\s+.*?\s+from\s+.*support\/infrastructure\/flow-setup\.js["']/m,
    ];
    for (const file of this.suiteFiles("unit")) {
      const source = this.readSource(file);
      if (forbidden.some((pattern) => pattern.test(source))) {
        throw new Error(`unit boundary violation: ${file}`);
      }
    }
  }

  static discover(root) {
    const files = [];
    const visit = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith(".test.js")) files.push(relative(root, full));
      }
    };
    visit(join(root, "tests"));
    visit(join(root, "src", "presets"));
    return new TestSuiteManifest({ root, files });
  }
}
