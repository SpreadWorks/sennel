# Flow 実行機構

このディレクトリには、実行する `Step` の共通契約、`StepResult`、`StepFactory`、`StepConnector`、Flow 固有のエラー情報クラスを置く。Flow 全体の状態遷移規約は親の `src/flow/AGENTS.md` を正とし、ここでは実行機構固有の境界だけを定める。

- `Step` は typed facts を具体的な `StepResult` に変換し、`StepResult.persist(service)` の durable receipt を待ってから `execute()` の結果を返す。永続化エラーは Error Result に変換せず、そのまま送出する。
- `StepResult` は直接生成できない抽象基底とし、Draft の各意味を固定 `kind`・固定 `type`・固定 `stepId` の具体クラスで表現する。復元は一元化した registry で `kind`、class、`type`、`stepId` の一致を検証し、Error Result は `code` と構造化 `data` を保持する。
- `StepFactory` は Step 側の依存宣言に従ってサービスを生成・注入する。Step 固有の依存一覧や成果物の取得・保存処理を Factory に集めない。
- 工程固有の判断と修復候補の計算・採用は該当 Step 配下に置く。Step は Service の構造化入力と保存 API を利用し、dispatcher から保存処理や業務判断の callback を受け取らない。JSON や保存先パスの選択は Service に委ねる。
- Definition は `stepId + StepResult` から一度だけ具体的な Settlement を選ぶ。target connection だけが `StepConnector` を持ち、Execution、Await、Failure に偽の Connector を付けない。
- `StepConnector` は Definition が選んだ target connection の準備・適用を担当する。接続元 Attempt と成果物の版を固定するが、遷移先や成果物の品質は判断しない。
- canonical Store を状態と成果物の唯一の正本とする。Step や Factory は成果物のパスを推測しない。
- Draft／Review などの成果物の読み書き・スキーマ検証は、将来の `src/flow/services/` に置く各サービスが既存の成果物クラスと canonical Store の API を使って担う。サービスはこのディレクトリに置かない。
- `src/flow/lib/` 全体をこのディレクトリへ移す対象とはしない。状態、成果物、遷移判断など責務の異なるコードを一括して収容しない。
