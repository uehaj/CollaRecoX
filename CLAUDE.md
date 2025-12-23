# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

このプロジェクトは、OpenAI GPT-4oモデルを使用した音声文字起こしアプリケーションと、リアルタイム共同編集機能を持つNext.js 15アプリケーションです。

### 主要機能

1. **音声文字起こし** - OpenAI GPT-4o transcribe/realtimeモデルによる音声認識
   - `/recorder` - バッチ処理モード（録音完了後に処理）
   - `/realtime` - リアルタイムストリーミングモード（WebSocket経由）

2. **リアルタイム共同編集** - Yjs + Tiptapによる共同編集
   - `/editor/[sessionId]` - Google Docs風の共同編集画面
   - 外部WebSocket（wss://demos.yjs.dev/ws）を使用した同期

### 技術スタック

- **フレームワーク**: Next.js 15 (App Router)
- **リアルタイム同期**: Yjs + y-websocket + Tiptap
- **WebSocketサーバー**: カスタムNode.jsサーバー（server.js）
- **AI**: OpenAI API (GPT-4o transcribe/realtime models)
- **状態管理**: Jotai
- **スタイリング**: Tailwind CSS v4

## 開発コマンド

### 推奨：開発スクリプト (bin/dev.sh)

環境変数の自動読み込み、プロキシ対応、ログ出力機能を含む統合スクリプトです。

```bash
# 通常起動（ポート8888、WebSocket対応）
bin/dev.sh

# 既存プロセスを強制終了して起動（ポート競合時）
bin/dev.sh -f

# ログファイル出力を有効化（logs/ディレクトリに保存）
bin/dev.sh -l

# 強制終了 + ログ出力（推奨）
bin/dev.sh -f -l

# カスタムログディレクトリ指定
bin/dev.sh -l -d /path/to/logs

# ヘルプ表示
bin/dev.sh -h
```

**機能:**
- `.env.local`の自動読み込み
- 企業プロキシ環境での自動TLS証明書検証無効化
- `-f`オプション: ポート8888使用中のプロセスを自動kill
- `-l`オプション: タイムスタンプ付きログファイル出力（`logs/server_YYYYMMDD_HHMMSS.log`）

**ログ監視（別ターミナル）:**
```bash
tail -f logs/server_*.log | grep --color 'threshold\|VAD\|Auto-commit\|Error'
```

### 直接起動

```bash
# 開発サーバーの起動（npm経由）
npm run dev

# 企業プロキシ環境でSSL証明書エラーが発生する場合
source <(grep -v '^#' .env.local | sed 's/^/export /') && export NODE_TLS_REJECT_UNAUTHORIZED=0 && npm run dev

# 標準のNext.js開発サーバー（WebSocketなし）
npm run next-dev

# プロダクションビルド
npm run build

# プロダクションサーバーの起動
npm run start

# リント
npm run lint
```

**重要**:
- 開発時は `bin/dev.sh` の使用を推奨します。環境変数の自動読み込みとプロキシ対応が含まれます。
- `npm run dev` を直接使用する場合は、事前に環境変数を読み込んでください。
- 企業プロキシ環境で「unable to verify the first certificate」エラーが発生する場合、`bin/dev.sh`が自動的に`NODE_TLS_REJECT_UNAUTHORIZED=0`を設定します。
  - **注意**: この設定はセキュリティリスクがあるため、開発環境でのみ使用してください。本番環境では絶対に使用しないでください。

## 環境変数

プロジェクトルートに `.env.local` ファイルを作成し、以下を設定してください：

```env
OPENAI_API_KEY=your_openai_api_key_here
```

`.env.example` を参考にしてください。

## アーキテクチャ概要

### WebSocketサーバー（server.js）

- Next.jsのカスタムサーバーとして動作
- `/api/realtime-ws` パスでWebSocketをハンドリング
- OpenAI Realtime APIへのプロキシとして機能
- HMR（Hot Module Replacement）用のWebSocketも処理

### 共同編集の仕組み

- **Yjs**: CRDTベースのリアルタイムデータ同期ライブラリ
- **y-websocket**: YjsドキュメントをWebSocket経由で同期
- **Tiptap**: ProseMirrorベースのリッチテキストエディタ
- **y-prosemirror**: YjsとProseMirrorのバインディング

現在は外部サービス（`wss://demos.yjs.dev/ws`）を使用していますが、将来的にはserver.jsに統合可能です。

### APIルート構成

- `/api/transcribe` - バッチ音声文字起こし（ストリーミングレスポンス）
- `/api/realtime` - リアルタイム文字起こし設定
- `/api/realtime-ws` - WebSocket経由のリアルタイム音声ストリーミング

## 全体方針

まず、イシュー(ISSUE.md)を確認します。イシューがなければ指示をうけてイシューを作成します。
イシュー作成後に、計画(PLAN.md)を作成し、確認をとります。
確認後にタスクリストに従い作業を行います。

一時的な分析結果などの情報は、プロジェクトトップのworking配下に保存してください。

# コマンド

以下はコマンドです。

## develop_mcp_sevrer

