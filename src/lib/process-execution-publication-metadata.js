import crypto from "node:crypto";
import path from "node:path";
import { AtomicFile } from "./atomic-file.js";
import { FileIdentity } from "./file-identity.js";
import { sameFileIdentity } from "./real-directory-authority.js";
import {
  ProcessExecutionControlFailure, ProcessExecutionValueEncoding,
  executionUuid as uuid, executionValueSnapshot as json, executionValueExact as exact,
} from "./process-execution-values.js";

const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const PAGE_CONTENT_BYTES = 256 * 1024;
const metadataAuthority = Symbol("runtime publication metadata");
const selections = new WeakMap();
const retirements = new WeakMap();

function fail(reason, message, details) { throw new ProcessExecutionControlFailure(reason, message, details); }
function fields(value, names) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) {
    throw new TypeError("Runtime publication metadata has missing or unknown fields");
  }
}
function guardFunction(guard) {
  if (typeof guard !== "function") throw new TypeError("Runtime publication metadata requires its owning semantic guard");
}
function transitionFile(file) {
  if (!(file instanceof AtomicFile) || file.maxBytes !== MAX_REGISTRY_BYTES) {
    throw new TypeError("Runtime publication metadata requires its bounded transition AtomicFile");
  }
  file.directoryAuthority.assertStable();
  return file;
}
function assertCanonicalMetadataBytes(value, snapshot) {
  const bytes = snapshot.bytes;
  if (!Buffer.from(snapshot.text()).equals(bytes) || !Buffer.from(JSON.stringify(value)).equals(bytes)) {
    fail("record-corrupt", "Runtime publication metadata differs from its exact canonical physical bytes");
  }
}

