// 議事録投影コア（src/lib/minutesProjection.js）の単体テスト。
// 対象はすべて純関数のため外部接続やDOM操作は不要（モックなし・決定的）。
const { test } = require('node:test');
const assert = require('node:assert');
const {
  collectMinuteItems,
  groupItemsByKind,
  buildMinutesMarkdown,
} = require('../../src/lib/minutesProjection');

// minuteMark付きテキストノードを簡潔に作る（extraMarksでbold等の他markも重ねられる）。
const markedText = (text, kind, id, createdAt, extraMarks = []) => ({
  type: 'text',
  text,
  marks: [...extraMarks, { type: 'minuteMark', attrs: { kind, id, createdAt } }],
});

// マークの無いプレーンテキストノードを作る。
const plainText = (text) => ({ type: 'text', text });

// 段落ノード（リーフブロック）を作る。
const paragraph = (...content) => ({ type: 'paragraph', content });

// doc全体を作る。
const doc = (...content) => ({ type: 'doc', content });

// minuteMark.ts の MINUTE_KIND_ORDER 相当（7種）。
const KIND_ORDER = ['decision', 'action', 'concern', 'plan', 'actual', 'next', 'info'];

test('collectMinuteItems: 単一の段落・単一ランを1項目として抽出する', () => {
  const docJson = doc(
    paragraph(markedText('今期の予算は500万円とすることに決めました。', 'decision', 'm1', 111))
  );
  const items = collectMinuteItems(docJson, KIND_ORDER);
  assert.deepStrictEqual(items, [
    { id: 'm1', kind: 'decision', text: '今期の予算は500万円とすることに決めました。', createdAt: 111 },
  ]);
});

test('collectMinuteItems: 同一idが段落をまたぐ場合は改行で連結して1項目にする', () => {
  const docJson = doc(
    paragraph(markedText('今日は晴れです。', 'action', 'm1', 10)),
    paragraph(markedText('明日は雨です。', 'action', 'm1', 10))
  );
  const items = collectMinuteItems(docJson, KIND_ORDER);
  assert.strictEqual(items.length, 1, '同一idの段落またぎは1項目に結合される');
  assert.strictEqual(items[0].text, '今日は晴れです。\n明日は雨です。', '段落境界は改行で連結される');
});

test('collectMinuteItems: idが異なれば別項目として扱う', () => {
  const docJson = doc(
    paragraph(markedText('決定した内容です。', 'decision', 'm1', 1)),
    paragraph(markedText('宿題の内容です。', 'action', 'm2', 2))
  );
  const items = collectMinuteItems(docJson, KIND_ORDER);
  assert.strictEqual(items.length, 2, 'idが異なれば別項目になる');
  assert.deepStrictEqual(items[0], { id: 'm1', kind: 'decision', text: '決定した内容です。', createdAt: 1 });
  assert.deepStrictEqual(items[1], { id: 'm2', kind: 'action', text: '宿題の内容です。', createdAt: 2 });
});

test('collectMinuteItems: 同一段落内でbold等の他markと混在しても同一idなら区切りなしで連結する', () => {
  const docJson = doc(
    paragraph(
      markedText('あい', 'decision', 'm1', 5, [{ type: 'bold' }]),
      markedText('うえ', 'decision', 'm1', 5),
      plainText('（マークなし）')
    )
  );
  const items = collectMinuteItems(docJson, KIND_ORDER);
  assert.strictEqual(items.length, 1, 'minuteMarkの無いテキストは項目化されない');
  assert.strictEqual(items[0].text, 'あいうえ', '同一段落内の同一idは他markの有無を問わず直接連結される');
});

test('collectMinuteItems: validKindsに無いkindはinfoに矯正される', () => {
  const docJson = doc(paragraph(markedText('不明な種別のテキスト', 'unknown-kind', 'm1', 1)));
  const items = collectMinuteItems(docJson, KIND_ORDER);
  assert.strictEqual(items[0].kind, 'info', '未知のkindはinfoに矯正される');
});

test('collectMinuteItems: validKinds省略時はすべてinfoに矯正される', () => {
  const docJson = doc(paragraph(markedText('本文', 'decision', 'm1', 1)));
  const items = collectMinuteItems(docJson);
  assert.strictEqual(items[0].kind, 'info', 'validKinds省略時は空配列扱いですべてinfoに矯正される');
});

test('collectMinuteItems: 同一idが非連続に離れて現れても1項目にまとめ、出現順の最初の位置を項目位置とする', () => {
  const docJson = doc(
    paragraph(markedText('最初の発言。', 'decision', 'm1', 1)),
    paragraph(markedText('別項目の発言。', 'action', 'm2', 2)),
    paragraph(markedText('続きの発言。', 'decision', 'm1', 1))
  );
  const items = collectMinuteItems(docJson, KIND_ORDER);
  assert.strictEqual(items.length, 2, 'm1は非連続でも1項目にまとまる');
  assert.strictEqual(items[0].id, 'm1', 'm1は最初に出現した位置が項目位置になる');
  assert.strictEqual(items[0].text, '最初の発言。\n続きの発言。', '離れた出現は改行で連結される');
  assert.strictEqual(items[1].id, 'm2', 'm2はm1に挟まれるが2番目の項目になる');
});

