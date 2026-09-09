# sennel — 内部アーキテクチャとルール

このドキュメントは `src/` 配下のコード（npm パッケージとして配布される）の開発ルールを定義する。

## プロジェクト概要

- **パッケージ:** `sennel`
- **説明:** ソースコード解析に基づくドキュメント自動生成と Spec-Driven Development ワークフローを提供する CLI ツール
- **モジュール形式:** ES Modules (`"type": "module"`)
- **ランタイム:** Node.js >= 18.0.0
- **外部依存:** なし（Node.js 組み込みモジュールのみ）
- **エントリポイント:** `./src/sennel.js`

## ディレクトリ構造

```
src/
├── sennel.js              CLI エントリポイント（トップレベルディスパッチャ）
├── docs.js                   docs ディスパッチャ
├── spec.js                   spec ディスパッチャ
├── flow.js                   flow ディスパッチャ
├── setup.js / upgrade.js / presets-cmd.js / plugin.js / help.js  独立コマンド
├── lib/                      全レイヤー共有ユーティリティ
│   ├── cli.js                repoRoot, sourceRoot, parseArgs, PKG_DIR
│   ├── config.js             .sennel/config.json ローダー
│   ├── agent.js              AI エージェント呼び出し
│   ├── presets.js            プリセット自動探索・親チェーン解決
│   ├── plugin-registry.js    plugin manifest 検証・install/sync・contribution 解決
│   ├── official-plugins.js   公式 preset plugin repository の場所を解決
│   ├── flow-state.js         Spec-Driven Development フロー状態永続化
│   ├── flow-envelope.js      flow get/set/run の JSON envelope
│   ├── git-helpers.js          git/gh 状態取得ヘルパー
│   ├── include.js            include ディレクティブ展開
│   ├── i18n.js               3層 i18n（ドメイン名前空間付き）
│   └── types.js              型エイリアス解決・バリデーション
├── docs/
│   ├── commands/             scan, enrich, init, data, text, readme,
│   │                         forge, review, changelog, agents, translate
│   ├── data/                 共通 DataSource（project, docs, lang, agents）
│   └── lib/                  ドキュメント生成エンジン
├── flow/
│   ├── flow.js              flow ディスパッチャ（get/set/run）
│   ├── registry.js          コマンドメタデータの単一ソース
│   ├── get.js               get サブディスパッチャ
│   ├── set.js               set サブディスパッチャ
│   ├── run.js               run サブディスパッチャ
│   ├── get/                 status, resolve-context, check, prompt, qa-count, guardrail, issue
│   ├── set/                 step, request, issue, note, files, metric
│   ├── run/                 prepare-spec, gate, review, finalize, sync
│   └── commands/            内部ヘルパー（merge, cleanup, review の実体）
├── spec/commands/            init, gate, guardrail（flow/run/prepare-spec, gate が内部で呼ぶ）
├── presets/                  core builtin preset（base のみ）
├── locale/                   en/, ja/
└── templates/
    ├── skills/              skill テンプレート（SKILL.md）
    └── partials/            共有パーツ（include 用）
```

### skill manifest の名前契約

`src/skills/*/SKILL.md` の `name` とディレクトリ名は一致させる。名前は、小文字英数字とハイフンからなる要素をドットで区切った名前空間形式を許可する（例: `sennel.flow-auto`）。ドットなしの hyphen-case 名も有効とする。

スキル変更時は `npm run validate:skills` を実行すること。外部の汎用 skill validator が hyphen-case のみを許可して `sennel.flow` を拒否する場合、その validator は Sennel の名前空間契約と互換性がないため、Sennel skill の合否判定には使用しない。

公式 preset content は main package に同梱しない。公式 plugin source は resolver が検出する実 repository または明示設定された repository とし、migration 完了はその repository の clean な Git HEAD と contribution path で検証する。

## コマンドルーティング

