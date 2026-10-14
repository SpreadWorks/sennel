# Preset Creation Guide

This document is the procedure guide for creating a new sennel preset as either **built-in (`src/presets/<key>/`)** or **project-local (`.sennel/presets/<key>/`)**. It is based on the DI (Dependency Injection) container contract introduced in spec 191, and covers specifications, procedures, pitfalls, and validation commands so that an AI agent can assemble a preset end-to-end by reading this document alone.

The intended reader is a developer or AI who already understands the sennel internal architecture (`src/CLAUDE.md` / `src/AGENTS.md`) and needs to build a preset for a new framework or project structure.

---

## 1. What is a Preset?

A preset bundles framework-specific "scan settings + DataSources + templates" into a package. It forms a **single-inheritance chain** via the `parent` field in `preset.json`, and child presets override the parent's settings, DataSources, and templates.

Inheritance chain examples:

```
base → webapp → php-webapp → symfony
base → webapp → js-webapp → nextjs
base → cli → node-cli
base → api → graphql
```

When you list multiple presets in the `type` array of `.sennel/config.json`, each preset's inheritance chain is resolved **independently**, and chapters, DataSources, and templates are merged (no parent relationship between presets is required).

```json
{ "type": ["spread-commerce", "graphql", "monorepo"] }
```

---

## 2. Decision Flow

Before starting the implementation, decide where and what kind of preset to create.

### 2.1 Built-in or Project-Local?

| Condition | Location |
|---|---|
| Generic framework/library support (reusable) | `src/presets/<key>/` (built-in) |
| Specific to one project's directory structure / customization | `.sennel/presets/<key>/` (project-local) |

**Project-local presets are leaf-only.** The `parent` chain always points to built-in presets.

### 2.2 Extend an Existing Preset or Create a New One?

1. Check `src/presets/` for a suitable parent candidate (`webapp`, `php-webapp`, `js-webapp`, `symfony`, `laravel`, `cakephp2`, `nextjs`, `hono`, `node-cli`, `database`, `api/graphql`, etc.).
2. Specify the closest preset as `parent`. If nothing fits, start from an upper-level preset such as `base` / `webapp` / `cli`.
3. If the parent has a DataSource or template with the same name, the child overrides it (last-wins).

---

## 3. Directory Layout

```
<preset-root>/<key>/
├── preset.json              Required: metadata, chapters, scan patterns
├── guardrail.json           Optional: spec / impl guardrail rules
├── data/                    DataSource modules (scan + resolve in one)
│   └── <category>.js        1 file = 1 category (default export is a register factory)
├── templates/
│   ├── ja/                  Chapter templates per language
│   └── en/
└── tests/                   Required for built-in presets
    ├── unit/                Unit tests (scan parser I/O)
    ├── e2e/                 Full-scan pipeline tests
    ├── acceptance/          Fixture-based acceptance tests
    │   └── test.js
    └── analyzers.js         Test-only helpers (may import sennel internals)
```

For project-local presets, `tests/` is not required.

**Note**: Previously there was a `scan/` directory that held scan parsers separately, but this layout has been abolished. Scan logic now lives inside the `Scannable` DataSource in `data/<category>.js`.

---

## 4. preset.json Schema

```json
{
  "parent": "symfony",
  "label": "Spread Commerce (EC-CUBE 4.x + Next.js)",
  "aliases": ["eccube"],
  "chapters": [
    { "chapter": "overview.md", "desc": "Overview" },
    { "chapter": "controller_routes.md", "desc": "Controllers and routing" }
  ],
  "scan": {
    "include": ["src/backend/app/Customize/**/*.php"],
    "exclude": ["src/backend/app/Plugin/*/vendor/**"]
  }
}
```

| Field | Required | Description |
|---|---|---|
| `parent` | Optional | Parent preset key. Omit for a standalone preset |
| `label` | Recommended | Display name |
| `aliases` | Optional | Alternative names that can appear in `type` of `config.json` |
| `chapters` | Optional | Chapter order and descriptions. Inherits parent's `chapters` when omitted |
| `scan.include` | Optional | Scan target globs (POSIX separator) |
| `scan.exclude` | Optional | Exclusion globs |

### 4.1 How `chapters` Works

- Chapter names declared in `chapters` must have a matching file in the preset's own `templates/<lang>/` or an ancestor's (otherwise the gate FAILs).
- When multiple presets are listed in `type` of `config.json`, chapter order is **unioned starting from the first preset**. **Place the most specific (leaf) preset first.**

