import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";
import { deploySkills } from "../../src/lib/skills.js";
import { resolveIncludes } from "../../src/lib/include.js";
import { stripDataMarkers } from "../../src/docs/lib/directive-parser.js";
import { loadRules, expandSkillRulesDirectives } from "../../src/lib/skill-rules.js";

const CMD = join(process.cwd(), "src/sennel.js");
const PKG_DIR = join(process.cwd(), "src");
const SKILL_SOURCES_DIR = join(PKG_DIR, "skills");
const MAX_SKILL_SOURCES = 64;

/** Non-interactive CLI args */
const NI_ARGS = [
  "--name", "test-proj",
  "--type", "base",
  "--purpose", "developer-guide",
  "--tone", "polite",
];

function resolveSkillFile(name) {
  // Skill deployment recognizes the canonical SKILL.md source only.
  const skillFile = join(SKILL_SOURCES_DIR, name, "SKILL.md");
  return fs.existsSync(skillFile) ? skillFile : null;
}

function listSkillSourceNames() {
  const skillSourceNames = fs.readdirSync(SKILL_SOURCES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && resolveSkillFile(entry.name) !== null)
    .map((entry) => entry.name);
  assert.ok(
    skillSourceNames.length <= MAX_SKILL_SOURCES,
    `expected at most ${MAX_SKILL_SOURCES} skill sources`,
  );
  return skillSourceNames;
}

function assertSkillNamesUseNamespace(skillNames, label) {
  for (const skillName of skillNames) {
    assert.ok(skillName.startsWith("sennel."), `${label}/${skillName} should use sennel.* naming`);
  }
}

function assertRegularFile(filePath) {
  const stat = fs.lstatSync(filePath);
  assert.equal(stat.isSymbolicLink(), false, `${filePath} should not be a symlink`);
  assert.equal(stat.isFile(), true, `${filePath} should be a regular file`);
}

function assertNoSymlinks(directory) {
  const stat = fs.lstatSync(directory);
  assert.equal(stat.isSymbolicLink(), false, `${directory} should not be a symlink`);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(directory)) assertNoSymlinks(join(directory, entry));
  }
}

function assertDeployedSkillFiles(workRoot) {
  const expectedNames = listSkillSourceNames().sort();
  for (const base of [".claude", ".agents"]) {
    assertNoSymlinks(join(workRoot, base));
    const skillsDir = join(workRoot, base, "skills");
    const skillNames = fs.readdirSync(skillsDir).sort();
    assert.deepEqual(skillNames, expectedNames, `${skillsDir} should contain every bundled skill`);
    assertSkillNamesUseNamespace(skillNames, `${base}/skills`);
    for (const skillName of skillNames) {
      const skillRoot = join(skillsDir, skillName);
      assert.equal(fs.lstatSync(skillRoot).isDirectory(), true, `${skillRoot} should be a real directory`);
      assertRegularFile(join(skillRoot, "SKILL.md"));
    }
  }
}

function runSetup(workRoot, extraArgs = []) {
  const result = spawnSync(process.execPath, [CMD, "setup", ...NI_ARGS, ...extraArgs], {
    encoding: "utf8",
    cwd: workRoot,
    timeout: 10000,
    env: { ...process.env, SENNEL_WORK_ROOT: workRoot, SENNEL_SOURCE_ROOT: workRoot },
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
}

describe("051: skill namespace with dot separator", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  describe("src/skills/ naming", () => {
    it("skill source directories use sennel.* naming", () => {
      const skillSourceNames = listSkillSourceNames();
      assert.ok(skillSourceNames.length > 0, "should have skill sources");
      assertSkillNamesUseNamespace(skillSourceNames, "src/skills");
    });

    it("SKILL.md name fields use sennel.* naming", () => {
      const skillSourceNames = listSkillSourceNames();
      for (const skillName of skillSourceNames) {
        const skillFile = resolveSkillFile(skillName);
        const content = fs.readFileSync(skillFile, "utf8");
        const match = content.match(/^name:\s*(.+)$/m);
        assert.ok(match, `skill in "${skillName}" should have a name field`);
        assert.ok(match[1].startsWith("sennel."), `name "${match[1]}" should start with "sennel."`);
      }
    });
  });

  describe("bundled skill deployment", () => {
    it("deploySkills copies the exact bundled set as regular files with expanded content to both targets", () => {
      tmp = createTmpDir();
      writeJson(tmp, ".sennel/config.json", {
        lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
      });

      const results = deploySkills(tmp);
      const skillSourceNames = listSkillSourceNames();
      assert.deepEqual(results.map(({ name }) => name).sort(), [...skillSourceNames].sort());
      assertDeployedSkillFiles(tmp);

      const rules = loadRules();
      for (const skillName of skillSourceNames) {
        const sourceFile = resolveSkillFile(skillName);
        const rawContent = fs.readFileSync(sourceFile, "utf8");
        const includedContent = resolveIncludes(rawContent, {
          baseDir: join(SKILL_SOURCES_DIR, skillName),
          pkgDir: PKG_DIR,
          skillsDir: SKILL_SOURCES_DIR,
          presetsDir: join(PKG_DIR, "presets"),
          sourceFile,
        });
        const sourceContent = stripDataMarkers(expandSkillRulesDirectives(includedContent, rules));
        for (const base of [".claude", ".agents"]) {
          const skillPath = join(tmp, base, "skills", skillName, "SKILL.md");
          const content = fs.readFileSync(skillPath, "utf8");
          assert.equal(content, sourceContent, `${skillPath} should match the expanded skill source`);
          assert.doesNotMatch(content, /<!-- include\(/, `${skillPath} should have no unresolved includes`);
        }
      }
    });
  });

  describe("setup agent instruction generation", () => {
    it("setup --agent claude,codex generates both instruction files and deploys skills as regular files", () => {
      tmp = createTmpDir();
      writeJson(tmp, "package.json", { name: "test-proj" });

      runSetup(tmp, ["--agent", "claude,codex"]);

      assertDeployedSkillFiles(tmp);
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const instructionPath = join(tmp, name);
        assertRegularFile(instructionPath);
        assert.match(fs.readFileSync(instructionPath, "utf8"), /<!-- \{\{data\("agents\.flow"\)\}\} -->/);
      }
    });

    it("setup without --agent deploys skills without generating instruction files", () => {
      tmp = createTmpDir();
      writeJson(tmp, "package.json", { name: "test-proj" });

      runSetup(tmp);

      assertDeployedSkillFiles(tmp);
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        assert.equal(fs.existsSync(join(tmp, name)), false, `${name} should require --agent`);
      }
    });
  });
});
