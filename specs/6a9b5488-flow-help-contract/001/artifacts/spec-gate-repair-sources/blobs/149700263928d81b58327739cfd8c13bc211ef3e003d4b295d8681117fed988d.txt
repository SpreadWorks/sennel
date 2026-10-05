/**
 * Minimal TOML parser for wrangler.toml.
 * Handles key=value, [section], [[array_of_tables]], and # comments.
 * Does NOT handle inline tables, multiline strings, or datetime.
 */
export function parseTOML(text) {
  const result = {};
  let current = result;
  let currentPath = [];

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;

    // Array of tables: [[section.name]]
    const aotMatch = line.match(/^\[\[(.+)\]\]$/);
    if (aotMatch) {
      const keys = aotMatch[1].trim().split(".").map((k) => k.trim());
      currentPath = keys;
      let target = result;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in target)) target[keys[i]] = {};
        target = target[keys[i]];
      }
      const lastKey = keys[keys.length - 1];
      if (!Array.isArray(target[lastKey])) target[lastKey] = [];
      const entry = {};
      target[lastKey].push(entry);
      current = entry;
      continue;
    }

    // Section: [section] or [section.sub]
    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) {
      const keys = secMatch[1].trim().split(".").map((k) => k.trim());
      currentPath = keys;
      let target = result;
      for (const key of keys) {
        if (!(key in target)) target[key] = {};
        if (Array.isArray(target[key])) {
          // Navigate into the last element of an array of tables
          target = target[key][target[key].length - 1];
        } else {
          target = target[key];
        }
      }
      current = target;
      continue;
    }

    // Key-value: key = value
    const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const val = parseValue(kvMatch[2].trim());
      current[key] = val;
    }
  }

  return result;
}

/**
 * Parse a TOML value.
 * @param {string} raw
 * @returns {*}
 */
function parseValue(raw) {
  // String (double or single quoted)
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Array
  if (raw.startsWith("[")) {
    return parseArray(raw);
  }

  // Number (integer or float)
  const num = Number(raw);
  if (!Number.isNaN(num)) return num;

  // Fallback: return as string
  return raw;
}

/**
 * Parse a TOML array value (single line only).
 * @param {string} raw - e.g. '["a", "b", "c"]'
 * @returns {Array}
 */
function parseArray(raw) {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];

  const items = [];
  let current = "";
  let inString = false;
  let quote = "";
  let depth = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      current += ch;
      if (ch === quote) inString = false;
    } else if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      current += ch;
    } else if (ch === "[") {
      depth++;
      current += ch;
    } else if (ch === "]") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed !== "") items.push(parseValue(trimmed));
      current = "";
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed !== "") items.push(parseValue(trimmed));

  return items;
}
