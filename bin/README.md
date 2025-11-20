# Collarecox Server Scripts

このディレクトリには、Collarecoxサーバーを管理するためのスクリプトが含まれています。

## スクリプト一覧

### start-daemon.sh
WebSocketサーバーをデーモンプロセスとして起動・管理するスクリプトです。

## 使用方法

### 基本コマンド

```bash
# サーバー開始
./bin/start-daemon.sh start

# サーバー停止
./bin/start-daemon.sh stop

# サーバー再起動
./bin/start-daemon.sh restart

# ステータス確認
./bin/start-daemon.sh status

# ログ監視（リアルタイム）
./bin/start-daemon.sh logs

# エラーログ監視（リアルタイム）
./bin/start-daemon.sh errors
```

### 環境変数の設定

サーバー起動前に必要な環境変数を設定してください：

```bash
# OpenAI APIキーを設定（必須）
export OPENAI_API_KEY="your-openai-api-key-here"

# プロキシ設定（社内環境では必須）
export HTTPS_PROXY="http://prx01.dev.ntt-tx.co.jp:8080"
```

### ログファイル

サーバーのログは以下の場所に保存されます：

- **通常ログ**: `logs/server.log`
- **エラーログ**: `logs/server.error.log`
- **PIDファイル**: `server.pid`

### サーバー情報

- **ポート**: 8888
- **WebSocketエンドポイント**: 
  - `/api/realtime-ws` - OpenAI Realtime API接続
  - `/api/yjs-ws` - リアルタイムコラボレーション

### アクセス方法

サーバー起動後、以下のURLでアクセスできます：

- **開発用**: http://localhost:8888
- **本番用**: https://genai.dgi.ntt-tx.co.jp:8010 (Caddy経由)

## トラブルシューティング

### サーバーが起動しない場合

1. **ポート確認**:
   ```bash
   netstat -tlnp | grep 8888
   ```

2. **ログ確認**:
   ```bash
   ./bin/start-daemon.sh errors
   ```

3. **環境変数確認**:
   ```bash
   echo $OPENAI_API_KEY
   echo $HTTPS_PROXY
   ```

### WebSocket接続エラーの場合

1. **サーバーステータス確認**:
   ```bash
   ./bin/start-daemon.sh status
   ```

2. **OpenAI API接続確認**:
   ```bash
   curl -I https://api.openai.com
   ```

3. **プロキシ設定確認**:
   - 社内環境では `HTTPS_PROXY` の設定が必要

## systemdサービス（オプション）

より堅牢な運用のため、systemdサービスとしても設定できます：

```bash
# サービスファイルをコピー（root権限必要）
sudo cp collarecox.service /etc/systemd/system/
sudo systemctl daemon-reload

# サービス開始・有効化
sudo systemctl start collarecox
sudo systemctl enable collarecox
```

## 注意事項

- サーバー起動前に `npm install` を実行してください
- OpenAI APIキーは必須です
- 社内環境では必ずプロキシ設定を行ってください
- サーバー停止時は `./bin/start-daemon.sh stop` を使用してください（Ctrl+Cは推奨されません）