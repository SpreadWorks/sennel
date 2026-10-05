/**
 * src/flow/lib/fetch-issue.js
 *
 * Shared gh issue view wrapper (spec 225 R2).
 * strict=true  → throws on gh failure / parse failure.
 * strict=false → returns null on failure and emits one stderr warning line.
 *
 * Used by `get-issue.js` (strict) and by the auto-check input path
 * (set-init / set-issue / run-prepare-spec — lenient).
 */

import { runCmd, formatError } from "../../lib/process.js";

export function fetchIssue(number, root, { strict = false } = {}) {
  const num = String(number ?? "");
  if (!num || !/^\d+$/.test(num)) {
    const msg = "issue number required (positive integer)";
    if (strict) throw new Error(msg);
    process.stderr.write(`warn: failed to fetch issue #${number}: ${msg}\n`);
    return null;
  }

  const res = runCmd(
    "gh",
    ["issue", "view", num, "--json", "title,body,labels,state"],
    { cwd: root, timeout: 15000 },
  );
  if (!res.ok) {
    const reason = formatError(res);
    if (strict) throw new Error(`gh issue view failed: ${reason}`);
    process.stderr.write(`warn: failed to fetch issue #${num}: ${reason}\n`);
    return null;
  }

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch (e) {
    if (strict) throw new Error(`gh issue view returned non-JSON: ${e.message}`);
    process.stderr.write(`warn: failed to fetch issue #${num}: non-JSON response\n`);
    return null;
  }

  return {
    title: data.title,
    body: data.body,
    labels: data.labels,
    state: data.state,
  };
}
