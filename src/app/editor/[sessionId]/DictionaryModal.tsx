'use client';

import React, { useState } from 'react';
import type { DictionaryEntry } from '@/lib/dictionaryCore';
import type { AddEntryResult, DictionaryStatus } from '@/lib/hooks/useDictionary';

interface DictionaryModalProps {
  /** 登録済み辞書エントリ（createdAt降順） */
  entries: DictionaryEntry[];
  addEntry: (wrong: string, correct: string) => AddEntryResult;
  removeEntry: (wrong: string) => void;
  status: DictionaryStatus;
  /** 閲覧モード時は追加フォーム・削除ボタンを出さない（閲覧のみ） */
  isReadOnly: boolean;
  onClose: () => void;
}

/**
 * 辞書管理モーダル。登録件数・一覧（誤→正・登録日時・削除）・手動追加フォームを表示する。
 * entriesはuseDictionaryのY.Map observerで更新されるため、他ユーザーの変更も即時反映される。
 * 設計: docs/superpowers/specs/2026-07-02-dictionary-and-minutes-design.html セクション1.4
 */
export default function DictionaryModal({ entries, addEntry, removeEntry, status, isReadOnly, onClose }: DictionaryModalProps) {
  const [wrong, setWrong] = useState('');
  const [correct, setCorrect] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const handleAdd = () => {
    const result = addEntry(wrong, correct);
    if (!result.ok) {
      setFormError(result.reason);
      return;
    }
    setWrong('');
    setCorrect('');
    setFormError(null);
  };

  const formatDate = (ms: number): string => new Date(ms).toLocaleString('ja-JP');

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-surface border border-hairline rounded-lg shadow-sm w-full max-w-2xl mx-4 flex flex-col max-h-[80vh]">
        {/* ヘッダー */}
        <div className="p-4 border-b border-hairline flex justify-between items-center">
          <h3 className="text-lg font-light text-ink">
            📖 固有名詞辞書
            <span className="ml-2 text-sm text-muted font-normal">
              {entries.length}件登録済み{status !== 'connected' && '（接続中...）'}
            </span>
          </h3>
          <button onClick={onClose} className="text-muted hover:text-body transition-colors">
            ✕
          </button>
        </div>

        {/* コンテンツ */}
        <div className="p-4 overflow-y-auto flex-1">
          {/* 手動追加フォーム（閲覧モードでは非表示） */}
          {!isReadOnly && (
            <div className="mb-4 p-3 bg-surface-soft rounded-md border border-hairline">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={wrong}
                  onChange={(e) => { setWrong(e.target.value); setFormError(null); }}
                  placeholder="誤（例: コラレコ）"
                  className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-hairline rounded-md text-ink focus:outline-none focus:ring-1 focus:ring-celadon"
                />
                <span className="text-muted flex-shrink-0">→</span>
                <input
                  type="text"
                  value={correct}
                  onChange={(e) => { setCorrect(e.target.value); setFormError(null); }}
                  placeholder="正（例: CollaReco）"
                  className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-hairline rounded-md text-ink focus:outline-none focus:ring-1 focus:ring-celadon"
                />
                <button
                  onClick={handleAdd}
                  disabled={!wrong.trim() || !correct.trim()}
                  className="px-3 py-1.5 text-sm text-on-celadon bg-celadon rounded-md hover:bg-celadon-active disabled:bg-celadon-disabled disabled:cursor-not-allowed transition-colors whitespace-nowrap flex-shrink-0"
                >
                  追加
                </button>
              </div>
              {formError && <p className="text-xs text-error mt-1">{formError}</p>}
            </div>
          )}

          {/* 一覧 */}
          {entries.length === 0 ? (
            <p className="text-sm text-muted py-6 text-center">まだ辞書に登録がありません。</p>
          ) : (
            <div className="space-y-1">
              {entries.map((entry) => (
                <div
                  key={entry.wrong}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-md hover:bg-surface-soft"
                >
                  <div className="flex items-center gap-2 text-sm text-body min-w-0">
                    <span className="text-body-strong truncate">{entry.wrong}</span>
                    <span className="text-muted flex-shrink-0">→</span>
                    <span className="truncate">{entry.correct}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs text-muted-soft">{formatDate(entry.createdAt)}</span>
                    {!isReadOnly && (
                      <button
                        onClick={() => removeEntry(entry.wrong)}
                        title="削除"
                        className="text-xs text-error hover:underline"
                      >
                        削除
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="p-4 border-t border-hairline flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-ink bg-surface border border-hairline rounded-md hover:bg-surface-soft transition-colors"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
