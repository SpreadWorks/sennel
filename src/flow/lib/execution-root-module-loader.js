import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRODUCT } from "../../lib/product.js";

function requiredDirectory(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${name} must identify an absolute directory`);
  }
  return path.resolve(value);
}

const repositoryRoot = requiredDirectory(PRODUCT.env("TEST_REPOSITORY_ROOT"));
const executionRoot = requiredDirectory(PRODUCT.env("TEST_EXECUTION_ROOT"));
const specRoot = requiredDirectory(PRODUCT.env("TEST_SPEC_ROOT"));
const canonicalSpecRoot = requiredDirectory(PRODUCT.env("TEST_CANONICAL_SPEC_ROOT"));

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function executionUrlForSharedRelativeImport(specifier, context) {
  if (!specifier.startsWith(".") || !context.parentURL?.startsWith("file:")) return null;
  const parentPath = fileURLToPath(context.parentURL);
  if (!isWithin(specRoot, parentPath)) return null;

  const relativeParent = path.relative(specRoot, parentPath);
  const canonicalParent = path.join(canonicalSpecRoot, relativeParent);
  const repositoryUrl = new URL(specifier, pathToFileURL(canonicalParent));
  if (repositoryUrl.protocol !== "file:") return null;
  const repositoryPath = fileURLToPath(repositoryUrl);
  if (isWithin(canonicalSpecRoot, repositoryPath)) {
    const materializedPath = path.join(specRoot, path.relative(canonicalSpecRoot, repositoryPath));
    return fs.existsSync(materializedPath) ? pathToFileURL(materializedPath).href : null;
  }
  if (!isWithin(repositoryRoot, repositoryPath)) return null;

  const executionPath = path.join(executionRoot, path.relative(repositoryRoot, repositoryPath));
  if (!fs.existsSync(executionPath)) return null;
  const executionUrl = pathToFileURL(executionPath);
  executionUrl.search = repositoryUrl.search;
  executionUrl.hash = repositoryUrl.hash;
  return executionUrl.href;
}

/**
 * Shared spec tests live under the base checkout, but imports of repository
 * code must resolve against the execution worktree. The shared spec tree is
 * deliberately excluded so test-to-test imports keep their single authority.
 */
export async function resolve(specifier, context, nextResolve) {
  const sharedRelativeExecutionUrl = executionUrlForSharedRelativeImport(specifier, context);
  if (sharedRelativeExecutionUrl) return nextResolve(sharedRelativeExecutionUrl, context);

  const resolved = await nextResolve(specifier, context);
  if (resolved.url.startsWith("file:") && repositoryRoot !== executionRoot) {
    const resolvedPath = fileURLToPath(resolved.url);
    if (isWithin(repositoryRoot, resolvedPath) && !isWithin(specRoot, resolvedPath)) {
      const executionPath = path.join(executionRoot, path.relative(repositoryRoot, resolvedPath));
      if (fs.existsSync(executionPath)) {
        return { ...resolved, url: pathToFileURL(executionPath).href, shortCircuit: true };
      }
    }
  }
  return resolved;
}