ディスパッチ: `sennel.js` → `docs.js`/`spec.js`/`flow.js` → 各ハンドラ

```
sennel <cmd> [args]
    │
    ├─ sennel.js          # 1. プロジェクトコンテキスト解決 + ディスパッチ
    │   ├─ docs.js           # 2. docs サブコマンドのルーティング
    │   │   └─ docs/commands/*.js   # 3. 実際のコマンド実装
    │   ├─ spec.js           # 2. spec サブコマンドのルーティング
    │   │   └─ spec/commands/*.js
    │   ├─ flow.js           # 2. flow サブディスパッチャ（registry.js 参照）
    │   │   ├─ flow/get.js → flow/get/*.js
    │   │   ├─ flow/set.js → flow/set/*.js
    │   │   └─ flow/run.js → flow/run/*.js
    │   ├─ plugin.js         # plugin repo/package 管理
    │   └─ help.js           # 直接実行
```

`sennel.js` は core command を先に解決する。core に存在しないトップレベル command は、enabled plugin の `contributions.commands` に fallback する。plugin は core command 名を上書きできない。

### プロジェクトコンテキスト

`sennel.js` は実行時に以下の環境変数を設定する:

| 環境変数 | 意味 | 設定元 |
|---|---|---|
| `SENNEL_SOURCE_ROOT` | 対象プロジェクトのソースコードルート | `cli.js` で解決 |
| `SENNEL_WORK_ROOT` | 作業ディレクトリ（`.sennel/`, `docs/` の親） | `cli.js` で解決 |

### flow コマンド返却値方針

flow get/set/run コマンドは「状態クエリ系」と「操作系」の2カテゴリに分類される。

**分類基準**: コマンドの目的が「現在の状態を読み取る」か「状態を変更する/副作用を起こす」か。

| カテゴリ | requiresFlow | flow 不在時の挙動 | エラー方式 |
|---|---|---|---|
| 状態クエリ系 | `false` | `ok:true` + 空状態を返す | — |
| 操作系 | `true` (dispatcher guard) | `Envelope.fail` (NO_FLOW) | ユーザー起因: `Envelope.fail`、内部エラー: `throw` |

- **状態クエリ系** (get-status, get-next-action, get-check 等): `requiresFlow: false`。flow が存在しない場合でも `ok:true` + 意味のある空状態（`{ active: false }`, `{ step: null }` 等）を返す。
- **操作系** (set-step, run-gate, run-finalize 等): `requiresFlow: true`。ユーザー起因の前提条件違反は `Envelope.fail` を return する（`throw` ではない）。内部エラー（agent 呼び出し失敗、JSON パースエラー等）は `throw` のまま（dispatcher の catch-all が `Envelope.fail` にラップ）。
- `requiresFlow` は registry.js のエントリと FlowCommand クラスの両方に設定する。

### flow runtime log

flow commands automatically append visible stdout/stderr to `.tmp/logs/<flowId>.log`; commands without an active flow use `.tmp/logs/no-flow.log`. Use `sennel flow get runtime-log` for flow command failure diagnosis. Explicit shell redirection is only needed for non-flow commands or special cases outside the flow dispatcher.

### Flow 状態遷移の責務境界

**MUST:** `src/flow/`、Flow の状態遷移に関係する `src/lib/`（`flow-manager.js`、`flow-version.js` 等）、または対応するテストを変更する場合は、Flow 状態遷移規約の正本である [`flow/AGENTS.md`](flow/AGENTS.md) を読み、その責務境界、不変条件、検証要件に従うこと。

### flow step 命名規則

`src/flow/definition.js` の leaf step id は **`<phase>-<concern>-<action>`** 規則に従う。step id 単体から所属 phase が読めるようにするための規約であり、**phase 接頭辞は必須（例外なし）**とする。bare な `review` / `gate` / `gate-impl` のような phase 文脈依存の名前は使わない。

