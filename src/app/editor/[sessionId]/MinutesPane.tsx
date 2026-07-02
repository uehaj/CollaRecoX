'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { MINUTE_KINDS, MINUTE_KIND_ORDER, type MinuteKind } from '@/lib/tiptap/minuteMark';
import { collectMinuteItems, groupItemsByKind, buildMinutesMarkdown, type MinuteItem } from '@/lib/minutesProjection';

interface MinutesPaneProps {
  editor: Editor | null;
  sessionId: string;
  /** 現在接続中の参加者名一覧（呼び出し側のusers-<id> Map等から渡す） */
  participants: string[];
  /** 閲覧モード時は×（マーカー解除）ボタンを出さない（閲覧とコピーは可） */
  isReadOnly: boolean;
  onClose: () => void;
}

// editorのdocを走査してから再計算するまでのデバウンス（設計2.3節: 約300ms）。
const RECOMPUTE_DEBOUNCE_MS = 300;
// 項目クリックでジャンプした行の一時ハイライト表示時間。
const JUMP_HIGHLIGHT_MS = 2000;

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// 今日の日付を「YYYY年M月D日(曜)」形式にする（会議情報の日付欄・v1は簡易表示）。
function formatDateLabel(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日(${WEEKDAY_LABELS[date.getDay()]})`;
}

type MinuteGroups = Record<MinuteKind, MinuteItem[]>;

const emptyGroups = (): MinuteGroups => groupItemsByKind([], MINUTE_KIND_ORDER);

/**
 * 議事録ビュー（右ペイン）。minuteMarkが唯一の真実源であり、editor docを走査した投影を表示する
 * 純粋な描画コンポーネント（マーカー付与UIは持たない。付与はエディタ本体側の責務）。
 * 設計: docs/superpowers/specs/2026-07-02-dictionary-and-minutes-design.html セクション2.3
 */
export default function MinutesPane({ editor, sessionId, participants, isReadOnly, onClose }: MinutesPaneProps) {
  const [groups, setGroups] = useState<MinuteGroups>(emptyGroups);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // editorのdocからminuteMark項目を再計算してstateへ反映する（純関数への投影処理を委譲するだけ）。
  const recompute = useCallback(() => {
    if (!editor) {
      setGroups(emptyGroups());
      return;
    }
    const docJson = editor.state.doc.toJSON();
    const items = collectMinuteItems(docJson, MINUTE_KIND_ORDER);
    setGroups(groupItemsByKind(items, MINUTE_KIND_ORDER));
  }, [editor]);

  // editorの'update'イベントを約300msデバウンスで購読し、初回も1回計算する。
  useEffect(() => {
    if (!editor) return;
    recompute();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(recompute, RECOMPUTE_DEBOUNCE_MS);
    };

    editor.on('update', handleUpdate);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off('update', handleUpdate);
    };
  }, [editor, recompute]);

  // アンマウント時にハイライト解除タイマーを片付ける。
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const dateLabel = useMemo(() => formatDateLabel(new Date()), []);

  // 指定idのminuteMarkが付いたテキストノードの範囲をdoc全体から出現順に集める
  // （段落をまたいで複数ランに分かれている場合は複数レンジになる）。
  const findRangesById = useCallback(
    (id: string): Array<{ from: number; to: number }> => {
      if (!editor) return [];
      const ranges: Array<{ from: number; to: number }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const hasMark = node.marks.some((mark) => mark.type.name === 'minuteMark' && mark.attrs.id === id);
        if (hasMark) ranges.push({ from: pos, to: pos + node.nodeSize });
      });
      return ranges;
    },
    [editor]
  );

  // 項目クリック: idの最初の出現位置へ選択を移動してスクロールし、一時的に行をハイライトする。
  const handleJump = (id: string) => {
    if (!editor) return;
    const ranges = findRangesById(id);
    if (ranges.length === 0) return;

    editor.chain().focus().setTextSelection(ranges[0].from).scrollIntoView().run();

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedId(id);
    highlightTimerRef.current = setTimeout(() => setHighlightedId(null), JUMP_HIGHLIGHT_MS);
  };

  // ×ボタン: 同じidの範囲全体からminuteMarkを除去する（1つのtransactionでまとめて適用）。
  // removeMarkは文字の挿入削除を伴わずpositionをずらさないため、事前収集したrangesをそのまま使える。
  // 選択位置の明示的な変更は行わないため、ユーザーの現在の選択はProseMirrorのマッピングに従い保持される。
  const handleRemove = (id: string) => {
    if (!editor || isReadOnly) return;
    const ranges = findRangesById(id);
    if (ranges.length === 0) return;
    const minuteMarkType = editor.state.schema.marks.minuteMark;
    if (!minuteMarkType) return;

    let tr = editor.state.tr;
    for (const range of ranges) {
      tr = tr.removeMark(range.from, range.to, minuteMarkType);
    }
    editor.view.dispatch(tr);
  };

  const handleCopy = () => {
    const sections = MINUTE_KIND_ORDER.map((kind) => ({
      kind,
      label: MINUTE_KINDS[kind].label,
      items: groups[kind] ?? [],
    }));
    const markdown = buildMinutesMarkdown({
      meta: { dateLabel, sessionId, participants },
      sections,
    });
    navigator.clipboard.writeText(markdown).then(() => {
      alert('議事録をクリップボードにコピーしました');
    });
  };

  return (
    <div className="bg-surface rounded-lg shadow-sm border border-hairline p-4 sticky top-4 flex flex-col max-h-[calc(100vh-2rem)]">
      {/* ヘッダー */}
      <div className="flex items-center justify-between pb-3 border-b border-hairline flex-shrink-0">
        <h3 className="text-lg font-light text-ink">議事録</h3>
        <button
          onClick={onClose}
          className="text-muted hover:text-body transition-colors"
          title="議事録を閉じる"
          aria-label="議事録を閉じる"
        >
          ✕
        </button>
      </div>

      {/* 本文（内部スクロール） */}
      <div className="flex-1 overflow-y-auto py-3 space-y-4 min-h-0">
        {/* 会議情報（自動・v1は簡易表示） */}
        <section>
          <h4 className="text-sm font-medium text-body-strong mb-1">会議情報</h4>
          <ul className="text-sm text-body space-y-0.5">
            <li>日付: {dateLabel}</li>
            <li>セッションID: {sessionId}</li>
            <li>参加者: {participants.length > 0 ? participants.join('、') : 'なし'}</li>
          </ul>
        </section>

        {MINUTE_KIND_ORDER.map((kind) => {
          const kindMeta = MINUTE_KINDS[kind];
          const items = groups[kind] ?? [];
          return (
            <section key={kind}>
              <h4 className="flex items-center gap-1.5 text-sm font-medium text-body-strong mb-1">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: kindMeta.border }}
                  aria-hidden
                />
                {kindMeta.label}
              </h4>
              {items.length === 0 ? (
                <p className="text-sm text-muted-soft">（まだありません）</p>
              ) : (
                <ul className="space-y-1">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className={`group flex items-start gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 transition-colors duration-500 ${
                        highlightedId === item.id ? 'bg-celadon/20' : 'hover:bg-surface-soft'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => handleJump(item.id)}
                        className="flex-1 min-w-0 text-left text-sm text-body whitespace-pre-wrap break-words"
                        title="クリックして本文へ移動"
                      >
                        {item.text}
                      </button>
                      {!isReadOnly && (
                        <button
                          type="button"
                          onClick={() => handleRemove(item.id)}
                          className="flex-shrink-0 text-xs text-muted hover:text-error transition-colors opacity-0 group-hover:opacity-100"
                          title="マーカーを解除"
                          aria-label="マーカーを解除"
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {/* フッター */}
      <div className="pt-3 border-t border-hairline flex-shrink-0">
        <button
          type="button"
          onClick={handleCopy}
          className="w-full px-3 py-1.5 text-sm bg-surface text-ink border border-hairline rounded-md hover:bg-surface-soft transition-colors"
        >
          📋 議事録をコピー
        </button>
      </div>
    </div>
  );
}
