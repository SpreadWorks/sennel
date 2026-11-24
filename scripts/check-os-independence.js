#!/usr/bin/env node
import { auditOsIndependenceAt, OsAuditFailure } from "../tests/support/structure/os-audit.js";

try {
  if (process.argv.length !== 2) throw new Error("Run check:os-independence without arguments from the repository root");
  const report = auditOsIndependenceAt(process.cwd());
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
} catch (error) {
  const report = new OsAuditFailure(error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}