利用者の指示にしたがって開発をおこないます。
develop_mcp_serverという指示をうけたら、以下のファイルを読み込んで指示にしたがって。

- MCP_TypeScript_SDK.md
- MCP.md

読みこんだあと何かをする必要はありません。

## save_context

save_context という指示を受けたら、ここまでのISSUE.mdにたいする進捗状況を、
プロジェクトやカレントディレクトリなどを記録含めて./worklog/PROGRESS.mdというファイルに
保存します。この際、「PROGRESS_YYMMDDHHMMSS.txt」というファイルとして作成したうえで、
それを「PROGRESS.txt」に上書きコピーします。。
「YYMMDDHHMMSS」は実際のタイムスタンプです。
この記録は、会話を次の会話にもちこすために作成するものです。

## load_context

load_context という指示を受けたら、保存されている./work-historyのcontext_latest.txtを
読み込んでその内容の指示にしたがって。

なお、読み込みがおわったときにタスク実行は絶対に開始しないでください。

load_contextコマンドを実行した直後に書き換えをはじめないでください。
ユーザに何をするか最初に確認し、指示をまってください。


ISSUE.mdを表示して、現在取り組んでいる課題を表示してください。

## create_issue

ユーザーに、やりたいことの内容をヒアリングして、以下のイシュー管理チケット(ISSUE.md)を作成します。

# イシュー管理

ユーザが今依頼している実行しているイシューをはISSUE.mdというファイル名で
tasks/ディレクトリ直下に以下のフォーマットで作成し管理します。完了したイシューは、
worklog配下にworklog/ISSUE_closed_YYYYMMDD.mdというファイル名にして移動します。

```ISSUE.md
# チケット： タイトル
## 概要
<!-- このチケットで解決したい課題 -->

## 関連リンク

# 受け入れ条件
<!-- チケットをクローズできる条件を状態として表現する -->

# 心配事
<!-- チケットを進めるうえでハードルとなりそうな懸念点を列挙します -->

# タスク
<!-- チケットの見積もりを行うために、必要なタスクを列挙します -->

# 成果物
<!-- PR以外の成果物のリンクを記載 -->

# 振り返り
<!-- チケットを進める過程で発生したトラブル等 -->

```

# タスクへの分解

ユーザからイシューを依頼された際、ユーザは何を求めているのかよく考えてtasks/PLAN.mdを作成します。
PLAN.mdを作成する際には、現時点でPLAN.mdにのこっているタスクをのこすかいったん保留するかをユーザに確認する。

保留するという答えを得たなら、tasks/PLAN.md中の完了していないタスクを
tasks/PENDINGS.mdに追記する。そしてこれからやるべきことを以下の型式の
tasks/PLAN.mdにマークダウン形式に書き起こす。タスクの順序は戦略的に依存関係を
考慮して作成してください。

```PLAN.md
# Issueの計画

<!-- Issueの計画を立てます。ユーザーストーリーに分解し、一つ一つにタスクを洗い出します。-->

## Story-1: {ペルソナ}として{機能}により{価値}を得る

{ストーリーの内容を記載します。}

### タスク

- [ ] タスク1
- [ ] タスク2
- [ ] タスク3

```

・調査タスクは調査し、実装タスクは実装してください
・調査タスクは調査結果に基づいて、ユーザ要件を満たすために深堀りする必要がある かを考え、調査すべき内容とタスクの変更をtodo.mdに更新すること
・更新されたタスクに基づいて続けて実施してください


# イシューとタスクの完了

イシューを完了するまえに、状況を報告し、ユーザにクローズしてよいかの確認をかならずとってください。
コミットしてよいかどうかも、ユーザに確認をとってください。

確認ができた場合、完了したイシューは、
worklog配下にworklog/ISSUE_closed_YYYYMMDD.mdというファイル名にして移動します。
完了したイシューに所属するPLAN.mdは
worklog配下にworklog/PLAN_closed_YYYYMMDD.mdというファイル名にして移動します。


# TypeScript

TypeScriptの書き方として、enumの使用は禁止、文字列のUnion型または定数オブジェクトを使用する。namespaceも禁止。あとclassではなくobjectを多用して。関数型スタイルを意識して。オブジェクトリテラルとシンプルな関数を多用する


# 全体アーキテクチャについては以下に記載しています。

 docs/OVERVIEW.md


# 禁止事項

load_contextしたときに即座にタスク開始はしないこと。
読み込みがおわったときにタスク実行は絶対に開始しないでください。

# 音声認識メモ

 音声認識は単一サーバでおこないます。そして、音声認識結果は、そのサーバが、一人のユーザとして、共有ドキュメントの末尾に発現を追加する。そうすれば、他のユーザに認識結果が配信されます。音声認識は1つの端末からしかおこないません。編集のみが、共有編集画面からおこなわれます。

# メモリ

- コミットするまえにビルドして
- APIを勝手に増やすことは禁止
- MCPはいっさいつかわないこと
- bin/dev.shについてCLAUDE.mdに追記
- 一時的なテストコードはworkdir配下に作成すること