### 4.2 `scan` Patterns

- Separator is always `/` (even on Windows).
- `**` matches any depth, `*` matches any single path segment character.
- The parent's `scan` is merged (additive). To exclude something from the parent, use `exclude`.

### 4.3 guardrail.json (optional)

A file declaring preset-specific design principles and prohibitions. AI uses it for checks in the Spec-Driven Development flow's `plan.gate` / `impl.review`. Independent of the docs generation pipeline.

```json
{
  "guardrails": [
    {
      "id": "use-parameterized-queries",
      "title": "Use Parameterized Queries",
      "body": "DQL and QueryBuilder shall use parameter bindings.",
      "meta": { "phase": ["spec", "impl"] }
    }
  ]
}
```

### 4.4 overrides.json (project root, optional)

A single dictionary file placed at `.sennel/overrides.json` for the whole project. Use it to manually fix descriptions returned by DataSource entries (it takes precedence over enrich's AI-generated summaries).

```json
{
  "tables": { "contents": "Content table (per video episode)" },
  "controllers": { "UserController": "User authentication and profile management" }
}
```

---

## 5. DataSource Implementation (DI factory contract)

### 5.1 register Factory Form (MUST)

The **default export of every `src/presets/**/data/*.js` and `.sennel/presets/**/data/*.js` file must be a factory function of the form `register(container)`**. A direct class default export is not allowed. If a class is exported directly, the loader calls it as a factory and fails with a `new` / constructor error.

```javascript
// NG: exporting a class directly as default is rejected by the loader
//     (the loader invokes the default export as a factory function and fails)

// OK: register factory
export default function register(container) {
  const DataSource = container.get("base.DataSource");
  class FooSource extends DataSource {
    list(analysis, labels) { return null; }
  }
  return FooSource;
}
```

The factory is invoked synchronously, and the returned Source class is registered by the loader under `dataSources.<category>`.

### 5.2 Obtaining Base Classes / Utilities

All sennel base classes and utilities must be **obtained through the Container**. At the top of a data source file, only Node.js built-in modules (`fs`, `path`, `url`, `crypto`) may be imported; relative imports into sennel internals and bare specifier imports are forbidden.

```javascript
import fs from "fs";

export default function register(container) {
  const DataSource = container.get("base.DataSource");
  const Scannable = container.get("base.Scannable");
  const AnalysisEntry = container.get("base.AnalysisEntry");
  const findFiles = container.get("scanner.findFiles");
  const stripBlockComments = container.get("phpParser.stripBlockComments");
  // ...
}
```

### 5.3 Inheriting Parent Preset Assets

Parent preset DataSource classes and their `Entry` classes are obtained via the Container's preset registry. The loader registers parent presets before child presets, so inside a child preset's `register()` the call `container.getPreset("<parent>")` is always resolvable.

```javascript
export default function register(container) {
  const webapp = container.getPreset("webapp").dataSources;
  const ControllersSource = webapp.controllers;
  const ControllerEntry = ControllersSource.Entry;

  class MyControllersSource extends ControllersSource {
    static Entry = ControllerEntry;
    match(relPath) { return relPath.endsWith("Controller.php"); }
    parse(absPath) {
      const entry = new ControllerEntry();
      // populate entry fields
      return entry;
    }
  }
  return MyControllersSource;
}
```

Extending `WebappDataSource`:

```javascript
export default function register(container) {
  const AnalysisEntry = container.get("base.AnalysisEntry");
  const WebappDataSource = container.getPreset("webapp").dataSources["webapp-data-source"];

  class ViewEntry extends AnalysisEntry {
    viewType = null;
    static summary = {};
  }
  class MyViewsSource extends WebappDataSource {
    static Entry = ViewEntry;
  }
  return MyViewsSource;
}
```

### 5.4 Two Kinds of DataSource

**(A) Scannable DataSource (scan and data combined)**

`match()` picks up files, and `parse()` returns parse results. The scan pipeline writes the returned entries to `analysis[category].entries` and automatically fills common fields (`file` / `hash` / `lines` / `mtime`). Resolve methods (`list()`, etc.) read `analysis` and produce output.

`Scannable` is exposed as a mixin via `base.Scannable`:

```javascript
export default function register(container) {
  const DataSource = container.get("base.DataSource");
  const Scannable = container.get("base.Scannable");
  class WebappDataSource extends Scannable(DataSource) {}
  return WebappDataSource;
}
```

**(B) Data-only DataSource (reads analysis written by another scan)**

Does not have `match()` / `parse()`; implements only resolve methods. **The analysis key it reads must be written by a scan DataSource somewhere in the chain**.

```javascript
export default function register(container) {
  const DataSource = container.get("base.DataSource");
  class SchemaSource extends DataSource {
    tables(analysis, labels) {
      const tables = analysis.schemas?.tables ?? [];
      if (tables.length === 0) return null;
      // ...
    }
  }
  return SchemaSource;
}
```

### 5.5 `match(relPath)` / `parse(absPath)` Contracts

- `match(relPath)`: `relPath` is the path relative to the scan root, separator is `/`, no leading `./`. Returns boolean.
- `parse(absPath)`: Argument is an absolute path. The scan pipeline invokes `parse` once per file in a synchronous loop by contract, so read synchronously with `fs.readFileSync(absPath, "utf8")` (making `parse` async would change the scan-pipeline contract and is out of scope for an individual preset). Returns `new this.constructor.Entry()` or `null`. Initialize Entry fields with `null`.

### 5.6 Resolve Method Return Value

Returns a **`Table` / `MarkdownText` renderable object, or `null`**. Always return `null` when there is no data (do not render broken empty tables).

### 5.7 Resolve Method Invocation Rules

A template's `{{data("<preset>.<category>.<method>", {labels: "A|B|C"})}}` calls `dataSources.get(category).method(analysis, labels)`. The `labels` arrive as an array `["A", "B", "C"]`. Category name = file name of `data/<category>.js` (without `.js`).

---

## 6. Import Rules (MUST follow)

Only **Node.js built-in modules** may be imported at the top of `data/*.js`:

```javascript
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
```

**Forbidden:**

1. Relative imports into sennel internals (`../../../docs/lib/...`, `../../lib/...`, `../../<sibling-preset>/...`) are forbidden.
2. Bare specifiers (`sennel/api`, `sennel/presets/*`, etc.) do not exist (removed in spec 191).
3. All sennel dependencies must be obtained inside the `register(container)` function via `container.get(...)` / `container.getPreset(...)`.

Test-only helpers that need sennel internal imports must be isolated in `tests/analyzers.js` (see §13.4).

---

## 7. Container Keys

Dependencies available inside a `register(container)` function are listed below (registered by `initContainer()` in `src/lib/container.js`). The Container is extended additively (existing keys are never changed), so new keys can be added in minor/patch releases without breaking existing presets.

### 7.1 Base Classes (base)

| Key | Kind | Purpose |
|---|---|---|
| `base.DataSource` | class | DataSource base class (resolve methods / helpers) |
| `base.Scannable` | mixin function | Adds scan capability (`class X extends Scannable(DataSource)`) |
| `base.AnalysisEntry` | class | Base class for scan entries (parent of classes assigned to `static Entry`) |
| `base.ANALYSIS_META_KEYS` | string[] | Array of reserved meta-field names on an Entry |

### 7.2 Scanner Utilities

| Key | Kind | Purpose |
|---|---|---|
| `scanner.findFiles` | function | Find files from glob patterns |
| `scanner.collectFiles` | function | Merge multiple include/exclude and collect files |
| `scanner.patternToRegex` | function | Convert a glob to a regex |
| `scanner.parseFile` | function | Dispatch to a language handler's parse by extension |
| `scanner.parsePHPFile` | function | PHP-specific parse |
| `scanner.parseJSFile` | function | JS/TS-specific parse |
| `scanner.camelToSnake` | function | `CamelCase` → `camel_case` |
| `scanner.pluralize` | function | Simple English pluralization |
| `scanner.getFileStats` | function | Line counts, hashes, etc. for a file |

### 7.3 PHP Parser Utilities

| Key | Kind | Purpose |
|---|---|---|
| `phpParser.stripBlockComments` | function | Remove `/* ... */` comments |
| `phpParser.extractArrayBody` | function | Extract the body text of `array(...)` |
| `phpParser.extractTopLevelKeys` | function | Extract top-level keys of an array literal |
| `phpParser.extractQuotedStrings` | function | Extract quoted string literals |

### 7.4 path-match Utilities

| Key | Kind | Purpose |
|---|---|---|
| `pathMatch.hasPathPrefix` | function | Relative path prefix match |
| `pathMatch.hasSegmentPath` | function | Path-segment containment check |
| `pathMatch.hasAnyPathPrefix` | function | Match against any of multiple prefixes |

### 7.5 lang / toml / config

| Key | Kind | Purpose |
|---|---|---|
| `lang.getHandler` | function | Get a language handler by extension |
| `toml.parse` | function | Parse TOML text into an object |
| `config.loadJsonFile` | function | Safely load a JSON file (does not throw on missing/empty) |

### 7.6 Runtime Services

Data sources rarely touch these directly, but some advanced resolve methods reference them:

| Key | Kind | Purpose |
|---|---|---|
| `root` | string | Absolute project root path |
| `mainRoot` | string | Path of the main repo (points to main even from inside a worktree) |
| `inWorktree` | boolean | Whether executing inside a worktree |
| `paths` | object | Absolute paths (root, repositoryRoot, srcRoot, managedDir, outputDir, agentWorkDir, temporaryRoot, logDir, configPath). agentWorkDir selects execution; temporaryRoot and logDir select independent scratch and log storage. |
| `config` | object | Loaded `.sennel/config.json` (null when uninitialized) |
| `lang` | string | `config.lang` (documentation language) |
| `i18n` | function | Translation function |
| `logger` | Logger | Log output |
| `agent` | Agent | AI agent invocation |
| `flowManager` | FlowManager | Spec-Driven Development flow state management |

### 7.7 Preset Registry

| Method | Purpose |
|---|---|
| `container.getPreset("<key>")` | Returns `{ dataSources: { <category>: SourceClass, ... } }` |
| `container.hasPreset("<key>")` | Whether registered |

Used by a child preset to inherit parent Source / Entry classes.

---

## 8. External Preset Compatibility (peerDependencies)

An external preset distributed as an npm package expresses its compatibility with sennel **only via `peerDependencies` in `package.json`**. No independent version field is added to the Container API.

```json
{
  "name": "sennel-preset-foo",
  "peerDependencies": {
    "sennel": "^0.1.0-alpha"
  }
}
```

- peerDependencies declares the minimum sennel version required to satisfy **Container key compatibility**.
- The Container grows only additively (existing keys never change), so minor/patch updates do not break existing presets.
- Do not put sennel in `dependencies` (this would install it twice and break resolution).

---

## 9. Template Design

### 9.1 Directive List

```markdown
<!-- {%extends%} -->                 Inherit the parent template (same file name)
<!-- {%extends: layout%} -->         Inherit by a different name
<!-- {%block "name"%} -->...<!-- {%/block%} --> Block definition / override

<!-- {{data("<preset>.<category>.<method>", {labels: "A|B|C"})}} -->
<!-- {{/data}} -->

<!-- {{text({prompt: "write description", mode: "deep"})}} -->
<!-- {{/text}} -->
```

- `{{data}}` and `{{/data}}` **remain in the file after resolution** and serve as markers for the next build.
- An empty template file acts as a "deletion marker" that removes the parent's block.

### 9.2 When to Use `{{data}}` vs `{{text}}`

| Condition | Directive |
|---|---|
| Mechanically extractable by regex / parser | `{{data(...)}}` |
| Too framework-specific to structure | `{{text(...)}}` |

### 9.3 Parent Uses `{{text}}`, Child Overrides with `{{data}}`

Upper-level presets like `webapp` use `{{text}}` + `{%block%}`; child presets override the block with `{{data}}`.

### 9.4 Template Resolution Priority (high → low)

1. Project-local `.sennel/templates/<lang>/docs/`
2. Project-local preset `.sennel/presets/<key>/templates/<lang>/`
3. Leaf preset `src/presets/<leaf>/templates/<lang>/`
4. Parent presets (up to root)

---

## 10. MUST: scan / data Pairing Rule

If a data DataSource reads `analysis.X`, there must be a scan DataSource somewhere in the chain that writes `X`.

```
✅ Correct:
  scan DataSource "modules" → writes analysis.modules
  data DataSource modules.list() → reads analysis.modules

❌ Violation:
  data DataSource schema.tables() → reads analysis.schemas
  → no scan DataSource writes analysis.schemas
```

---

## 11. enrich Constraints

The enrich phase only attaches `summary` / `chapter` / `role` to entries that scan has collected. **It does not create new analysis categories or invent data that scan failed to find.**

---

## 12. Implementation Procedure (Top-down)

### 12.1 Creation Order (MUST)

Build in the order **Templates → DataSources → scan parsers**. Working backwards from the consumer avoids writing unnecessary parsers and prevents missing data.

### 12.2 Step-by-Step

1. **Create preset.json** — define at minimum `parent` / `scan.include` / `chapters`
2. **Add `<key>` to `type` in config.json** — put the leaf first
3. **Validate scan patterns with `sennel docs scan --dry-run`**
4. **Place templates** — start with only `{{text}}` to establish the skeleton
5. **Implement DataSources one at a time** — each as a `register(container)` factory. After each, run `sennel docs scan` and check `<category>.entries.length`
6. **Swap the relevant template blocks from `{{text}}` to `{{data}}`**
7. **Run `sennel docs build`** and verify the entire pipeline
8. **Add guardrail.json** (polish once build passes)
9. **For built-in presets, set up `tests/`** and run `npm test` to verify integrity

### 12.3 Minimal Working Set

```
.sennel/
├── config.json                    # Add "type": ["mypreset", ...]
└── presets/mypreset/
    ├── preset.json                # {"parent": "webapp", "scan": {"include": ["src/**/*.js"]}}
    └── data/
        └── simple.js
```

```javascript
// data/simple.js
export default function register(container) {
  const AnalysisEntry = container.get("base.AnalysisEntry");
  const WebappDataSource = container.getPreset("webapp").dataSources["webapp-data-source"];

  class SimpleEntry extends AnalysisEntry {
    name = null;
    static summary = {};
  }
  class SimpleSource extends WebappDataSource {
    static Entry = SimpleEntry;
    match(relPath) { return relPath.endsWith(".js"); }
    parse(absPath) {
      const entry = new SimpleEntry();
      entry.name = absPath.split("/").pop();
      return entry;
    }
  }
  return SimpleSource;
}
```

---

## 13. Validation Commands and Tests

### 13.1 Validation Commands

```bash
sennel docs scan --dry-run         # Per-category entry-count summary
sennel docs scan --stdout          # Print full analysis JSON
sennel docs scan                   # Real run
sennel docs build                  # Full pipeline
npm test                              # Integrity tests
npm test -- --preset <key>            # Per-preset
node tests/acceptance/run.js <key>    # Per-preset acceptance
```

### 13.2 Test Layout (Built-in Presets)

- `tests/unit/` — DataSource `match` / `parse` I/O tests
- `tests/e2e/` — preset.json scan configuration check and full scan
- `tests/acceptance/test.js` — preset-local fixture acceptance tests

### 13.3 Integrity Tests

`tests/unit/presets/preset-scan-integrity.test.js` automatically verifies:

1. Every preset with scan patterns has a scan DataSource in its chain
2. Every `{{data}}` directive references a method that exists on the DataSource
3. For every data DataSource that reads `analysis.X`, some scan DataSource in the chain writes `X`

### 13.4 Test-Only Helpers (`tests/analyzers.js`)

Importing sennel internals from `data/*.js` is forbidden (§6). When a unit test needs to verify "the Source's parse produces a specific AST" or a similar internal assertion, place the test-only helper in `tests/analyzers.js` — that file is free to import sennel internals. Test files (`tests/unit/*.test.js`) should import only from this helper, keeping the Source body free of internal module dependencies.

---

## 14. Pitfall Checklist

### 14.1 `*/` Inside a JSDoc Comment Closes the Comment

Writing a file path that contains `*/` inside a doc comment cuts the comment short.

```javascript
/**
 * Parses src/app/Plugin/*/PluginManager.php.   ← "*/" closes the comment
 */
```

**Fix**: Replace wildcards in paths with placeholders such as `{name}`. Validate with `node --input-type=module --check <file>`.

### 14.2 Do Not Default-Export a Class Directly

The loader invokes the default export as a factory function. A class default export is called in a non-`new` manner and fails with "Class constructor X cannot be invoked without 'new'". **Always wrap it as `register(container) { return class ... }`**.

### 14.3 No Self-Reference Within the Same Preset

Inside the `data/` files of a parent preset (e.g. webapp itself), do not rely on `container.getPreset("webapp")` for self-reference. The loader processes files in `readdir` order and registers the preset only after all files in `data/` have been processed. If a sibling Source in the same preset needs to be extended, load it from its own file first and reconstruct the class hierarchy from the base classes inside `register(container)`.

### 14.4 Strictness of `chapters`

Chapters declared in `chapters` require a template in the preset itself or an ancestor. For chapters you do not override, place a thin template with `{%extends%}`.

### 14.5 `[init] ERROR:` Is an Informational Message

`sennel docs init`'s `[init] ERROR: N files already exist under docs/` is an **informational** notice (about `--force`), not a failure. Judge by exit code.

### 14.6 Common Errors

| Error | Cause |
|---|---|
| `Class constructor X cannot be invoked without 'new'` | A class was default-exported directly (not wrapped in a register factory) |
| `Container: dependency not registered: <key>` | `container.get()` was called with an unregistered key |
| `Cannot read properties of null (reading 'dataSources')` | `container.getPreset("<key>")` referred to an unregistered preset |
| `<category>.entries.length === 0` | `match()` is always false, or `scan.include` is missing |
| `Preset not found: <key>` | Not listed in `type` of `config.json` |
| `[data] UNRESOLVED {{data}} in foo.md: <cat>.<sub>.<method>` | The DataSource does not exist or the resolve method is not defined |

---

## 15. Additional Requirements for Built-in Presets

### 15.1 No Project-Specific Values

Do not write project-specific values (project name, host, port, container name, etc.) into `src/presets/`. Keep only generic parsing logic. Externalize project-specific values in `.sennel/config.json`.

### 15.2 Tests (MUST)

Provide `tests/unit/` / `tests/e2e/` / `tests/acceptance/test.js` and make each preset runnable on its own via `npm test -- --preset <name>`.

---

## 16. Additional Requirements for Project-Local Presets

- Leaf-only. `parent` must point to a built-in key.
- `preset.json` may be omitted (inherits defaults from the built-in chain).
- Files under `.sennel/templates/<lang>/docs/` have the highest priority (stronger than preset templates).
- `package.json` is not needed (the loader uses sennel's own resolution context).

---

## 17. AI Execution Checklist

1. [ ] Inspect the target project's directory structure and framework
2. [ ] Choose the closest parent among existing presets
3. [ ] Create `<preset-root>/<key>/preset.json`
4. [ ] Add `<key>` to the head of the `type` array in `.sennel/config.json`
5. [ ] Confirm file collection with `sennel docs scan --dry-run`
6. [ ] Place skeleton templates under `templates/<lang>/` (start with `{{text}}` only)
7. [ ] Implement DataSources one by one as `register(container)` factories
8. [ ] Obtain dependencies via `container.get(...)` / `container.getPreset(...).dataSources`
9. [ ] Verify there is no direct class export and no relative import into sennel internals
10. [ ] After each DataSource, run `sennel docs scan` and inspect `analysis.json`
11. [ ] If you read `analysis.X`, verify that a scan DataSource in the chain writes `X`
12. [ ] Gradually replace `{{text}}` with `{{data}}` in templates
13. [ ] Confirm the whole pipeline passes with `sennel docs build`
14. [ ] For built-in presets, set up `tests/` and ensure `npm test` passes
15. [ ] For external distribution, declare `sennel` under `peerDependencies` in `package.json`

---

## 18. Reference Files

sennel core:

| File | Content |
|---|---|
| `src/lib/container.js` | Container implementation and `initContainer()` key registration |
| `src/lib/presets.js` | Preset discovery, chain resolution, and loader |
| `src/docs/lib/data-source.js` | `DataSource` base class |
| `src/docs/lib/scan-source.js` | `Scannable` mixin (`match`, `parse`) |
| `src/docs/lib/analysis-entry.js` | `AnalysisEntry` base class |
| `src/docs/lib/template-merger.js` | Template inheritance and block merging |
| `src/presets/base/data/*.js` | Reference for the base factory pattern |
| `src/presets/webapp/data/webapp-data-source.js` | Reference for `Scannable(DataSource)` factory |
| `src/presets/cakephp2/data/*.js` | Reference implementation for a PHP framework |

Project rules:

- `src/CLAUDE.md` / `src/AGENTS.md` — sennel internal architecture and MUST rules
- Project root `CLAUDE.md` — restrictions on writing to `src/`

## Guardrail Rewrite Rubric

Use the guardrail rewrite rubric when updating preset guardrails.
Each rewritten guardrail should define named violation sections, diff-verification condition bullets, and a severity-policy that distinguishes blocking from advisory findings.
