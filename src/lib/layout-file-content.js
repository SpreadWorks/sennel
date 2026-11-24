import crypto from "node:crypto";
import fs from "node:fs";
import { LayoutTemplateEncodingError, LayoutTemplateTransformation } from "./layout-template-transformation.js";
import { MAX_IN_MEMORY_FILE_BYTES, RegularFileReadReceipt, visitRegularFileChunks } from "./regular-file-snapshot.js";
import { AtomicFile } from "./atomic-file.js";
import { combineProcessExecutionFailures } from "./process-execution-completion.js";

const TRANSFORMATION = new LayoutTemplateTransformation();
const READ_OPTIONS = Object.freeze({ label: "layout migration source file", maxBytes: MAX_IN_MEMORY_FILE_BYTES });
const capturedContent = Symbol("completed layout content observation");

/** Bounded streaming evidence; the source bytes stay in the original tree. */
export class LayoutFileContent {
  constructor(token, { original, transformedDigest, transformedByteLength, transform, maxBytes }) {
    if (token !== capturedContent || !(original instanceof RegularFileReadReceipt)) {
      throw new TypeError("layout content requires a complete physical file receipt");
    }
    this.original = original;
    this.transformedDigest = transformedDigest;
    this.transformedByteLength = transformedByteLength;
    this.transform = transform;
    this.maxBytes = maxBytes;
    Object.freeze(this);
  }

  static capture(filePath, { transform = false, directoryAuthority = null, expectedIdentity = null,
    maxBytes = MAX_IN_MEMORY_FILE_BYTES } = {}) {
    const hash = crypto.createHash("sha256");
    let transformedByteLength = 0;
    let validText = transform;
    const stream = transform ? TRANSFORMATION.createStream(bytes => {
      hash.update(bytes);
      transformedByteLength += bytes.length;
    }) : null;
    const accept = operation => {
      try { operation(); }
      catch (error) {
        if (!(error instanceof LayoutTemplateEncodingError)) throw error;
        validText = false;
      }
    };
    const original = visitRegularFileChunks(filePath, { ...READ_OPTIONS, maxBytes, directoryAuthority, expectedIdentity,
      visit(bytes) { if (validText) accept(() => stream.write(bytes)); },
    });
    if (validText) accept(() => stream.finish());
    return new this(capturedContent, { original, transform: validText, maxBytes,
      transformedDigest: validText ? hash.digest("hex") : original.digest,
      transformedByteLength: validText ? transformedByteLength : original.byteLength });
  }

  /** Source proof and closed output readback precede AtomicFile publication. */
  copyTo(destinationPath, options = {}) {
    return this.#copyTo(destinationPath, options, this.transform, this.transformedDigest,
      this.transformedByteLength, this.original.permissionHint);
  }

  /** Owned raw evidence uses the stage's default permissions, not user modes. */
  writeBeforeImage(destinationPath, options = {}) {
    return this.#copyTo(destinationPath, options, false, this.original.digest, this.original.byteLength, null);
  }

  #copyTo(destinationPath, { directoryAuthority = null, faultInjector = () => {} }, transform, digest, byteLength, permissionHint) {
    const original = this.original;
    const destination = new AtomicFile(destinationPath, { directoryAuthority, faultInjector,
      phaseNamespace: "layout-copy", permissionHint });
    const stage = destination.createOutputStage(descriptor => {
      const emit = bytes => fs.writeFileSync(descriptor, bytes);
      const stream = transform ? TRANSFORMATION.createStream(emit) : null;
      const current = visitRegularFileChunks(original.filePath, { ...READ_OPTIONS, maxBytes: this.maxBytes, expectedIdentity: original.identity,
        faultInjector, phaseNamespace: "layout-copy-source", visit(bytes) {
          if (stream === null) emit(bytes);
          else stream.write(bytes);
        },
      });
      if (stream !== null) stream.finish();
      if (!original.hasSameFileVersion(current)) {
        throw new Error("layout migration source changed before staged copy completed");
      }
    }, { exclusive: true });
    try {
      // Read an already owned, closed stage. The path alone never adopts it;
      // publication still uses AtomicFile's retained stage capability.
      const output = visitRegularFileChunks(stage.path, { label: "layout migration output stage", maxBytes: destination.maxBytes,
        expectedIdentity: stage.identity, directoryAuthority: destination.directoryAuthority, requireSingleLink: true, visit() {} });
      if (output.digest !== digest || output.byteLength !== byteLength) {
        throw new Error("layout migration output differs from its source-derived transformation");
      }
      return destination.publishStage(stage, { exclusive: true });
    } catch (error) {
      if (error.committedToVisibleName || error.cleanupFailed || !stage.active) throw error;
      try { destination.disposeStage(stage); }
      catch (cleanupError) { throw combineProcessExecutionFailures(error, cleanupError); }
      throw error;
    }
  }
}
