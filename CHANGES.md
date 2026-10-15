# Vivliostyle Core fork の変更内容

この文書は、Vivliostyle Core 2.45.2 を起点にしたforkの、Core単体の変更内容と公開APIを説明します。起点の上流コミットは `a90d13def0817ef4c67a6780cdbad80e460068db`、パッケージ名は `@vivliostyle/core`、パッケージの版は `2.45.2-ogenkou.1` です。Gitのsubmoduleからソースを取得し、ローカルでビルドして利用します。各パッケージには `private: true` を設定しています。記述は2026-10-15時点の実装に合わせています。

性能比較で基準にしたCore 2.45.1（`13d0a9c4918cb91b97ff0253d2da5f0d2dc9de98`）は、比較用に選んだ版です。各測定の条件と使用したビルドは、測定結果に付属する環境情報で確認できます。

変更対象は主に `packages/core/` です。HTMLとCSSによる組版を維持しながら、編集中の原稿を入力する入口、ページの再利用、対象紙面までの部分組版、別の表示環境への紙面と組版状態の移送を追加しました。入力形式からHTMLへの変換、原稿ファイルの管理、編集の集約、実行環境の配置・通信・表示切替は利用側が担当します。エディタやアプリケーションは、これらのAPIを組み合わせてプレビューを構成できます。

## 目的と基本的な考え方

エディタのプレビューでは、全文を確定する作業と、今見たい紙面を更新する作業に異なる役割があります。毎回全文の完成を待つと、長い原稿の入力に表示が追いつきません。

このforkでは、前回の完成結果を再利用しながら全文を更新する経路と、必要な紙面が完成したところで止まる経路を用意しました。部分組版でも、ページを独立して組むわけではありません。変更前の安全なページを再利用し、その続きから順に組版して対象へ到達します。前方に再利用できない変更がある場合や、後方のページ番号の確定が必要な場合には、長い組版が必要になります。

ここでいう「完成」には、次の二つがあります。

- **全文完成**：そのrevisionの全ページが組み終わり、必要なページ参照の解決も終わった状態。次回の再利用元として扱います。
- **対象紙面の完成**：指定した原稿位置を含む単ページ、または見開きが完成した状態。

紙面を複製・移送する際には、組版の完了に加えて画像等のリソースの準備を待ちます。待機用APIで画像のsrc等が設定されたことを確認してから、紙面DOMを複製します。

## ページごとの本文の組方向・段数

通常の `@page` の `writing-mode` はページの文脈を指定し、本文の組方向は文書ルートに従います。この既存の扱いを維持しつつ、名前付きページ等で本文領域だけを切り替える指定を追加しました。

```css
@page contents {
  --vivliostyle-page-content-writing-mode: horizontal-tb;
  --vivliostyle-page-content-column-count: 1;
}
nav[role="doc-toc"] {
  page: contents;
  writing-mode: horizontal-tb;
  break-before: page;
  break-after: page;
}
```

これにより、縦書き・複数段の本文に、複数ページへ続く横書き一段組みの目次を挿入できます。要素側の `writing-mode` も指定して本文の文字方向を合わせます。文書全体のページ送り方向や、他のページの組方向・段数は変えません。

組方向は `horizontal-tb` / `vertical-rl` / `vertical-lr`、段数は1〜100の整数リテラルを受け付けます。未指定・不正な値は文書ルートの指定に従います。`var()` 等による間接指定はここでは扱いません。可搬seedの互換性判定には、この指定を含むCSS条件をそろえます。

## 追加した機能

### 1. メモリ上の原稿と資源の入力

`loadMemoryDocument()` と `refreshMemoryDocument()` で、HTML文字列とCSS・画像・font等の資源を直接渡せます。リソースは文字列、Blob、ArrayBufferで渡し、Core内で読めるURLへ変換します。

```ts
type MemoryDocumentSource = {
  url: string; // 相対URLの基準にもなる、原稿の安定した絶対URL
  html: string;
  revision?: number; // 呼び出し元が管理する原稿の版
  sourceMap?: readonly SourceTextEntry[];
  resources?: readonly MemoryResource[];
};

type MemoryResource = {
  url: string; // 原稿URLからの相対URL、または絶対URL
  content: string | Blob | ArrayBuffer;
  mediaType?: string;
};
```

メモリ入力の `revision` は非同期応答の照合と全文完成の管理に使います。位置対応を登録する場合は必須です。リソースを固定して組版する場合は、利用側で先に内容を収集し、`resources` として渡します。

### 2. ページの再利用

