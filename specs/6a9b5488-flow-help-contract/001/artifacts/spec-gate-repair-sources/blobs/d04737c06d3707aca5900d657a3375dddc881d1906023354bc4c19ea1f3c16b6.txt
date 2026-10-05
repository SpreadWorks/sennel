/**
 * tools/analyzers/lib/php-array-parser.js
 *
 * PHP ソースコード解析ユーティリティ。
 * CakePHP 2.x の array() 構文からプロパティ・キー・値を抽出する。
 */

/**
 * ブロックコメント (/* ... *​/) を除去する。
 * 行コメント (// ...) は除去しない。
 */
export function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * `$property = array(...)` の中身を括弧バランスで抽出する。
 * `var`, `public`, `protected`, `private` 修飾子に対応。
 * 見つからない場合は空文字を返す。
 */
export function extractArrayBody(fileContent, propertyName) {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:var|public|protected|private)\\s+\\$${escaped}\\s*=\\s*array\\s*\\(`,
    "m",
  );
  const m = re.exec(fileContent);
  if (!m) return "";

  const startIdx = m.index + m[0].length;
  let depth = 1;
  let i = startIdx;
  while (i < fileContent.length && depth > 0) {
    const ch = fileContent[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    i += 1;
  }
  if (depth !== 0) return "";
  return fileContent.slice(startIdx, i - 1);
}

/**
 * 連想配列の第一階層キーを抽出する。
 * `'Key' => array(...)` パターンから Key 部分を返す。
 */
export function extractTopLevelKeys(arrayBody) {
  const keys = [];
  const re = /['"](\w+)['"]\s*=>/g;
  let depth = 0;
  let lastIdx = 0;

  for (let i = 0; i < arrayBody.length; i += 1) {
    const ch = arrayBody[i];
    if (ch === "(" || ch === "[") {
      depth += 1;
    } else if (ch === ")" || ch === "]") {
      depth -= 1;
    }

    if (depth === 0) {
      const segment = arrayBody.slice(lastIdx, i + 1);
      re.lastIndex = 0;
      const m = re.exec(segment);
      if (m) {
        keys.push(m[1]);
      }
      if (ch === ",") {
        lastIdx = i + 1;
      }
    }
  }

  if (lastIdx < arrayBody.length) {
    const segment = arrayBody.slice(lastIdx);
    re.lastIndex = 0;
    const m = re.exec(segment);
    if (m) {
      keys.push(m[1]);
    }
  }

  return [...new Set(keys)];
}

/**
 * 配列内の文字列値を全抽出する。
 * `$uses = array('Content', 'Title')` → ['Content', 'Title']
 */
export function extractQuotedStrings(arrayBody) {
  const strings = [];
  const re = /['"]([A-Za-z0-9_\/.]+)['"]/g;
  let m;
  while ((m = re.exec(arrayBody)) !== null) {
    strings.push(m[1]);
  }
  return strings;
}

/**
 * CamelCase → snake_case 変換。
 */
export function camelToSnake(name) {
  return name
    .replace(/([A-Z])/g, (_, ch, idx) =>
      idx === 0 ? ch.toLowerCase() : `_${ch.toLowerCase()}`,
    )
    .replace(/__+/g, "_");
}

/**
 * 簡易英語複数形変換。CakePHP 2.x 規約準拠。
 */
export function pluralize(word) {
  if (!word) return word;
  const lower = word.toLowerCase();

  const irregulars = {
    person: "people",
    man: "men",
    child: "children",
    sex: "sexes",
    move: "moves",
    goose: "geese",
    mouse: "mice",
  };
  if (irregulars[lower]) {
    return word[0] === word[0].toUpperCase()
      ? irregulars[lower][0].toUpperCase() + irregulars[lower].slice(1)
      : irregulars[lower];
  }

  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  if (/f$/i.test(word)) return word.slice(0, -1) + "ves";
  if (/fe$/i.test(word)) return word.slice(0, -2) + "ves";
  return `${word}s`;
}
