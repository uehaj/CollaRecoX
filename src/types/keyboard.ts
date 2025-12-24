/**
 * キーボードショートカットの定義
 */
export interface KeyboardShortcut {
  /** キーコード（例: 'r', 'Enter', '?'） */
  key: string;
  /** Ctrl/Cmdキーが必要か */
  ctrl?: boolean;
  /** Shiftキーが必要か */
  shift?: boolean;
  /** Altキーが必要か */
  alt?: boolean;
  /** ショートカットの説明 */
  description: string;
  /** 実行するハンドラ関数 */
  handler: () => void;
  /** カテゴリ */
  category: 'format' | 'feature' | 'view';
}

/**
 * useKeyboardShortcutsフックのオプション
 */
export interface UseKeyboardShortcutsOptions {
  /** AI再編モーダルを開くハンドラ */
  onRewrite?: () => void;
  /** Markdown編集モーダルを開くハンドラ */
  onMarkdownEdit?: () => void;
  /** 強制コミットを実行するハンドラ */
  onForceCommit?: () => void;
  /** 編集履歴の表示をトグルするハンドラ */
  onToggleHistory?: () => void;
  /** ショートカットヘルプを表示するハンドラ */
  onShowHelp?: () => void;
  /** input/textarea要素にフォーカスがあるか（ショートカットを無効化するため） */
  isInputFocused?: boolean;
}
