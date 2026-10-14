# プリセット作成ガイド

このドキュメントは、sennel のプリセットを **ビルトイン (`src/presets/<key>/`)** または **プロジェクトローカル (`.sennel/presets/<key>/`)** として新規作成する際の手順書である。spec 191 で導入された DI (Dependency Injection) コンテナ契約に基づいて記述しており、AI エージェントが本ドキュメントだけを読んでプリセットを組み立てられるように、仕様・手順・落とし穴・検証コマンドを網羅している。

対象読者は、sennel 本体のアーキテクチャ (`src/CLAUDE.md` / `src/AGENTS.md`) を把握した上で、新しいフレームワーク・プロジェクト構造に対応するプリセットを作る開発者・AI である。

---

## 1. プリセットとは

プリセットはフレームワーク固有の「スキャン設定 + DataSource + テンプレート」を一束にしたパッケージである。`preset.json` の `parent` フィールドによる **単一継承チェーン** で構成し、子プリセットが親の設定・DataSource・テンプレートを上書きする。

継承チェーンの例:

```
base → webapp → php-webapp → symfony
base → webapp → js-webapp → nextjs
base → cli → node-cli
base → api → graphql
```

`.sennel/config.json` の `type` 配列に複数プリセットを並べると、各プリセットの継承チェーンが **独立に** 解決され、チャプター・DataSource・テンプレートが合成される (プリセット間に parent 関係は不要)。

```json
{ "type": ["spread-commerce", "graphql", "monorepo"] }
```

---

## 2. 作成判断フロー

実装を始める前に以下を確認し、どこにどの種類のプリセットを作るかを決める。

### 2.1 ビルトインか、プロジェクトローカルか

| 条件 | 配置先 |
|---|---|
| 汎用フレームワーク・ライブラリ対応 (再利用される) | `src/presets/<key>/` (ビルトイン) |
| 特定プロジェクトのディレクトリ構造・カスタマイズに特化 | `.sennel/presets/<key>/` (プロジェクトローカル) |

**プロジェクトローカルはリーフ専用**。`parent` チェーンは常にビルトインを使用する。

### 2.2 既存プリセットを継承するか、新規作成するか

1. `src/presets/` に対象フレームワークの親候補があるか確認する (`webapp`, `php-webapp`, `js-webapp`, `symfony`, `laravel`, `cakephp2`, `nextjs`, `hono`, `node-cli`, `database`, `api/graphql` 等)。
2. 最も近いプリセットを `parent` に指定する。近いものがなければ `base` / `webapp` / `cli` 等の上位プリセットから始める。
3. 親プリセットに同名 DataSource・テンプレートがある場合、子で override される (後勝ち)。

---

## 3. ディレクトリ構造

```
<preset-root>/<key>/
├── preset.json              必須: メタデータ・チャプター・scan パターン
├── guardrail.json           任意: スペック／実装ガードレールルール
├── data/                    DataSource モジュール群 (scan と resolve を兼ねる)
│   └── <category>.js        1 ファイル = 1 カテゴリ (default export は register ファクトリ)
├── templates/
│   ├── ja/                  各言語のチャプターテンプレート
│   └── en/
└── tests/                   ビルトインプリセットは必須
    ├── unit/                scan パーサー I/O テスト
    ├── e2e/                 フルスキャンパイプラインテスト
    ├── acceptance/          fixture ベースのアクセプタンステスト
    │   └── test.js
    └── analyzers.js         テスト専用ヘルパー (sennel 内部 import を許可)
```

プロジェクトローカルでは `tests/` は必須ではない。

**注意**: 以前は `scan/` ディレクトリに scan パーサーを分離する構成だったが、現行では廃止されている。scan ロジックは `data/<category>.js` の `Scannable` DataSource に統合する。

---

## 4. preset.json スキーマ

