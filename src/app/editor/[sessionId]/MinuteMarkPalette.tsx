'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { MINUTE_KINDS, MINUTE_KIND_ORDER, type MinuteKind } from '@/lib/tiptap/minuteMark';

// 議事録マーカーの段落ホバーパレット（主operation。設計2.2節「段落ワンクリック」）。
// 段落(<p>)にホバーすると左余白に「＋」チップを出し、クリックで7種のポップオーバーを開く。
// kind選択でその段落全体(内容の開始〜終了)へ直接tr.addMarkする(選択範囲は動かさない)。
// 設計: docs/superpowers/specs/2026-07-02-dictionary-and-minutes-design.html セクション2.2

interface MinuteMarkPaletteProps {
  editor: Editor | null;
  /** 絶対配置の基準となる祖先要素（CollaborativeEditorV2側の本文スクロール領域を包む<div className="relative">） */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 本文スクロール領域（スクロールでチップ/ポップオーバーを隠すために監視する） */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 緑(校正待ち)の末尾文字数。ロック境界の判定に使う */
  greenTailChars: number;
  /** 青(再補正対象)の末尾文字数。ロック境界の判定に使う */
  protectedTailChars: number;
}

interface HoverState {
  start: number; // 段落内容の開始位置(doc座標)
  end: number; // 段落内容の終了位置(doc座標)
  top: number; // コンテナ基準のtop(px)
  left: number; // コンテナ基準のleft(px)
}

const CHIP_SIZE = 22; // 「＋」チップの一辺(px)
const CHIP_GAP = 4; // 段落左端とチップの間隔(px)

// doc末尾からn文字ぶんの開始doc座標を返す（境界段落の途中になりうる）。
// CollaborativeEditorV2.tsx内のprivateなlockStartPosと同一実装。ファイル変更範囲の制約上、
// 共有モジュールへ切り出せないためここに複製する（ロジックを変える場合は両方を揃えること）。
const lockStartPos = (doc: PMNode, n: number): number => {
  if (n <= 0) return doc.content.size + 1; // ロックなし（番兵: どのステップにも一致しない）
  let remaining = n;
  let from = doc.content.size;
  let pos = 0;
  const starts: number[] = [];
  for (let i = 0; i < doc.childCount; i++) { starts.push(pos); pos += doc.child(i).nodeSize; }
  for (let i = doc.childCount - 1; i >= 0 && remaining > 0; i--) {
    const node = doc.child(i);
    const textLen = node.textContent.length;
    const nodeStart = starts[i];
    if (textLen <= remaining) { from = nodeStart + 1; remaining -= textLen; }
    else { from = nodeStart + 1 + (textLen - remaining); remaining = 0; }
  }
  return from;
};

