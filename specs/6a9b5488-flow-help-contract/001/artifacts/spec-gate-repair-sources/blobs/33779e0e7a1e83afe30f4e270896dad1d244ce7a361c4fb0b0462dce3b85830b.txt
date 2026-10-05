/**
 * src/lib/json-parse.js
 *
 * AI レスポンスの壊れた JSON を修復するユーティリティ。
 * 再帰下降パーサー + バックトラックで構造を認識しながら修復する。
 *
 * Architecture inspired by josdejong/jsonrepair (ISC License).
 * See NOTICE for acknowledgement.
 */

const STRUCTURAL = new Set([",", ":", "{", "}", "[", "]"]);

/**
 * Repair broken JSON from AI responses.
 * Handles: unescaped quotes in strings, truncated JSON, markdown fences,
 * surrounding text, and invalid escape sequences.
 *
 * @param {string} text - Raw AI response (may contain broken JSON)
 * @returns {string} Repaired JSON string (valid for JSON.parse)
 */
export function repairJson(text) {
  let input = stripMarkdownFences(text);
  // Find the start of JSON
  const jsonStart = findJsonStart(input);
  if (jsonStart < 0) return input.trim();
  input = input.slice(jsonStart);

  let i = 0;
  let output = "";

  function ch() { return input[i]; }
  function eof() { return i >= input.length; }
  function emit(s) { output += s; }

  function skipWhitespace() {
    while (!eof() && isWhitespace(ch())) {
      emit(ch());
      i++;
    }
  }

  function parseValue() {
    skipWhitespace();
    if (eof()) return false;
    const c = ch();
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "`") return parseString(); // AI sometimes uses backtick as opening quote
    if (c === "-" || isDigit(c)) return parseNumber();
    if (tryKeyword("true") || tryKeyword("false") || tryKeyword("null")) return true;
    return false;
  }

  function parseObject() {
    emit("{");
    i++; // skip {
    skipWhitespace();

    let first = true;
    while (!eof()) {
      skipWhitespace();
      if (eof()) break;
      if (ch() === "}") { emit("}"); i++; return true; }

      if (!first) {
        if (ch() === ",") { emit(","); i++; }
        else { emit(","); } // missing comma — insert
        skipWhitespace();
        if (eof()) break;
        if (ch() === "}") { emit("}"); i++; return true; } // trailing comma
      }
      first = false;

      // key
      if (ch() !== '"') break;
      parseString();
      skipWhitespace();

      // colon
      if (!eof() && ch() === ":") { emit(":"); i++; }
      else { emit(":"); } // missing colon — insert
      skipWhitespace();

      // value
      if (eof()) { emit("null"); break; }
      if (!parseValue()) { emit("null"); }
    }

    // truncation — auto-close
    emit("}");
    return true;
  }

  function parseArray() {
    emit("[");
    i++; // skip [
    skipWhitespace();

    let first = true;
    while (!eof()) {
      skipWhitespace();
      if (eof()) break;
      if (ch() === "]") { emit("]"); i++; return true; }

      if (!first) {
        if (ch() === ",") { emit(","); i++; }
        else { emit(","); }
        skipWhitespace();
        if (eof()) break;
        if (ch() === "]") { emit("]"); i++; return true; } // trailing comma
      }
      first = false;

      if (!parseValue()) break;
    }

    emit("]");
    return true;
  }

  /**
   * Parse a JSON string with backtracking for unescaped quote detection.
   *
   * Strategy (inspired by jsonrepair):
   * 1. First pass: scan for closing quote. When we see a `"`, check if the
   *    next non-whitespace char is a structural delimiter (,}]:). If so, it's
   *    the real end quote. Otherwise, escape it and continue.
   * 2. If first pass reaches EOF without a valid close, backtrack and retry
   *    in "stop at delimiter" mode — end the string at the first unescaped
   *    structural delimiter encountered.
   */
  function parseString() {
    const saveI = i;
    const saveOutput = output;

    const result = parseStringPass(false);
    if (result) return true;

    // Backtrack and retry with stopAtDelimiter
    i = saveI;
    output = saveOutput;
    return parseStringPass(true);
  }

  function parseStringPass(stopAtDelimiter) {
    const opener = ch(); // either '"' or '`' — both normalized to '"' on output
    emit('"');
    i++; // skip opening quote

    while (!eof()) {
      const c = ch();

      // Escape sequences
      if (c === "\\") {
        i++;
        if (eof()) break;
        const escaped = ch();
        if ('"\\/bfnrtu'.includes(escaped)) {
          emit("\\");
          emit(escaped);
          i++;
        } else {
          // Invalid escape — drop backslash, keep char
          emit(escaped);
          i++;
        }
        continue;
      }

      // Candidate end quote: accept either `"` or `` ` `` (the latter only
      // when the opener was backtick — otherwise inner backticks are content).
      const isCandidateClose = c === '"' || (c === "`" && opener === "`");
      if (isCandidateClose) {
        // Look ahead past whitespace for structural char
        let peek = i + 1;
        while (peek < input.length && isWhitespace(input[peek])) peek++;
        const after = input[peek];

        if (after === undefined || after === "," || after === "}" ||
            after === "]" || after === ":") {
          // Real end of string
          emit('"');
          i++;
          return true;
        }

        // Double-quote not followed by structural char — likely unescaped
        // interior quote. Backtick not followed by structural char is just
        // an inner code fence; keep it as content.
        if (c === '"') {
          emit('\\"');
        } else {
          emit(c);
        }
        i++;
        continue;
      }

      // stopAtDelimiter mode: treat structural chars as string boundary
      if (stopAtDelimiter && STRUCTURAL.has(c)) {
        emit('"');
        return true;
      }

      // Control characters — escape them
      if (c.charCodeAt(0) < 0x20) {
        emit(escapeControl(c));
        i++;
        continue;
      }

      emit(c);
      i++;
    }

    // EOF inside string — close it
    emit('"');
    return true;
  }

  function parseNumber() {
    if (ch() === "-") { emit("-"); i++; }
    if (eof()) { emit("0"); return true; }

    // Integer part
    while (!eof() && isDigit(ch())) { emit(ch()); i++; }

    // Decimal part
    if (!eof() && ch() === ".") {
      emit(".");
      i++;
      if (eof() || !isDigit(ch())) emit("0"); // truncated: "2." → "2.0"
      while (!eof() && isDigit(ch())) { emit(ch()); i++; }
    }

    // Exponent part
    if (!eof() && (ch() === "e" || ch() === "E")) {
      emit(ch());
      i++;
      if (!eof() && (ch() === "+" || ch() === "-")) { emit(ch()); i++; }
      if (eof() || !isDigit(ch())) emit("0"); // truncated exponent
      while (!eof() && isDigit(ch())) { emit(ch()); i++; }
    }

    return true;
  }

  function tryKeyword(kw) {
    if (input.slice(i, i + kw.length) === kw) {
      const after = input[i + kw.length];
      if (after === undefined || isWhitespace(after) || STRUCTURAL.has(after)) {
        emit(kw);
        i += kw.length;
        return true;
      }
    }
    return false;
  }

  parseValue();
  return output;
}

// --- Helpers ---

function stripMarkdownFences(text) {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  return s;
}

function findJsonStart(text) {
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  if (objStart < 0 && arrStart < 0) return -1;
  if (objStart < 0) return arrStart;
  if (arrStart < 0) return objStart;
  return Math.min(objStart, arrStart);
}

function isWhitespace(c) {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function isDigit(c) {
  return c >= "0" && c <= "9";
}

function escapeControl(c) {
  const code = c.charCodeAt(0);
  if (code === 0x09) return "\\t";
  if (code === 0x0a) return "\\n";
  if (code === 0x0d) return "\\r";
  return "\\u" + code.toString(16).padStart(4, "0");
}
