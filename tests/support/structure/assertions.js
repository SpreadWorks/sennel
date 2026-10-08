import assert from "node:assert/strict";

export function assertStructureSuccess(report) {
  assert.equal(report.ok, true, report.diagnostics.map((diagnostic) => diagnostic.toString()).join("\n"));
}

export function assertStructureViolation(report, rule, file, message, trace, source = null, marker = null) {
  const diagnostic = report.diagnostics.find((entry) => entry.rule === rule && entry.file === file && entry.message.includes(message));
  assert.ok(diagnostic, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.deepEqual(diagnostic.trace, trace);
  if (marker !== null) {
    const offset = source.indexOf(marker);
    assert.ok(offset >= 0, `fixture must contain exact diagnostic marker ${marker}`);
    const prefix = source.slice(0, offset);
    assert.equal(diagnostic.line, prefix.split("\n").length);
    assert.equal(diagnostic.column, offset - prefix.lastIndexOf("\n"));
  } else {
    assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
  }
  return diagnostic;
}
