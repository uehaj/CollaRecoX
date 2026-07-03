// 議事録投影のコア純関数モジュールの型宣言。
// 実装は同名の minutesProjection.js（CommonJS）。MinutesPane.tsx からはこの宣言を通じて
// import して型付きで利用する。

export interface MinuteItem {
  /** minuteMarkのid属性（同一idのテキストランを1項目に結合したもの） */
  id: string;
  /** 議事録の種別キー（collectMinuteItemsのvalidKindsに無い値は'info'に矯正済み） */
  kind: string;
  /** 結合後の本文テキスト（段落をまたぐ結合・非連続な結合は'\n'で連結） */
  text: string;
  /** 項目の付与時刻（epoch ms。最初に出現したランのcreatedAt） */
  createdAt: number | null;
}

export interface MinutesMeta {
  /** 表示用の日付ラベル（例: "2026年7月3日(金)"） */
  dateLabel: string;
  sessionId: string;
  /** 現在接続中の参加者名一覧 */
  participants: string[];
}

export interface MinutesSection {
  kind: string;
  /** セクション見出し（MINUTE_KINDS[kind].label 相当） */
  label: string;
  items: MinuteItem[];
}

/**
 * ProseMirror doc の toJSON() 結果（editor.state.doc.toJSON()）から、
 * minuteMark 付きテキストランを本文出現順に収集し、同一idのランを1項目に結合する。
 * kindはvalidKindsに含まれる値のみ採用し、含まれない値は'info'に矯正する
 * （省略時は空配列＝すべて'info'に矯正）。docJsonが不正でも例外を投げず空配列を返す。
 */
export function collectMinuteItems(
  docJson: unknown,
  validKinds?: string[]
): MinuteItem[];

/**
 * 項目一覧をkindごとに振り分ける。kindOrderの全キーを空配列で初期化したうえで、
 * itemsを出現順のまま各kindの配列へ振り分ける。kindOrderに無いkindの項目は無視する。
 */
export function groupItemsByKind<K extends string>(
  items: MinuteItem[],
  kindOrder: K[]
): Record<K, MinuteItem[]>;

/**
 * 議事録全体をMarkdown文字列に整形する（「📋 議事録をコピー」用）。
 * 形式: "# 議事録" → "## 会議情報" → 各セクション見出し+項目（空セクションは "（なし）"）。
 */
export function buildMinutesMarkdown(params: {
  meta: MinutesMeta;
  sections: MinutesSection[];
}): string;