| 要素 | 意味 | 値の例 |
|---|---|---|
| `phase` | step が属するフェーズ | `draft`, `spec`, `test`, `impl`, `task` |
| `concern` | 対象とする関心事（省略可能。phase と action だけで一意なら不要） | `questions`, `coverage` |
| `action` | step が行う操作 | `review`, `gate`, `triage`, `repair` |

例: `spec-gate`（spec phase の gate）、`impl-review`（impl phase の review）、`test-review`（test phase の review）、`draft-questions-review`（draft phase の questions に対する review）、`draft-coverage-review`、`impl-gate`、`spec-review`。

衝突しうる concern 名（`review` / `gate-impl` / `impl`）は flow scope では `impl-*` / `spec-gate`、task cursor scope では `task-*` に解決する。alpha 期間は旧 Step 名を受理・変換せず、canonical definition の stable ID だけを扱う。

### ドキュメント生成パイプライン

`sennel docs build` は以下のパイプラインを順に実行する:

```
scan → enrich → init → data → text → readme → agents → [translate]
```

| ステップ | 役割 |
|---|---|
| **scan** | ソースコードをスキャンし analysis.json を生成 |
| **enrich** | AI で analysis エントリーに summary/chapter/role を付与 |
| **init** | テンプレートを継承チェーンでマージし docs/ に出力 |
| **data** | `{{data}}` ディレクティブを analysis データで置換 |
| **text** | `{{text}}` ディレクティブを AI 生成テキストで埋める |
| **readme** | README.md を生成 |
| **agents** | AGENTS.md を生成 |

---

## プリセットシステム

### 概要

プリセットはフレームワーク固有のスキャン設定・DataSource・テンプレートをパッケージ化する。
`parent` フィールドによる単一継承チェーンで構成される。

```
base → webapp → js-webapp → hono
base → webapp → js-webapp → nextjs
base → webapp → php-webapp → cakephp2
base → webapp → php-webapp → laravel
base → webapp → php-webapp → symfony
base → cli → node-cli
base → library
base → database → drizzle
base → edge → workers
base → storage → r2
base → api → rest
base → api → graphql
```

### preset.json の構造

```json
{
  "parent": "webapp",
  "label": "CakePHP 2.x",
  "aliases": [],
  "chapters": ["overview.md", "stack_and_ops.md", ...],
  "scan": {
    "include": ["app/**/*.php"],
    "exclude": ["vendor/**"]
  }
}
```

| フィールド | 説明 |
|---|---|
| `parent` | 親プリセットの key（継承チェーン） |
| `label` | 表示名 |
| `chapters` | このプリセットの章順序（子は親の chapters を上書き） |
| `scan.include` | スキャン対象の glob パターン |
| `scan.exclude` | 除外パターン |

### プリセットディレクトリ構成

```
presets/<key>/
├── preset.json              プリセット定義
├── data/                    DataSource クラス群（scan + resolve を兼ねる）
│   ├── config.js            設定解析
│   ├── controllers.js       コントローラ解析
│   └── ...
├── tests/                   プリセット固有テスト
│   ├── unit/                ユニットテスト（DataSource の match/parse I/O テスト等）
│   ├── e2e/                 E2E テスト（統合スキャンテスト等）
│   └── acceptance/          acceptance テスト（preset ローカル fixture + test.js）
└── templates/               章テンプレート
    ├── ja/
    │   ├── overview.md
    │   ├── stack_and_ops.md
    │   └── ...
    └── en/
        └── ...
```

---

## プリセット作成ルール

### MUST: プリセット作成ガイドとの同期

プリセットの仕様・作成手順・契約（`preset.json` スキーマ、DataSource のインターフェース、`match()` / `parse()` の引数契約、resolve メソッドの戻り値型、import ルール、テンプレートディレクティブ、scan/data ペアリング規則等）を変更した場合、**`.sennel/templates/*/docs/creating_presets.md`（全言語）を同じコミット内で必ず更新すること。**

対象となる変更の例:

