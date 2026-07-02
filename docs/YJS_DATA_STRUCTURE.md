# YJSデータ構造

このドキュメントでは、共同編集機能で使用されるYJSドキュメントのデータ構造を説明します。

## 概要

各セッションは `transcribe-editor-v2-{sessionId}` という名前のYJSドキュメントとして管理されます。
このほかに、全セッション共通のグローバルな辞書ドキュメント `collareco-dictionary` があります。

## データ構造

```
セッション: transcribe-editor-v2-{sessionId}
│
├── content-{sessionId}   : XmlFragment
│   └── Tiptap/ProseMirrorのドキュメントコンテンツ
│       （議事録マーカー minuteMark を含む。下記「議事録マーカー」参照）
│
├── status-{sessionId}    : Map
│   └── isTranscribing: boolean  // 文字起こし中かどうか
│
├── users-{sessionId}     : Map
│   └── {userId}: {
│         id: string,         // ユーザーID
│         name: string,       // ユーザー表示名
│         color: string,      // ユーザー色（カーソル表示用）
│         joinedAt: number    // 接続時刻（UNIX timestamp）
│       }
│
└── raw-{sessionId}       : Text
    └── 校正前の確定生テキスト（差分検証用の原本。追記専用）

グローバル: collareco-dictionary（全セッション共通・固有名詞辞書）
│
└── entries : Map
    └── {誤（wrong）}: {
          correct: string,    // 正しい表記
          createdAt: number   // 登録日時（UNIX timestamp ms）
        }
```

### 固有名詞辞書（collareco-dictionary）

- 校正画面の「✏ 訂正して辞書登録」や「📖 辞書」モーダルから編集され、
  server.js がAI校正プロンプトに注入する（`src/lib/dictionaryCore.js` が単一の共有ロジック）。
- server.js が起動時に direct connection で常駐させ、変更をデバウンスして
  `data/dictionary.json` に永続化する（サーバー再起動後も復元される。git管理外）。
- 上限1000件（超過時は古い順に削除）。プロンプト注入は新しい順100件まで。

### 議事録マーカー（minuteMark）

`content-{sessionId}` 内の Tiptap カスタム mark として保持される（＝本文と一緒に全参加者へ同期）。

| 属性 | 型 | 説明 |
|------|------|------|
| `kind` | string | 種別: decision / action / concern / plan / actual / next / info（`src/lib/tiptap/minuteMark.ts` の `MINUTE_KINDS` が真実源） |
| `id` | string | 項目のグルーピング用の一意ID（同一idのランを議事録の1項目に結合） |
| `createdAt` | number | 付与日時（UNIX timestamp ms） |

校正画面右の議事録ペイン（MinutesPane）は、この mark を本文出現順に走査して
種別セクションへ投影する純粋なビューであり、独自のYjs構造は持たない。

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
