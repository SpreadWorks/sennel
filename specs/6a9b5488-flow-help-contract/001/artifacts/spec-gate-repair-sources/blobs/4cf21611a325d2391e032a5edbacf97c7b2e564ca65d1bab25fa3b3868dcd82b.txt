/**
 * YAML language handler.
 * Provides minify only.
 */

import { hasHashPrefix } from "./comments.js";

function removeHashComments(code) {
  return code
    .split("\n")
    .map((line) => {
      if (line.match(/^#!/)) return line;
      if (hasHashPrefix(line)) return line;
      return line.replace(/(?:^|\s)#.*$/, "").trimEnd();
    })
    .filter((line) => line.trim() !== "")
    .join("\n");
}

export function minify(code) {
  return removeHashComments(code);
}
