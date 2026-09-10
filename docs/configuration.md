<!-- {{data("base.docs.langSwitcher", {labels: "relative"})}} -->
[日本語](ja/configuration.md) | **English**
<!-- {{/data}} -->

# Configuration and Customization

## Description

<!-- {{text({prompt: "Write a 1-2 sentence overview of this chapter. Include the types of config files, range of configurable items, and customization points."})}} -->

sennel is configured through a single project-level JSON file (`.sennel/config.json`) and optionally extended by project-local preset definitions. Configurable items span documentation output languages and style, agent provider selection and execution parameters, scan scope, flow and Git integration, and logging, with additional customization available through preset overrides and environment variables.
<!-- {{/text}} -->

## Content

### Configuration Files

<!-- {{text({prompt: "List all configuration files this tool reads, including their locations and roles, in table format. Extract from file reading logic in the source code."})}} -->

| File | Location | Role |
|------|----------|------|
| `config.json` | `.sennel/config.json` | Primary project configuration — defines language, preset type, docs settings, agent providers, scan patterns, and flow options. Required for all `sennel` commands. |
| `preset.json` (built-in) | `src/presets/<key>/preset.json` | Built-in preset manifests bundled with the npm package. Auto-discovered at startup and define chapter structure, scan defaults, and template associations. |
| `preset.json` (project-local) | `.sennel/presets/<key>/preset.json` | Project-local preset overrides. When present, takes precedence over the built-in preset of the same key. Supports the same schema as built-in presets and may declare a `parent` for inheritance. |
| `package.json` | Project root | Loaded selectively via `loadPackageField()` to read arbitrary project metadata into documentation generation context. |
<!-- {{/text}} -->

### Configuration Reference

<!-- {{text({prompt: "Describe all configuration fields in table format. Include field name, required/optional, type, default value, and description. Extract from validation logic and default value definitions in the source code.", mode: "deep"})}} -->

| Field | Required | Type | Default | Description |
|-------|----------|------|---------|-------------|
| `lang` | Yes | string | — | Operating language for the CLI, generated AGENTS.md, skills, and spec files (e.g., `"en"`, `"ja"`). |
| `type` | Yes | string \| string[] | — | Preset name(s) to activate (e.g., `"symfony"` or `["symfony", "postgres"]`). Leaf name only — path-style values are not supported. |
| `docs` | Yes | object | — | Container for all documentation output settings. |
| `docs.languages` | Yes | string[] | — | List of language codes for documentation output (e.g., `["en"]` or `["ja", "en"]`). |
| `docs.defaultLanguage` | Yes | string | — | Primary language; must appear in `docs.languages`. |
| `docs.mode` | No | `"translate"` \| `"generate"` | `"translate"` | How non-default-language documents are produced. |
| `docs.style.purpose` | No | string | — | Document purpose hint: `"developer-guide"`, `"user-guide"`, `"api-reference"`, or a custom string. |
| `docs.style.tone` | No | string | — | Writing tone: `"polite"`, `"formal"`, or `"casual"`. |
| `docs.style.customInstruction` | No | string | — | Additional free-form instructions passed to the documentation generation agent. |
| `docs.exclude` | No | string[] | — | Glob patterns for source files to exclude from documentation scanning. |
| `name` | No | string | — | Project name, set by the setup wizard. |
| `concurrency` | No | number | `5` | Maximum number of files processed in parallel during pipeline execution. |
| `scan.include` | Yes (if `scan` present) | string[] | — | Glob patterns specifying which source files to include in a scan. |
| `scan.exclude` | No | string[] | `[]` | Glob patterns for files to exclude from the scan. |
| `agent.default` | No | string | — | Default agent provider key (e.g., `"claude/sonnet"`). |
| `agent.workDir` | No | string | `".tmp"` | Working directory for agent execution, relative to the project root. |
| `agent.timeout` | No | number | `900` | Agent execution timeout in seconds. |
| `agent.retryCount` | No | number | — | Retry count for `docs enrich` agent calls on failure. |
| `agent.promptCharacterLimit` | No | integer | `120000` | Maximum provider-visible characters per logical agent invocation; must be between `1000` and `120000`. This is independent of the UTF-8 argv byte threshold. |
| `agent.providers` | No | object | `{}` | Map of custom agent provider definitions keyed by a user-chosen identifier. |
| `agent.providers[key].command` | Yes (per provider) | string | — | Executable to invoke (e.g., `"claude"`, `"codex"`). |
| `agent.providers[key].args` | Yes (per provider) | string[] | — | Arguments passed to the command. Use `{{PROMPT}}` as the placeholder for the generated prompt. |
| `agent.providers[key].systemPromptFlag` | No | string | — | CLI flag used to pass a system prompt (e.g., `"--system-prompt"`). |
| `agent.providers[key].jsonOutputFlag` | No | string | — | CLI flag that requests JSON-formatted output from the agent. |
| `agent.profiles` | No | object | — | Named profiles mapping command prefixes to provider keys, enabling per-command agent selection. |
| `agent.useProfile` | No | string | — | Name of the profile to activate; overridden by the `SENNEL_PROFILE` environment variable. |
| `flow.merge` | No | `"squash"` \| `"ff-only"` \| `"merge"` | `"squash"` | Git merge strategy applied when closing a flow. |
| `flow.push.remote` | No | string | `"origin"` | Git remote used for push operations during flow finalization. |
| `flow.commands.context.search.mode` | No | `"ngram"` \| `"ai"` | — | Search mode used when retrieving flow context. |
| `commands.gh` | No | `"enable"` \| `"disable"` | `"disable"` | Whether the GitHub CLI (`gh`) is available for PR-related flow steps. |
| `logs.enabled` | No | boolean | `false` | Enable unified JSONL logging of agent requests and responses. |
| `logs.dir` | No | string | `"{agent.workDir}/logs"` | Directory for unified JSONL agent logs. Flow runtime logs can be directed per invocation with `--log-file`; when omitted, `flow run` writes under `<agentWorkDir>/logs/<flowId>/`. |
| `chapters` | No | object[] | preset defaults | Override or reorder the chapter list. Each entry requires a `chapter` filename and supports optional `desc` and `exclude` fields. |
| `experimental.workflow.enable` | No | boolean | `false` | Enable the experimental workflow feature. |
| `experimental.workflow.languages.source` | No | string | — | Source language for the experimental workflow. |
| `experimental.workflow.languages.publish` | No | string | — | Target publish language for the experimental workflow. |
<!-- {{/text}} -->

