'use client';

import React, { useState } from 'react';
import { validateDictionaryEntry } from '@/lib/dictionaryCore';

interface CorrectionDialogProps {
  /** 誤=右クリック時の選択テキスト（読み取り専用表示） */
  wrongText: string;
  onCancel: () => void;
  /** 適用時に呼ばれる。correctは常にtrim済み */
  onApply: (correct: string, registerToDictionary: boolean) => void;
}

/**
 * 「訂正して辞書登録」ダイアログ。
 * 誤（選択テキスト・読み取り専用）/ 正（入力欄）/ 辞書に登録（既定ON）を表示し、
 * validateDictionaryEntryでリアルタイム検証してNG理由を表示、違反時は適用ボタンを無効化する。
 * 辞書登録チェックOFF時は文字数制約の検証を緩め、正テキストが非空であることのみを必須とする
 * （本文置換のみを行うケースを許容するため）。
 * 設計: docs/superpowers/specs/2026-07-02-dictionary-and-minutes-design.html セクション1.1
 */
export default function CorrectionDialog({ wrongText, onCancel, onApply }: CorrectionDialogProps) {
  const [correct, setCorrect] = useState('');
  const [registerToDictionary, setRegisterToDictionary] = useState(true);

  const validation = registerToDictionary
    ? validateDictionaryEntry(wrongText, correct)
    : correct.trim().length > 0
      ? { ok: true as const, wrong: wrongText.trim(), correct: correct.trim() }
      : { ok: false as const, reason: '正を入力してください' };

  const handleApply = () => {
    if (!validation.ok) return;
    onApply(validation.correct, registerToDictionary);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-surface border border-hairline rounded-lg shadow-sm w-full max-w-lg mx-4">
        {/* ヘッダー */}
        <div className="p-4 border-b border-hairline flex justify-between items-center">
          <h3 className="text-lg font-light text-ink">✏ 訂正して辞書登録</h3>
          <button onClick={onCancel} className="text-muted hover:text-body transition-colors">
            ✕
          </button>
        </div>

        {/* コンテンツ */}
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-body-strong mb-1">誤</label>
            <div className="p-2 bg-surface-soft rounded-md border border-hairline text-sm text-body whitespace-pre-wrap max-h-32 overflow-y-auto">
              {wrongText}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-body-strong mb-1">正</label>
            <input
              type="text"
              value={correct}
              onChange={(e) => setCorrect(e.target.value)}
              autoFocus
              placeholder="正しい表記を入力"
              className={`w-full px-3 py-2 border rounded-md text-sm text-ink focus:outline-none focus:ring-1 focus:ring-celadon ${
                !validation.ok && correct.length > 0 ? 'border-error bg-error/5' : 'border-hairline'
              }`}
            />
            {!validation.ok && correct.length > 0 && (
              <p className="text-xs text-error mt-1">{validation.reason}</p>
            )}
          </div>

          <label className="flex items-center space-x-2 text-sm text-body">
            <input
              type="checkbox"
              checked={registerToDictionary}
              onChange={(e) => setRegisterToDictionary(e.target.checked)}
              className="rounded accent-celadon"
            />
            <span>辞書に登録</span>
          </label>
          {!registerToDictionary && (
            <p className="text-xs text-muted">辞書に登録せず、本文の置換のみを行います。</p>
          )}
        </div>

        {/* フッター */}
        <div className="p-4 border-t border-hairline flex justify-end space-x-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-ink bg-surface border border-hairline rounded-md hover:bg-surface-soft transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={handleApply}
            disabled={!validation.ok}
            className="px-4 py-2 text-sm text-on-celadon bg-celadon rounded-md hover:bg-celadon-active disabled:bg-celadon-disabled disabled:cursor-not-allowed transition-colors"
          >
            適用
          </button>
        </div>
      </div>
    </div>
  );
}
