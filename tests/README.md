# テスト

Node.js 標準のテストランナー（`node:test`）を使用します。追加の依存はありません。

## スモークテスト（`tests/smoke/`）

実サーバへ実接続して主要経路を検証する結合スモークテストです（モックなし）。

### 前提

事前に dev サーバを起動しておくこと（ポート 8888）。

```bash
bin/dev.sh -f -l
```

接続先を変えたい場合は `SMOKE_BASE` で上書きできます（既定: `ws://localhost:8888/collarecox`）。

### 実行

```bash
# 決定的な中継経路テストのみ（OpenAI非依存）
npm run test:smoke

# 自動校正（OpenAI実呼び出し）も含める場合
RUN_AI_SMOKE=1 npm run test:smoke
```

### 内容

| ファイル | 内容 | OpenAI |
|---|---|---|
| `relay.test.js` | 認識WS中継 → 共有doc反映、interim(pendingText)反映、確定でのクリア | 不要（自動校正OFF） |
| `collab-liveness.test.js` | セッション生存確認(alive/empty)、共有docの非永続性、awarenessプレゼンス数による「最後の接続」判定（プローブは非カウント） | 不要 |
| `autoproofread.test.js` | 自動校正（オーバーラップ）結果の確定追記、文字化け(U+FFFD)非混入の回帰防止 | 必要（`RUN_AI_SMOKE=1` で有効化） |

## E2Eテスト（`tests/e2e/`）

ヘッドレス実ブラウザ(Chromium)で UI 挙動を検証します。`npm test`（smoke）には含まれず、明示的に実行します。

### 前提

- dev サーバを 8888 で起動しておくこと（`bin/dev.sh -f`）。
- ブラウザバイナリ:
  - 既定では devDependency の `@sparticuz/chromium` 同梱バイナリを使う（Linux/CI 向け。npm 経由で取得済み）。
  - macOS 等では `PUPPETEER_EXECUTABLE_PATH` にローカル Chrome/Chromium のパスを指定する。
    例: `PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`
- 接続先は `E2E_ORIGIN` で上書き可能（既定: `http://localhost:8888/collarecox`）。

### 実行

```bash
npm run test:e2e
```

### 内容

| ファイル | 内容 |
|---|---|
| `leave-stocktaking.test.js` | 離脱確認（最後の接続のときだけ beforeunload で確認）、ホーム一覧の棚卸し（空セッションを一覧と localStorage から除去・生存は残す） |