### Repair fingerprint safety boundary

`flow.repairFingerprint.maxChangedPaths` controls how many changed paths can be processed as one complete repair fingerprint. The default is `20000`; valid values are integers from `1` through `1000000`. Increase it only when the typed `REPAIR_CHANGED_PATH_LIMIT` error reports that a legitimate change set exceeds the current boundary.

`flow.repairFingerprint.include` is an optional array of repository-relative paths that must be tracked even when Git ignores them. It is add-only: there is no corresponding `exclude` setting, because excluding implementation inputs would allow stale evidence to be accepted.

```json
{
  "flow": {
    "repairFingerprint": {
      "maxChangedPaths": 50000,
      "include": ["generated/contracts"]
    }
  }
}
```

The default input set follows Git policy rather than directory names. An ignored, untracked `src/node_modules` is excluded; a tracked or non-ignored untracked path at the same location is included. These settings do not define a project source root and do not change which tests the flow runs.

### Customization Points

<!-- {{text({prompt: "Describe items that users can customize. Extract configurable items from the source code and include configuration examples for each.", mode: "deep"})}} -->

**Agent Providers**

You can define custom agent providers or override built-in ones under `agent.providers`. Built-in Codex providers use GPT-5.6 Luna, Terra, and Sol with an explicit reasoning effort in each provider key. Use `{{PROMPT}}` in the `args` array as the injection point for the generated prompt.

```json
{
  "agent": {
    "default": "claude/sonnet",
    "providers": {
      "my-claude": {
        "command": "claude",
        "args": ["-p", "{{PROMPT}}", "--model", "claude-3-7-sonnet-20250219"],
        "systemPromptFlag": "--system-prompt"
      }
    }
  }
}
```

**Agent Profiles**

Profiles map command prefixes to provider keys, allowing different agent providers to be used for different sennel operations. Activate a profile with `agent.useProfile` or the `SENNEL_PROFILE` environment variable.

