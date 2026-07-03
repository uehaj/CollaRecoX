// 議事録投影のコア純関数モジュール。
// src/app/editor/[sessionId]/MinutesPane.tsx（TypeScriptクライアント。
// 型は同名の minutesProjection.d.ts を参照）から使う共有コード。
// tiptap/ProseMirror本体には依存せず、editor.state.doc.toJSON() が返すプレーンなJSONのみを扱う
// （minuteMarkの定義自体は src/lib/tiptap/minuteMark.ts が真実源で、本モジュールはそれに依存しない）。
// 副作用を持たない純関数のみを置く（editorの購読・DOM操作・クリップボード書込は呼び出し側の責務）。
//
// 設計: docs/superpowers/specs/2026-07-02-dictionary-and-minutes-design.html セクション2.3

/**
 * @typedef {Object} MinuteItem
 * @property {string} id - minuteMarkのid属性（同一idのテキストランを1項目に結合したもの）
 * @property {string} kind - 議事録の種別キー（validKindsに無い値は'info'に矯正済み）
 * @property {string} text - 結合後の本文テキスト（段落をまたぐ結合・非連続な結合は'\n'で連結）
 * @property {number|null} createdAt - 項目の付与時刻（epoch ms。最初に出現したランのcreatedAt）
 */

/**
 * @typedef {Object} MinutesMeta
 * @property {string} dateLabel - 表示用の日付ラベル（例: "2026年7月3日(金)"）
 * @property {string} sessionId
 * @property {string[]} participants - 現在接続中の参加者名一覧
 */

/**
 * @typedef {Object} MinutesSection
 * @property {string} kind
 * @property {string} label - セクション見出し
 * @property {MinuteItem[]} items
 */

/**
 * ProseMirrorのテキストノードのmarks配列からminuteMarkのattrsを取り出す。
 * 見つからない場合、またはmarksが配列でない場合はnullを返す。
 * @param {Array<{type?: string, attrs?: Record<string, unknown>}>|undefined} marks
 * @returns {Record<string, unknown>|null}
 */
function findMinuteMarkAttrs(marks) {
  if (!Array.isArray(marks)) return null;
  const found = marks.find((mark) => mark && mark.type === 'minuteMark');
  return found && found.attrs ? found.attrs : null;
}

/**
 * ノードが「リーフブロック」（段落相当。直下にテキスト等のインラインノードだけを持ち、
 * 自身の子がさらにcontentを持つブロックノードではない）かどうかを判定する。
 * bulletList/listItemのような入れ子のブロックコンテナはリーフではないため、
 * さらに内側へ再帰する（walkBlocks側の分岐で使う）。
 * @param {{content?: Array<Record<string, unknown>>}} node
 * @returns {boolean}
 */
function isLeafBlock(node) {
  if (!Array.isArray(node.content)) return true;
  return node.content.every((child) => !child || !Array.isArray(child.content));
}

/**
 * ProseMirror doc の toJSON() 結果（editor.state.doc.toJSON()）から、
 * minuteMark 付きテキストランを本文出現順に収集し、同一 id のランを1項目に結合する。
 *
 * 結合ルール:
 * - 同一の段落（リーフブロック）内で同一idのランが複数に分かれている場合
 *  （bold等の他markとの境界でテキストノードが分割された場合を含む）は、区切り文字なしで直接連結する。
 * - 段落をまたいで同一idが現れる場合は '\n' で連結する（連続して隣り合う段落・
 *   間に他の内容を挟んで非連続に現れる場合のいずれも同様）。
 * - 項目の並び順は、その id が本文中で最初に出現した位置の順（出現順）になる
 *  （2回目以降の出現がどこにあっても、項目の位置は変わらない）。
 *
 * kindはvalidKindsに含まれる値のみ採用し、含まれない値（未知のkind・null等）は'info'に矯正する
 * （本モジュールはtiptapに依存しないため、有効なkind一覧は呼び出し側から渡す。省略時は空配列として
 * 扱われ、結果としてすべてのkindが'info'に矯正される）。
 * id属性を持たないminuteMarkランは、グルーピング先が無いため無視する。
 * docJsonが不正な形（null・content無し等）でも例外を投げず空配列を返す。
 *
 * @param {{content?: Array<Record<string, unknown>>}|null|undefined} docJson - editor.state.doc.toJSON() の結果
 * @param {string[]} [validKinds] - 有効なkind文字列一覧（省略時は空配列＝すべて'info'に矯正）
 * @returns {MinuteItem[]}
 */
