import {
  MARKDOWN_FORMAT_TABLE,
  Renderable,
  assertMarkdownFormat,
} from "./renderable.js";

/**
 * src/docs/lib/directive-parser.js
 *
 * テンプレート内の出力ディレクティブ {{ }} と制御ディレクティブ {% %} を解析する。
 *
 * 出力ディレクティブ（関数呼び出しスタイル）:
 *   <!-- {{data("preset.source.method", {labels: "A|B", format: "list", ignoreError: true})}} -->
 *   <!-- {{/data}} -->
 *   <!-- {{text({prompt: "Write overview.", mode: "deep"})}} -->
 *   <!-- {{/text}} -->
 *
 * 制御ディレクティブ（宣言スタイル）:
 *   <!-- {%extends "layout"%} -->
 *   <!-- {%block "name"%} -->
 *   <!-- {%/block%} -->
 *
 * マルチラインディレクティブ:
 *   <!--
 *   {{data("webapp.controllers.list", {
 *     labels: "Name|Path",
 *     ignoreError: true
 *   })}}
 *   -->
 */

/**
 * @typedef {Object} DataDirective
 * @property {"data"} type
 * @property {string} preset     - プリセット名 (e.g. "symfony", "base")
 * @property {string} source     - DataSource 名 (e.g. "controllers")
 * @property {string} method     - メソッド名 (e.g. "list")
 * @property {string[]} labels   - テーブルヘッダー表示名
 * @property {Object} params     - オプションパラメータ
 * @property {string} raw        - ディレクティブの全文（マルチラインの場合は結合済み）
 * @property {number} line       - 開始行番号 (0-based)
 * @property {number} endLine    - {{/data}} の行番号 (0-based)
 * @property {boolean} inline    - {{data}} と {{/data}} が同一行か
 * @property {string} fullRaw    - インラインの場合、行全体
 */

/**
 * @typedef {Object} TextDirective
 * @property {"text"} type
 * @property {string} prompt     - LLM に渡すプロンプト
 * @property {Object} params     - オプショナルパラメータ
 * @property {string} raw        - ディレクティブの全文
 * @property {number} line       - 開始行番号 (0-based)
 * @property {number} endLine    - {{/text}} の行番号 (0-based)
 */

// ---------------------------------------------------------------------------
// Shared directive patterns
// ---------------------------------------------------------------------------
const ENDDATA_RE = /^<!--\s*\{\{\/data\}\}\s*-->$/;
const ENDTEXT_RE = /^<!--\s*\{\{\/text\}\}\s*-->$/;