更新前後の原稿DOMを照合し、CSS、ページの境界、counter、組版再開位置等の状態から再利用できる範囲を判定します。変更箇所より前の安全なページ（prefix）を使い、変更部分以降を組み直します。後続の組版状態が一致すれば、その後のページ（suffix）も再利用できます。

ただし、柱やページ参照の依存がある場合にはsuffixの採用を止めるなど、機能ごとに保守的な制限があります。見た目や本文文字列だけの一致で紙面を採用しません。同じ空段落の連続追加でも、前方の確定した対応を後方照合で上書きせず、追加した行を飛び越えないようにしています。

本文だけを更新して全文を確定する場合は、`renderAllPages: false`、`paginationMode: "complete"` と `reusePages: true` を組み合わせます。`renderAllPages: true` は再利用を無効にする既存仕様です。CSS・font・用紙条件・資源の内容が変わった場合は、再利用元の互換性を見直して全再組版へ戻します。

### 3. 対象紙面までの組版と見開きの選択

`paginationMode: "target-display-unit"` は、`fragment` 等で指定した対象の紙面が完成すると組版を終了します。`focusedDisplayMode: "singlePage" | "spread"` をDocumentOptionsへ渡すと、対象の単ページまたは隣接する見開きを選べます。見開きでは必要な隣ページも組み、左右両紙面を保持・資源待ち・位置対応の対象にします。文書の境界では片側だけの場合もあります。

`focusedDisplayMode` は表示する紙面の選択であり、`pageViewMode` による組版viewportやspreadView preferenceを変更しません。この分離により、単ページ条件で作ったseedを見開きの部分組版でも再利用できます。seedの設定・viewport一致検査は維持しています。

指定しない場合は従来の `pageViewMode` に従います。`paginationMode: "complete"` では `focusedDisplayMode` を無視します。通常の `pageViewMode` 自体は引き続き組版条件に作用するため、再利用するViewer同士で条件をそろえてください。

### 4. 組版再開用のseedと完成紙面を別々に移送

別rendererへ渡すデータには、二つの用途があります。

| データ | 用途 | 受信側の作業 |
| --- | --- | --- |
| `PortablePreviewSeed` | 次の組版の再利用元。原稿、紙面、再開位置、counter、対応する参照状態を含む | 専用donor Viewerで原稿・CSS・fontを準備して状態を復元し、部分組版用Viewerへローカルseedを渡す |
| `CompletedPaperPacket` | 全文完成した紙面の表示。組版再開状態を含まない | `CompletedPaperHost` でCSS環境と紙面を復元し、選んだページを表示する。紙面の再組版は行わない |

ローカルの `PreviewSnapshotSeed` はDOM参照を含み、そのままプロセス間では渡せません。可搬seedはDOM参照や関数を含まない形式 `vivliostyle-portable-body-v1` に変換し、`postMessage` / `structuredClone` で渡せます。復元の既定経路は、初期化のためだけの一ページ組版を省略します。原稿解析やCSS・fontの準備は必要です。

可搬seedは明示的revisionを持つ単一文書の全文完成済みbody-flowを対象とし、安全な再開状態を復元できない構成を拒否します。完成紙面packetはこの再開条件を必要としないため、seedが未対応の作品でも、全文完成結果を表示できます。

どちらも、同じCoreビルドが生成した信頼済みデータを対象とします。`compatibilityKey` にCoreビルド、CSS、font、資源内容等の同一性を含めるのは利用側の責務です。Coreは形式、key、紙面条件、ソース対応、復元状態を追加検証します。外部HTMLを無害化する機能ではありません。

### 5. 原稿位置対応と表示紙面の保持

`sourceMap` に、解析済みHTMLのTextNodeのpath、生成元キー、正確なテキストを登録します。Coreは紙面上のTextNodeから `{ revision, key, offset, kind }` を返せます。offsetは生成元テキスト内のUTF-16位置であり、MarkdownやHTML文字列全体のindexではありません。

対応はページ分割、テキストの分割、ページ再利用、seed移送、保持紙面の複製へ引き継ぎます。各文字をspan化しません。kindは `text` / `ruby-base` / `ruby-reading` / `generated`。Coreが挿入したハイフン等はgeneratedとして元の境界へ対応づけます。原稿URIへの変換、ルビの本文への対応、旧revisionの位置を最新原稿へ補正する処理は利用側に残ります。

保持APIが返す `SourceMappedPresentation` は、紙面DOMと位置対応を組版Viewerの次の更新から独立させます。普通の `cloneNode` / `importNode` では位置対応を引き継げないため、このAPIを使います。複雑な疑似要素・first-letter・shadow処理等を含むすべての表示文字の逆引きを保証するものではありません。