test('collectMinuteItems: 項目の並び順はkindの順序ではなく本文出現順になる', () => {
  const docJson = doc(
    paragraph(markedText('先に報告。', 'info', 'm1', 1)),
    paragraph(markedText('後で決定。', 'decision', 'm2', 2))
  );
  const items = collectMinuteItems(docJson, KIND_ORDER);
  assert.strictEqual(items[0].kind, 'info', 'KIND_ORDERではdecisionが先だが本文出現順ではinfoが先になる');
  assert.strictEqual(items[1].kind, 'decision');
});

test('collectMinuteItems: id属性の無いminuteMarkランは無視する', () => {
  const docJson = doc(
    paragraph({ type: 'text', text: '本文', marks: [{ type: 'minuteMark', attrs: { kind: 'decision', id: null, createdAt: 1 } }] })
  );
  assert.deepStrictEqual(collectMinuteItems(docJson, KIND_ORDER), []);
});

test('collectMinuteItems: 空文書や不正なdocJsonでも例外を投げず空配列を返す', () => {
  // contentが空配列の場合（空文書）。
  assert.deepStrictEqual(collectMinuteItems(doc(), KIND_ORDER), []);
  // docJson自体がnull・contentプロパティが無い場合も空配列を返す（防御的処理）。
  assert.deepStrictEqual(collectMinuteItems(null, KIND_ORDER), []);
  assert.deepStrictEqual(collectMinuteItems({}, KIND_ORDER), []);
});

test('groupItemsByKind: kindOrderの全キーを空配列で初期化する', () => {
  const grouped = groupItemsByKind([], KIND_ORDER);
  for (const kind of KIND_ORDER) {
    assert.deepStrictEqual(grouped[kind], [], `${kind}は項目が無くても空配列で初期化される`);
  }
});

test('groupItemsByKind: itemsを出現順のまま各kindへ振り分ける', () => {
  const items = [
    { id: 'm1', kind: 'decision', text: 'A', createdAt: 1 },
    { id: 'm2', kind: 'action', text: 'B', createdAt: 2 },
    { id: 'm3', kind: 'decision', text: 'C', createdAt: 3 },
  ];
  const grouped = groupItemsByKind(items, KIND_ORDER);
  assert.deepStrictEqual(grouped.decision, [items[0], items[2]], 'decisionは出現順のまま2件入る');
  assert.deepStrictEqual(grouped.action, [items[1]]);
  assert.deepStrictEqual(grouped.concern, [], '該当項目の無いkindは空配列のまま');
});

test('groupItemsByKind: kindOrderに無いkindの項目は無視する', () => {
  const items = [{ id: 'm1', kind: 'unknown', text: 'X', createdAt: 1 }];
  const grouped = groupItemsByKind(items, KIND_ORDER);
  for (const kind of KIND_ORDER) {
    assert.deepStrictEqual(grouped[kind], [], 'KIND_ORDERに無いkindの項目はどのバケツにも入らない');
  }
});

test('buildMinutesMarkdown: 会議情報・非空セクション・空セクション（なし）の書式が一致する', () => {
  const meta = { dateLabel: '2026年7月3日(金)', sessionId: 'session-abc', participants: ['田中', '鈴木'] };
  const sections = [
    { kind: 'decision', label: '決定事項', items: [{ id: 'm1', kind: 'decision', text: '予算は500万円。', createdAt: 1 }] },
    { kind: 'action', label: '宿題', items: [] },
  ];
  const markdown = buildMinutesMarkdown({ meta, sections });
  const expected = [
    '# 議事録',
    '',
    '## 会議情報',
    '',
    '- 日付: 2026年7月3日(金)',
    '- セッションID: session-abc',
    '- 参加者: 田中、鈴木',
    '',
    '## 決定事項',
    '',
    '- 予算は500万円。',
    '',
    '## 宿題',
    '',
    '（なし）',
  ].join('\n');
  assert.strictEqual(markdown, expected);
});

test('buildMinutesMarkdown: 複数行テキストはインデント継続行として整形され、参加者0人は「なし」になる', () => {
  const meta = { dateLabel: '2026年7月3日(金)', sessionId: 's1', participants: [] };
  const sections = [
    { kind: 'action', label: '宿題', items: [{ id: 'm1', kind: 'action', text: '一行目\n二行目', createdAt: 1 }] },
  ];
  const markdown = buildMinutesMarkdown({ meta, sections });
  assert.ok(markdown.includes('- 一行目\n  二行目'), '2行目以降は2スペースインデントの継続行になる');
  assert.ok(markdown.includes('- 参加者: なし'), '参加者が空配列のときは「なし」と表示する');
});
