import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";
import { SourceModule } from "../support/structure/source-reader.js";

const file = "src/renamed-reader.js";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
}

test("declaration words in string data cannot become source declarations", () => {
  const source = `const present = 'function' instanceof Object;`;
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  const negative = check(`${source}\nimport fs from 'node:fs'; fs.readFileSync('/proc/self/stat');`);
  assert.ok(negative.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation"));
  assert.equal(negative.complete, true, negative.diagnostics.join("\n"));
});

test("nested class member origins retain the lexical declaration identity", () => {
  const source = (path) => `import fs from 'node:fs';
    class Reader { read() { return 'ordinary'; } }
    function load() {
      class Reader { read() { return fs.readFileSync(${JSON.stringify(path)}); } }
      const reader = new Reader(); return reader.read();
    }
    load();`;
  const portable = check(source("snapshot.json"));
  assert.equal(portable.ok, true, portable.diagnostics.join("\n"));
  const negative = check(source("/proc/self/stat"));
  assert.ok(negative.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation" && entry.line === 4), negative.diagnostics.join("\n"));
  assert.equal(negative.complete, true, negative.diagnostics.join("\n"));
});

test("a nested class without a module namesake can be inspected without a parser failure", () => {
  const report = check(`function create() { class Entry { value = null; } const entry = new Entry(); return entry.value; } create();`);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
});

test("return words and delimiter text remain data when reading helper results", () => {
  const source = `export function read() { const keyword = 'return'; return { body: '}' }; }`;
  const declaration = new SourceModule(file, source).declaration("read");
  assert.equal(declaration.returns().length, 1);
  assert.equal(declaration.returns()[0].matches("{ body: '}' }"), true);
  const portable = check(`${source} read();`);
  assert.equal(portable.ok, true, portable.diagnostics.join("\n"));
});

test("return member and property names are not return statements", () => {
  const source = `export function read(value) { value.return('ordinary'); const object = { return: 'data' }; return object; }`;
  const declaration = new SourceModule(file, source).declaration("read");
  assert.equal(declaration.returns().length, 1);
  assert.equal(declaration.returns()[0].matches("object"), true);
});

for (const declaration of [
  "class Inner { static value = opaque(); }",
  "class Inner { [opaque()]() {} }",
  "class Inner extends opaque() {}",
]) test(`class definition effects remain fail closed: ${declaration}`, () => {
  const report = check(`import fs from 'node:fs'; export function read() {
    if (process.platform === 'win32') { ${declaration} return fs.readFileSync('snapshot.json'); }
    return fs.readFileSync('snapshot.json');
  }`);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("repeated observation-free literals do not consume the work budget again", () => {
  const values = Array.from({ length: 2100 }, () => "console.log(message);").join("\n");
  const source = `const message = 'ordinary'; ${values}`;
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  const negative = check(`${source}\nimport fs from 'node:fs'; fs.readFileSync('/proc/self/stat');`);
  assert.equal(negative.complete, true, negative.diagnostics.join("\n"));
  assert.ok(negative.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation"));
});

for (const [container, key] of [["{ read: fs.readFileSync }", "'read'"], ["[fs.readFileSync]", "0"]]) {
  test(`literal container projection retains the selected capability: ${container}`, () => {
    const source = (path, selection = key) => `import fs from 'node:fs'; const readers = ${container}; readers[${selection}](${JSON.stringify(path)});`;
    const portable = check(source("snapshot.json"));
    assert.equal(portable.ok, true, portable.diagnostics.join("\n"));
    const negative = check(source("/proc/self/stat"));
    assert.equal(negative.complete, true, negative.diagnostics.join("\n"));
    assert.ok(negative.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation"));
    const unknown = check(source("snapshot.json", "selected"));
    assert.equal(unknown.complete, false);
    assert.ok(unknown.diagnostics.some((entry) => entry.classification === "incomplete" && /computed/.test(entry.message)));
  });
}

test("literal helper results keep the environment of each caller", () => {
  const source = `import fs from 'node:fs';
    function read(path) { const selected = path; fs.readFileSync(selected); }
    read('snapshot.json'); read('/proc/self/stat');`;
  const report = check(source);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation" && entry.line === 2));
  const recovered = check(source.replace("'/proc/self/stat'", "'snapshot.json'"));
  assert.equal(recovered.ok, true, recovered.diagnostics.join("\n"));
});

for (const [name, source] of [
  ["parameter", "export function normalize(value) { value = value.toJSON(); return value; }"],
  ["catch input", "try { opaque(); } catch (cause) { cause = new Error(String(cause)); console.log(cause); }"],
]) test(`ordinary ${name} self-updates do not invent a capability origin`, () => {
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  const unresolved = check("const first = second; const second = first; first();");
  assert.equal(unresolved.complete, false);
  assert.ok(unresolved.diagnostics.some((entry) => entry.classification === "incomplete" && /origin cycle/.test(entry.message)));
});

test("self-updating helper inputs retain capabilities supplied by real callers", () => {
  const source = `import fs from 'node:fs'; function read(reader) { reader = reader; return reader('/proc/self/stat'); } read(fs.readFileSync);`;
  const report = check(source);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation"), report.diagnostics.join("\n"));
});

test("platform predicates return boolean results rather than empty implementations", () => {
  const source = `export function matches(left, right) {
    if (process.platform === 'win32') return (left & 0o200) === (right & 0o200);
    return left === right;
  }`;
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  for (const result of ["false", "undefined", "left + right", "1 === 2", "left === right && unknownValue", "!left && unknownValue", "left instanceof 3"]) {
    const negative = check(source.replace("(left & 0o200) === (right & 0o200)", result));
    assert.equal(negative.ok, false);
    assert.ok(negative.diagnostics.some((entry) => entry.rule === "OS01"), negative.diagnostics.join("\n"));
    if (result === "1 === 2") assert.ok(negative.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation"));
  }
});

test("returned class instances retain capability arguments captured by their factory", () => {
  const source = (path, returned = "") => `import fs from 'node:fs';
    function make(reader) { class Bridge { read(file) { ${returned} reader(file); } } return new Bridge(); }
    make(fs.readFileSync).read(${JSON.stringify(path)});`;
  const portable = check(source("snapshot.json"));
  assert.equal(portable.ok, true, portable.diagnostics.join("\n"));
  const report = check(source("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation"), report.diagnostics.join("\n"));
  const unresolved = check(source("/proc/self/stat", "return"));
  assert.equal(unresolved.complete, false);
  assert.ok(unresolved.diagnostics.some((entry) => entry.classification === "incomplete"));
});

test("returned class instances retain concrete paths captured by their factory", () => {
  const source = `import fs from 'node:fs';
    function make(path) { class Reader { read() { fs.readFileSync(path); } } return new Reader(); }
    make('/proc/self/stat').read();`;
  const report = check(source);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation"), report.diagnostics.join("\n"));
});


test("direct static factory receivers preserve constructor and instance capability origins", () => {
  const source = path => `import fs from 'node:fs';
    class Reader {
      constructor(read) { this.read = read; }
      static capture(read) { return new this(read); }
      execute(path) { this.read(path); }
    }
    Reader.capture(fs.readFileSync).execute(${JSON.stringify(path)});`;
  const portable = check(source("snapshot.json"));
  assert.equal(portable.ok, true, portable.diagnostics.join("\n"));
  const rejected = check(source("/proc/self/stat"));
  assert.equal(rejected.complete, true, rejected.diagnostics.join("\n"));
  assert.ok(rejected.diagnostics.some(entry => entry.rule === "OS01" && entry.classification === "violation"), rejected.diagnostics.join("\n"));
});

test("static receivers remain lexical in arrows and are absent from detached or ordinary functions", () => {
  const source = body => `import fs from 'node:fs';
    class Reader {
      constructor(read) { this.read = read; }
      static capture(read) { ${body} }
      execute(path) { this.read(path); }
    }
    Reader.capture(fs.readFileSync).execute('snapshot.json');`;
  const arrow = check(source("const create = () => new this(read); return create();"));
  assert.equal(arrow.ok, true, arrow.diagnostics.join("\n"));
  const detached = source("return new this(read);").replace("    Reader.capture(fs.readFileSync)",
    "    const create = Reader.capture; create(fs.readFileSync)");
  for (const input of [detached, source("function create() { return new this(read); } return create();")]) {
    const report = check(input);
    assert.equal(report.complete, false, report.diagnostics.join("\n"));
    assert.ok(report.diagnostics.some(entry => entry.classification === "incomplete"), report.diagnostics.join("\n"));
  }
});

test("BigInt primitive conversion is inspectable without erasing mode or callable provenance", () => {
  const portable = check("const nativePid = BigInt(process.pid); console.log(nativePid);");
  assert.equal(portable.ok, true, portable.diagnostics.join("\n"));
  const mode = check(`import fs from 'node:fs';
    if (BigInt(fs.statSync('snapshot.json').mode) === 448) authorize();`);
  assert.equal(mode.ok, false);
  assert.ok(mode.diagnostics.some(entry => entry.rule === "OS03"), mode.diagnostics.join("\n"));
  const capability = check("import fs from 'node:fs'; consume(BigInt(fs.readFileSync));");
  assert.equal(capability.complete, false, capability.diagnostics.join("\n"));
  assert.ok(capability.diagnostics.some(entry => entry.classification === "incomplete"), capability.diagnostics.join("\n"));
  const shadowed = check("import fs from 'node:fs'; function BigInt(read) { read('/proc/self/stat'); } BigInt(fs.readFileSync);");
  assert.ok(shadowed.diagnostics.some(entry => entry.rule === "OS01" && entry.classification === "violation"), shadowed.diagnostics.join("\n"));
});

test("known object spreads preserve reader, path, visitor and source-order overrides", () => {
  const source = fields => `import fs from 'node:fs';
    function read(options) { options.reader(options.path); options.visit(); }
    const options = { reader: fs.readFileSync, path: 'snapshot.json' };
    read({ ${fields}, visit() {} });`;
  for (const fields of ["...options", "path: '/proc/self/stat', ...options"]) {
    const report = check(source(fields));
    assert.equal(report.ok, true, report.diagnostics.join("\n"));
  }
  const rejected = check(source("...options, path: '/proc/self/stat'"));
  assert.equal(rejected.complete, true, rejected.diagnostics.join("\n"));
  assert.ok(rejected.diagnostics.some(entry => entry.rule === "OS01" && entry.classification === "violation"), rejected.diagnostics.join("\n"));
  for (const body of ["fs.readFileSync('/proc/self/stat');", "this.reader('/proc/self/stat');"]) {
    const visitor = check(source("...options").replace("visit() {}", `visit() { ${body} }`));
    assert.ok(visitor.diagnostics.some(entry => entry.rule === "OS01" && entry.classification === "violation"), visitor.diagnostics.join("\n"));
  }
});

test("unknown spreads and executable or ambiguous object members remain incomplete", () => {
  for (const fields of [
    "...unknownOptions",
    "...{ get reader() { return fs.readFileSync; } }",
    "...{ [unknownKey]: fs.readFileSync }",
    "...{ reader: fs.readFileSync, reader: unknownReader }",
  ]) {
    const report = check(`import fs from 'node:fs'; function read(options) { options.reader('/proc/self/stat'); }
      read({ ${fields}, visit() {} });`);
    assert.equal(report.complete, false, report.diagnostics.join("\n"));
    assert.ok(report.diagnostics.some(entry => entry.classification === "incomplete"), report.diagnostics.join("\n"));
  }
});


test("inspected synchronous void helpers do not invent capability return values", () => {
  const source = body => `import fs from 'node:fs'; function finish(read) { ${body} }
    const result = finish(fs.readFileSync); consume(result);`;
  const portable = check(source("read('snapshot.json');"));
  assert.equal(portable.ok, true, portable.diagnostics.join("\n"));
  const forbidden = check(source("read('/proc/self/stat');"));
  assert.ok(forbidden.diagnostics.some(entry => entry.rule === "OS01" && entry.classification === "violation"), forbidden.diagnostics.join("\n"));
  for (const input of [
    source("escape(read);"),
    source("if (condition) return read; return opaque();"),
    source("read('snapshot.json');").replace("function finish", "async function finish"),
    source("read('snapshot.json');").replace("function finish", "function* finish"),
    "import fs from 'node:fs'; const finish = async read => { read('snapshot.json'); }; consume(finish(fs.readFileSync));",
  ]) {
    const report = check(input);
    assert.equal(report.complete, false, report.diagnostics.join("\n"));
    assert.ok(report.diagnostics.some(entry => entry.classification === "incomplete"), report.diagnostics.join("\n"));
  }
});