```json
{
  "parent": "symfony",
  "label": "Spread Commerce (EC-CUBE 4.x + Next.js)",
  "aliases": ["eccube"],
  "chapters": [
    { "chapter": "overview.md", "desc": "概要" },
    { "chapter": "controller_routes.md", "desc": "コントローラとルーティング" }
  ],
  "scan": {
    "include": ["src/backend/app/Customize/**/*.php"],
    "exclude": ["src/backend/app/Plugin/*/vendor/**"]
  }
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `parent` | 任意 | 親プリセットの key。省略時は独立プリセット |
| `label` | 推奨 | 表示名 |
| `aliases` | 任意 | `config.json` の `type` に書ける別名 |
| `chapters` | 任意 | チャプターの順序と説明。省略時は親の `chapters` を継承 |
| `scan.include` | 任意 | スキャン対象の glob (POSIX 区切り) |
| `scan.exclude` | 任意 | 除外 glob |

### 4.1 `chapters` の扱い

- `chapters` に宣言したチャプター名は、自プリセットか親プリセットの `templates/<lang>/` に対応ファイルが存在する必要がある (無ければ gate で FAIL)。
- `config.json` の `type` が複数プリセットを並べる場合、チャプター順は **配列の先頭プリセットから union** される。**先頭に最も具体的な (leaf) プリセットを置く** こと。

### 4.2 `scan` パターン

- 区切り文字は `/` 固定 (Windows でも `/`)。
- `**` は任意階層、`*` は 1 階層内の任意文字。
- 親プリセットの `scan` はマージされる (追加方向)。子で除外したい場合は `exclude` に書く。

### 4.3 guardrail.json (任意)

プリセット固有の設計原則・禁止事項を宣言するファイル。Spec-Driven Development フローの `plan.gate` / `impl.review` で AI がチェックに使う。docs 生成パイプラインとは独立。

```json
{
  "guardrails": [
    {
      "id": "use-parameterized-queries",
      "title": "Use Parameterized Queries",
      "body": "DQL and QueryBuilder shall use parameter bindings.",
      "meta": { "phase": ["spec", "impl"] }
    }
  ]
}
```

### 4.4 overrides.json (プロジェクト直下・任意)

`.sennel/overrides.json` に置くプロジェクト全体で 1 つの辞書ファイル。DataSource が返すエントリの説明文を手動で確定したい場合に使う (enrich の AI 生成結果より優先される)。

```json
{
  "tables": { "contents": "コンテンツ (動画エピソード単位)" },
  "controllers": { "UserController": "ユーザー認証・プロフィール管理" }
}
```

---

## 5. DataSource の実装 (DI factory 契約)

### 5.1 register ファクトリ形式 (MUST)

`src/presets/**/data/*.js` および `.sennel/presets/**/data/*.js` の **default export は `register(container)` 形式のファクトリ関数** でなければならない。class 直接 export は許可しない。class を直接 export すると loader はファクトリとして呼び出すため、`new X()` エラーで失敗する。

```javascript
// NG: class を直接 default export する形式は loader に受け付けられない
//     (loader は default export をファクトリ関数として呼び出すため失敗する)

// OK: register factory
export default function register(container) {
  const DataSource = container.get("base.DataSource");
  class FooSource extends DataSource {
    list(analysis, labels) { return null; }
  }
  return FooSource;
}
```

ファクトリ関数は同期で呼ばれ、返り値の Source クラスを loader が `dataSources.<category>` に登録する。

### 5.2 基底クラス・ユーティリティの取得

sennel の基底クラス・ユーティリティは **すべて Container 経由で取得** する。データソース実装のファイル先頭では Node.js 組み込みモジュール (`fs`, `path`, `url`, `crypto`) のみ import でき、sennel 内部への相対 import・bare specifier import は禁止する。

```javascript
import fs from "fs";

export default function register(container) {
  const DataSource = container.get("base.DataSource");
  const Scannable = container.get("base.Scannable");
  const AnalysisEntry = container.get("base.AnalysisEntry");
  const findFiles = container.get("scanner.findFiles");
  const stripBlockComments = container.get("phpParser.stripBlockComments");
  // ...
}
```

### 5.3 親プリセットの資産を継承する

親プリセットの DataSource クラスおよびその `Entry` は Container の preset registry 経由で取得する。loader は親プリセットを先に登録してから子プリセットを登録するため、子プリセットの `register()` では `container.getPreset("<parent>")` が常に解決可能である。

```javascript
export default function register(container) {
  const webapp = container.getPreset("webapp").dataSources;
  const ControllersSource = webapp.controllers;
  const ControllerEntry = ControllersSource.Entry;

  class MyControllersSource extends ControllersSource {
    static Entry = ControllerEntry;
    match(relPath) { return relPath.endsWith("Controller.php"); }
    parse(absPath) {
      const entry = new ControllerEntry();
      // populate entry fields
      return entry;
    }
  }
  return MyControllersSource;
}
```

`WebappDataSource` を継承する場合:

```javascript
export default function register(container) {
  const AnalysisEntry = container.get("base.AnalysisEntry");
  const WebappDataSource = container.getPreset("webapp").dataSources["webapp-data-source"];

  class ViewEntry extends AnalysisEntry {
    viewType = null;
    static summary = {};
  }
  class MyViewsSource extends WebappDataSource {
    static Entry = ViewEntry;
  }
  return MyViewsSource;
}
```

### 5.4 2 種類の DataSource

**(A) Scannable DataSource (scan と data を兼用)**

`match()` でファイルを拾い、`parse()` で解析結果を返す。scan パイプラインが戻り値を `analysis[category].entries` に書き、共通フィールド (`file` / `hash` / `lines` / `mtime`) を自動付与する。resolve メソッド (`list()` 等) で `analysis` を読んで出力する。

`Scannable` は mixin として `base.Scannable` 経由で提供される:

```javascript
export default function register(container) {
  const DataSource = container.get("base.DataSource");
  const Scannable = container.get("base.Scannable");
  class WebappDataSource extends Scannable(DataSource) {}
  return WebappDataSource;
}
```

**(B) Data-only DataSource (他の scan が書いた analysis を読むだけ)**

`match()` / `parse()` を持たず、resolve メソッドのみ実装する。**読む analysis キーを書く scan DataSource がチェーン内に必ず存在する必要がある**。

```javascript
export default function register(container) {
  const DataSource = container.get("base.DataSource");
  class SchemaSource extends DataSource {
    tables(analysis, labels) {
      const tables = analysis.schemas?.tables ?? [];
      if (tables.length === 0) return null;
      // ...
    }
  }
  return SchemaSource;
}
```

### 5.5 `match(relPath)` / `parse(absPath)` の契約

- `match(relPath)`: `relPath` はスキャンルートからの相対パス、区切りは `/`、先頭 `./` なし。戻り値は boolean。
- `parse(absPath)`: 引数は絶対パス。scan パイプラインは各ファイルを 1 回だけ同期ループで `parse` に渡す契約のため、`fs.readFileSync(absPath, "utf8")` で同期読込する (非同期化は scan パイプライン全体の契約変更を伴うため preset 単位では行わない)。戻り値は `new this.constructor.Entry()` か `null`。Entry フィールドは `null` で初期化する。

### 5.6 resolve メソッドの戻り値

戻り値は **`Table` / `MarkdownText` 等のレンダリング可能オブジェクトまたは `null`**。データが無いときは必ず `null` を返す (空テーブルで壊れた表を描かない)。

### 5.7 resolve メソッドの呼び出し規約

テンプレートの `{{data("<preset>.<category>.<method>", {labels: "A|B|C"})}}` は `dataSources.get(category).method(analysis, labels)` を呼ぶ。`labels` は配列 `["A", "B", "C"]` として渡る。カテゴリ名 = `data/<category>.js` のファイル名 (`.js` 抜き)。

---

## 6. import ルール (厳守)

`data/*.js` のファイル先頭に書けるのは **Node.js 組み込みモジュールのみ**:

```javascript
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
```

**禁止事項:**

1. sennel 内部への相対 import (`../../../docs/lib/...`, `../../lib/...`, `../../<sibling-preset>/...`) は禁止。
2. bare specifier (`sennel/api`, `sennel/presets/*` 等) は存在しない (spec 191 で削除済み)。
3. sennel のすべての依存は `register(container)` 関数の内部で `container.get(...)` / `container.getPreset(...)` で取得する。

テスト専用ヘルパー (sennel 内部 import が必要なもの) は `tests/analyzers.js` に分離する (後述 §13.4)。

---

## 7. Container キー一覧

`register(container)` 関数内で取得できる依存は以下のとおり (`src/lib/container.js` の `initContainer()` で登録)。Container は追加のみで拡張される (既存キー不変) ため、新規キー追加でマイナー/パッチが上がっても既存 preset は壊れない。

### 7.1 基底クラス (base)

| キー | 種別 | 用途 |
|---|---|---|
| `base.DataSource` | class | データソース基底クラス (resolve メソッド・helper を持つ) |
| `base.Scannable` | mixin function | scan 能力を付与する (`class X extends Scannable(DataSource)`) |
| `base.AnalysisEntry` | class | scan エントリの基底クラス (`static Entry = ...Entry` に設定するクラスの親) |
| `base.ANALYSIS_META_KEYS` | string[] | Entry の予約メタフィールド名配列 |

### 7.2 scanner ユーティリティ

| キー | 種別 | 用途 |
|---|---|---|
| `scanner.findFiles` | function | glob パターンからファイル一覧を取得 |
| `scanner.collectFiles` | function | 複数 include/exclude をマージしてファイル収集 |
| `scanner.patternToRegex` | function | glob → 正規表現変換 |
| `scanner.parseFile` | function | 拡張子に応じて言語ハンドラの parse を呼ぶ |
| `scanner.parsePHPFile` | function | PHP 固有の parse |
| `scanner.parseJSFile` | function | JS/TS 固有の parse |
| `scanner.camelToSnake` | function | `CamelCase` → `camel_case` 変換 |
| `scanner.pluralize` | function | 英単語の簡易複数形 |
| `scanner.getFileStats` | function | ファイルの行数・ハッシュ等を取得 |

### 7.3 PHP パーサーユーティリティ

| キー | 種別 | 用途 |
|---|---|---|
| `phpParser.stripBlockComments` | function | `/* ... */` コメントを除去 |
| `phpParser.extractArrayBody` | function | `array(...)` の本体文字列を抽出 |
| `phpParser.extractTopLevelKeys` | function | 配列のトップレベルキーを抽出 |
| `phpParser.extractQuotedStrings` | function | クォート文字列を抽出 |

### 7.4 path-match ユーティリティ

| キー | 種別 | 用途 |
|---|---|---|
| `pathMatch.hasPathPrefix` | function | 相対パスの prefix 一致判定 |
| `pathMatch.hasSegmentPath` | function | セグメント単位の含有判定 |
| `pathMatch.hasAnyPathPrefix` | function | 複数 prefix のいずれかに一致するか |

### 7.5 lang / toml / config

| キー | 種別 | 用途 |
|---|---|---|
| `lang.getHandler` | function | 拡張子から言語ハンドラを取得 |
| `toml.parse` | function | TOML テキストを object に解析 |
| `config.loadJsonFile` | function | JSON ファイルを安全にロード (空/欠損で throw しない) |

### 7.6 ランタイムサービス

data source 側で通常は触らないが、一部の高度な resolve では参照する:

| キー | 種別 | 用途 |
|---|---|---|
| `root` | string | プロジェクトルート絶対パス |
| `mainRoot` | string | main リポジトリのパス (worktree 配下でも main 側を指す) |
| `inWorktree` | boolean | worktree 内で実行中か |
| `paths` | object | 絶対パス (root, repositoryRoot, srcRoot, managedDir, outputDir, agentWorkDir, temporaryRoot, logDir, configPath)。agentWorkDir は実行先、temporaryRoot と logDir は独立した一時保存先とログ保存先。 |
| `config` | object | `.sennel/config.json` の読み込み結果 (未初期化時は null) |
| `lang` | string | `config.lang` (ドキュメント言語) |
| `i18n` | function | 翻訳関数 |
| `logger` | Logger | ログ出力 |
| `agent` | Agent | AI エージェント呼び出し |
| `flowManager` | FlowManager | Spec-Driven Development フロー状態管理 |

### 7.7 preset registry

| メソッド | 用途 |
|---|---|
| `container.getPreset("<key>")` | `{ dataSources: { <category>: SourceClass, ... } }` を返す |
| `container.hasPreset("<key>")` | 登録されているか |

子プリセットが親の Source/Entry を継承するときに使う。

---

## 8. 外部配布 preset の互換性 (peerDependencies)

npm パッケージとして配布する外部 preset は、`package.json` の `peerDependencies` のみで sennel との互換性を表現する。Container API に独立した version フィールドは設けない。

```json
{
  "name": "sennel-preset-foo",
  "peerDependencies": {
    "sennel": "^0.1.0-alpha"
  }
}
```

- peerDependencies は **Container キーの互換性** を表す最小バージョン指定である。
- Container は追加のみで拡張される (既存キー不変) ため、マイナー/パッチ更新で既存 preset は壊れない。
- `dependencies` に sennel を入れないこと (本体と重複インストールされ解決が壊れる)。

---

## 9. テンプレートの設計

### 9.1 ディレクティブ一覧

```markdown
<!-- {%extends%} -->                 親テンプレートを継承 (同じファイル名)
<!-- {%extends: layout%} -->         別名で継承
<!-- {%block "name"%} -->...<!-- {%/block%} --> ブロック定義・override

