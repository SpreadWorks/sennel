/**
 * Facade for one explicitly requested, catalog-verified human artifact view.
 *
 * The service deliberately has no Flow state mutation API. It resolves one
 * exact Version target, reads the closed registry contract, renders from
 * verified sources, and optionally persists a non-authoritative cache entry.
 */

import { FLOW_ARTIFACT_VIEW_REGISTRY } from "./artifact-view-registry.js";
import {
  ArtifactViewReader,
  ArtifactViewTarget,
  resolveArtifactViewTarget,
} from "./artifact-view-reader.js";
import { ArtifactFullView, ArtifactFullViewRenderer } from "./artifact-view-renderer.js";
import { ArtifactFullViewFingerprint, ArtifactViewCache, ArtifactViewCacheWarning } from "./artifact-view-cache.js";

function object(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

/** A source/read or deterministic-render failure safe for the Flow envelope boundary. */
export class ArtifactViewServiceError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message, cause === null ? undefined : { cause });
    if (!["ARTIFACT_VIEW_READ_FAILED", "ARTIFACT_VIEW_RENDER_FAILED"].includes(code)) {
      throw new Error("artifact view service error code is invalid");
    }
    this.name = "ArtifactViewServiceError";
    this.code = code;
  }
}

/** Immutable return value for ArtifactViewService.full(). */
export class ArtifactViewFullResult {
  constructor({ markdown, fullView, fullFingerprint, cache, cacheStore } = {}) {
    if (typeof markdown !== "string" || markdown === "") throw new Error("artifact full result Markdown must be non-empty");
    if (!(fullView instanceof ArtifactFullView)) throw new Error("artifact full result requires an ArtifactFullView");
    if (!(fullFingerprint instanceof ArtifactFullViewFingerprint)) {
      throw new Error("artifact full result requires an ArtifactFullViewFingerprint");
    }
    if (cache === null || typeof cache !== "object" || Array.isArray(cache) || (cache.hit !== true && cache.hit !== false)) {
      throw new Error("artifact full result cache must declare a hit boolean");
    }
    // On a matching cache hit, markdown is the exact stored human body after
    // metadata stripping.  `fullView` remains the freshly catalog-verified
    // deterministic source used by semantic summaries and fingerprinting.
    if (!cache.hit && markdown !== fullView.markdown) {
      throw new Error("uncached artifact full result Markdown must match its deterministic full view");
    }
    if (cache.warning !== null && !(cache.warning instanceof ArtifactViewCacheWarning)) {
      throw new Error("artifact full result cache warning must be an ArtifactViewCacheWarning or null");
    }
    if (!(cacheStore instanceof ArtifactViewCache)) throw new Error("artifact full result requires an ArtifactViewCache");
    this.markdown = markdown;
    this.fullView = fullView;
    this.fullFingerprint = fullFingerprint;
    this.sourceArtifacts = fullView.sourceArtifacts;
    this.cache = Object.freeze({ hit: cache.hit, warning: cache.warning });
    this.cacheStore = cacheStore;
    this.cacheWarning = cache.warning;
    Object.freeze(this);
  }
}

/**
 * Version-scoped artifact view coordinator. All methods are synchronous: the
 * reader and renderer use local canonical data only, and AtomicFile writes are
 * synchronous so the caller has a complete result or a non-fatal warning.
 */
export class ArtifactViewService {
  constructor({
    config = {},
    flowManager,
    i18n = null,
    root = null,
    registry = FLOW_ARTIFACT_VIEW_REGISTRY,
    cacheFaultInjector = null,
    renderer = null,
  } = {}) {
    object(config, "artifact view config");
    if (!flowManager || typeof flowManager.specLocation !== "function" || typeof flowManager.canonicalVersionLocation !== "function") {
      throw new Error("artifact view service requires FlowManager Version location APIs");
    }
    if (root !== null && (typeof root !== "string" || root.trim() === "")) throw new Error("artifact view root must be a non-empty string or null");
    if (!registry || typeof registry.require !== "function") throw new Error("artifact view service requires an ArtifactViewRegistry");
    if (cacheFaultInjector !== null && typeof cacheFaultInjector !== "function") {
      throw new Error("artifact view cacheFaultInjector must be a function or null");
    }
    this.config = Object.freeze({ ...config });
    this.flowManager = flowManager;
    this.registry = registry;
    this.cacheFaultInjector = cacheFaultInjector;
    if (renderer !== null && !(renderer instanceof ArtifactFullViewRenderer)) {
      throw new Error("artifact view renderer must be an ArtifactFullViewRenderer or null");
    }
    this.renderer = renderer ?? new ArtifactFullViewRenderer({ config: this.config, root, i18n });
    Object.freeze(this);
  }

