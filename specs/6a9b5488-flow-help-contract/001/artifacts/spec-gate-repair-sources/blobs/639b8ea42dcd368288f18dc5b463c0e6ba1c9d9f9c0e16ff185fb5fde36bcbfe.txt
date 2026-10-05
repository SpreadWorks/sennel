/**
 * src/lib/glob.js
 *
 * Shared glob-style pattern helpers.
 */

const REGEX_META_CHARS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]"]);
const BACKSLASH_CHAR_CODE = 92;

/**
 * Convert a small glob pattern to a regular expression.
 * - `**` matches any path tail
 * - double-star followed by slash matches zero or more directories
 * - `*` matches any characters except `/`
 */
export function globToRegex(pattern) {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        regex += "(?:.+/)?";
        i += 3;
      } else {
        regex += ".*";
        i += 2;
      }
    } else if (pattern[i] === "*") {
      regex += "[^/]*";
      i++;
    } else if (REGEX_META_CHARS.has(pattern[i]) || pattern.charCodeAt(i) === BACKSLASH_CHAR_CODE) {
      regex += "\\" + pattern[i];
      i++;
    } else {
      regex += pattern[i];
      i++;
    }
  }
  return new RegExp("^" + regex + "$");
}