<!-- {{data("<preset>.<category>.<method>", {labels: "A|B|C"})}} -->
<!-- {{/data}} -->

<!-- {{text({prompt: "説明文を書く", mode: "deep"})}} -->
<!-- {{/text}} -->
```

- `{{data}}` と `{{/data}}` は **解決後もファイルに残り**、次回 build の目印になる。
- 空テンプレートファイルは「削除マーク」として親のブロックを消す。

### 9.2 `{{data}}` と `{{text}}` の使い分け

| 条件 | ディレクティブ |
|---|---|
| 正規表現／パーサーで機械的に抽出可能 | `{{data(...)}}` |
| フレームワーク固有すぎて構造化不能 | `{{text(...)}}` |

### 9.3 親テンプレートは `{{text}}`、子が `{{data}}` で override

webapp 等の上位プリセットは `{{text}}` + `{%block%}` で定義し、子プリセットが block override で `{{data}}` に差し替える。

### 9.4 テンプレート解決の優先順位 (高 → 低)

1. プロジェクトローカル `.sennel/templates/<lang>/docs/`
2. プロジェクトローカルプリセット `.sennel/presets/<key>/templates/<lang>/`
3. リーフプリセット `src/presets/<leaf>/templates/<lang>/`
4. 親プリセット (root まで)

---

## 10. MUST: scan と data のペアリング規則

data DataSource が `analysis.X` を読むなら、チェーン内に `X` を書く scan DataSource が必ず存在すること。

```
✅ 正しい:
  scan DataSource "modules" → analysis.modules を書く
  data DataSource modules.list() → analysis.modules を読む

