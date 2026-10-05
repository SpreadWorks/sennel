/**
 * Non-authoritative cache for explicitly requested human artifact views.
 *
 * Cache files live under the exact Version root's .runtime/views directory.
 * They are deliberately absent from the artifact catalog and are never read
 * as Flow transition input. A cache failure is therefore represented as a
 * warning after successful rendering rather than as a Flow failure.
 */

import fs from "node:fs";
import path from "node:path";
import { AtomicFile } from "../../lib/atomic-file.js";
import { FLOW_ARTIFACT_VIEW_REGISTRY } from "./artifact-view-registry.js";
import { ArtifactFullView } from "./artifact-view-renderer.js";
import { ArtifactViewTarget, artifactViewRuntimeDirectory } from "./artifact-view-reader.js";
import {
  artifactViewSha256,
  immutableArtifactViewFingerprintInput,
  stableArtifactViewJson,
} from "./artifact-view-fingerprint.js";

const CACHE_FORMAT_REVISION = "1";
const CACHE_COMMENT_PREFIX = "<!-- sennel-flow-artifact-view ";
const CACHE_COMMENT_SUFFIX = " -->\n";
const MODES = new Set(["full", "summary"]);

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function fingerprintValue(value, field) {
  const result = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} must be a SHA-256 digest`);
  return result;
}

function cacheMode(value) {
  const mode = text(value, "artifact view cache mode");
  if (!MODES.has(mode)) throw new Error("artifact view cache mode must be full or summary");
  return mode;
}

/** Fixed cache slot for one registered view target and mode. */
export class ArtifactViewCacheKey {
  constructor({ logicalKey, mode, registry = FLOW_ARTIFACT_VIEW_REGISTRY } = {}) {
    if (!registry || typeof registry.require !== "function") throw new Error("artifact view cache key requires an ArtifactViewRegistry");
    this.logicalKey = registry.require(logicalKey).logicalKey;
    this.mode = cacheMode(mode);
    this.fileName = `${this.logicalKey}.${this.mode}.md`;
    Object.freeze(this);
  }

  toJSON() { return { logicalKey: this.logicalKey, mode: this.mode, fileName: this.fileName }; }
}

/** Complete fingerprint inputs for a deterministic full view. */
export class ArtifactFullViewFingerprint {
  constructor({ fullView } = {}) {
    if (!(fullView instanceof ArtifactFullView)) throw new Error("full artifact view fingerprint requires an ArtifactFullView");
    this.logicalKey = fullView.logicalKey;
    const target = Object.freeze({
      specId: fullView.document.target.specId,
      version: fullView.document.target.version,
    });
    const sources = Object.freeze(fullView.sourceArtifacts.map((source) => Object.freeze({
      logicalKey: source.logicalKey,
      relativePath: source.relativePath,
      hash: source.hash,
    })));
    this.inputs = immutableArtifactViewFingerprintInput({
      // The cache is Version-scoped on disk, but the selected canonical
      // identity is also an explicit hash input.  Do not conflate that
      // identity with the closed renderer registry specification.
      target,
      registry: fullView.document.entry.specification(),
      sources,
      rendererRevision: fullView.rendererRevision,
      lang: fullView.language,
      i18nRevision: fullView.i18nRevision,
    });
    this.revision = CACHE_FORMAT_REVISION;
    this.value = artifactViewSha256(stableArtifactViewJson({
      cacheRevision: this.revision,
      mode: "full",
      logicalKey: this.logicalKey,
      ...this.inputs,
    }));
    Object.freeze(this);
  }

  toString() { return this.value; }
}

/** Metadata stored only in the cache file's first HTML comment. */
export class ArtifactViewCacheMetadata {
  constructor({ revision = CACHE_FORMAT_REVISION, fingerprint } = {}) {
    this.revision = text(revision, "artifact view cache revision");
    this.fingerprint = fingerprintValue(fingerprint, "artifact view cache fingerprint");
    Object.freeze(this);
  }

  toComment() {
    return `${CACHE_COMMENT_PREFIX}${JSON.stringify({ revision: this.revision, fingerprint: this.fingerprint })}${CACHE_COMMENT_SUFFIX}`;
  }

  static parse(markdown) {
    if (typeof markdown !== "string") throw new Error("artifact view cache content must be text");
    if (!markdown.startsWith(CACHE_COMMENT_PREFIX)) throw new Error("artifact view cache metadata comment is absent");
    const end = markdown.indexOf(CACHE_COMMENT_SUFFIX);
    if (end < 0) throw new Error("artifact view cache metadata comment is malformed");
    const raw = markdown.slice(CACHE_COMMENT_PREFIX.length, end);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`artifact view cache metadata is invalid JSON: ${error.message}`);
    }
    const metadata = new ArtifactViewCacheMetadata(parsed);
    return Object.freeze({
      metadata,
      markdown: markdown.slice(end + CACHE_COMMENT_SUFFIX.length),
    });
  }
}

/** A non-fatal cache persistence diagnostic for the Flow envelope layer. */
export class ArtifactViewCacheWarning {
  constructor({ message, cause = null } = {}) {
    this.code = "ARTIFACT_VIEW_CACHE_NOT_SAVED";
    this.message = text(message, "artifact view cache warning message");
    this.cause = cause === null ? null : String(cause.message || cause);
    Object.freeze(this);
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.cause === null ? {} : { cause: this.cause }) };
  }
}

export class ArtifactViewCacheRead {
  constructor({ hit, markdown = null } = {}) {
    if (hit !== true && hit !== false) throw new Error("artifact view cache read hit must be boolean");
    if (hit && (typeof markdown !== "string" || markdown === "")) throw new Error("artifact view cache hit requires Markdown");
    this.hit = hit;
    this.markdown = hit ? markdown : null;
    Object.freeze(this);
  }
}

export class ArtifactViewCacheWrite {
  constructor({ saved, warning = null } = {}) {
    if (saved !== true && saved !== false) throw new Error("artifact view cache write saved must be boolean");
    if (warning !== null && !(warning instanceof ArtifactViewCacheWarning)) {
      throw new Error("artifact view cache write warning must be an ArtifactViewCacheWarning or null");
    }
    this.saved = saved;
    this.warning = warning;
    Object.freeze(this);
  }
}

/**
 * One Version-scoped cache filesystem boundary. read() intentionally treats
 * every cache read/validation problem as a miss so canonical rendering can
 * continue. write() returns a warning rather than throwing once Markdown is
 * already generated.
 */
export class ArtifactViewCache {
  constructor({ target, faultInjector = null, registry = FLOW_ARTIFACT_VIEW_REGISTRY } = {}) {
    if (!(target instanceof ArtifactViewTarget)) throw new Error("artifact view cache requires an ArtifactViewTarget");
    if (faultInjector !== null && typeof faultInjector !== "function") throw new Error("artifact view cache faultInjector must be a function or null");
    if (!registry || typeof registry.require !== "function") throw new Error("artifact view cache requires an ArtifactViewRegistry");
    this.target = target;
    this.registry = registry;
    this.faultInjector = faultInjector;
    this.directory = artifactViewRuntimeDirectory(target);
    Object.freeze(this);
  }

  read({ logicalKey, mode, revision = CACHE_FORMAT_REVISION, fingerprint } = {}) {
    try {
      const key = new ArtifactViewCacheKey({ logicalKey, mode, registry: this.registry });
      const expected = new ArtifactViewCacheMetadata({ revision, fingerprint });
      const bytes = new AtomicFile(this.#filePath(key), { phaseNamespace: "artifact-view-cache-read" }).read(null);
      if (bytes === null) return new ArtifactViewCacheRead({ hit: false });
      const parsed = ArtifactViewCacheMetadata.parse(bytes.toString("utf8"));
      if (parsed.metadata.revision !== expected.revision || parsed.metadata.fingerprint !== expected.fingerprint) {
        return new ArtifactViewCacheRead({ hit: false });
      }
      if (parsed.markdown === "") return new ArtifactViewCacheRead({ hit: false });
      return new ArtifactViewCacheRead({ hit: true, markdown: parsed.markdown });
    } catch {
      // A cache must never prevent rendering from cataloged canonical sources.
      return new ArtifactViewCacheRead({ hit: false });
    }
  }

  write({ logicalKey, mode, revision = CACHE_FORMAT_REVISION, fingerprint, markdown, warningMessage = null } = {}) {
    try {
      const key = new ArtifactViewCacheKey({ logicalKey, mode, registry: this.registry });
      const metadata = new ArtifactViewCacheMetadata({ revision, fingerprint });
      if (typeof markdown !== "string" || markdown === "") throw new Error("artifact view cache Markdown must be non-empty");
      if (markdown.startsWith(CACHE_COMMENT_PREFIX)) {
        throw new Error("artifact view cache Markdown must not include cache metadata");
      }
      this.#ensureDirectory();
      new AtomicFile(this.#filePath(key), {
        phaseNamespace: "artifact-view-cache",
        ...(this.faultInjector ? { faultInjector: this.faultInjector } : {}),
      }).write(`${metadata.toComment()}${markdown}`);
      return new ArtifactViewCacheWrite({ saved: true });
    } catch (error) {
      return new ArtifactViewCacheWrite({
        saved: false,
        warning: new ArtifactViewCacheWarning({
          message: warningMessage === null
            ? "The artifact view was generated but its cache could not be saved."
            : text(warningMessage, "artifact view cache warning message"),
          cause: error,
        }),
      });
    }
  }

  #filePath(key) {
    return path.join(this.directory, key.fileName);
  }

  #ensureDirectory() {
    this.target.location.assertAuthority(null, { mustExist: true });
    const runtime = this.target.location.resolve(".runtime");
    fs.mkdirSync(runtime, { recursive: true, mode: 0o755 });
    this.target.location.assertAuthority(".runtime", { mustExist: true });
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o755 });
    this.target.location.assertAuthority(path.posix.join(".runtime", "views"), { mustExist: true });
  }
}

export const ARTIFACT_VIEW_CACHE_REVISION = CACHE_FORMAT_REVISION;