function collectMinuteItems(docJson, validKinds) {
  const kinds = Array.isArray(validKinds) ? validKinds : [];
  /** @type {Map<string, { id: string, kind: string, text: string, createdAt: number|null, lastParagraphIndex: number }>} */
  const itemsById = new Map();
  let paragraphIndex = 0;

  const appendRun = (attrs, text) => {
    const id = attrs.id;
    if (!id || typeof id !== 'string') return; // idの無いランは結合先が無いため無視する

    const rawKind = attrs.kind;
    const kind = kinds.includes(rawKind) ? rawKind : 'info';
    const createdAt = typeof attrs.createdAt === 'number' ? attrs.createdAt : null;

    const existing = itemsById.get(id);
    if (!existing) {
      itemsById.set(id, { id, kind, text, createdAt, lastParagraphIndex: paragraphIndex });
      return;
    }
    // 直前にこのidのテキストを追加したのと同じ段落内なら直接連結、
    // 段落をまたいでいれば（非連続に離れていても）改行で連結する。
    existing.text += existing.lastParagraphIndex === paragraphIndex ? text : `\n${text}`;
    existing.lastParagraphIndex = paragraphIndex;
  };

  const processLeafBlock = (node) => {
    const children = Array.isArray(node.content) ? node.content : [];
    for (const child of children) {
      if (child && child.type === 'text' && typeof child.text === 'string') {
        const attrs = findMinuteMarkAttrs(child.marks);
        if (attrs) appendRun(attrs, child.text);
      }
    }
    paragraphIndex += 1; // このリーフブロック（段落相当）の処理を終えたら境界を1つ数える
  };

  const walkBlocks = (nodes) => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (isLeafBlock(node)) {
        processLeafBlock(node);
      } else {
        walkBlocks(node.content);
      }
    }
  };

  const rootContent = docJson && Array.isArray(docJson.content) ? docJson.content : [];
  walkBlocks(rootContent);

  return Array.from(itemsById.values()).map(({ id, kind, text, createdAt }) => ({ id, kind, text, createdAt }));
}

/**
 * 項目一覧をkindごとに振り分ける。kindOrderの全キーを空配列で初期化したうえで、
 * itemsを出現順のまま各kindの配列へ振り分ける（各配列内の順序はitemsの順序を保つ）。
 * kindOrderに無いkindの項目は無視する（collectMinuteItemsのkind矯正により通常は発生しない防御的処理）。
 * @param {MinuteItem[]} items
 * @param {string[]} kindOrder
 * @returns {Record<string, MinuteItem[]>}
 */
function groupItemsByKind(items, kindOrder) {
  const order = Array.isArray(kindOrder) ? kindOrder : [];
  /** @type {Record<string, MinuteItem[]>} */
  const grouped = {};
  for (const kind of order) grouped[kind] = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (Object.prototype.hasOwnProperty.call(grouped, item.kind)) {
      grouped[item.kind].push(item);
    }
  }
  return grouped;
}

/**
 * 複数行テキストをMarkdownの箇条書き1項目として整形する
 * （先頭行は"- "、続く行は2スペースインデントの継続行にする）。
 * @param {string} text
 * @returns {string}
 */
function formatMarkdownListItem(text) {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`))
    .join('\n');
}

/**
 * 議事録全体をMarkdown文字列に整形する（「📋 議事録をコピー」用）。
 * 形式: "# 議事録" → "## 会議情報"（日付・セッションID・参加者） → 各セクション見出し+項目
 *（空セクションは "（なし）"）。ブロック（タイトル・会議情報・各セクション）の間は空行1行で区切り、
 * 各セクション内は見出しと本文の間にも空行1行を挟む。
 * @param {{ meta: MinutesMeta, sections: MinutesSection[] }} params
 * @returns {string}
 */
function buildMinutesMarkdown({ meta, sections }) {
  const participants = Array.isArray(meta.participants) && meta.participants.length > 0
    ? meta.participants.join('、')
    : 'なし';

  const blocks = [
    '# 議事録',
    [
      '## 会議情報',
      '',
      `- 日付: ${meta.dateLabel}`,
      `- セッションID: ${meta.sessionId}`,
      `- 参加者: ${participants}`,
    ].join('\n'),
  ];

  for (const section of Array.isArray(sections) ? sections : []) {
    const body = section.items.length > 0
      ? section.items.map((item) => formatMarkdownListItem(item.text)).join('\n')
      : '（なし）';
    blocks.push([`## ${section.label}`, '', body].join('\n'));
  }

  return blocks.join('\n\n');
}

module.exports = {
  collectMinuteItems,
  groupItemsByKind,
  buildMinutesMarkdown,
};