## 現在の再利用範囲とフォールバック

以下は可搬seedを使った再利用の範囲です。通常組版でこれらのCSS機能を削除したという意味ではありません。

| 構成 | 現在の扱い |
| --- | --- |
| 通常本文、現在ページの `counter(page)`、固定文字列の柱 | 安全なページ境界と設定の一致を確認して再利用 |
| 見出し連動の `string-set` と `string(name, first/start/last/first-except)` | prefix再利用に対応。新原稿のcascadeで値・位置を再構築し、代入値の変更も照合。named string使用時のsuffix採用は無効 |
| 本文の `target-counter(..., page)` による目次・ページ参照 | 参照状態をseedへ移送。変更suffixの参照先を再解決し、必要な参照元ページを既存resolverで再組版。参照先削除時はprefixを短縮。参照付きsuffix採用は無効 |
| 固定したbytesから作ったdata URLの `img`（srcsetなし） | prefix再利用の対象。資源内容の変更で互換キーを変える |
| Blob URL・外部URL・srcset画像、表・SVG・複雑なflow等 | 可搬seedの保守的な制限により再利用できない構成がある。完成紙面の移送を使う |
| 総ページ数 `counter(pages)`、`target-text` / `target-counters`、running要素、ページ装飾内のtarget参照、counterを含む特殊な柱等 | 可搬seedの対象外となる依存を含む。通常の全文組版へ戻す |

目次の参照先がすべて再利用prefix内なら、部分組版は対象紙面で終了できます。参照が未確定、またはprefixを使えない目次付きpreviewでは、全文を確定して要求位置を引き直す場合があります。その場合は `focusedterminal` の `referenceCompletionRequired` で区別できます。項目追加で目次が一ページ増えるなど、長い再組版が必要なケースも残ります。目次の寸法固定や番号DOMだけの置換は行いません。

再利用不可の構成では利用側が `complete` を選び、完成紙面packetを表示します。任意CSSの部分組版が、全文確定前から正しい目次番号や総ページ数を常に返すという契約ではありません。

## 公開API

公開入口は `packages/core/src/vivliostyle.ts` です。CoreViewerの完全な型定義は `packages/core/src/vivliostyle/core-viewer.ts` を参照してください。

### 入力・組版状態

| API | 説明 |
| --- | --- |
| `loadMemoryDocument(source, documentOptions?, viewerOptions?)` | メモリ原稿のロード |
| `refreshMemoryDocument(source, options?)` | 現在のメモリ原稿の更新。本文だけの更新ではreusePagesを指定 |
| `refreshDocument(options?)` | URL文書等の更新。変更資源のURLをchangedUrlsで渡せる |
| `cancelPreviewUpdate()` | 進行中のpreview更新またはseed取込みを中断 |
| `disposeMemoryResources()` | メモリ資源の解放。貸出中URLは最後のhandle解放まで保持 |
| `getCommittedPreviewSnapshotSeed()` | 最後の全文完成結果からローカルseedを取得 |
| `preparePreviewSnapshotSeed(seed)` | 更新先ViewerのDocumentへseedを複製。元seedは不変に保つ |
| `exportCommittedSeed(key)` | 全文完成結果を可搬seedとして書出し |
| `importCommittedSeed(payload, options)` | 新規の専用donor Viewerへ復元するPromise |
| `validateCommittedSeed(payload, key)` | 初期化済みdonorで、ソースや紙面を改変せず検証 |

`importCommittedSeed` のoptionsは `compatibilityKey`、CSS等の `documentOptions`、`skipInitialPage`、`signal`、`timeoutMs`。初期紙面組版省略は既定true、timeoutは既定120秒です。結果は `seed`、`prepareMs`、`hydrateMs`、`initialPagesTypeset` を返します。取込み後のdonorは不変な再利用元であり、再ロード・更新・再設定を拒否します。

### 完成紙面・資源準備・表示

