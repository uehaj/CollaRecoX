# YJSデータ構造

このドキュメントでは、共同編集機能で使用されるYJSドキュメントのデータ構造を説明します。

## 概要

各セッションは `transcribe-editor-v2-{sessionId}` という名前のYJSドキュメントとして管理されます。

## データ構造

```
セッション: transcribe-editor-v2-{sessionId}
│
├── content-{sessionId}   : XmlFragment
│   └── Tiptap/ProseMirrorのドキュメントコンテンツ
│
├── status-{sessionId}    : Map
│   └── isTranscribing: boolean  // 文字起こし中かどうか
│
└── users-{sessionId}     : Map
    └── {userId}: {
          id: string,         // ユーザーID
          name: string,       // ユーザー表示名
          color: string,      // ユーザー色（カーソル表示用）
          joinedAt: number    // 接続時刻（UNIX timestamp）
        }
```

## 各フィールドの説明

### content-{sessionId} (XmlFragment)

Tiptap/ProseMirrorエディタのドキュメントコンテンツを格納します。`@tiptap/extension-collaboration`によって自動的に同期されます。

### status-{sessionId} (Map)

セッションの状態を管理するマップです。

| キー | 型 | 説明 |
|------|------|------|
| `isTranscribing` | boolean | 音声文字起こしが進行中かどうか |

### users-{sessionId} (Map)

接続中のユーザー情報を管理するマップです。キーはユーザーID、値はユーザー情報オブジェクトです。

| プロパティ | 型 | 説明 |
|------------|------|------|
| `id` | string | ユーザーの一意識別子 |
| `name` | string | ユーザーの表示名 |
| `color` | string | ユーザーのカーソル色（例: `#ef4444`） |
| `joinedAt` | number | 接続時刻（UNIX timestamp） |

## ユーザー識別の仕組み

### クライアント側 (CollaborativeEditorV2.tsx)

- **ユーザーID**: `localStorage` の `editor-user-id` キーで永続化
  - 形式: `user-{timestamp}-{random}`
  - 例: `user-1733567890123-abc123def`
  - 同一ブラウザの複数タブでは同じIDが使用される

- **ユーザー表示名**: `localStorage` の `editor-user-name` キーで永続化
  - デフォルト: `User {乱数}`（例: `User 123`）
  - ユーザーが編集可能

- **ユーザー色**: ユーザーIDのハッシュから決定
  - 同じユーザーIDなら同じ色が割り当てられる
  - カラーパレット: 8色（赤、オレンジ、黄、緑、青、インディゴ、紫、ピンク）

### サーバー側 (server.js)

- Hocuspocusを使用してYJSドキュメントを管理
- WebSocketエンドポイント: `/api/yjs-ws`
- `users-{sessionId}`マップを監視して接続ユーザーを追跡

## ライフサイクル

1. **接続時**: ユーザー情報が`users-{sessionId}`マップに登録される
2. **接続中**: カーソル位置と選択範囲がリアルタイムで同期される
3. **切断時**: ユーザー情報が`users-{sessionId}`マップから削除される

## CRDTによるデータ永続性

### 分散データモデル

YJSはCRDT（Conflict-free Replicated Data Type）を採用しており、データは分散的に保持されます。サーバーとクライアントの関係は対等であり、どちらも同じデータの完全なコピーを持ちます。

```
┌─────────────────────────────────────────────────────────────┐
│                    YJSドキュメント                           │
│              transcribe-editor-v2-{sessionId}               │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Hocuspocus   │    │   ブラウザA    │    │   ブラウザB    │
│   サーバー     │◄──►│  (YJS Client) │◄──►│  (YJS Client) │
│  (server.js)  │    │               │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┴─────────────────────┘
                        双方向同期
```

### データの永続性

- **データが保持される条件**: サーバーまたは任意のクライアントが1つでも接続を維持していれば、データは保持されます。
- **データが失われる条件**: すべてのノード（サーバー + 全クライアント）が終了した場合のみ、データは失われます。

| シナリオ | データ |
|---------|--------|
| サーバー再起動、クライアント接続中 | **保持** - クライアントから再同期 |
| クライアント終了、サーバー稼働中 | **保持** - サーバーに残存 |
| サーバー稼働中、新規クライアント接続 | **保持** - サーバーから同期 |
| 全ノード終了 | **消失** |

### 永続化ストレージについて

現在の実装ではメモリ上でのみデータを保持しています。永続化が必要な場合は、Hocuspocusの以下のストレージアダプターを追加で設定できます：

- `@hocuspocus/extension-database` - カスタムデータベース
- `@hocuspocus/extension-sqlite` - SQLite
- `@hocuspocus/extension-redis` - Redis

## 関連ファイル

- `src/app/editor/[sessionId]/CollaborativeEditorV2.tsx` - クライアント側の実装
- `server.js` - Hocuspocusサーバーの実装
