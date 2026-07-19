# 引継書: qpdf-wasm メモリ制約の恒久対応

**作成日**: 2026-07-19
**作成元プロジェクト**: PDFWork（ブラウザ完結型PDF編集ツール）
**引継理由**: 根本対応（qpdf.wasm の再ビルド）は Emscripten ツールチェーンのセットアップを要し、
PDFWork リポジトリのスコープを超えるため、別プロジェクトとして切り出す。

---

## 1. 問題の要約

PDFWork は暗号化・復号・PDF最適化（Linearize）を [qpdf](https://qpdf.sourceforge.io/) の
WASM 版（npm パッケージ [`qpdf-run`](https://github.com/RabbitHols/qpdf-run) が同梱する
`qpdf.wasm`）で実行している。この `qpdf.wasm` は **固定 16.375MB の WASM 線形メモリでビルド
されており、実行時にメモリを拡張できない**。そのため、qpdf に渡す PDF が一定サイズ
（実測で概ね 6〜8MB）を超えると、以下の Emscripten ランタイムエラーで**即座に中断**する。

```
Aborted(OOM). Build with -sASSERTIONS for more info.
```

暗号化されたPDFの読み込み・書き込みはユースケースとして十分想定されるにもかかわらず、
**この制約はこれまで一切テストされておらず、実運用で初めて発覚した**（添付ファイル機能の
追加によりファイルサイズが実質的に増えやすくなったことがきっかけで顕在化した）。

PDFWork 側では応急処置として「5MBを超える場合は暗号化を実行前に中断し、分かりやすい
エラーを出す」ガードを実装済みだが、**5MBという閾値は実用上小さすぎる**。恒久対応として
`qpdf.wasm` 自体を、メモリ拡張を許可した状態で再ビルドする必要がある。

---

## 2. 根本原因（技術的に確認済みの事実）

### 2.1 現在のWASMバイナリのメモリ設定

`node_modules/qpdf-run/vendor/qpdf/lib/qpdf.wasm` の WASM Memory セクションを直接パース
した結果:

```
Memory section, count = 1
  memory 0: flags=1, initial pages=262 (16.375 MB), max pages=262 (16.375 MB)
```

`initial` と `max` が完全に同一（`262` ページ）＝ **メモリ拡張の余地がゼロ**。これは
Emscripten で `-sALLOW_MEMORY_GROWTH` を指定せずにビルドした場合の典型的な出力である
（`INITIAL_MEMORY` の既定値に近い値がそのまま `max` としても固定されている）。

グルーコード（`qpdf.js`、Emscripten生成のJSラッパー）側にも対応するハードコードがある:

```js
var abortOnCannotGrowMemory = requestedSize => { abort("OOM") };
var _emscripten_resize_heap = requestedSize => {
  var oldSize = HEAPU8.length;
  requestedSize >>>= 0;
  abortOnCannotGrowMemory(requestedSize);
};
```

＝ ヒープ拡張要求が来ると、拡張を試みることすらせず即座に `abort("OOM")` する。

### 2.2 実測による失敗閾値

PDFWork のブラウザ環境（実際の `QpdfRun.createBrowserQpdfRunner()` 経由）で、サイズを
変えながら `--encrypt` / `--linearize` を実行して確認:

| 入力サイズ | `--encrypt` | `--linearize` |
|---|---|---|
| 1〜6 MB | 成功 | 成功 |
| 8 MB | **`Aborted(OOM)...`** | **`Aborted(OOM)...`** |
| 10 MB | **`Aborted(OOM)...`** | **`Aborted(OOM)...`** |

6MBと8MBの間に境界がある。qpdf は入力の解析・オブジェクトモデル構築・出力バッファ生成で
入力サイズの数倍のワーキングメモリを要するため、16.375MBの総ヒープに対し実際に安全に
処理できるファイルサイズはその半分以下になる。

**重要**: OOM発生後も qpdf ランナー自体（Workerインスタンス）は破損せず、次回呼び出しから
正常に動作する（同一ランナーで 10MB→OOM→1MB→成功、を確認済み）。つまり「一度落ちたら
セッション全体が使えなくなる」わけではなく、あくまで**その1回の入力サイズに対する処理が
失敗するだけ**。

### 2.3 影響範囲

qpdf.wasm を経由する処理は暗号化・復号・Linearize の3つのみ（すべて同一のWASMインスタンス・
同一のヒープ制約を共有）。それ以外の読み込み・編集・pdf-lib によるページ再構築・保存は
**純JS実装（pdf-lib）で qpdf を一切経由しない**ため、この制約の影響を受けない
（無圧縮18.4MBの添付ファイルを、暗号化・Linearize無しで問題なくエクスポートできることを
確認済み）。

| 操作 | qpdfを経由するか | 影響 |
|---|---|---|
| PDF読み込み・ページ編集・並べ替え・回転 | しない | 影響なし |
| 通常保存（暗号化なし・非Linearized） | しない | 影響なし |
| **保存時にパスワード保護が有効** | する（`--encrypt`） | **合計サイズが約8MB超でOOM** |
| **保存時、元PDFがLinearized（Web最適化済み）** | する（`--linearize`） | **合計サイズが約8MB超でOOM** |
| **暗号化されたPDFの読み込み（復号）** | する（`--decrypt`） | **ファイル自体が約8MB超でOOM** |

サイズを押し上げやすい要因: 大きい添付ファイルの添付、埋め込み画像/フォントの多いPDF、
複数ファイルの結合、ページ数が非常に多い文書。

---

## 3. 現在の応急対応（PDFWork リポジトリ内、恒久対応後は見直し対象）

以下はすべて `src/pdf-logic.js` と `src/ui-main.js` に実装済み（PDFWork の
`docs/TODO.md` の **P1-5** 項目、テストは `tests/18_qpdf_oom_guard.test.js`）。

- `pdf-logic.js`:
  - `export const QPDF_SAFE_INPUT_BYTES = 5 * 1024 * 1024;` — 実測の成功/失敗境界
    （6MB/8MB）に対して安全側に倒した閾値。**恒久対応後はこの定数を大幅に引き上げる、
    またはガード自体を撤去することを検討する。**
  - `export function isQpdfOomError(e)` — エラーメッセージが `OOM`/`Aborted` を含むかで
    Emscripten のヒープ枯渇 abort かどうかを判定するヘルパー。
  - `buildExportBytes(state)`: 暗号化が有効な場合、`bytes.length > QPDF_SAFE_INPUT_BYTES`
    なら `encryptBytes()` を呼ばずに例外を投げる（「ファイルサイズが大きすぎるため、
    パスワード保護を適用できません」）。Linearizeのみ超過している場合はエラーにせず
    黙ってスキップする（最適化のみで正しさに影響しないため）。
- `ui-main.js`:
  - `decryptImported()`: `isQpdfOomError(e)` が true の場合、パスワード再入力ループに
    入れず「ファイルサイズが大きすぎるため復号できませんでした」と通知して読込を
    スキップする（修正前は OOM を「パスワード誤り」として扱い、正しいパスワードを
    入力しても永遠に再入力を求められる不具合があった）。

**恒久対応（qpdf.wasm 再ビルド）が完了したら**、`QPDF_SAFE_INPUT_BYTES` を新しいビルドの
実測安全値に合わせて引き上げる（もしくはメモリ拡張が効くようになるため、ガード自体を
「一定サイズ以上は警告だけ出す」程度に緩めることも検討可能）。`isQpdfOomError()` による
エラー分類・分かりやすいメッセージ化の仕組み自体は、再ビルド後も残しておく価値がある
（どのような固定上限であれ、それを超えた場合に生のEmscriptenメッセージではなく
分かりやすい説明を出す、という設計は妥当なため）。

---

## 4. 恒久対応の方針: qpdf.wasm の再ビルド

### 4.1 直すべきビルドオプション

Emscripten の `emcc`/`em++` リンクオプションに以下を追加する（現在のビルドには
含まれていないと推測される）:

```
-sALLOW_MEMORY_GROWTH=1        # 最重要。実行時にWASM線形メモリを動的拡張できるようにする
-sMAXIMUM_MEMORY=1073741824    # 拡張時の上限。例: 1GB（用途に応じて調整）
-sINITIAL_MEMORY=67108864      # 初期確保量。例: 64MB（小さいPDFで毎回growthさせずに済む）
```

- `ALLOW_MEMORY_GROWTH` だけでも問題は解消するはずだが、`INITIAL_MEMORY` も適度に
  引き上げておくと、典型的な小〜中サイズのPDF処理で growth 自体が発生せず高速になる。
- `MAXIMUM_MEMORY` は WASM32 の上限（4GB）を超えない範囲で、実運用で扱う最大PDFサイズに
  余裕を持たせて設定する。PDFWork 自体は非暗号化パスで100MB超のファイルを既に扱って
  いるため、暗号化パスも同程度（最低でも数百MB）まで安全に処理できることが望ましい。

### 4.2 何をビルドし直す必要があるか

- **ソース**: qpdf 本体（[github.com/qpdf/qpdf](https://github.com/qpdf/qpdf)、Apache License
  2.0）。依存する zlib（圧縮）等もWASM向けにクロスビルドが必要。
- **ツールチェーン**: [Emscripten SDK (emsdk)](https://emscripten.org/docs/getting_started/downloads.html)。
- **ビルド方式**: qpdf は CMake ベース。Emscripten の `emcmake`/`emmake` でラップして
  WASM ターゲット向けにビルドする（qpdf 公式に WASM ビルド手順は無いため、CMake の
  ツールチェーンファイルや依存解決を自前で調整する必要がある可能性が高い）。
- **JS側との整合性**: `qpdf-run` パッケージ（`node_modules/qpdf-run/vendor/qpdf/lib/`）は
  `qpdf.js`（Emscripten生成のグルーコード）・`qpdf.wasm`・`worker.js`（qpdf-run独自の
  Worker実行ラッパー）の3点セットで構成される。再ビルドした `.wasm` は、既存の `qpdf.js`
  グルーコードが期待するエクスポート関数（`_main` 等のCLIエントリポイント、
  ファイルシステム操作用のFS API等）と**互換性を保つ必要がある**。理想的には
  `qpdf-run` プロジェクト自体のビルドスクリプト（もしリポジトリに存在すれば）を参考に
  同じ Emscripten バージョン・同じエクスポート設定で、メモリ関連オプションだけ追加する形が
  最も安全。

### 4.3 代替アプローチ: upstream への貢献

自前でゼロから WASM ビルドパイプラインを構築する前に、**`qpdf-run`
（github.com/RabbitHols/qpdf-run）に Issue/PR を出す**という選択肢も検討すべき。
先方の既存ビルドスクリプトにメモリオプションを1行追加するだけで直る可能性が高く、
再現性・保守性の観点でも upstream で直る方が望ましい。現在 npm 上の最新版は `0.2.1`
（本調査時点、他に `0.1.0`/`0.2.0` のみ存在）であり、更新頻度は高くなさそうなので、
Issue提起後の対応速度は要確認。

### 4.4 検証方法

再ビルドした `.wasm` の検証には、以下の2段階を推奨する。

**(a) 静的検証（Memory section の確認）** — 本調査で使用したのと同じ手法で、ビルドした
`.wasm` の Memory セクションをパースし、`flags=1` かつ `initial < max` になっている
（＝拡張余地がある）ことを確認する:

```js
// Node.js で実行。第一引数に .wasm パスを渡す。
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
let offset = 8;
function readVarUint(buf, offset) {
  let result = 0, shift = 0, byte;
  do { byte = buf[offset++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
  return [result, offset];
}
while (offset < buf.length) {
  const id = buf[offset]; offset++;
  let size; [size, offset] = readVarUint(buf, offset);
  const sectionStart = offset;
  if (id === 5) {
    let count; [count, offset] = readVarUint(buf, sectionStart);
    for (let i = 0; i < count; i++) {
      const flags = buf[offset]; offset++;
      let initial; [initial, offset] = readVarUint(buf, offset);
      console.log('memory', i, 'flags=', flags, 'initial pages=', initial, `(${(initial*65536/1024/1024).toFixed(2)} MB)`);
      if (flags & 1) {
        let max; [max, offset] = readVarUint(buf, offset);
        console.log('  max pages=', max, `(${(max*65536/1024/1024).toFixed(2)} MB)`);
      } else {
        console.log('  no max declared (growth behavior depends on JS glue / MAXIMUM_MEMORY)');
      }
    }
  }
  offset = sectionStart + size;
}
```

**(b) 実処理での確認** — PDFWork リポジトリの `tests/18_qpdf_oom_guard.test.js` と同じ
考え方で、段階的にサイズを大きくした添付ファイル付きPDFに対し `--encrypt`/`--linearize`/
`--decrypt` を実行し、以前は失敗していたサイズ（8MB, 20MB, 50MB, 100MB 等）で成功する
ことを確認する。PDFWork 側の `tests/config.js` に高エントロピー（非圧縮）なダミーファイル
生成のヘルパー関数があるため、テストデータ生成の参考にできる。

### 4.5 再ビルド後、PDFWork 側で必要な変更

1. `node_modules/qpdf-run/vendor/qpdf/lib/qpdf.wasm`（および必要なら `qpdf.js`）を
   新しいビルド成果物で差し替える（`qpdf-run` を fork した独自パッケージにする、または
   `tools/build-crypto.mjs` のコピー元を差し替える）。
2. `src/pdf-logic.js` の `QPDF_SAFE_INPUT_BYTES` を新しい安全値に更新（新ビルドの実測に
   基づく。理想的には既存の大容量ファイル対応の閾値 `TOTAL_FILE_WARN_BYTES`=100MB 等と
   整合する値）。
3. `tests/18_qpdf_oom_guard.test.js` を新しい閾値に合わせて更新し、より大きいサイズでも
   暗号化・Linearize・復号が成功することを確認するテストを追加する。
4. `libraries.zip` に同梱されるライブラリ構成が変わるため、`loader.js` の `DB_VERSION`
   を必ずインクリメントする（PDFWork の既存ルール。古いキャッシュを自動的に無効化するため）。

---

## 5. 参考: このリポジトリ内の関連ファイル

| ファイル | 内容 |
|---|---|
| `src/pdf-logic.js` | `QPDF_SAFE_INPUT_BYTES`・`isQpdfOomError()`・`buildExportBytes()`・`encryptBytes()`/`decryptBytes()`/`linearizeBytes()` |
| `src/ui-main.js` | `decryptImported()`（OOMとパスワード誤りの分岐） |
| `tests/18_qpdf_oom_guard.test.js` | 現行ガードの回帰テスト（再ビルド後の閾値変更で更新が必要） |
| `docs/TODO.md` の **P1-5** 項目 | 本問題の詳細な経緯・実装済み対応の記録 |
| `tools/build-crypto.mjs` | `node_modules/qpdf-run` の成果物を `src/libraries/` へコピーするビルドスクリプト（再ビルド成果物の差し替え先の参考） |
| `node_modules/qpdf-run/vendor/qpdf/lib/` | 現在の `qpdf.wasm`/`qpdf.js` の実体（npmパッケージ由来、リポジトリには含まれない） |

---

## 6. 未解決の疑問（新プロジェクト側で確認・判断してほしい事項）

- `qpdf-run` に自前のビルドスクリプトが存在するか（GitHubリポジトリ確認要）。存在すれば
  それをベースにメモリオプションだけ追加するのが最短。
- qpdf のWASM向けビルドに必要な依存（zlib以外に何があるか。バージョンによっては
  libjpeg等が絡む可能性）の洗い出し。
- `MAXIMUM_MEMORY` の適切な値（PDFWork想定の最大ファイルサイズと、ブラウザ環境での
  実用上のメモリ確保上限のバランス）。
- 再ビルドしたWASMバイナリのライセンス・配布条件の再確認（qpdf自体はApache 2.0だが、
  ビルド成果物の再配布方法によっては `qpdf-run` 側のライセンス表記との整合も要確認）。
