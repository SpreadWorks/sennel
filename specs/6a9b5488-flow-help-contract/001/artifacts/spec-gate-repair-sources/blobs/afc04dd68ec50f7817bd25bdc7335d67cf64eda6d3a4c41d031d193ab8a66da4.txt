/** Lightweight glob selection used by the documentation scanner. */

import { globToRegex } from "../../lib/glob.js";

const DOCUMENTATION_SCANNER_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "vendor"]);

export function isDocumentationScannerExcludedPath(relativePath) {
  return relativePath.split("/").some((segment) => DOCUMENTATION_SCANNER_EXCLUDED_DIRECTORIES.has(segment));
}

function assertPatterns(name, patterns) {
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
    throw new Error(`documentation source ${name} must be an array of strings`);
  }
}

function staticDirectoryPrefix(pattern) {
  const segments = pattern.split("/");
  const wildcardIndex = segments.findIndex((segment) => segment.includes("*"));
  if (wildcardIndex === -1) return segments.length === 1 ? null : segments.slice(0, -1);
  if (wildcardIndex === 0 && segments.length === 1) return segments[0].includes("**") ? [] : null;
  return segments.slice(0, wildcardIndex);
}

function directoryCanContain(prefix, directory) {
  if (prefix === null) return false;
  if (prefix.length === 0) return true;
  const segments = directory.split("/").filter(Boolean);
  return prefix.slice(0, Math.min(prefix.length, segments.length))
    .every((segment, index) => segment === segments[index]);
}

export class DocumentationSourceSelection {
  constructor({ include = [], exclude = [] } = {}) {
    assertPatterns("include", include);
    assertPatterns("exclude", exclude);
    this.include = Object.freeze([...include]);
    this.exclude = Object.freeze([...exclude]);
    this.includeMatchers = Object.freeze(this.include.map((pattern) => globToRegex(pattern)));
    this.excludeMatchers = Object.freeze(this.exclude.map((pattern) => globToRegex(pattern)));
    this.includeDirectoryPrefixes = Object.freeze(this.include.map(staticDirectoryPrefix));
    Object.freeze(this);
  }

  matchesFile(relativePath) {
    return this.includeMatchers.some((matcher) => matcher.test(relativePath))
      && !this.excludeMatchers.some((matcher) => matcher.test(relativePath));
  }

  shouldEnterDirectory(relativePath) {
    return this.includeDirectoryPrefixes.some((prefix) => directoryCanContain(prefix, relativePath));
  }
}
