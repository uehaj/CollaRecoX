'use client';

import { useEffect } from 'react';

interface ShortcutHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * プラットフォーム検出（Mac vs Windows/Linux）
 */
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const modifierKey = isMac ? 'Cmd' : 'Ctrl';

/**
 * ショートカットヘルプモーダル
 *
 * キーボードショートカット一覧をカテゴリ別に表示します。
 */
export default function ShortcutHelpModal({
  isOpen,
  onClose,
}: ShortcutHelpModalProps) {
  // Escapeキーでモーダルを閉じる
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={onClose}
      aria-labelledby="shortcut-help-title"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[80vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="p-4 border-b">
          <h3
            id="shortcut-help-title"
            className="text-lg font-medium text-gray-900"
          >
            キーボードショートカット
          </h3>
        </div>

        {/* コンテンツ */}
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {/* Tiptap標準ショートカット */}
          <section className="mb-6">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">
              書式設定（Tiptap標準）
            </h4>
            <div className="space-y-2">
              <ShortcutRow
                keys={[modifierKey, 'B']}
                description="太字"
              />
              <ShortcutRow
                keys={[modifierKey, 'I']}
                description="斜体"
              />
              <ShortcutRow
                keys={[modifierKey, 'U']}
                description="下線"
              />
              <ShortcutRow
                keys={[modifierKey, 'Shift', 'X']}
                description="取り消し線"
              />
              <ShortcutRow
                keys={[modifierKey, 'Shift', 'H']}
                description="ハイライト"
              />
              <ShortcutRow
                keys={[modifierKey, 'Z']}
                description="元に戻す"
              />
              <ShortcutRow
                keys={[modifierKey, 'Shift', 'Z']}
                description="やり直し"
              />
            </div>
          </section>

          {/* CollaRecoX独自機能 */}
          <section className="mb-6">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">
              CollaRecoX機能
            </h4>
            <div className="space-y-2">
              <ShortcutRow
                keys={[modifierKey, 'Shift', 'R']}
                description="AI再編を開く"
              />
              <ShortcutRow
                keys={[modifierKey, 'Shift', 'D']}
                description="Markdown編集を開く"
              />
              <ShortcutRow
                keys={[modifierKey, 'Enter']}
                description="強制コミット（手動区切り）"
              />
              <ShortcutRow
                keys={[modifierKey, 'Shift', 'H']}
                description="編集履歴の表示切り替え"
              />
            </div>
          </section>

          {/* 表示 */}
          <section>
            <h4 className="text-sm font-semibold text-gray-700 mb-3">
              表示
            </h4>
            <div className="space-y-2">
              <ShortcutRow keys={['?']} description="このヘルプを表示" />
              <ShortcutRow keys={['Esc']} description="モーダルを閉じる" />
            </div>
          </section>
        </div>

        {/* フッター */}
        <div className="p-4 border-t flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ショートカット表示行コンポーネント
 */
function ShortcutRow({
  keys,
  description,
}: {
  keys: string[];
  description: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 px-3 hover:bg-gray-50 rounded">
      <span className="text-sm text-gray-600">{description}</span>
      <div className="flex items-center gap-1">
        {keys.map((key, index) => (
          <span key={index} className="flex items-center">
            <kbd className="px-2 py-1 text-xs font-semibold text-gray-800 bg-gray-100 border border-gray-300 rounded">
              {key}
            </kbd>
            {index < keys.length - 1 && (
              <span className="mx-1 text-gray-400">+</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