  /** Resolve only an exact completed Version or an explicitly supplied active state. */
  resolveFullTarget(selector = {}) {
    if (selector instanceof ArtifactViewTarget) return selector;
    const value = object(selector, "artifact view target selector");
    if (value.target !== undefined) {
      if (!(value.target instanceof ArtifactViewTarget)) throw new Error("artifact view target must be an ArtifactViewTarget");
      if (Object.keys(value).some((key) => key !== "target")) {
        throw new Error("artifact view target cannot be combined with another selector");
      }
      return value.target;
    }
    return resolveArtifactViewTarget({
      flowManager: this.flowManager,
      specId: value.specId ?? null,
      version: value.version ?? null,
      activeState: value.activeState ?? null,
      location: value.location ?? null,
    });
  }

  /** Obtain the cache adapter for exactly the selected Version. */
  cacheFor(selector = {}) {
    const target = this.resolveFullTarget(selector);
    return new ArtifactViewCache({
      target,
      registry: this.registry,
      ...(this.cacheFaultInjector ? { faultInjector: this.cacheFaultInjector } : {}),
    });
  }

  /** Render one registered artifact and best-effort save its deterministic full view. */
  full(input = {}) {
    const request = object(input, "artifact view full request");
    const entry = this.registry.require(request.logicalKey);
    let target;
    try {
      target = this.resolveFullTarget({
        ...(request.specId === undefined ? {} : { specId: request.specId }),
        ...(request.version === undefined ? {} : { version: request.version }),
        ...(request.activeState === undefined ? {} : { activeState: request.activeState }),
        ...(request.location === undefined ? {} : { location: request.location }),
        ...(request.target === undefined ? {} : { target: request.target }),
      });
    } catch (cause) {
      throw new ArtifactViewServiceError(
        "ARTIFACT_VIEW_READ_FAILED",
        `artifact view target resolution failed: ${cause.message || cause}`,
        { cause },
      );
    }
    let document;
    try {
      document = new ArtifactViewReader({ target, registry: this.registry }).read(entry.logicalKey);
    } catch (cause) {
      throw new ArtifactViewServiceError(
        "ARTIFACT_VIEW_READ_FAILED",
        `artifact view source read failed: ${cause.message || cause}`,
        { cause },
      );
    }
    let fullView;
    try {
      fullView = this.renderer.render(document);
    } catch (cause) {
      throw new ArtifactViewServiceError(
        "ARTIFACT_VIEW_RENDER_FAILED",
        `artifact view render failed: ${cause.message || cause}`,
        { cause },
      );
    }
    const fullFingerprint = new ArtifactFullViewFingerprint({ fullView });
    const cacheStore = this.cacheFor(target);
    const cached = cacheStore.read({
      logicalKey: entry.logicalKey,
      mode: "full",
      revision: fullFingerprint.revision,
      fingerprint: fullFingerprint.toString(),
    });
    if (cached.hit) {
      return new ArtifactViewFullResult({
        markdown: cached.markdown,
        fullView,
        fullFingerprint,
        cache: { hit: true, warning: null },
        cacheStore,
      });
    }
    const saved = cacheStore.write({
      logicalKey: entry.logicalKey,
      mode: "full",
      revision: fullFingerprint.revision,
      fingerprint: fullFingerprint.toString(),
      markdown: fullView.markdown,
      warningMessage: this.renderer.localizer.message("cacheNotSaved"),
    });
    return new ArtifactViewFullResult({
      markdown: fullView.markdown,
      fullView,
      fullFingerprint,
      cache: { hit: false, warning: saved.warning },
      cacheStore,
    });
  }
}