- Container が preset 向けに公開する基底クラス (`base.DataSource`, `base.Scannable`, `base.AnalysisEntry` 等) の追加・削除・シグネチャ変更
- `package.json` の `exports` 変更
- `DataSource` / `Scannable` / `AnalysisEntry` / `Table` / `MarkdownText` のインターフェース変更
- `preset.json` スキーマの追加・変更
- `data/` loader のロード規約変更
- テンプレートディレクティブ（`{%extends%}`, `{%block%}`, `{{data}}`, `{{text}}`）の文法・挙動変更
- プリセット作成手順・MUST ルールの追加・変更

### MUST: preset エントリはファクトリ形式 (spec 191)

`src/presets/**/data/*.js` の default export は `register(container)` 形式のファクトリ関数でなければならない。class 直接 export は許可しない。

```js
// NG: class を直接 export（読み込み時に import 解決が走るため sennel 内部への相対 import が必要になる）
import { DataSource } from "../../../docs/lib/data-source.js";
export default class FooSource extends DataSource { ... }

// OK: register factory — 依存は container 引数から取得
export default function register(container) {
  const DataSource = container.get("base.DataSource");
  class FooSource extends DataSource { ... }
  return FooSource;
}
```

Top-level には Node.js 組み込み (`fs`, `path`, `url`, `crypto` 等) のみ import 可能。`../../../docs/`, `../../lib/`, `../../<sibling-preset>/` への相対 import は禁止。

親 preset のクラスを継承する場合は `container.getPreset("<parent>").dataSources.<name>` で取得する。`static Entry = ...Entry` を子が再利用する場合は `ParentSource.Entry` でアクセスする。

### 外部 preset のバージョン整合 (spec 191: R7)

外部 preset (npm パッケージとして配布される sennel 互換 preset) は `package.json` の `peerDependencies` のみを用いて sennel との互換性を表現する。

```json
{
  "name": "sennel-preset-foo",
  "peerDependencies": {
    "sennel": "^0.1.0-alpha"
  }
}
```

Container API に独立した version フィールドは設けない。外部 preset 側は peerDependencies で必要な sennel の最小バージョン (Container キーの互換性を表す) を指定する。Container は追加のみ (既存キー不変) で拡張されるため、マイナー/パッチ更新で既存 preset が壊れない構造を維持する。

本ガイドは AI エージェントがプリセットを作成する際の単一の参照ドキュメントである。**ガイドが実装とズレるとプリセット作成が破綻する**ため、実装変更と文書更新を同一 PR で行うこと。別 PR に分割してはならない。

### MUST: プリセット作成手順（トップダウン設計）

プリセットの構成要素は以下の順序で作成すること:

1. **テンプレート** (`templates/`) — どんなドキュメントを出力するか定義する
2. **DataSource** (`data/`) — テンプレートが必要とするデータを `Scannable` DataSource の `match` / `parse` / `scan` で収集し、resolve メソッドで提供する

消費者（テンプレート）→ 生産者（DataSource）の順に作ることで、不要な解析を書かず、必要なデータの漏れがなくなる。scan 処理は独立した `scan/` ディレクトリではなく DataSource クラス自身が `Scannable` mixin 経由で担う。

### MUST: プリセットテストの作成

プリセットは `tests/` ディレクトリを含むこと。

- root `tests/unit/presets/<name>/` — DataSource の `match` / `parse` I/O テスト。最小限の fixture を作成し、入出力を検証する
- root `tests/integration/` — preset.json の scan 設定やフルスキャンなどの filesystem 境界シナリオ
- `tests/acceptance/*.acceptance.test.js` — preset ローカル fixture を使う deterministic acceptance テスト。共有処理は root `tests/acceptance/lib/` を使う
- テンプレートを作成・変更した場合は acceptance テストも実装し、実行すること
- `npm test -- --preset <name>` で preset の acceptance を含む suite を個別実行できること
- テストファイルは npm パッケージには含まれない（package.json の `files` で除外済み）

