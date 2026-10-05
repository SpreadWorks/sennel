/**
 * sennel/docs/lib/scanner.js
 *
 * 汎用ソースコード解析ユーティリティ。
 * ファイル探索・言語別パーサなど、DataSource の scan() で使われる共通機能を提供する。
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getLangHandler } from "./lang-factory.js";
import { globToRegex } from "../../lib/glob.js";
import { DocumentationSourceSelection, isDocumentationScannerExcludedPath } from "./source-selection.js";

// ---------------------------------------------------------------------------
// ファイル探索
// ---------------------------------------------------------------------------

/**
 * glob 風パターンを正規表現に変換する。
 * "*" → 任意文字列。
 */
export function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

/**
 * ファイルの行数・ハッシュ・更新日時を取得する。
 *
 * @param {string} absPath - ファイルの絶対パス
 * @returns {{ lines: number, hash: string, mtime: string }}
 */
export function getFileStats(absPath) {
  const content = fs.readFileSync(absPath, "utf8");
  const stat = fs.statSync(absPath);
  return {
    lines: content.split("\n").length,
    hash: crypto.createHash("md5").update(content).digest("hex"),
    mtime: stat.mtime.toISOString(),
  };
}

/**
 * dir 配下からパターンに一致するファイルを再帰的に探索する。
 */
export function findFiles(baseDir, pattern, excludeList, subDirs) {
  const regex = patternToRegex(pattern);
  const excludeSet = new Set(excludeList || []);
  const results = [];

  function walk(dir, relPrefix) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && subDirs) {
        walk(path.join(dir, entry.name), path.join(relPrefix, entry.name));
      } else if (entry.isFile()) {
        if (regex.test(entry.name) && !excludeSet.has(entry.name)) {
          const absP = path.join(dir, entry.name);
          results.push({
            absPath: absP,
            relPath: path.join(relPrefix, entry.name),
            fileName: entry.name,
            ...getFileStats(absP),
          });
        }
      }
    }
  }

  walk(baseDir, "");
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ---------------------------------------------------------------------------
// 言語別クラス/関数抽出
// ---------------------------------------------------------------------------

/**
 * PHP ファイルからクラス名・親クラス・public メソッド・プロパティを抽出する。
 */
export function parsePHPFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");

  // クラス定義
  const classMatch = content.match(
    /class\s+(\w+)(?:\s+extends\s+(\w+))?/,
  );
  const className = classMatch ? classMatch[1] : path.basename(filePath, ".php");
  const parentClass = classMatch ? classMatch[2] || "" : "";

  // public メソッド
  const methodRegex = /public\s+function\s+(\w+)\s*\(/g;
  const methods = [];
  let m;
  while ((m = methodRegex.exec(content)) !== null) {
    methods.push(m[1]);
  }

  // プロパティ（$var = 'value' / $var = array(...) 形式）
  const properties = {};
  const propRegex =
    /(?:public|protected|private|var)\s+\$(\w+)\s*=\s*(?:(?:'([^']*)'|"([^"]*)")|array\(([^)]*)\)|\[([^\]]*)\])/g;
  let pm;
  while ((pm = propRegex.exec(content)) !== null) {
    const propName = pm[1];
    const strValue = pm[2] || pm[3];
    const arrayContent = pm[4] || pm[5];

    if (strValue !== undefined) {
      properties[propName] = strValue;
    } else if (arrayContent !== undefined) {
      // 配列からクォートされた文字列を抽出
      const items = [];
      const itemRegex = /['"]([^'"]+)['"]/g;
      let im;
      while ((im = itemRegex.exec(arrayContent)) !== null) {
        items.push(im[1]);
      }
      properties[propName] = items;
    }
  }

  // belongsTo / hasMany / hasOne / hasAndBelongsToMany
  const relations = {};
  for (const relType of ["belongsTo", "hasMany", "hasOne", "hasAndBelongsToMany"]) {
    const relRegex = new RegExp(
      `\\$${relType}\\s*=\\s*(?:array\\(([\\s\\S]*?)\\)|\\[([\\s\\S]*?)\\])`,
    );
    const relMatch = content.match(relRegex);
    if (relMatch) {
      const body = relMatch[1] || relMatch[2] || "";
      const keys = [];
      const keyRegex = /['"](\w+)['"]\s*(?:=>|,|\)|\])/g;
      let km;
      while ((km = keyRegex.exec(body)) !== null) {
        keys.push(km[1]);
      }
      if (keys.length > 0) {
        relations[relType] = keys;
      }
    }
  }

  return { className, parentClass, methods, properties, relations, content };
}

/**
 * JS ファイルからエクスポートされた関数/クラスを抽出する。
 */
export function parseJSFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const className = path.basename(filePath, ".js");

  // export function / export class / export default
  const funcRegex =
    /export\s+(?:async\s+)?(?:function|class)\s+(\w+)/g;
  const methods = [];
  let m;
  while ((m = funcRegex.exec(content)) !== null) {
    methods.push(m[1]);
  }

  // function xxx (非 export)
  const localFuncRegex = /^(?:async\s+)?function\s+(\w+)/gm;
  while ((m = localFuncRegex.exec(content)) !== null) {
    if (!methods.includes(m[1])) {
      methods.push(m[1]);
    }
  }

  return { className, parentClass: "", methods, properties: {}, relations: {}, content };
}

/**
 * 拡張子から言語を自動判定してパーサーを選択する。
 * lang-factory 経由で言語ハンドラを取得し、parse を呼ぶ。
 * lang 引数が明示されていれば、それを優先する。
 */
export function parseFile(filePath, lang) {
  // Legacy lang argument support
  if (lang === "php") return parsePHPFile(filePath);
  if (lang === "js") return parseJSFile(filePath);

  const handler = getLangHandler(filePath);
  if (handler?.parse) {
    const content = fs.readFileSync(filePath, "utf8");
    return handler.parse(content, filePath);
  }
  // デフォルト: ファイル名のみ
  return {
    className: path.basename(filePath),
    parentClass: "",
    methods: [],
    properties: {},
    relations: {},
    content: "",
  };
}

// ---------------------------------------------------------------------------
// glob ベースファイル収集
// ---------------------------------------------------------------------------

/**
 * sourceRoot 配下から include/exclude glob パターンに一致するファイルを収集する。
 *
 * @param {string} baseDir - ソースルートの絶対パス
 * @param {DocumentationSourceSelection|string[]} selectionOrInclude - 選択モデルまたはinclude globパターン配列
 * @param {string[]} [exclude] - exclude glob パターン配列
 * @returns {Array<{ absPath: string, relPath: string, fileName: string, hash: string, lines: number, mtime: string }>}
 */
export function collectFiles(baseDir, selectionOrInclude = [], exclude = []) {
  const selection = selectionOrInclude instanceof DocumentationSourceSelection
    ? selectionOrInclude
    : new DocumentationSourceSelection({ include: selectionOrInclude, exclude });
  if (selection.include.length === 0) return [];
  const results = [];

  function walk(dir, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (isDocumentationScannerExcludedPath(nextRel)) continue;
        if (!selection.shouldEnterDirectory(nextRel)) continue;
        walk(path.join(dir, entry.name), nextRel);
      } else if (entry.isFile()) {
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (!selection.matchesFile(relPath)) continue;
        const absPath = path.join(dir, entry.name);
        results.push({
          absPath,
          relPath,
          fileName: entry.name,
          ...getFileStats(absPath),
        });
      }
    }
  }

  walk(baseDir, "");
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

export { camelToSnake, pluralize } from "./php-array-parser.js";