/** Opening tag pattern for {{text(...)}} directives. */
export const TEXT_OPEN_RE = /^<!--\s*\{\{text\(/;

// ---------------------------------------------------------------------------
// New control directive patterns
// ---------------------------------------------------------------------------
export const BLOCK_START_RE = /^<!--\s*\{%block\s+"([\w-]+)"%\}\s*-->$/;
export const BLOCK_END_RE   = /^<!--\s*\{%\/block%\}\s*-->$/;
const EXTENDS_RE     = /^<!--\s*\{%extends(?:\s+"([\w-]+)")?%\}\s*-->$/;

// ---------------------------------------------------------------------------
// HTML comment block extraction (for multiline support)
// ---------------------------------------------------------------------------

/**
 * HTML コメントブロック <!-- ... --> を抽出する。
 * 単一行コメントとマルチラインコメントの両方に対応。
 *
 * @param {string} line - 現在の行
 * @param {string[]} lines - 全行配列
 * @param {number} index - 現在の行インデックス
 * @returns {{ content: string, endIndex: number }|null}
 */
export function extractCommentBlock(line, lines, index) {
  const trimmed = line.trim();

  // Single-line: <!-- ... -->
  const singleMatch = trimmed.match(/^<!--(.+?)-->$/s);
  if (singleMatch) {
    return { content: singleMatch[1].trim(), endIndex: index };
  }

  // Multiline start: <!--
  if (trimmed === "<!--" || (trimmed.startsWith("<!--") && !trimmed.includes("-->"))) {
    const parts = [trimmed.slice(4).trim()]; // content after <!--
    for (let j = index + 1; j < lines.length; j++) {
      const jTrimmed = lines[j].trim();
      if (jTrimmed.endsWith("-->")) {
        parts.push(jTrimmed.slice(0, -3).trim());
        const content = parts.filter(Boolean).join("\n");
        return { content, endIndex: j };
      }
      parts.push(jTrimmed);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Output directive parsing (function call style)
// ---------------------------------------------------------------------------

/**
 * Parse option object from function call arguments.
 * Handles: {labels: "A|B", format: "list", ignoreError: true, maxLines: 10, mode: "deep"}
 *
 * @param {string} optStr - Option string (without outer braces)
 * @returns {Object}
 */
function parseOptions(optStr) {
  if (!optStr) return {};
  const opts = {};

  // Match key: value pairs (handles quoted strings, booleans, numbers)
  const pairRe = /(\w+)\s*:\s*(?:"([^"]*)"|(true|false|\d+(?:\.\d+)?)|(\w+))/g;
  let m;
  while ((m = pairRe.exec(optStr)) !== null) {
    const key = m[1];
    if (m[2] !== undefined) {
      opts[key] = m[2].replace(/\\n/g, "\n"); // quoted string (unescape \n)
    } else if (m[3] !== undefined) {
      if (m[3] === "true") opts[key] = true;
      else if (m[3] === "false") opts[key] = false;
      else opts[key] = Number(m[3]);
    } else if (m[4] !== undefined) {
      opts[key] = m[4]; // unquoted identifier
    }
  }

  return opts;
}

/**
 * Build data directive fields from a dotted path and options string.
 *
 * @param {string} pathStr - Dotted path (e.g. "base.project.summary")
 * @param {string} optsStr - Options string (e.g. 'labels: "A|B", format: "list", ignoreError: true')
 * @returns {Object|null} { preset, source, method, labels, params } or null
 */
/** Parser-owned option keys that the resolver layer consumes directly. */
const PARSER_OWNED_OPTION_KEYS = new Set(["labels", "header", "footer", "ignoreError", "format"]);

function buildDataFields(pathStr, optsStr) {
  const parts = pathStr.split(".");
  if (parts.length < 3) return null;

  const preset = parts[0];
  const method = parts[parts.length - 1];
  const source = parts.slice(1, -1).join(".");

  const opts = parseOptions(optsStr);
  const labels = opts.labels ? opts.labels.split("|").map((l) => l.trim()) : [];
  // Backward-compatible: `params` contains all directive options minus `labels`.
  // Parser-owned controls (header/footer/ignoreError/format) remain readable via params for
  // existing tests; resolveFn receives a filtered subset (userParams) per spec R23.
  const params = { ...opts };
  delete params.labels;

  return { preset, source, method, labels, params };
}

function extractUserParams(params) {
  if (!params) return {};
  const out = {};
  for (const k of Object.keys(params)) {
    if (!PARSER_OWNED_OPTION_KEYS.has(k)) out[k] = params[k];
  }
  return out;
}

/**
 * Parse a data() function call.
 * Format: data("preset.source.method", {options})
 *         data("preset.source.method")
 *
 * @param {string} content - Content inside {{ }}
 * @returns {Object|null} Parsed directive fields or null
 */
function parseDataCall(content) {
  const re = /^data\(\s*"([\w][\w.-]*)"\s*(?:,\s*\{([^}]*)\})?\s*\)$/s;
  const m = content.match(re);
  if (!m) return null;
  return buildDataFields(m[1], m[2] || "");
}

/**
 * Parse a text() function call.
 * Format: text({prompt: "...", mode: "deep", id: "name", maxLines: 10})
 *
 * @param {string} content - Content inside {{ }}
 * @returns {Object|null} Parsed directive fields or null
 */
function parseTextCall(content) {
  // text({...})
  const re = /^text\(\s*\{([\s\S]*)\}\s*\)$/s;
  const m = content.match(re);
  if (!m) return null;

  const opts = parseOptions(m[1]);
  const prompt = opts.prompt;
  if (!prompt) return null;

  const params = { ...opts };
  delete params.prompt;

  return { prompt, params };
}

// ---------------------------------------------------------------------------
// Inline data directive detection
// ---------------------------------------------------------------------------

/**
 * Inline {{data(...)}} pattern for single-line detection.
 * Matches: <!-- {{data("path", {opts})}} -->content<!-- {{/data}} -->
 */
const INLINE_DATA_RE = /<!--\s*\{\{data\(\s*"([\w][\w.-]*)"\s*(?:,\s*\{([^}]*)\})?\s*\)\}\}\s*-->([\s\S]*?)<!--\s*\{\{\/data\}\}\s*-->/;

function parseInlineData(match) {
  return buildDataFields(match[1], match[2] || "");
}

// ---------------------------------------------------------------------------
// Closing tag search helper
// ---------------------------------------------------------------------------

/**
 * 指定位置以降から閉じタグを検索する。見つからなければエラーを投げる。
 *
 * @param {string[]} lines - 全行配列
 * @param {number} startIndex - 検索開始行
 * @param {RegExp} closingRe - 閉じタグの正規表現
 * @param {string} label - エラーメッセージ用のディレクティブ名
 * @param {number} openLine - 開始タグの行番号（エラーメッセージ用）
 * @returns {number} 閉じタグの行番号
 */
function findClosingTag(lines, startIndex, closingRe, label, openLine) {
  for (let j = startIndex; j < lines.length; j++) {
    if (closingRe.test(lines[j].trim())) return j;
  }
  throw new Error(`Unclosed {{${label}}} directive at line ${openLine + 1}`);
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * テンプレートテキストからディレクティブを抽出する。
 *
 * @param {string} text - テンプレート全文
 * @returns {Array<DataDirective|TextDirective>}
 */
export function parseDirectives(text) {
  const lines = text.split("\n");
  const directives = [];

  for (let i = 0; i < lines.length; i++) {
    // Inline {{data(...)}} check (multiple per line)
    const inlineGlobal = new RegExp(INLINE_DATA_RE.source, "g");
    const inlineMatches = [...lines[i].matchAll(inlineGlobal)];
    if (inlineMatches.length > 0) {
      for (const m of inlineMatches) {
        const parsed = parseInlineData(m);
        if (!parsed) continue;
        directives.push({
          type: "data",
          ...parsed,
          raw: m[0],
          line: i,
          endLine: i,
          inline: true,
          fullRaw: lines[i],
        });
      }
      continue;
    }

    // Extract comment block (single-line or multiline)
    const comment = extractCommentBlock(lines[i], lines, i);
    if (!comment) continue;

    const { content, endIndex } = comment;

    // Try {{data(...)}}
    const dataContent = content.match(/^\{\{(data\([\s\S]*\))\}\}$/s);
    if (dataContent) {
      const parsed = parseDataCall(dataContent[1]);
      if (parsed) {
        const endLine = findClosingTag(lines, endIndex + 1, ENDDATA_RE, "data", i);
        const rawLines = lines.slice(i, endIndex + 1);
        directives.push({
          type: "data",
          ...parsed,
          raw: rawLines.join("\n"),
          line: i,
          endLine,
          inline: false,
          fullRaw: null,
        });
        i = endIndex;
        continue;
      }
    }

    // Try {{text(...)}}
    const textContent = content.match(/^\{\{(text\([\s\S]*\))\}\}$/s);
    if (textContent) {
      const parsed = parseTextCall(textContent[1]);
      if (parsed) {
        const endLine = findClosingTag(lines, endIndex + 1, ENDTEXT_RE, "text", i);
        const rawLines = lines.slice(i, endIndex + 1);
        directives.push({
          type: "text",
          prompt: parsed.prompt,
          params: parsed.params,
          raw: rawLines.join("\n"),
          line: i,
          endLine,
        });
        i = endIndex;
        continue;
      }
    }
  }

  return directives;
}

// ---------------------------------------------------------------------------
// Block directive replacement
// ---------------------------------------------------------------------------

/**
 * ブロックディレクティブの内容を置換する。
 * lines 配列を直接変更する（splice）。
 *
 * @param {string[]} lines - ファイルの行配列
 * @param {DataDirective} d - ディレクティブ
 * @param {string} [content] - 新しい内容（省略時はコンテンツをクリア）
 */
export function replaceBlockDirective(lines, d, content) {
  // For multiline directives, raw may span multiple lines
  const rawLines = d.raw.split("\n");
  const endDataLine = lines[d.endLine];
  const newLines = content != null
    ? [...rawLines, content, endDataLine]
    : [...rawLines, endDataLine];
  lines.splice(d.line, d.endLine - d.line + 1, ...newLines);
}

// ---------------------------------------------------------------------------
// Directive resolution
// ---------------------------------------------------------------------------

/**
 * インラインディレクティブのコンテンツを置換する。
 */
function replaceInlineDirective(lines, d, content) {
  const openTag = d.raw.match(/<!--\s*\{\{data\([^)]*\)\}\}\s*-->/s)?.[0];
  const endTag = "<!-- {{/data}} -->";
  if (openTag) {
    const replacement = content != null
      ? `${openTag}${content}${endTag}`
      : `${openTag}${endTag}`;
    lines[d.line] = lines[d.line].replace(d.raw, replacement);
  }
}

/**
 * テンプレート内の {{data}} ディレクティブを一括解決する。
 *
 * @param {string} text - テンプレート全文
 * @param {function} resolveFn - (preset, source, method, labels, params) => rendered string | null
 *   params is an object with directive option keys other than parser-owned controls
 *   (labels, header, footer, ignoreError, format). Parser-owned controls remain on d.params for the
 *   resolver layer's own use and are NOT forwarded to resolveFn.
 * @param {Object} [opts]
 * @param {function} [opts.onResolve] - (directive, rendered) => void
 * @param {function} [opts.onSkip] - (directive) => void — data 以外のディレクティブ時
 * @param {function} [opts.onUnresolved] - (directive) => void — null 返却時
 * @returns {{ text: string, replaced: number }}
 */
export function resolveDataDirectives(text, resolveFn, opts) {
  const { onResolve, onSkip, onUnresolved } = opts || {};
  const directives = parseDirectives(text);
  if (directives.length === 0) return { text, replaced: 0 };

  const lines = text.split("\n");
  let replaced = 0;

  for (let i = directives.length - 1; i >= 0; i--) {
    const d = directives[i];

    if (d.type !== "data") {
      if (onSkip) onSkip(d);
      continue;
    }

    const format = assertMarkdownFormat(d.params?.format ?? MARKDOWN_FORMAT_TABLE);
    const userParams = extractUserParams(d.params);
    let resolved;
    try {
      resolved = resolveFn(d.preset, d.source, d.method, d.labels, userParams);
    } catch (cause) {
      if (d.params?.ignoreError === true) {
        if (d.inline) {
          replaceInlineDirective(lines, d);
        } else {
          replaceBlockDirective(lines, d);
        }
        replaced++;
        continue;
      }
      throw cause;
    }
    const rendered = resolved instanceof Renderable ? resolved.toMarkdownFormat(format) : null;
    if (resolved === null || resolved === undefined || rendered === null) {
      if (d.params?.ignoreError === true) {
        if (d.inline) {
          replaceInlineDirective(lines, d);
        } else {
          replaceBlockDirective(lines, d);
        }
        replaced++;
        continue;
      }
      if (onUnresolved) onUnresolved(d);
      continue;
    }

    // Build content with optional header/footer (parser-owned controls live on d.params)
    const { header, footer } = d.params || {};
    const parts = [];
    if (header) parts.push(header);
    parts.push(rendered);
    if (footer) parts.push(footer);
    const content = parts.join("\n");

    if (onResolve) onResolve(d, rendered);

    if (d.inline) {
      replaceInlineDirective(lines, d, content);
      replaced++;
    } else if (d.endLine >= 0) {
      replaceBlockDirective(lines, d, content);
      replaced++;
    }
  }

  return { text: lines.join("\n"), replaced };
}

// ---------------------------------------------------------------------------
// Marker strip (for skill deploy pipeline)
// ---------------------------------------------------------------------------

const DATA_OPEN_LINE_RE = /^<!--\s*\{\{data\(/;
const DATA_CLOSE_LINE_RE = /^<!--\s*\{\{\/data\}\}\s*-->\s*$/;

/**
 * Remove paired `<!-- {{data(...)}} -->` ... `<!-- {{/data}} -->` markers from the
 * already-expanded markdown, preserving the body content between them and all surrounding
 * lines. Idempotent. Throws when an unexpanded data directive remains (paired marker
 * bracketing content that itself contains an unprocessed `<!-- {{data(...)}} -->` line).
 *
 * @param {string} content
 * @returns {string}
 */
export function stripDataMarkers(content) {
  const lines = content.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (DATA_OPEN_LINE_RE.test(trimmed)) {
      // Find the matching close
      let depth = 1;
      let j = i + 1;
      let body = [];
      while (j < lines.length && depth > 0) {
        const s = lines[j].trim();
        if (DATA_OPEN_LINE_RE.test(s)) {
          throw new Error(
            `unexpanded data directive at line ${j + 1}: nested {{data}} marker found inside an enclosing block`,
          );
        }
        if (DATA_CLOSE_LINE_RE.test(s)) {
          depth = 0;
          break;
        }
        body.push(lines[j]);
        j++;
      }
      if (depth !== 0) {
        throw new Error(`unexpanded data directive at line ${i + 1}: missing closing marker`);
      }
      // Output the body (markers dropped)
      for (const b of body) out.push(b);
      i = j + 1;
      continue;
    }
    if (DATA_CLOSE_LINE_RE.test(trimmed)) {
      // Stray close without an open
      throw new Error(`unexpanded data directive at line ${i + 1}: stray closing marker without opening`);
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Block structure parsing (for template inheritance)
// ---------------------------------------------------------------------------

/**
 * マージ済みテンプレートからブロック制御行を除去する。
 *
 * @param {string} text - テンプレートテキスト
 * @returns {string}
 */
export function stripBlockDirectives(text) {
  return text.split("\n")
    .filter((line) => {
      const t = line.trim();
      return !BLOCK_START_RE.test(t) && !BLOCK_END_RE.test(t) && !EXTENDS_RE.test(t);
    })
    .join("\n");
}

/**
 * テンプレートファイルのブロック継承構造を解析する。
 *
 * @param {string} text - テンプレート全文
 * @returns {{
 *   extends: boolean,
 *   extendsTarget: string|null,
 *   blocks: Map<string, { name: string, content: string[] }>,
 *   preamble: string[],
 *   postamble: string[],
 * }}
 */
export function parseBlocks(text) {
  const lines = text.split("\n");
  let hasExtends = false;
  let extendsTarget = null;
  const blocks = new Map();
  const preamble = [];
  const postamble = [];

  const stack = [];
  let lastBlockEndLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    const extendsMatch = trimmed.match(EXTENDS_RE);
    if (extendsMatch) {
      hasExtends = true;
      extendsTarget = extendsMatch[1] || null;
      continue;
    }

    const blockStart = trimmed.match(BLOCK_START_RE);
    if (blockStart) {
      if (stack.length > 0) {
        stack[stack.length - 1].content.push(lines[i]);
      }
      stack.push({ name: blockStart[1], content: [] });
      continue;
    }

    if (BLOCK_END_RE.test(trimmed)) {
      if (stack.length > 0) {
        const completed = stack.pop();
        blocks.set(completed.name, completed);
        lastBlockEndLine = i;
        if (stack.length > 0) {
          stack[stack.length - 1].content.push(lines[i]);
        }
      }
      continue;
    }

    if (stack.length > 0) {
      stack[stack.length - 1].content.push(lines[i]);
      continue;
    }

    if (blocks.size === 0 && lastBlockEndLine === -1) {
      preamble.push(lines[i]);
    } else {
      postamble.push(lines[i]);
    }
  }

  return { extends: hasExtends, extendsTarget, blocks, preamble, postamble };
}