### MUST: scan DataSource と data DataSource の対応

**data DataSource が `analysis.X` を読むなら、チェーン内に `X` を書く scan DataSource が必要。**

- scan DataSource は `match(file)` + `scan(files)` メソッドを持ち、ファイルを解析して `analysis[name]` に書き込む
- data DataSource は `analysis[key]` を読んでマークダウンテーブルを生成する
- この2つは対であるべき
- scan DataSource を実装できるなら実装する（フレームワーク固有の scan は子プリセットで実装する）
- scan DataSource を実装できない場合は、data DataSource も作ってはならない。テンプレートは `{{text}}` にする
- **data DataSource だけが存在し、対応する scan DataSource がない状態はルール違反**

```
✅ 正しい例:
  scan DataSource "modules" → analysis.modules に書き込む
  data DataSource modules.list() → analysis.modules を読む

❌ 間違い:
  data DataSource schema.tables() → analysis.schemas を読む
  → analysis.schemas を書く scan DataSource がどこにもない
```

### MUST: `{{data}}` と `{{text}}` の使い分け

| 条件 | ディレクティブ |
|---|---|
| scan で構造的に収集できるデータ | `{{data("preset.source.method")}}` |
| scan で収集不可（フレームワーク固有すぎる） | `{{text({prompt: "..."})}}` |

**判断基準**: そのデータを正規表現やパーサーで機械的に抽出できるか？
- YES → `{{data}}`（テーブル形式で正確なデータを提供）
- NO → `{{text}}`（AI がソースコードと analysis コンテキストから文章を生成）

### MUST: 親テンプレートは `{{text}}`、子が `{{data}}` で override

フレームワーク固有のデータを表示する箇所は、親（webapp 等）テンプレートでは `{{text}}` + `{%block%}` で定義し、子プリセットが block override で `{{data}}` に差し替える。

```markdown
<!-- webapp/templates/ja/auth_and_session.md -->
<!-- {%block "auth_config"%} -->
<!-- {{text({prompt: "認証設定を説明してください。"})}} -->
<!-- {{/text}} -->
<!-- {%/block%} -->
```

```markdown
<!-- cakephp2/templates/ja/auth_and_session.md -->
<!-- {%extends%} -->
<!-- {%block "auth_config"%} -->
<!-- {{data("cakephp2.config.auth", {labels: "項目|内容"})}} -->
<!-- {{/data}} -->
<!-- {%/block%} -->
```

これにより:
- webapp 単体: AI が文章を生成（scan データがなくても動く）
- cakephp2: scan データから正確なテーブルを出力
- 将来のプリセット: override テンプレートを追加するだけ

### MUST: enrich は静的収集データの加工に留める

enrich フェーズは scan が収集したエントリーへのメタデータ付与（summary, chapter, role）のみを行う。
新しい analysis カテゴリの生成や、scan が見つけていないデータの創出は行わない。

### DataSource の2種類

**1. Scannable DataSource（scan + data 兼用）**

```javascript
import { Scannable } from "../../../docs/lib/scan-source.js";
import { DataSource } from "../../../docs/lib/data-source.js";

export default class ModulesSource extends Scannable(DataSource) {
  match(file) { return file.ext === ".js"; }
  scan(files) { return { modules: [...], summary: { total: files.length } }; }
  list(analysis, labels) { /* analysis.modules を読んでテーブル生成 */ }
}
```

- `match(file)`: このソースが処理すべきファイルか判定
- `scan(files)`: マッチしたファイルを解析し、analysis に書き込むデータを返す
- その他メソッド: data コマンドで呼ばれ、analysis を読んでマークダウンを返す

**2. Data-only DataSource（data 専用）**

```javascript
import { DataSource } from "../../../docs/lib/data-source.js";

export default class SchemaSource extends DataSource {
  tables(analysis, labels) { /* analysis.schemas.tables を読んでテーブル生成 */ }
}
```