❌ 違反:
  data DataSource schema.tables() → analysis.schemas を読む
  → 対応する scan DataSource が存在しない
```

---

## 11. enrich の制約

enrich フェーズは scan が収集したエントリに `summary` / `chapter` / `role` を付与するのみ。**新しい analysis カテゴリの生成や、scan が見つけていないデータの創出は行わない**。

---

## 12. 実装手順 (トップダウン)

### 12.1 作成順序 (MUST)

**テンプレート → DataSource → scan パーサー** の順で作る。消費者から逆算することで不要なパーサーを書かず、必要なデータの漏れも防ぐ。

### 12.2 ステップバイステップ

1. **preset.json を作る** — `parent` / `scan.include` / `chapters` を最低限定義
2. **config.json の `type` に追加** — leaf を配列先頭に
3. **`sennel docs scan --dry-run` で scan パターン検証**
4. **テンプレートを配置** — まず `{{text}}` だけで骨格を作る
5. **DataSource を 1 つずつ実装** — `register(container)` 形式。追加ごとに `sennel docs scan` を実行し `<category>.entries.length` を確認
6. **テンプレートの該当ブロックを `{{data}}` に差し替える**
7. **`sennel docs build` で全パイプライン確認**
8. **guardrail.json を追加** (build が通ってから改善)
9. **ビルトインプリセットの場合は `tests/` を整備し、`npm test` で整合性を確認**

### 12.3 最小動作セット

```
.sennel/
├── config.json                    # "type": ["mypreset", ...] を追加
└── presets/mypreset/
    ├── preset.json                # {"parent": "webapp", "scan": {"include": ["src/**/*.js"]}}
    └── data/
        └── simple.js