```json
{
  "agent": {
    "profiles": {
      "ci": {
        "docs": "codex/gpt-5.6-terra-low",
        "flow": "claude/sonnet"
      }
    },
    "useProfile": "ci"
  }
}
```

**Documentation Style**

Control the tone and purpose of generated documents through `docs.style`. The `customInstruction` field passes additional free-form guidance to the generation agent.

```json
{
  "docs": {
    "languages": ["en"],
    "defaultLanguage": "en",
    "style": {
      "purpose": "user-guide",
      "tone": "polite",
      "customInstruction": "Avoid jargon and include code examples wherever possible."
    }
  }
}
```

**Multi-Language Output**

Set `docs.languages` to an array of language codes and configure `docs.mode` to control how secondary languages are produced.

```json
{
  "docs": {
    "languages": ["en", "ja"],
    "defaultLanguage": "en",
    "mode": "translate"
  }
}
```

**Project-Local Presets**

Place a `preset.json` (and optional templates) under `.sennel/presets/<key>/` to override or extend any built-in preset. The project-local definition takes precedence over the same-named built-in preset. Declare a `parent` field to inherit from an existing preset.

```json
{
  "parent": "symfony",
  "label": "My Symfony Project",
  "chapters": [
    {"chapter": "overview.md"},
    {"chapter": "deployment.md", "desc": "Deployment procedures"}
  ]
}
```

**Scan Scope**

Restrict or expand which files are analysed by configuring `scan.include` and `scan.exclude` with glob patterns.

```json
{
  "scan": {
    "include": ["src/**/*.php", "config/**/*.yaml"],
    "exclude": ["src/migrations/**"]
  }
}
```

**Flow and Git Integration**

Configure how sennel interacts with Git during flow finalization.

```json
{
  "flow": {
    "merge": "squash",
    "push": {"remote": "upstream"}
  }
}
```

**Logging**

Enable JSONL logging to record agent prompts and responses. Logs are written as daily `.jsonl` files and per-request JSON files under the configured directory.

Flow runtime command logs are separate human-readable files. Use `sennel flow run <action> --agent-work-dir .tmp --log-file .tmp/<name>.log` when an operator-readable log path is needed.

```json
{
  "logs": {
    "enabled": true,
    "dir": ".tmp/logs"
  }
}
```
<!-- {{/text}} -->

### Built-In Agent Profiles

`sennel setup` stores the selected agent family in `agent.default` as `claude` or `codex`, and stores the routing intent in `agent.useProfile`. Built-in profile names are `claude-only`, `codex-only`, `claude-main`, and `codex-main`.

Built-in `agent.profiles` and `agent.providers` are resolved from the package at runtime. They do not need to be copied into `.sennel/config.json`. Define the same key locally only when you want to override the package default.

The built-in Codex tiers are `codex/gpt-5.6-luna-low` for lightweight work, `codex/gpt-5.6-terra-low` and `codex/gpt-5.6-terra-medium` for routine generation and validation, and `codex/gpt-5.6-sol-medium` for quality-sensitive reviews.

```json
{
  "agent": {
    "default": "codex",
    "useProfile": "codex-main",
    "profiles": {
      "codex-main": {
        "docs.readme": "my-codex"
      }
    },
    "providers": {
      "my-codex": {
        "command": "codex",
        "args": ["exec", "{{PROMPT}}"]
      }
    }
  }
}
```

### Environment Variables

<!-- {{text({prompt: "List all environment variables referenced by the tool and their purposes in table format. Extract from process.env references in the source code.", mode: "deep"})}} -->

| Variable | Purpose |
|----------|---------|
| `SENNEL_WORK_ROOT` | Overrides the automatically detected work root (normally the Git repository root). When set, all file resolution is anchored to this path instead of the result of `git rev-parse --show-toplevel`. |
| `SENNEL_SOURCE_ROOT` | Overrides the source root used for scanning and documentation generation. When set, takes precedence over the value derived from `SENNEL_WORK_ROOT` or the Git root. |
| `SENNEL_PROFILE` | Specifies the active agent profile name. Takes priority over the `agent.useProfile` field in `config.json`, allowing the profile to be switched per invocation without modifying the config file. |
<!-- {{/text}} -->

---

<!-- {{data("base.docs.nav")}} -->
[← CLI Command Reference](cli_commands.md) | [Internal Design →](internal_design.md)
<!-- {{/data}} -->