- `scan()` / `match()` を持たない
- analysis にデータがあれば動作する（なければ null を返す）
- **MUST**: このパターンを使う場合、読む analysis キーを書く scan DataSource がチェーン内に存在する必要がある。対応する scan がないなら data DataSource を作ってはならない

### DataSource メソッドの戻り値型（設計方針）

DataSource の resolve メソッド（`list()` / `tables()` 等、テンプレートから `{{data}}` で呼ばれるメソッド）の戻り値は、**レンダリング可能な値クラスのインスタンスまたは null** とする。生の Markdown 文字列を返してはならない。

プロジェクトは TypeScript を採用しないため、値の構造は OOP（クラス）で表現する（プロジェクト `CLAUDE.md` の「OOP による型表現」を参照）。戻り値には以下の専用クラスを用いる。

- `Table` — 表形式データ（labels と rows を保持、列数の整合を invariant として強制）
- `MarkdownText` — そのまま埋め込む Markdown 断片
- （必要に応じて）`BulletList` / `Heading` 等の追加クラス

```javascript
import { Table } from "../../../docs/lib/renderable.js";

export default class RoutesSource extends DataSource {
  list(analysis, labels) {
    const routes = analysis.routes?.entries || [];
    if (routes.length === 0) return null;
    const rows = routes.map(r => [r.pattern, r.controller, r.action]);
    return new Table(labels, rows);
  }
}
```

**利点**:

- コンストラクタで invariant を強制（例: Table は列数一致、labels 非空）
- `instanceof` による確実な型判別
- `toMarkdown()` を型に所属させることで、出力形式の拡張（将来の `toHtml()` 等）が Open/Closed に従う
- テンプレート展開層は `result.toMarkdown()` をポリモルフィックに呼ぶだけで済む
- オブジェクトリテラル（`{ type: "table", ... }`）のような discriminated union もどきは採用しない

**禁止事項**:

- 基底 `DataSource` の `toMarkdownTable()` のような Markdown 文字列生成ヘルパーを新設してはならない（既存のものは `Table` クラスへの段階移行対象）
- 戻り値として生の文字列を返してはならない。構造が単なるテキストなら `MarkdownText` でラップする

---

## テンプレート構文

### ディレクティブ

**出力ディレクティブ** (`{{ }}`):

```html
<!-- {{data("preset.source.method", {labels: "ヘッダ1|ヘッダ2"})}} -->
<!-- {{/data}} -->

<!-- {{text({prompt: "説明を書いてください。", mode: "deep"})}} -->
<!-- {{/text}} -->
```

**制御ディレクティブ** (`{% %}`):

```html
<!-- {%extends "layout"%} -->

<!-- {%block "content"%} -->
...
<!-- {%/block%} -->
```

### テンプレート継承

`{%extends%}` で親テンプレートのブロックを継承・上書きする。

```
layout.md（レイアウト）
  └─ overview.md（{%extends "layout"%} で継承）
       └─ cakephp2/overview.md（{%extends%} で override）
```

**layout.md のナビゲーション**: layout を extends するテンプレートは自動的にナビゲーション（前後章リンク）が付与される。extends しないテンプレートにはナビが付かない。

### block のネスト

block は入れ子にできる。親ブロック内にネストされたブロックは、子テンプレートで個別に override 可能。

```markdown
<!-- {%block "content"%} -->
## 見出し
<!-- {%block "section_a"%} -->
セクション A の内容
<!-- {%/block%} -->
<!-- {%block "section_b"%} -->
セクション B の内容
<!-- {%/block%} -->
<!-- {%/block%} -->
```

---

## 言語ハンドラ（Factory パターン）

### 概要

言語固有の処理（パース、minify、imports/exports 抽出）は `src/docs/lib/lang/` 配下の言語ハンドラに集約される。
`lang-factory.js` の `getLangHandler(filePath)` がファイル拡張子からハンドラを返す。

