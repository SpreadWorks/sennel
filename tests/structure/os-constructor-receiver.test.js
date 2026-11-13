import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-constructor-receiver.cjs";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), {
    files: [entry], entrypoints: [entry],
  }).check();
}
function sink(report, line) {
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === line && item.classification === "violation"), report.diagnostics.join("\n"));
}
function safe(report) {
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
}

test("a constructor field alias retains its actual filesystem input", () => {
  const report = check(`const fs = require('node:fs');
class Reader {
  constructor(file) { this.file = file; this.alias = this.file; }
  read() { fs.readFileSync(this.alias); }
}
new Reader('/proc/self/stat').read();`);
  sink(report, 4);
});
test("constructor field alias chains retain their actual filesystem input", () => {
  const report = check(`const fs = require('node:fs');
class Reader {
  constructor(file) { this.file = file; this.alias = this.file; this.selected = this.alias; }
  read() { fs.readFileSync(this.selected); }
}
new Reader('/proc/self/stat').read();`);
  sink(report, 4);
});
test("constructor field projections retain distinct constructed inputs", () => {
  const report = check(`const fs = require('node:fs');
class Reader {
  constructor(file) { this.file = file; this.alias = this.file; }
  read() { fs.readFileSync(this.alias); }
}
function inspect(reader) { reader.read(); }
inspect(new Reader('snapshot.json'));
inspect(new Reader('/proc/self/stat'));`);
  sink(report, 4);
});
test("a constructor field alias accepts a portable filesystem input", () => {
  safe(check(`const fs = require('node:fs');
class Reader {
  constructor(file) { this.file = file; this.alias = this.file; }
  read() { fs.readFileSync(this.alias); }
}
new Reader('snapshot.json').read();`));
});
test("constructor-created arrows retain their constructed receiver", () => {
  const report = check(`const fs = require('node:fs');
class Reader {
  constructor(file) { this.file = file; this.read = () => fs.readFileSync(this.file); }
}
new Reader('/proc/self/stat').read();`);
  sink(report, 3);
});
test("instance field arrows retain their constructed receiver", () => {
  const report = check(`const fs = require('node:fs');
class Reader {
  constructor(file) { this.file = file; }
  read = () => fs.readFileSync(this.file);
}
new Reader('/proc/self/stat').read();`);
  sink(report, 4);
});
test("constructor projections replace a factory method's captured receiver", () => {
  const report = check(`const fs = require('node:fs');
class Factory {
  constructor(file) { this.file = file; }
  create(file) {
    class Reader {
      constructor(file) { this.file = file; this.alias = this.file; }
      read() { fs.readFileSync(this.alias); }
    }
    return new Reader(file);
  }
}
new Factory('snapshot.json').create('/proc/self/stat').read();`);
  sink(report, 7);
});
test("instance field arrows replace a factory method's captured receiver", () => {
  const report = check(`const fs = require('node:fs');
class Factory {
  constructor(file) { this.file = file; }
  create(file) {
    class Reader {
      constructor(file) { this.file = file; }
      read = () => fs.readFileSync(this.file);
    }
    return new Reader(file);
  }
}
new Factory('snapshot.json').create('/proc/self/stat').read();`);
  sink(report, 7);
});
test("constructor projection inspects a method called through its receiver", () => {
  const report = check(`const fs = require('node:fs');
class Reader {
  constructor(file) { this.file = file; this.alias = this.select(); }
  select() { fs.readFileSync(this.file); return this.file; }
  read() { return this.alias; }
}
new Reader('/proc/self/stat').read();`);
  sink(report, 4);
});
test("ordinary functions created by constructors do not capture this", () => {
  safe(check(`const fs = require('node:fs');
class Reader {
  constructor(file) { this.file = file; this.read = function () { fs.readFileSync(this.file); }; }
}
const reader = new Reader('/proc/self/stat');
const read = reader.read;
read();`));
});
