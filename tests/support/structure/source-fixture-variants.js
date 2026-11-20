/** Static text edits describe fixture inputs; inspected JavaScript is never executed. */
class SourceFixtureEdit {
  constructor(start, end, text) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || typeof text !== "string") {
      throw new TypeError("ordered fixture text edit required");
    }
    Object.assign(this, { start, end, text });
    Object.freeze(this);
  }
}
class SourceFixtureText {
  constructor(seed, edits) {
    if (typeof seed !== "string" || !Array.isArray(edits)) throw new TypeError("source fixture seed and edits required");
    this.seed = seed;
    this.edits = Object.freeze(edits.map(edit => new SourceFixtureEdit(...edit)));
    let end = 0;
    for (const edit of this.edits) {
      if (edit.start < end || edit.end > seed.length) throw new TypeError("fixture edits must stay ordered within their seed");
      end = edit.end;
    }
    Object.freeze(this);
  }
  render() {
    let result = "", end = 0;
    for (const edit of this.edits) {
      result += this.seed.slice(end, edit.start) + edit.text;
      end = edit.end;
    }
    return result + this.seed.slice(end);
  }
}
class SourceFixtureDiagnostic {
  constructor({ file, rule, line, column, classification, message = null }) {
    if (typeof file !== "string" || !file || typeof rule !== "string" || !rule || !Number.isInteger(line) || line < 1
      || !Number.isInteger(column) || column < 1 || !["incomplete", "violation"].includes(classification)
      || message !== null && typeof message !== "string") throw new TypeError("fixture diagnostic rule and position required");
    Object.assign(this, { file, rule, line, column, classification, message });
    Object.freeze(this);
  }
  matches(diagnostic) {
    return diagnostic.file === this.file && diagnostic.rule === this.rule && diagnostic.line === this.line
      && diagnostic.column === this.column && diagnostic.classification === this.classification
      && (this.message === null || diagnostic.message === this.message);
  }
}
export class SourceFixtureCase {
  constructor(group, input) {
    if (typeof group.name !== "string" || typeof group.sourceFile !== "string" || typeof input.name !== "string"
      || typeof input.positive !== "boolean" || typeof input.complete !== "boolean" || input.positive !== (input.expected === null)) {
      throw new TypeError("named source fixture case with a matching expectation required");
    }
    this.name = `${group.name}/${input.name}`;
    this.file = group.sourceFile;
    this.positive = input.positive;
    this.complete = input.complete;
    this.input = new SourceFixtureText(group.seed, input.edits);
    this.expected = input.expected === null ? null : new SourceFixtureDiagnostic(input.expected);
    this.normal = input.normalEdits === undefined ? null : new SourceFixtureText(group.seed, input.normalEdits);
    this.normalKind = input.normalKind ?? null;
    this.unsupported = input.unsupportedEdits === undefined ? null : new SourceFixtureText(group.seed, input.unsupportedEdits);
    this.unsupportedExpected = input.unsupportedExpected === undefined ? null : new SourceFixtureDiagnostic(input.unsupportedExpected);
    if (this.expected !== null && this.expected.file !== this.file
      || this.unsupportedExpected !== null && this.unsupportedExpected.file !== this.file
      || (this.unsupported === null) !== (this.unsupportedExpected === null)
      || this.normal !== null && typeof this.normalKind !== "string") throw new TypeError("source control requires its own expectation");
    Object.freeze(this);
  }
  static read(groups) {
    return groups.flatMap(group => group.cases.map(input => new SourceFixtureCase(group, input)));
  }
}