```

```javascript
// data/simple.js
export default function register(container) {
  const AnalysisEntry = container.get("base.AnalysisEntry");
  const WebappDataSource = container.getPreset("webapp").dataSources["webapp-data-source"];

  class SimpleEntry extends AnalysisEntry {
    name = null;
    static summary = {};
  }
  class SimpleSource extends WebappDataSource {
    static Entry = SimpleEntry;
    match(relPath) { return relPath.endsWith(".js"); }
    parse(absPath) {
      const entry = new SimpleEntry();
      entry.name = absPath.split("/").pop();
      return entry;
    }
  }
  return SimpleSource;
}
```

---

## 13. 検証コマンドとテスト

### 13.1 検証コマンド

```bash
sennel docs scan --dry-run         # カテゴリ別エントリ件数 summary
sennel docs scan --stdout          # 全 analysis JSON を標準出力
sennel docs scan                   # 本実行
sennel docs build                  # 全パイプライン
npm test                              # 整合性テスト
npm test -- --preset <key>            # プリセット別
node tests/acceptance/run.js <key>    # acceptance 個別実行
```

### 13.2 テスト構成 (ビルトインプリセット)

- `tests/unit/` — DataSource の `match` / `parse` I/O テスト
- `tests/e2e/` — preset.json の scan 設定検証・フルスキャン
- `tests/acceptance/test.js` — preset ローカル fixture

### 13.3 整合性テスト

`tests/unit/presets/preset-scan-integrity.test.js` が以下を自動検証する:

1. scan パターンを持つプリセットは、チェーン内に scan DataSource を持つ
2. テンプレートの `{{data}}` が参照するメソッドが DataSource に存在する
3. `analysis.X` を読む data DataSource があれば、`X` を書く scan DataSource がチェーン内に存在する

### 13.4 テスト専用ヘルパー (`tests/analyzers.js`)

`data/*.js` では sennel 内部への import が禁止されている (§6)。ユニットテストで「Source の parse が特定の AST を返すこと」のような個別検証を書きたい場合、テスト専用ヘルパーを `tests/analyzers.js` に置き、そこからは自由に sennel 内部モジュールを import してよい。テストファイル (`tests/unit/*.test.js`) はこのヘルパーだけを import し、Source 本体から内部モジュール依存を切り離す。

---

## 14. 落とし穴チェックリスト

### 14.1 JSDoc 内の `*/` がコメントを閉じる

ドキュメントコメントにファイルパスの `*/` を書くとコメントが途中で終わる。

```javascript
/**
 * src/app/Plugin/*/PluginManager.php を解析する。   ← "*/" でコメント終了
 */
