/**
 * src/docs/lib/docs-context.js
 *
 * Pure function that assembles docs-specific context fields from the shared
 * dependency container and CLI overrides. Replaces the former
 * resolveCommandContext() in src/docs/lib/command-context.js.
 */

import path from "path";
import { DEFAULT_LANG } from "../../lib/config.js";

export function resolveDocsContext(container, cli, overrides) {
  const o = overrides || {};
  const paths = container.get("paths");
  const config = container.get("config");

  const root = o.root || paths.root;
  const srcRoot = o.srcRoot || paths.srcRoot;

  const lang = o.lang || cli?.lang || config?.lang || DEFAULT_LANG;
  const outputLang = o.outputLang || cli?.lang || config?.docs?.defaultLanguage || lang;
  const type = o.type || cli?.type || config?.type || "";

  const docsDir = o.docsDir
    ? path.resolve(root, o.docsDir)
    : cli?.docsDir
      ? path.resolve(root, cli.docsDir)
      : path.join(root, "docs");

  const commandId = o.commandId || undefined;
  const agent = container.get("agent");
  const t = container.get("i18n");

  return {
    root,
    srcRoot,
    config,
    lang,
    outputLang,
    type,
    docsDir,
    agent,
    commandId,
    t,
  };
}