| API | 説明 |
| --- | --- |
| `exportCompletedPaper(key)` | 全文完成紙面と位置対応、表示環境のpacketを書出し |
| `exportCompletedPaperWithResources(key)` | 全文資源を待ち、メモリ資源のbytesも含めて書出すPromise |
| `waitForPreviewResources({ complete?, signal?, timeoutMs? })` | 現在の表示単位、または全文のpage fetcherがsettleするまで待つ。既定timeoutは30秒 |
| `retainPreviewDisplayUnitAsync(document?, options?)` | 現在の単ページ／見開きの資源準備後に保持handleを返す |
| `retainPreviewDisplayUnit(document?)` | 準備済みの表示単位を同期で保持。未成立はnull、資源未準備は例外 |
| `getCurrentPreviewDisplayUnit()` | 現在の紙面のrevision、epage、DOM等を取得 |
| `getPageContainerForEpage(epage)` | 作業中／確定済みのページDOMを取得 |
| `getLatestCommittedPageContainerForEpage(epage)` | 最後の全文完成版のページDOMを取得 |
| `getCommittedPageContainerForEpage(epage, revision)` | 指定revisionと一致した完成ページだけを取得 |
| `showPreviewPageForEpage(epage, options?)` | 作業中／確定済みの紙面を表示。Core内でのページ表示用 |
| `getEpageForSourceOffset(url, offset)` | Coreのソース位置からページを取得。変換前の原稿位置とは別 |

epageは0始まりです。同期のseed準備・seed export・完成紙面exportも、資源未準備なら例外を返します。waitForPreviewResourcesはsignal中断、世代／表示対象変更、資源破棄、timeoutで終了します。画像の読込み失敗はsettleとして扱い、永続待機にしません。通常のload通知でも見開きの左右両ページのfetcherを待ちます。

`CompletedPaperDocument` はpacketから完成紙面とsource mapを復元する低水準の入口です。`CompletedPaperHost(packet, parent, key)` は独立したiframeにCSS・html/body属性・祖先の表示環境を復元し、世代間のCSS混入を防ぎます。`awaitReady()` でfontと画像を確認し、`retainPages(indices)` で表示するページを保持します。送信側で使えていたfontが受信側で失敗した場合は公開を拒否し、送信側ですでにfallbackしたfontは既存fallbackを許容します。

資源付きexportはCSS内の依存URLも復元できるように移送します。読めないstylesheet、未読込import、layer／supports付きimport、欠落Blob資源等は拒否します。通常のmedia付きimportは読込済みCSSOMから展開します。

### 保持handleと寿命

| handleのAPI | 説明 |
| --- | --- |
| `containers` | 表示用DOM。利用側で位置対応を壊す改変をしない |
| `resolveTextPosition(node, offset)` | 所属するTextNodeの生成元位置。未対応はnull |
| `hitTestSource(clientX, clientY)` | 表示Documentのclient座標から文字を調べる。余白等はnull |
| `cloneInto(document)` | DOM・位置対応を別Documentへ複製し、独立した資源leaseを取得 |
| `release()` | DOM・対応表・資源leaseを解放。繰返し呼出し可能 |

raw seedに自動lease管理はありません。旧seedを参照する組版作業と保持紙面がなくなるまで、donor Viewer／Documentと必要な資源を保持してください。CompletedPaperHostは `release()` と最後のhandle解放がそろうとiframeと受信側Blob URLを回収します。部分組版の保持handleだけでは任意CSSを隔離しないので、表示先のCSS/font環境を同じ世代のまま保持します。

### オプションとイベント

| 設定場所 | オプション | 用途 |
| --- | --- | --- |
| `CoreViewerOptions` | `paginationMode: "complete" \| "target-display-unit"` | 全文確定／対象紙面で終了の選択 |
| `CoreViewerOptions` | `displayIntent: number` | 対象表示要求の世代番号。イベントに折り返す |
| `DocumentOptions` | `clientRevision: number` | URL入力等の版番号。メモリ入力ではsource.revisionを使用 |
| `DocumentOptions` | `previewSnapshotSeed`, `reusePages` | 初回ロードから別Viewerの状態を再利用 |
| `DocumentOptions` | `focusedDisplayMode: "singlePage" \| "spread"` | 部分組版の表示単位。組版条件を変更しない |
| `DocumentOptions` | `fragment` | 表示したい原稿位置の指定 |

`addListener` で、対象紙面の成立を `targetdisplayready`、部分組版の最終状態を `focusedterminal`、Core内の表示変更を `previewdisplay` として受け取れます。revisionとdisplayIntentを照合して扱います。focusedterminalには再利用ページ数、対象位置の解決状況、参照のため全文確定を要したか等の情報があります。

明示的revision付きのメモリ入力で `paginationMode: "complete"` を指定すると、reusePages／renderAllPagesの組合せによらず全文完成後に `loaded` を通知します。revisionを付けない従来のURLロードのlazy表示は保持しているため、すべてのloadedを新しい全文確定契約と同一には扱いません。`paginationprogress` と既存の `PAGINATION_PROGRESS` hookによる進捗通知も利用できます。

