import { Mark, mergeAttributes } from '@tiptap/core';

// ===== 議事録マーカー（minuteMark）=====
// 校正エディタの本文に「決定事項」「宿題」などの種別マーカーを付ける Tiptap カスタム mark。
// mark は doc 本体に載るため Yjs で自動共有され、右ペインの議事録ビューはこの mark の投影になる。
// 設計: docs/superpowers/specs/2026-07-02-dictionary-and-minutes-design.html セクション2.2/2.3

// 種別の定義（このオブジェクトのキー順 = 議事録セクションの表示順。順序の真実源）。
// 配色は淡背景 bg + 下ボーダー border。既存のシステム色である
// 緑 #3fa874（校正待ち）・青 #2563eb（再補正対象）・黄 rgba(250,204,21,*)（利用者マーカー）と
// 目視で区別できるよう、緑・青・黄・青磁（選択色）の色相を避けている。
export const MINUTE_KINDS = {
  decision: { label: '決定事項', bg: '#fde8e8', border: '#d64545' },  // 赤
  action:   { label: '宿題',     bg: '#ffe9d6', border: '#e07020' },  // 橙
  concern:  { label: '懸案事項', bg: '#fce4ef', border: '#d6499b' },  // 桃
  plan:     { label: '予定',     bg: '#ece6fb', border: '#7a5cd0' },  // 紫
  actual:   { label: '実績',     bg: '#f0e7db', border: '#96703d' },  // 茶
  next:     { label: '次回予定', bg: '#f9e4fb', border: '#b249c4' },  // 赤紫
  info:     { label: '報告・共有', bg: '#e9edf0', border: '#64748b' }, // 灰
} as const;

// 種別キーの文字列 Union（enum は使わない）
export type MinuteKind = keyof typeof MINUTE_KINDS;

// セクション表示順の配列（MINUTE_KINDS のキー順から導出。議事録ペインの走査用）
export const MINUTE_KIND_ORDER = Object.keys(MINUTE_KINDS) as MinuteKind[];

// kind 文字列の判定（parseHTML で外部由来の値を検証する）
export const isMinuteKind = (value: unknown): value is MinuteKind =>
  typeof value === 'string' && value in MINUTE_KINDS;

// 項目のグルーピング用 id を生成する（crypto.randomUUID 非対応環境ではフォールバック）
const generateMinuteId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `minute-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

// Tiptap v2 標準の Commands 型拡張（module augmentation。namespace 禁止ルールには抵触しない）
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    minuteMark: {
      /**
       * 現在の選択範囲に議事録マーカーを付与する（id・createdAt は自動採番）。
       * 同一範囲に既存の minuteMark があれば後勝ちで置き換わる。
       */
      setMinuteMark: (kind: MinuteKind) => ReturnType;
      /**
       * 現在の選択範囲の議事録マーカーを解除する。
       */
      unsetMinuteMark: () => ReturnType;
    };
  }
}

// 議事録マーカー mark 本体。
// 同一 type の mark は ProseMirror の既定で排他（excludes 未指定時は自分自身を exclude し、
// 後から付けた mark が置き換わる = 後勝ち。prosemirror-model の MarkType.excluded 既定 [type] による）。
export const MinuteMark = Mark.create({
  name: 'minuteMark',

  // 範囲末尾での続き入力で mark が伸びないようにする
  inclusive: false,

  addAttributes() {
    return {
      // 種別（7種の文字列 Union）。外部HTML由来の不正値は renderHTML 側で info に矯正する
      kind: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-minute-kind'),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.kind ? { 'data-minute-kind': String(attributes.kind) } : {},
      },
      // 項目のグルーピング用の一意 id（議事録ペインで複数テキストランを1項目に結合する）
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-minute-id'),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.id ? { 'data-minute-id': String(attributes.id) } : {},
      },
      // 付与時刻（ミリ秒 epoch）
      createdAt: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute('data-minute-created-at');
          return value ? Number(value) : null;
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.createdAt != null ? { 'data-minute-created-at': String(attributes.createdAt) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-minute-kind]' }];
  },

  renderHTML({ mark, HTMLAttributes }) {
    // 種別ごとの見た目は globals.css の .minute-mark--<kind> が担当する（不正値は info に矯正）
    const kind: MinuteKind = isMinuteKind(mark.attrs.kind) ? mark.attrs.kind : 'info';
    return ['span', mergeAttributes(HTMLAttributes, { class: `minute-mark minute-mark--${kind}` }), 0];
  },

  addCommands() {
    return {
      setMinuteMark:
        (kind: MinuteKind) =>
        ({ commands }) => {
          return commands.setMark(this.name, { kind, id: generateMinuteId(), createdAt: Date.now() });
        },
      unsetMinuteMark:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name);
        },
    };
  },
});
