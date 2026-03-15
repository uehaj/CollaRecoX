# local-dev

ローカル開発環境のセットアップと起動手順。

## 前提条件

- Node.js v25+ （`--localstorage-file` フラグが必要）
- `.env.local` に `OPENAI_API_KEY` を設定済み

## 起動方法

### 推奨: bin/dev.sh

```bash
# 通常起動（ポート8888）
bin/dev.sh

# ポート競合時：既存プロセスを強制終了して起動
bin/dev.sh -f

# ログファイル出力を有効化
bin/dev.sh -f -l
```

### npm scripts

```bash
# 開発サーバー（Next.js + WebSocket、ポート8888）
npm run dev

# WebSocketサーバーのみ（ポート5001）
npm run server

# ビルド
npm run build

# 本番起動
npm run start
```

## WebSocketエンドポイント

server.jsは以下のWebSocketパスを処理する:

| パス | 用途 |
|------|------|
| `/collarecox/api/yjs-ws` | Hocuspocus（共同編集）|
| `/collarecox/api/realtime-ws` | リアルタイム音声文字起こし |
| `/_next/webpack-hmr` | HMR（開発時のみ）|

## 接続確認

WebSocket接続が正常に動作するか確認するワンライナー:

```bash
# Yjs WebSocket（Hocuspocusプロトコル）
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8888/collarecox/api/yjs-ws');
ws.on('open', () => { console.log('✅ yjs-ws: 接続成功'); ws.close(); });
ws.on('error', (e) => { console.error('❌ yjs-ws: 接続失敗', e.message); });
setTimeout(() => { console.log('⏰ タイムアウト'); process.exit(1); }, 5000);
"

# Realtime WebSocket
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8888/collarecox/api/realtime-ws');
ws.on('open', () => { console.log('✅ realtime-ws: 接続成功'); ws.close(); });
ws.on('error', (e) => { console.error('❌ realtime-ws: 接続失敗', e.message); });
setTimeout(() => { console.log('⏰ タイムアウト'); process.exit(1); }, 5000);
"
```

ポート5001で起動している場合は `localhost:8888` を `localhost:5001` に変更。

## Node.js v25 対応

Node.js v25ではビルトインの `localStorage` APIが導入されたが、`--localstorage-file` パスを指定しないとランタイムエラーになる。package.jsonの全nodeスクリプトに `--localstorage-file=/tmp/node-localstorage` を付与済み。

**注意**: Node.js v20以下では `--localstorage-file` フラグは `bad option` エラーになるため、nclc等のv20環境ではこのフラグを除去すること。

## トラブルシューティング

### ポート競合

```bash
# ポート8888を使用しているプロセスを確認
lsof -i :8888

# 強制終了
kill -9 $(lsof -ti :8888)
```

### WebSocket接続失敗

1. サーバーログで `[WebSocket] 🔄 UPGRADE EVENT TRIGGERED!` が出ているか確認
2. パスに `/collarecox` プレフィックスが付いているか確認（`basePath` 設定）
3. `noServer: true` + `handleUpgrade` パターンが正しく実装されているか確認

### 企業プロキシ環境

`bin/dev.sh` が自動的に `NODE_TLS_REJECT_UNAUTHORIZED=0` を設定する。手動起動時は:

```bash
source <(grep -v '^#' .env.local | sed 's/^/export /') && export NODE_TLS_REJECT_UNAUTHORIZED=0 && npm run dev
```