```

**対応**: パスのワイルドカードを `{name}` 等に置換する。ESM 検証は `node --input-type=module --check <file>`。

### 14.2 class を直接 default export しない

loader は default export をファクトリ関数として呼び出す。class を直接 default export すると `new X()` 相当の呼び出しとなり "Class constructor X cannot be invoked without 'new'" で失敗する。**必ず `register(container) { return class ... }` の形にする**。

### 14.3 同一 preset 内での自己参照禁止

webapp など親プリセット自身の `data/` 内部では、`container.getPreset("webapp")` による自己参照に依存しない。loader は `readdir` 順にファイルを処理し、自分自身の preset 登録は `data/` 全件処理後である。同一 preset 内の兄弟 Source を継承する場合は、兄弟 Source を定義するファイルを先に配置し、`register(container)` の中で改めて基底クラスから組み立てる。

### 14.4 `chapters` の厳格性

`chapters` で宣言したチャプターは、自プリセットか親プリセットにテンプレートが必要。override しないチャプターは `{%extends%}` で薄いテンプレートを置く。

### 14.5 `[init] ERROR:` は情報メッセージ

`sennel docs init` の `[init] ERROR: N 件のファイルが docs/ に既に存在します` は **failure ではなく情報メッセージ** (`--force` 案内)。exit code で判定する。

### 14.6 ありがちなエラー一覧

| エラー | 原因 |
|---|---|
| `Class constructor X cannot be invoked without 'new'` | class を直接 default export した (register factory にしていない) |
| `Container: dependency not registered: <key>` | Container に未登録のキーを `container.get()` した |
| `Cannot read properties of null (reading 'dataSources')` | `container.getPreset("<key>")` で未登録の preset を参照 |
| `<category>.entries.length === 0` | `match()` が常に false、または `scan.include` 未設定 |
| `Preset not found: <key>` | `config.json` の `type` に未記載 |
| `[data] UNRESOLVED {{data}} in foo.md: <cat>.<sub>.<method>` | DataSource 未存在、または resolve メソッド未定義 |

---

## 15. ビルトインプリセット向けの追加要件

### 15.1 プロジェクト固有情報禁止

`src/presets/` には特定プロジェクトの値 (プロジェクト名・ホスト・ポート・コンテナ名等) を書かない。汎用的な解析ロジックのみ。固有値は `.sennel/config.json` で外部化する。

### 15.2 テスト (MUST)

`tests/unit/` / `tests/e2e/` / `tests/acceptance/test.js` を整備し、`npm test -- --preset <name>` で単独実行できること。

---

## 16. プロジェクトローカルプリセット向けの追加要件

- リーフ専用。`parent` はビルトインキーを指す。
- `preset.json` の省略が可能 (省略時はビルトインのデフォルトを継承)。
- `.sennel/templates/<lang>/docs/` のファイルは最優先 (プリセットテンプレートより強い)。
- `package.json` は不要 (loader は sennel 本体の解決コンテキストを使う)。

---

## 17. AI 向け実行チェックリスト

1. [ ] 対象プロジェクトのディレクトリ構造・フレームワークを把握
2. [ ] 既存プリセットの中で最も近い親を選択
3. [ ] `<preset-root>/<key>/preset.json` を作成
4. [ ] `.sennel/config.json` の `type` 配列先頭に `<key>` を追加
5. [ ] `sennel docs scan --dry-run` でファイル収集確認
6. [ ] `templates/<lang>/` に骨格テンプレート配置 (まず `{{text}}` のみ)
7. [ ] 必要な DataSource を 1 つずつ `register(container)` 形式で実装
8. [ ] `container.get(...)` / `container.getPreset(...).dataSources` で依存取得
9. [ ] class を直接 export していないこと、相対 import がないことを確認
10. [ ] 各 DataSource 追加後に `sennel docs scan` → `analysis.json` 確認
11. [ ] `analysis.X` を読むなら `X` を書く scan がチェーン内にあるか確認
12. [ ] テンプレートの `{{text}}` を段階的に `{{data}}` に差し替え
13. [ ] `sennel docs build` で全パイプライン完走
14. [ ] ビルトインなら `tests/` 整備 → `npm test` で整合性 PASS
15. [ ] 外部配布時は `package.json` の `peerDependencies` に `sennel` を宣言

---

## 18. 参考ファイル

sennel 本体:

| ファイル | 内容 |
|---|---|
| `src/lib/container.js` | Container 実装と `initContainer()` のキー登録 |
| `src/lib/presets.js` | プリセット検出・チェーン解決・loader |
| `src/docs/lib/data-source.js` | `DataSource` 基底クラス |
| `src/docs/lib/scan-source.js` | `Scannable` mixin (`match`, `parse`) |
| `src/docs/lib/analysis-entry.js` | `AnalysisEntry` 基底クラス |
| `src/docs/lib/template-merger.js` | テンプレート継承・ブロックマージ |
| `src/presets/base/data/*.js` | base factory パターンの参考 |
| `src/presets/webapp/data/webapp-data-source.js` | `Scannable(DataSource)` ファクトリの参考 |
| `src/presets/cakephp2/data/*.js` | PHP フレームワーク実装の参考 |

プロジェクトルール:

- `src/CLAUDE.md` / `src/AGENTS.md` — sennel 内部アーキテクチャと MUST ルール
- プロジェクトルート `CLAUDE.md` — `src/` への書き込み禁止事項

## Guardrail Rewrite Rubric

プリセットの guardrail を更新するときは guardrail rewrite rubric を使う。
各 guardrail は named violation、diff-verification condition、severity-policy を明示する。