// マーカーのグルーピング用idを生成する（minuteMark.ts内のgenerateMinuteIdは非公開のため複製。
// 実装はminuteMark.tsと同一に保つこと。crypto.randomUUID非対応環境ではフォールバック）。
const generateMinuteId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `minute-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export default function MinuteMarkPalette({
  editor,
  containerRef,
  scrollRef,
  greenTailChars,
  protectedTailChars,
}: MinuteMarkPaletteProps) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const hoveredElRef = useRef<HTMLElement | null>(null);
  const popoverOpenRef = useRef(false);
  popoverOpenRef.current = popoverOpen;
  // 毎レンダー時に最新値をrefへ反映する（mousemoveハンドラの再購読を避けつつ最新のロック境界を読むため）
  const lockCharsRef = useRef(0);
  lockCharsRef.current = greenTailChars + protectedTailChars;

  // 段落要素から議事録マーカーの付与範囲(段落内容の開始/終了)とチップの表示位置を計算する。
  // ロック境界(緑+青の末尾レンジ。CollaborativeEditorV2の編集ロックと同じ境界)と交差する段落はnullを返す。
  const computeHover = (pEl: HTMLElement): HoverState | null => {
    if (!editor || !containerRef.current) return null;
    try {
      const pos = editor.view.posAtDOM(pEl, 0);
      const $pos = editor.state.doc.resolve(pos);
      const start = $pos.start();
      const end = $pos.end();
      const lockFrom = lockStartPos(editor.state.doc, lockCharsRef.current);
      if (end > lockFrom) return null; // ロック境界と交差 → 付与不可（チップを出さない）

      const coords = editor.view.coordsAtPos(start);
      const containerRect = containerRef.current.getBoundingClientRect();
      const left = Math.max(2, coords.left - containerRect.left - CHIP_SIZE - CHIP_GAP);
      const top = coords.top - containerRect.top;
      return { start, end, top, left };
    } catch (e) {
      console.warn('[MinuteMarkPalette] ⚠️ 段落位置の計算に失敗:', e);
      return null;
    }
  };

  // 段落ホバー検知: コンテナ全体(本文＋チップ/ポップオーバー)でmousemoveを監視する。
  // チップ/ポップオーバー上に乗っている間は現在の表示を維持し、段落でもチップでもない場所へ
  // 移ったらポップオーバーが開いていない限り隠す(ポップオーバーを開いた後の手の移動を妨げないため)。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const container = containerRef.current;
    if (!container) return;
    const editorDom = editor.view.dom as HTMLElement;

    const hide = () => {
      hoveredElRef.current = null;
      if (!popoverOpenRef.current) setHover(null);
    };

    const onMove = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-minute-palette]')) return; // チップ/ポップオーバー上は現状維持
      const pEl = target.closest('p');
      if (pEl && editorDom.contains(pEl)) {
        if (pEl === hoveredElRef.current) return; // 同じ段落なら再計算しない
        hoveredElRef.current = pEl;
        const next = computeHover(pEl);
        setHover(next);
        if (!next) setPopoverOpen(false);
        return;
      }
      hide();
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', hide);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', hide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, containerRef]);

  // スクロールでチップ/ポップオーバーを隠す（シンプルな方針: 追従はせず非表示にする）。
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const onScroll = () => {
      hoveredElRef.current = null;
      setPopoverOpen(false);
      setHover(null);
    };
    scrollEl.addEventListener('scroll', onScroll);
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  // ポップオーバーを開いている間: 画面クリック/Escで閉じる（既存の右クリックメニューと同じ作法）。
  useEffect(() => {
    if (!popoverOpen) return;
    const close = () => setPopoverOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [popoverOpen]);

  // kind選択: 選択範囲を動かさず、段落全体(start..end)へ直接addMarkする(1つのtransactionをdispatch)。
  // 同一type(minuteMark)の既存マークはProseMirrorの既定の排他により後勝ちで置き換わる。
  const applyKind = (kind: MinuteKind) => {
    if (!editor || !hover) return;
    const minuteMarkType = editor.state.schema.marks.minuteMark;
    if (!minuteMarkType) return;
    const mark = minuteMarkType.create({ kind, id: generateMinuteId(), createdAt: Date.now() });
    editor.view.dispatch(editor.state.tr.addMark(hover.start, hover.end, mark));
    setPopoverOpen(false);
    setHover(null);
  };

  if (!hover) return null;

  return (
    <div data-minute-palette className="absolute z-20" style={{ top: hover.top, left: hover.left }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setPopoverOpen((open) => !open); }}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex items-center justify-center rounded-full bg-surface border border-hairline text-muted text-xs leading-none shadow-sm hover:text-ink hover:border-celadon transition-colors"
        style={{ width: CHIP_SIZE, height: CHIP_SIZE }}
        title="議事録マーカーを付与"
        aria-label="議事録マーカーを付与"
      >
        ＋
      </button>
      {popoverOpen && (
        <div
          className="absolute left-full top-0 ml-1 bg-surface border border-hairline rounded-md shadow-md py-1 text-sm text-body"
          style={{ minWidth: '160px' }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {MINUTE_KIND_ORDER.map((kind) => {
            const kindMeta = MINUTE_KINDS[kind];
            return (
              <button
                key={kind}
                type="button"
                className="flex items-center gap-1.5 w-full text-left px-3 py-1.5 hover:bg-surface-soft"
                onClick={() => applyKind(kind)}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: kindMeta.border }}
                  aria-hidden
                />
                {kindMeta.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