### ファイル構成

```
src/docs/lib/
├── lang-factory.js          Factory（拡張子→ハンドラ）
└── lang/
    ├── js.js                JS/TS ハンドラ
    ├── php.js               PHP ハンドラ
    ├── py.js                Python ハンドラ（minify のみ）
    └── yaml.js              YAML ハンドラ（minify のみ）
```

### インターフェース

各言語ハンドラは以下のメソッドを export する。全メソッドの実装は任意。

| メソッド | 引数 | 戻り値 | 用途 |
|----------|------|--------|------|
| `parse(content, filePath)` | ソースコード文字列, パス | `{ className, parentClass, methods, properties, relations, content }` | scan 時のファイル解析 |
| `minify(content)` | ソースコード文字列 | 圧縮されたコード | text deep モードのトークン削減 |
| `extractImports(content)` | ソースコード文字列 | `string[]` 依存先パス/名前の配列 | 構造情報抽出 |
| `extractExports(content)` | ソースコード文字列 | `string[]` 公開名の配列 | 構造情報抽出 |

### 新しい言語の追加手順

1. `src/docs/lib/lang/<ext>.js` を作成し、必要なメソッドを export する
2. `src/docs/lib/lang-factory.js` の `EXT_MAP` に拡張子→ハンドラの対応を追加する
3. テストを追加する

### 呼び出し元

- `scanner.js` `parseFile()` — parse を呼ぶ
- `minify.js` `minify()` — minify を呼ぶ
- 各プリセットの DataSource `parse()` — extractImports/extractExports を呼ぶ

---

## コーディングルール

### プロジェクト固有情報の埋め込み禁止

`src/` 配下のコードおよびテンプレートに、特定プロジェクトの情報を直接書いてはならない。

- **禁止**: プロジェクト名、ホスト名、ポート番号、コンテナ名、固有 DB 名
- **許可**: `presets/` 配下のフレームワーク固有ロジック（汎用的な解析パターン）
- **設定**: プロジェクト固有の値は `.sennel/config.json` で外部化する

### 外部依存の禁止

Node.js 組み込み API (`fs`, `path`, `child_process`, `url` 等) のみを使用する。
npm パッケージへの依存を追加しないこと。

### ロックの責務境界

- **MUST: ファイルの相互排他で競合の解消を待つ場合は `lib/file-lock.js` の `FileLock` を使用し、待機方針はコンストラクタに渡す `FileLockWaitPolicy` で指定すること。** 同期・非同期とも、利用側にロック取得の独自リトライ、sleep、経過時間・タイムアウト判定を追加してはならない。
- **MUST: プロセス所有権の競合を待たずに拒否する場合は `lib/process-lock.js` の `ProcessLock` を使用すること。** 競合を捕捉して利用側で待機することで、その契約を変更してはならない。
- 所有者の生存判定、stale 回収、所有権の公開・解放は共通ロック層に委譲し、利用側で再実装しない。unknown、corrupt、権限・遷移の失敗を通常の競合として待機・再試行してはならない。待機は既定の有限時間を基本とし、無期限待機が要件である場合だけ `FileLockWaitPolicy` に `Infinity` を明示する。

### フォールバック値の抑制

必須の設定値・環境変数が不足している場合は、黙ってデフォルト値で動作させず、エラーメッセージを出力して停止すること。

### コマンドファイルの構造

`commands/` 配下のファイルは以下のパターンに従う:

```javascript
import { runIfDirect } from "../../lib/entrypoint.js";
import { parseArgs } from "../../lib/cli.js";
import { resolveCommandContext } from "../lib/command-context.js";

async function main(ctx) {
  if (!ctx) {
    const cli = parseArgs(process.argv.slice(2), { ... });
    if (cli.help) { printHelp(); return; }
    ctx = resolveCommandContext(cli);
  }
  // 実装
}

export { main };
runIfDirect(import.meta.url, main);
```