/** Exact metadata proof for an existing file or a closed owned stage. */
export class RuntimeFileGeneration {
  constructor(value) {
    this.identity = FileIdentity.fromStored(value.identity);
    if (!/^[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
      throw new TypeError("Runtime publication file generation is invalid");
    }
    this.digest = value.digest;
    this.bytes = value.bytes;
    exact(value, this);
    Object.freeze(this);
  }
  static capture(snapshot) { return snapshot === null ? null : new this({ identity: snapshot.identity.toJSON(), digest: snapshot.digest, bytes: snapshot.byteLength }); }
  matches(snapshot) { return snapshot !== null && sameFileIdentity(this.identity, snapshot.identity) && this.digest === snapshot.digest && this.bytes === snapshot.byteLength; }
  toJSON() { return { identity: this.identity, digest: this.digest, bytes: this.bytes }; }
}
export class RuntimePublicationStage {
  constructor(value) {
    if (typeof value.name !== "string" || !/^\.runtime-result-[0-9a-f-]{36}\.tmp$/.test(value.name)) throw new TypeError("Runtime publication stage name is invalid");
    uuid(value.name.slice(16, -4), "runtime publication stage ID");
    this.name = value.name;
    this.generation = new RuntimeFileGeneration(value.generation);
    exact(value, this);
    Object.freeze(this);
  }
  toJSON() { return { name: this.name, generation: this.generation }; }
}

/** One already encoded dependency; staging never decides operation semantics. */
export class RuntimePublicationWrite {
  #bytes;
  constructor(relativePath, bytes) {
    this.relativePath = relativePath;
    this.#bytes = Buffer.from(bytes);
    if (this.#bytes.length > MAX_REGISTRY_BYTES) fail("record-capacity", "Runtime publication dependency exceeds its existing durable size limit");
    Object.freeze(this);
  }
  get bytes() { return Buffer.from(this.#bytes); }
  assertBytes(bytes) {
    if (!this.#bytes.equals(bytes)) fail("authority-mismatch", "Prepared runtime stage differs from its exact original encoded data");
  }
}

/** Shared exact-generation removal; a path never recreates stage ownership. */
export function removeRuntimePublicationFile(file, generation, { guard = () => {} } = {}) {
  guardFunction(guard);
  guard();
  const actual = file.readSnapshot();
  if (actual === null) return;
  const original = file.commitGuard;
  const assertCurrent = () => {
    guard();
    if (!generation.matches(file.readSnapshot())) fail("authority-mismatch", "Prepared runtime cleanup refused a foreign generation");
  };
  file.commitGuard = (event) => { original(event); assertCurrent(); };
  try { assertCurrent(); file.remove(); }
  finally { file.commitGuard = original; }
}

class RuntimePublicationMetadataPointer {
  constructor(value) {
    fields(value, ["metadataVersion", "kind", "selectionId", "digest", "bytes", "head"]);
    if (value.metadataVersion !== 1 || value.kind !== "runtime-publication-metadata") throw new TypeError("Runtime publication metadata selection is unsupported");
    this.metadataVersion = value.metadataVersion;
    this.kind = value.kind;
    this.selectionId = uuid(value.selectionId, "runtime metadata selection ID");
    if (!/^[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.bytes) || value.bytes <= MAX_REGISTRY_BYTES) {
      throw new TypeError("Runtime publication metadata commitment is invalid");
    }
    this.digest = value.digest;
    this.bytes = value.bytes;
    this.head = new RuntimePublicationStage(value.head);
    exact(value, this);
    Object.freeze(this);
  }
  toJSON() { return { metadataVersion: this.metadataVersion, kind: this.kind, selectionId: this.selectionId,
    digest: this.digest, bytes: this.bytes, head: this.head }; }
}

class RuntimePublicationMetadataPage {
  #content;
  constructor(value) {
    fields(value, ["metadataVersion", "kind", "selectionId", "index", "next", "content"]);
    if (value.metadataVersion !== 1 || value.kind !== "runtime-publication-metadata-page"
      || !Number.isSafeInteger(value.index) || value.index < 0 || typeof value.content !== "string") {
      throw new TypeError("Runtime publication metadata page is invalid");
    }
    this.metadataVersion = value.metadataVersion;
    this.kind = value.kind;
    this.selectionId = uuid(value.selectionId, "runtime metadata page selection ID");
    this.index = value.index;
    this.next = value.next === null ? null : new RuntimePublicationStage(value.next);
    this.#content = Buffer.from(value.content, "base64");
    if (this.#content.length === 0 || this.#content.length > PAGE_CONTENT_BYTES
      || this.#content.toString("base64") !== value.content) throw new TypeError("Runtime publication metadata page content is not its exact bounded bytes");
    exact(value, this);
    Object.freeze(this);
  }
  get content() { return Buffer.from(this.#content); }
  toJSON() { return { metadataVersion: this.metadataVersion, kind: this.kind, selectionId: this.selectionId,
    index: this.index, next: this.next, content: this.#content.toString("base64") }; }
}

class RuntimePublicationMetadataPageObservation {
  constructor(file, reference, snapshot) {
    this.file = file;
    this.reference = reference;
    if (!reference.generation.matches(snapshot)) fail("authority-mismatch", "Selected runtime metadata page changed its exact generation");
    Object.freeze(this);
  }
  assertCurrent() {
    if (!this.reference.generation.matches(this.file.readSnapshot())) fail("authority-mismatch", "Selected runtime metadata page changed its exact generation");
  }
}

function pageFile(file, name) {
  return new AtomicFile(path.join(file.directory, name), { directoryAuthority: file.directoryAuthority,
    maxBytes: MAX_REGISTRY_BYTES, faultInjector: file.faultInjector, phaseNamespace: "runtime-metadata-page",
    commitGuard: () => file.directoryAuthority.assertStable() });
}
function stateOf(selection) {
  const state = selections.get(selection);
  if (state === undefined) throw new TypeError("Runtime publication metadata requires an inspected nominal selection");
  return state;
}
function assertRootCurrent(selection, message = "Selected runtime metadata root changed its exact generation") {
  const state = stateOf(selection);
  if (!state.generation.matches(state.file.readSnapshot())) fail("authority-mismatch", message);
}
function assertSameFile(file, selection) {
  const selected = stateOf(selection);
  if (file.filePath !== selected.file.filePath
    || !sameFileIdentity(file.directoryAuthority.identity, selected.file.directoryAuthority.identity)) {
    throw new TypeError("Runtime metadata selection belongs to another transition authority");
  }
}

/** Transport proof only; the owning runtime must validate the logical value. */
export class RuntimePublicationMetadataSelection {
  constructor(authority, state) {
    if (authority !== metadataAuthority) throw new TypeError("Runtime publication metadata selections require fresh inspection");
    selections.set(this, state);
    Object.freeze(this);
  }
  static inspect(file) {
    transitionFile(file);
    const snapshot = file.readSnapshot();
    if (snapshot === null) return null;
    const root = JSON.parse(snapshot.text()), pages = [];
    let logicalText = snapshot.text();
    if (Object.hasOwn(root, "metadataVersion")) {
      const pointer = new RuntimePublicationMetadataPointer(root), seen = new Set(), chunks = [];
      assertCanonicalMetadataBytes(pointer, snapshot);
      const hash = crypto.createHash("sha256");
      let length = 0, index = 0;
      for (let reference = pointer.head; reference !== null;) {
        if (seen.has(reference.name)) fail("record-corrupt", "Runtime metadata page chain contains a duplicate or cycle");
        seen.add(reference.name);
        const input = pageFile(file, reference.name), captured = input.readSnapshot();
        const observation = new RuntimePublicationMetadataPageObservation(input, reference, captured);
        const page = new RuntimePublicationMetadataPage(JSON.parse(captured.text()));
        assertCanonicalMetadataBytes(page, captured);
        if (page.selectionId !== pointer.selectionId || page.index !== index++) fail("record-corrupt", "Runtime metadata page differs from its exact selection and order");
        const bytes = page.content;
        length += bytes.length;
        if (length > pointer.bytes) fail("record-corrupt", "Runtime metadata exceeds its selected logical length");
        chunks.push(bytes); hash.update(bytes); pages.push(observation);
        reference = page.next;
      }
      if (length !== pointer.bytes || hash.digest("hex") !== pointer.digest) fail("record-corrupt", "Runtime metadata differs from its full original JSON commitment");
      const bytes = Buffer.concat(chunks, length);
      logicalText = bytes.toString("utf8");
      if (!Buffer.from(logicalText).equals(bytes)) fail("record-corrupt", "Runtime metadata is not exact UTF-8 JSON");
      JSON.parse(logicalText);
    }
    const selection = new this(metadataAuthority, { file, snapshot, generation: RuntimeFileGeneration.capture(snapshot),
      logicalText, pages: Object.freeze(pages) });
    selection.assertCurrent();
    return selection;
  }
  get snapshot() { return stateOf(this).snapshot; }
  get value() { return JSON.parse(stateOf(this).logicalText); }
  get pageCount() { return stateOf(this).pages.length; }
  assertCurrent() {
    const state = stateOf(this);
    assertRootCurrent(this);
    for (const page of state.pages) page.assertCurrent();
    assertRootCurrent(this, "Selected runtime metadata root changed during page capture");
  }
  clear({ clearGuard }) {
    guardFunction(clearGuard);
    const state = stateOf(this), original = state.file.commitGuard;
    const assertCurrent = () => { clearGuard(); this.assertCurrent(); };
    state.file.commitGuard = (event) => { original(event); assertCurrent(); };
    let publication;
    try { assertCurrent(); publication = state.file.remove(); }
    finally { state.file.commitGuard = original; }
    if (!publication.committed || state.file.readSnapshot() !== null) fail("authority-mismatch", "Runtime metadata root removal was not confirmed absent");
    return new RuntimePublicationMetadataRetirement(metadataAuthority, { file: state.file, pages: state.pages,
      successor: null });
  }
}

/** Only confirmed root replacement/removal can mint this cleanup authority. */
export class RuntimePublicationMetadataRetirement {
  constructor(authority, state) {
    if (authority !== metadataAuthority) throw new TypeError("Runtime metadata retirement requires a confirmed root transition");
    retirements.set(this, state);
    Object.freeze(this);
  }
  retire({ retirementGuard }) {
    guardFunction(retirementGuard);
    const state = retirements.get(this);
    const assertRetired = () => {
      retirementGuard();
      if (state.successor === null) {
        if (state.file.readSnapshot() !== null) fail("authority-mismatch", "Runtime metadata root reappeared before page retirement");
      } else assertRootCurrent(state.successor);
    };
    assertRetired();
    if (state.successor !== null) state.successor.assertCurrent();
    // The unchanged exact root keeps the old chain unselected. Each unlink
    // still checks that root, owning semantic guard and old page generation.
    // Full successor pages are fresh at both batch boundaries; the caller
    // must recapture its selected chain before any later canonical effect.
    for (const page of state.pages) removeRuntimePublicationFile(page.file, page.reference.generation, { guard: assertRetired });
    assertRetired();
    if (state.successor !== null) state.successor.assertCurrent();
  }
}

/** One fresh whole selection; failures retain data until exact old-root proof. */
export class RuntimePublicationMetadataUpdate {
  #file;
  #encoding;
  #previous;
  #pages = [];
  #rootWrite = null;
  #rootStage = null;
  #rootGeneration = null;
  #attempted = false;
  #selected = false;
  constructor(file, encoding, previous = null) {
    this.#file = transitionFile(file);
    if (!(encoding instanceof ProcessExecutionValueEncoding)) throw new TypeError("Runtime metadata requires its owned logical JSON encoding");
    if (previous !== null) assertSameFile(file, previous);
    this.#encoding = encoding;
    this.#previous = previous;
  }
  get rootPublicationConfirmed() { return this.#selected; }
  get stagedPageCount() { return this.#pages.length; }
  #assertPreviousRoot() {
    if (this.#previous === null) {
      if (this.#file.readSnapshot() !== null) fail("authority-mismatch", "Runtime metadata root appeared before selection");
    } else assertRootCurrent(this.#previous);
  }
  #assertPrevious() {
    if (this.#previous === null) this.#assertPreviousRoot();
    else this.#previous.assertCurrent();
  }
  #assertOwnedPages() {
    for (const page of this.#pages) {
      const snapshot = this.#file.inspectStage(page.handle);
      page.write.assertBytes(snapshot.bytes);
      if (!page.reference.generation.matches(snapshot)) fail("authority-mismatch", "Runtime metadata page lost its original closed stage generation");
    }
  }
  #stage() {
    const bytes = Buffer.from(this.#encoding.text());
    if (bytes.length <= MAX_REGISTRY_BYTES) {
      this.#rootWrite = new RuntimePublicationWrite(path.basename(this.#file.filePath), bytes);
      return;
    }
    const selectionId = crypto.randomUUID();
    let next = null;
    for (let index = Math.ceil(bytes.length / PAGE_CONTENT_BYTES) - 1; index >= 0; index--) {
      // No canonical effect can publish during staging. AtomicFile freshly
      // proves each new page's parent/original stage. The complete old
      // selection is recaptured before staging and before/at root selection.
      const page = new RuntimePublicationMetadataPage({ metadataVersion: 1, kind: "runtime-publication-metadata-page",
        selectionId, index, next: json(next), content: bytes.subarray(index * PAGE_CONTENT_BYTES,
          Math.min(bytes.length, (index + 1) * PAGE_CONTENT_BYTES)).toString("base64") });
      const name = `.runtime-result-${crypto.randomUUID()}.tmp`;
      const write = new RuntimePublicationWrite(name, Buffer.from(JSON.stringify(page)));
      const handle = this.#file.createStage(write.bytes, { stageName: name });
      const owned = { handle, write, reference: null };
      this.#pages.push(owned);
      const snapshot = this.#file.inspectStage(handle);
      write.assertBytes(snapshot.bytes);
      owned.reference = new RuntimePublicationStage({ name, generation: json(RuntimeFileGeneration.capture(snapshot)) });
      next = owned.reference;
    }
    const root = new RuntimePublicationMetadataPointer({ metadataVersion: 1, kind: "runtime-publication-metadata",
      selectionId, digest: this.#encoding.digest, bytes: bytes.length, head: json(next) });
    this.#rootWrite = new RuntimePublicationWrite(path.basename(this.#file.filePath), Buffer.from(JSON.stringify(root)));
  }
  publish({ selectGuard }) {
    guardFunction(selectGuard);
    if (this.#attempted) throw new TypeError("Runtime publication metadata update cannot be replayed");
    this.#attempted = true;
    selectGuard(); this.#assertPrevious();
    this.#stage();
    const original = this.#file.commitGuard;
    const assertCurrent = () => { selectGuard(); this.#assertPrevious(); this.#assertOwnedPages(); };
    assertCurrent();
    this.#rootStage = this.#file.createStage(this.#rootWrite.bytes);
    const snapshot = this.#file.inspectStage(this.#rootStage);
    this.#rootWrite.assertBytes(snapshot.bytes);
    this.#rootGeneration = RuntimeFileGeneration.capture(snapshot);
    this.#file.commitGuard = (event) => { original(event); assertCurrent(); };
    let publication;
    try { publication = this.#file.publishStage(this.#rootStage, { retainOnFailure: true }); }
    finally { this.#file.commitGuard = original; }
    if (!publication.committed || !this.#rootGeneration.matches(publication.snapshot)) fail("authority-mismatch", "Runtime metadata root publication lost its original stage generation");
    this.#rootWrite.assertBytes(publication.snapshot.bytes);
    this.#selected = true;
    const selection = RuntimePublicationMetadataSelection.inspect(this.#file);
    if (selection === null || !this.#rootGeneration.matches(selection.snapshot)) fail("authority-mismatch", "Runtime metadata root changed before selection readback");
    return new RuntimePublicationMetadataPublication(metadataAuthority, selection,
      this.#previous === null ? null : new RuntimePublicationMetadataRetirement(metadataAuthority, {
        file: this.#file, pages: stateOf(this.#previous).pages, successor: selection }));
  }
  discardAfterFailure({ cleanupGuard }) {
    guardFunction(cleanupGuard);
    if (this.#selected) return;
    // Only an unchanged EXACT old root (or original absence) permits cleanup.
    // An uncertain/new/foreign root retains every newly staged page and stage.
    const current = this.#file.readSnapshot();
    const unchanged = this.#previous === null ? current === null : stateOf(this.#previous).generation.matches(current);
    if (!unchanged) return;
    const assertUnselected = () => { cleanupGuard(); this.#assertPreviousRoot(); };
    assertUnselected(); this.#assertPrevious();
    const owned = [...this.#pages];
    if (this.#rootStage !== null && this.#rootStage.active) owned.push({ handle: this.#rootStage, write: this.#rootWrite, reference: null });
    // The unchanged exact old root cannot validly select these fresh stages.
    // Keep its full chain fresh at both batch boundaries; every removal still
    // checks the old root, owning guard and original new-stage full generation.
    for (const page of owned) {
      assertUnselected();
      const snapshot = this.#file.inspectStage(page.handle);
      page.write.assertBytes(snapshot.bytes);
      const generation = page.reference?.generation ?? RuntimeFileGeneration.capture(snapshot);
      removeRuntimePublicationFile(pageFile(this.#file, path.basename(page.handle.path)), generation, { guard: assertUnselected });
      page.handle.dispose();
    }
    assertUnselected(); this.#assertPrevious();
  }
}

/** Publication reports transport selection only; semantics remain with runtime. */
export class RuntimePublicationMetadataPublication {
  constructor(authority, selection, previousRetirement) {
    if (authority !== metadataAuthority) throw new TypeError("Runtime metadata publication requires confirmed owned root publication");
    this.selection = selection;
    this.previousRetirement = previousRetirement;
    Object.freeze(this);
  }
}