## 通常組版にも適用する高速化

### ページ先頭の本文探索

ページごとに前方DOMを探し直す処理に、構造・offset・親子関係の索引を追加しました。全文組版と部分組版の双方で使います。CSSのflow／inline判定は候補と祖先で毎回行います。

飛ばす前方区間がcascade済みで、display／position／floatが単純な値の場合だけ索引を使います。未cascade区間、式・関数、DOM変更、offset不整合では従来探索へ戻します。CSS評価順序を変えず、逆方向offset検索にも対応します。

### 改ページ後の反復要素の判定と候補索引

表ヘッダ等が次ページでも繰り返されるかを調べる際、文脈に依存しない定数CSS値で判定できる場合だけ、display正規化とrepeat-on-break判定に必要なpropertyに計算を絞ります。式・関数・region・view条件等を含む場合は従来の一式計算を使います。

Core所有の親で全子要素が反復しないと確認できた場合は、次ページの同じ走査を索引で省略します。初回の順序・早期終了は保持し、未知／動的候補を含む親は省略しません。DOMの子・文字・属性変更とstyle追加／差替えで無効化し、切り離された元DOMも監視します。Coreが追加するoffset属性の初回追加は除外します。

外部のgetStyle／StyleStore.styleOf／setAt等は既存の可変オブジェクトと同一性を維持します。外部へ可変styleが渡った場合、style／layout関連hookの登録、可変hook配列の外部読取りがある場合には、その実行環境で索引省略を保守的に止めます。保持された別名参照があり得るため、hookを除去しても省略を再開しません。内部読取り口から内部値を直接改変する操作は、Coreの所有権契約の対象外です。

索引と監視は組版世代の切替や資源破棄で解放し、seedや完成紙面packetへ移送しません。表・柱・脚注等の組版機能を削除する高速化ではありません。

## モジュール構成

主なファイルは `packages/core/src/vivliostyle/` 以下にあります。

| ファイル | 役割 |
| --- | --- |
| `core-viewer.ts` | 公開API、入力、seed取込み、資源待機・貸出 |
| `adaptive-viewer.ts` | 組版世代、対象表示、全文完成、イベントの制御 |
| `epub.ts` | 文書・ページの組版、再利用、部分組版の終了、参照解決 |
| `memory-document.ts` | メモリ原稿と資源の準備 |
| `preview-cache.ts` / `preview-diff.ts` | snapshot、再利用可否、差分とソース対応の照合 |
| `portable-seed.ts` | 可搬seedの構造検査・書出し・復元 |
| `completed-paper.ts` / `completed-paper-host.ts` | 完成紙面packet、復元、世代別CSS隔離と表示 |
| `source-map.ts` / `source-presentation.ts` | 文字位置の対応、保持紙面、資源lease |
| `page-start-index.ts` / `preview-boundary-index.ts` | ページ先頭探索やpreview境界の索引 |
| `repeat-index.ts` | 反復候補の索引、無効化、所有権の確認 |
| `css-styler.ts` / `vgen.ts` / `layout.ts` / `layout-helper.ts` / `vtree.ts` 等 | CSS評価、表示DOM生成、組版状態・位置対応の引継ぎ |

`preview-presentation.ts` は表示単位を選ぶ汎用モデルです。複数の組版Viewer間の公開制御、ページ移動、要求世代管理は利用側が担当します。このモデルが単独でプロセス間の表示順序を保証するわけではありません。

## ビルドと検証

Coreのpackage.jsonのNode要件は20以降です。ブラウザ内のCoreテストにはChromeを使用します。リポジトリ直下から次を実行します。

```console
npm ci --prefix packages/core --workspaces=false --ignore-scripts
npm run build --prefix packages/core
npm test --prefix packages/core/test
```

最後のコマンドはテスト用依存とChromeが準備された環境を前提とします。必要ならCHROME_BINを指定します。ビルドは `packages/core/lib/` にESM・CommonJS・ブラウザ用IIFE・型定義を生成します。

2026-10-12の検証では、上流由来の公式Coreテストにforkの回帰ケースを加えた927件すべてが成功しました。これは当時の検証結果です。現在のソースに含まれるテストは `packages/core/test/` にあり、最適化の適用条件と、従来の組版処理へ戻す条件を確認できます。

Core単体の追加検証は [検証コードの案内](benchmark/README.md) にまとめています。可搬seed、原稿位置対応と保持紙面、ページ探索、空段落差分、表示領域の高さ変更、組版中断を検証します。ページごとの本文の組方向・段数は `scripts/check-page-content-style.mjs` で確認できます。
