# Core単体の検証コード

このディレクトリには、編集プレビュー用APIとページ再利用の回帰検証を置いています。HTMLとCSSを直接Coreへ渡し、APIの応答、再利用した紙面、原稿位置の対応などを確認します。

## 準備

リポジトリ直下で開発用依存を準備し、Coreをビルドします。ルートの開発用依存にはPlaywright、Coreの開発用依存にはesbuildが含まれています。ルートのモジュール解決からesbuildを利用できる環境で実行してください。

```console
yarn install --frozen-lockfile
npm ci --prefix packages/core --workspaces=false --ignore-scripts
npm run build --prefix packages/core
```

ブラウザを使う検証には、Playwrightが起動できるブラウザを用意します。各スクリプトの指定方法は下表のとおりです。`--browser` はブラウザの実行ファイルへのパス、`PREVIEW_TEST_BROWSER` はPlaywrightのブラウザchannel名です。

## 検証の内容と実行

以下はリポジトリ直下から実行します。

| スクリプト | 確認すること | ブラウザの選択 |
| --- | --- | --- |
| `check-portable-seed.mjs` | seedの書き出し・復元、入力検証、中断、復元後の表示 | `--browser=PATH`。省略時は標準配置のChrome・Edgeを探索 |
| `check-svg-reuse.mjs` | 静的SVGを含む文書の再利用、原稿位置、可搬seed、対象見開き、対象外SVGの除外 | `--browser=PATH`。省略時は標準配置のChrome・Edgeを探索 |
| `check-source-map.mjs` | 原稿位置対応、紙面の保持・複製、seed移送、資源解放 | `--browser=PATH`。省略時は標準配置のChrome・Edgeを探索 |
| `check-page-search.mjs` | ページ開始位置の探索結果と走査の動作 | PlaywrightのChromium |
| `check-preview-diff.mjs` | 空段落の連続追加と通常の本文編集でのノード対応 | `PREVIEW_TEST_BROWSER`。既定は`msedge` |
| `check-viewport-resize.mjs` | 固定した用紙で表示領域の高さを変えたときの再利用と、全文組版との本文・source属性の一致 | PlaywrightのChromium |
| `check-render-cancellation.mjs` | 組版処理の中断、完了通知、その後のロード | PlaywrightのChromium |

```console
node benchmark/check-portable-seed.mjs
node benchmark/check-source-map.mjs --size=4000
node benchmark/check-page-search.mjs
node benchmark/check-preview-diff.mjs
node benchmark/check-viewport-resize.mjs
node benchmark/check-render-cancellation.mjs
```

`check-source-map.mjs` は `--output=PATH` を指定すると、検証結果とCoreビルドのSHA256をJSONに保存します。保存先には、Git管理対象外の `benchmark/results/` を利用できます。

`check-viewport-resize.mjs` は固定した組版viewportを持つHTML入力を使います。`--legacy` を指定するとその指定を外し、再利用の判定を比較できます。

`core-fixture.mjs` は検証用HTMLの生成、`harness/index.html` はブラウザ内の組版と紙面取得を担当します。各スクリプトが表示する所要時間は、その検証実行の補助情報です。

## 関連するテスト

Coreの単体テストは `packages/core/test/` にあります。ページごとの本文の組方向・段数は、次のスクリプトでも確認できます。

```console
node scripts/check-page-content-style.mjs
```

`check-svg-reuse.mjs` は `--output=PATH` で結果を保存できます。検証用依存を別フォルダーに用意している場合は `--modules=PATH` で、そのpackage.jsonがあるディレクトリを指定できます。
