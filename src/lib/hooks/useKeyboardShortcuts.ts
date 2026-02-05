import { useEffect, useCallback, useMemo } from 'react';
import { KeyboardShortcut, UseKeyboardShortcutsOptions } from '@/types/keyboard';

/**
 * プラットフォーム検出（Mac vs Windows/Linux）
 */
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/**
 * キーボードショートカットのカスタムフック
 *
 * CollaRecoX独自機能のキーボードショートカットを提供します。
 * Tiptap標準ショートカット（Ctrl+B、Ctrl+I等）には干渉しません。
 */
export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): void {
  const {
    onRewrite,
    onMarkdownEdit,
    onForceCommit,
    onToggleHistory,
    onShowHelp,
    isInputFocused = false,
  } = options;

  /**
   * ショートカット設定（useMemoでメモ化）
   */
  const shortcuts: KeyboardShortcut[] = useMemo(() => [
    {
      key: 'r',
      ctrl: true,
      shift: true,
      description: 'AI再編を開く',
      handler: () => onRewrite?.(),
      category: 'feature',
    },
    {
      key: 'd',
      ctrl: true,
      shift: true,
      description: 'Markdown編集を開く',
      handler: () => onMarkdownEdit?.(),
      category: 'feature',
    },
    {
      key: 'Enter',
      ctrl: true,
      description: '強制コミット（手動区切り）',
      handler: () => onForceCommit?.(),
      category: 'feature',
    },
    {
      key: 'h',
      ctrl: true,
      shift: true,
      description: '編集履歴の表示切り替え',
      handler: () => onToggleHistory?.(),
      category: 'view',
    },
    {
      key: '?',
      description: 'ショートカットヘルプを表示',
      handler: () => onShowHelp?.(),
      category: 'view',
    },
  ], [onRewrite, onMarkdownEdit, onForceCommit, onToggleHistory, onShowHelp]);

  /**
   * ショートカットがマッチするかチェック
   */
  const matchesShortcut = useCallback(
    (event: KeyboardEvent, shortcut: KeyboardShortcut): boolean => {
      // キーが一致するかチェック
      if (event.key !== shortcut.key) {
        return false;
      }

      // Ctrl/Cmdキーのチェック（プラットフォーム依存）
      const ctrlPressed = isMac ? event.metaKey : event.ctrlKey;
      if (shortcut.ctrl && !ctrlPressed) {
        return false;
      }
      if (!shortcut.ctrl && ctrlPressed && shortcut.key !== '?') {
        // '?'以外でCtrl/Cmdが不要なのに押されている場合は不一致
        return false;
      }

      // Shiftキーのチェック
      if (shortcut.shift && !event.shiftKey) {
        return false;
      }
      if (!shortcut.shift && event.shiftKey && shortcut.key !== '?') {
        // '?'以外でShiftが不要なのに押されている場合は不一致
        return false;
      }

      // Altキーのチェック
      if (shortcut.alt && !event.altKey) {
        return false;
      }
      if (!shortcut.alt && event.altKey) {
        return false;
      }

      return true;
    },
    []
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // input/textarea内ではショートカットを無効化
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      // isInputFocusedフラグでも無効化可能
      if (isInputFocused) {
        return;
      }

      // ショートカットをチェック
      for (const shortcut of shortcuts) {
        if (matchesShortcut(event, shortcut)) {
          event.preventDefault(); // デフォルト動作を防止
          shortcut.handler();
          break; // 最初にマッチしたショートカットのみ実行
        }
      }
    };

    // windowにキーボードイベントリスナーを登録
    window.addEventListener('keydown', handleKeyDown);

    // クリーンアップ
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [shortcuts, matchesShortcut, isInputFocused]);
}
