import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * Store-backed changelog projection for one canonical Flow Version.
 *
 * Changelog generation is a consumer: it never infers a root-level Flow
 * document or treats a rendered Markdown view as durable authority.
 */

import fs from "node:fs";
import path from "node:path";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function sanitizedText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function firstScopeLine(spec) {
  const value = spec?.scope?.in;
  return Array.isArray(value) && typeof value[0] === "string"
    ? sanitizedText(value[0], "n/a")
    : "n/a";
}

/** A read-only, authoritative metadata projection for one V1 Flow. */
export class CanonicalChangelogSpec {
  constructor({ specId, state, document, location, createdAt }) {
    this.specId = requiredText(specId, "canonical changelog specId");
    if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION) {
      throw new Error("canonical changelog requires a Version-1 Flow state");
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("canonical changelog spec.record must be an object");
    }
    if (!location || typeof location.specFile !== "string") {
      throw new Error("canonical changelog requires a resolved Version location");
    }
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.valueOf())) {
      throw new Error("canonical changelog createdAt must be a Date");
    }
    this.state = Object.freeze({
      lifecycle: state.lifecycle,
      execution: Object.freeze({ ...state.execution }),
      issue: state.issue ?? null,
    });
    this.document = Object.freeze(structuredClone(document));
    this.location = location;
    this.createdAt = new Date(createdAt.valueOf());
    Object.freeze(this);
  }

  static read({ flowManager, specId }) {
    if (!flowManager || typeof flowManager.loadReadOnly !== "function" || typeof flowManager.readArtifact !== "function") {
      throw new Error("canonical changelog requires FlowManager Store readers");
    }
    const id = requiredText(specId, "canonical changelog specId");
    const state = flowManager.loadReadOnly(id);
    if (state === null) return null;
    const location = flowManager.specLocation(id);
    const artifact = flowManager.readArtifact({
      specId: id,
      logicalKey: "spec.record",
      consumerNodeId: "system",
    });
    let document;
    try {
      document = JSON.parse(artifact.bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`canonical changelog spec.record is invalid: ${error.message}`);
    }
    return new CanonicalChangelogSpec({
      specId: id,
      state,
      document,
      location,
      createdAt: fs.statSync(location.specFile).mtime,
    });
  }

  toEntry() {
    const title = this.document.goal
      ? sanitizedText(String(this.document.goal).split("\n")[0], this.specId)
      : this.specId;
    return Object.freeze({
      title,
      created: this.createdAt.toISOString().slice(0, 10),
      status: this.state.lifecycle === "finalized" ? "completed" : "active",
      branch: sanitizedText(this.state.execution.featureBranch, "n/a"),
      inputLine: firstScopeLine(this.document),
      versionDirectory: path.posix.relative(this.location.specRoot, this.location.relativeDirectory),
      // Derived Markdown is intentionally absent from a canonical Flow. The
      // only durable links are cataloged root records.
      links: Object.freeze([
        "spec.json",
        ...(this.state.issue === null ? [] : ["issue.md"]),
      ]),
    });
  }
}
