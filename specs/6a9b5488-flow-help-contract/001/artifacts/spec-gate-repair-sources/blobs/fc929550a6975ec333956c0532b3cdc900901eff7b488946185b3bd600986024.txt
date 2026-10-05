/**
 * tools/lib/cli.js
 *
 * repoRoot / parseArgs — 全エントリポイント共通の CLI ユーティリティ。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runCmd, assertOk } from "./process.js";
import { PRODUCT } from "./product.js";

/**
 * sennel パッケージの src/ ディレクトリの絶対パス。
 * lib/ から1階層上が src/ であることを利用して解決する。
 */
export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 作業ルートを返す。
 * SENNEL_WORK_ROOT 環境変数が設定されている場合はそれを使用する（プロジェクトモード）。
 * それ以外は git rev-parse でリポジトリルートを取得し、失敗時は process.cwd() を返す。
 *
 * @returns {string} 作業ルートの絶対パス
 */
export function repoRoot() {
  if (process.env[PRODUCT.env("WORK_ROOT")]) return process.env[PRODUCT.env("WORK_ROOT")];
  // Logger 基盤の依存元のため runCmd を直接使う。runGit に変更してはならない
  // （Logger.git → resolveLogDir → repoRoot → runGit → Logger.git で無限再帰になる）。
  const res = runCmd("git", ["rev-parse", "--show-toplevel"]);
  if (res.ok) return res.stdout.trim();
  // npm パッケージとしてインストールされた場合、相対パス推定は
  // node_modules/ 内部を指すため process.cwd() を使用する
  return process.cwd();
}

/**
 * ソースルートを返す。
 * SENNEL_SOURCE_ROOT 環境変数が設定されている場合はそれを使用する（プロジェクトモード）。
 * それ以外は repoRoot() と同じ値を返す。
 *
 * @returns {string} ソースルートの絶対パス
 */
export function sourceRoot() {
  if (process.env[PRODUCT.env("SOURCE_ROOT")]) return process.env[PRODUCT.env("SOURCE_ROOT")];
  return repoRoot();
}

/**
 * 汎用 CLI パーサー。
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @param {Object}   spec
 * @param {string[]} [spec.flags]    - ブール型フラグ (例: ["--dry-run","--force"])
 * @param {string[]} [spec.options]  - 値付きオプション (例: ["--type","--agent"])
 * @param {string[]} [spec.optionalOptions] - 任意の値を取るオプション (例: ["--reset"])
 * @param {Object}   [spec.aliases]  - 短縮名マップ (例: { "-v": "--verbose" })
 * @param {Object}   [spec.defaults] - デフォルト値
 * @returns {Object} パース済みオプション (help は常に含む)
 */
export function parseArgs(argv, spec) {
  const flags = new Set(spec.flags || []);
  const options = new Set(spec.options || []);
  const optionalOptions = new Set(spec.optionalOptions || []);
  const aliases = spec.aliases || {};
  const opts = { ...spec.defaults, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    let a = argv[i];
    if (a === "--") continue;
    if (a in aliases) a = aliases[a];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (flags.has(a)) {
      opts[flagKey(a)] = true;
      continue;
    }
    if (options.has(a)) {
      const value = argv[i + 1];
      if (value == null || String(value).trim() === "" || String(value).startsWith("-")) {
        throw new Error(`Missing value for option: ${a}`);
      }
      opts[flagKey(a)] = String(value).trim();
      i += 1;
      continue;
    }
    if (optionalOptions.has(a)) {
      const value = argv[i + 1];
      if (value != null && String(value).trim() !== "" && !String(value).startsWith("-")) {
        opts[flagKey(a)] = String(value).trim();
        i += 1;
      } else {
        opts[flagKey(a)] = true;
      }
      continue;
    }
    throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

/**
 * worktree 内で実行されているかを判定する。
 * git worktree では .git がディレクトリではなく `gitdir: ...` を含むファイルになる。
 *
 * @param {string} root - リポジトリルートパス
 * @returns {boolean}
 */
export function isInsideWorktree(root) {
  const dotGit = path.join(root, ".git");
  try {
    return fs.statSync(dotGit).isFile();
  } catch (_) {
    return false;
  }
}

/**
 * worktree からメインリポジトリのパスを取得する。
 * `git rev-parse --git-common-dir` で共有 .git ディレクトリを取得し、その親を返す。
 *
 * @param {string} root - リポジトリルートパス
 * @returns {string} メインリポジトリの絶対パス
 */
export function getMainRepoPath(root) {
  // Logger 基盤の依存元のため runCmd を直接使う。runGit に変更してはならない
  // （Logger.git → resolveLogDir → getMainRepoPath → runGit → Logger.git で無限再帰になる）。
  const res = runCmd("git", ["-C", root, "rev-parse", "--git-common-dir"]);
  if (!res.ok && !(res.status === 0 && res.stdout.trim())) {
    assertOk(res, "failed to resolve git-common-dir");
  }
  const gitCommonDir = res.stdout.trim();
  // git-common-dir は絶対パスまたは root からの相対パスを返す
  const abs = path.resolve(root, gitCommonDir);
  return path.dirname(abs);
}

/**
 * sennel パッケージのバージョン文字列を返す。
 * package.json の読み込みに失敗した場合は "?" を返す。
 *
 * @returns {string}
 */
export function getPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "..", "package.json"), "utf8"));
    return pkg.version;
  } catch (_) {
    return "?";
  }
}

/**
 * UTC タイムスタンプ文字列を生成する。
 *
 * @param {Date} [date] - 日付オブジェクト（省略時は現在時刻）
 * @returns {string} "YYYY-MM-DD HH:MM:SS UTC"
 */
export function formatUTCTimestamp(date) {
  return (date || new Date()).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** --some-flag → someFlag */
function flagKey(flag) {
  return flag.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
