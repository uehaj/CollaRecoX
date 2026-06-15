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
| `autoproofread.test.js` | 自動校正（オーバーラップ）結果の確定追記、文字化け(U+FFFD)非混入の回帰防止 | 必要（`RUN_AI_SMOKE=1` で有効化） |