### AI エージェント呼び出し (`lib/agent.js`)

**MUST: AI を実行するすべての呼び出し箇所は、config から provider/profile を変更できる設定キーを持つこと。** 新しい AI 呼び出しを追加する場合、コード内に特定 provider/model を固定してはならない。core command は既存の `agent.profiles` / command id 解決に乗せ、plugin command/hook は `plugin.config.<pluginId>.agent.<name>` の override を解決できる public API 経由で呼び出すこと。未設定時だけ通常の agent default にフォールバックする。

**非同期呼び出しで `execFile` を使ってはならない。**

`child_process.spawn` を使い、`stdio: ["ignore", "pipe", "pipe"]` を明示する。
`execFile` は stdin を pipe モードで開くが、Claude CLI は stdin が pipe だと EOF を待ち続けてハングする。

```javascript
// NG: execFile — stdin が pipe のままでハングする
execFile("claude", args, opts, callback);

// OK: spawn — stdin を ignore で閉じる
const child = spawn("claude", args, {
  stdio: ["ignore", "pipe", "pipe"],
  ...opts,
});
```

### Provider の builtin profile: CLI フラグは args に literal 記述

**Provider クラスの `builtinProfiles()` が返す `args` 配列には、必要な CLI フラグを literal に含めること。** `Agent._buildInvocation` はユーザー config の profile を literal に解釈し、JSON 出力フラグ等の暗黙注入は一切行わない。

- JSON 出力フラグ（例: `--output-format json` for claude, `--json` for codex）は builtin profile の args に直接書く
- ランタイムで値が決まるフラグ（例: workDir の `-C <path>`）のみ `Agent._buildInvocation` が自動注入する（`provider.workDirFlag()` + `paths.agentWorkDir`）
- CLI フラグ名が将来変更されても、ユーザーは config.agent.providers で独自 profile を定義すれば対応可能

**禁止:** Provider に `jsonFlag()` 相当のメソッドを追加し、それを Agent 側で自動注入する設計。config で上書きできない隠し動作となり、CLI フラグ名変更時に code 修正が必須となる。

**`jsonOutputFlag` プロパティ（出力パース分岐の宣言）:** builtin profile および config.agent.providers の各 profile エントリには `jsonOutputFlag` (string, optional) を設定できる。このプロパティは args への注入には使用しない。agent.js が stdout を provider.parse() に渡すかどうかの分岐判定にのみ使用する。jsonOutputFlag が設定された profile は JSON パースを行い usage メトリクスを取得する。未設定の profile は plain text として扱い `{ text, usage: null }` を返す。

---

## テスト

### プリセット整合性テスト

`tests/unit/presets/preset-scan-integrity.test.js` が以下を自動検証する:

1. **scan パターンと scan DataSource の整合性** — preset.json に scan.include を定義しているプリセットは、チェーン内に scan DataSource を持つ
2. **テンプレートの data ディレクティブと DataSource メソッドの整合性** — `{{data("preset.source.method")}}` が参照するメソッドが DataSource に存在する
3. **analysis キーのカバレッジ** — data DataSource が `analysis.X` を読むなら、`X` を書く scan DataSource がプリセットエコシステム内に存在する

**新しいプリセットを追加・変更したら `npm test` を実行し、整合性テストがパスすることを確認すること。**

### プリセット固有テスト

プリセット固有テストの配置ルールとテスト内容は「プリセット作成ルール > MUST: プリセットテストの作成」を参照。

**プリセット毎のテスト実行:**

```bash
npm test -- --preset laravel    # tests/unit + tests/e2e + src/presets/laravel/tests/
npm test -- --preset symfony    # tests/unit + tests/e2e + src/presets/symfony/tests/
```

### テストルール

- テストを通すためにテストコードを修正してはならない
- テスト失敗時はまずシナリオの妥当性を確認し、妥当であればプロダクトコードを修正する
