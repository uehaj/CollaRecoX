// セッション生存確認 ＆ 離脱確認の土台ロジックのスモークテスト（OpenAI非依存・決定的）。
// 実サーバへ実接続し、以下を検証する:
//  - 棚卸し(sessionLiveness)の alive/empty 判定根拠
//  - 共有docの非永続性（接続ゼロで破棄）= 離脱確認が必要な根拠
//  - awareness プレゼンス数による「自分が最後の接続か」の判定。プローブは数に入らない。
//
// 前提: 事前に dev サーバを 8888 で起動しておくこと（bin/dev.sh -f）。
const { test } = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
const { sleep, fragmentText, connectDoc } = require('./helpers');

const rid = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// サーバ同様に paragraph > XmlText として本文を1段落追記する。
function appendParagraph(ydoc, sessionId, text) {
  const fragment = ydoc.getXmlFragment(`content-${sessionId}`);
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  fragment.insert(fragment.length, [p]);
}

test('未作成セッションへ接続すると本文は空（empty判定）', async () => {
  const id = rid('dead');
  const { ydoc, provider } = await connectDoc(id);
  try {
    const text = fragmentText(ydoc.getXmlFragment(`content-${id}`)).trim();
    assert.strictEqual(text, '', '未作成セッションの本文は空であるべき');
  } finally {
    provider.destroy();
  }
});

test('本文ありセッションへ接続すると本文を取得できる（alive判定）', async () => {
  const id = rid('alive');
  const writer = await connectDoc(id, { presence: 'host' });
  appendParagraph(writer.ydoc, id, '生存テストの本文');
  await sleep(300);
  const probe = await connectDoc(id); // プローブ相当（presenceなし）
  try {
    const text = fragmentText(probe.ydoc.getXmlFragment(`content-${id}`)).trim();
    assert.ok(text.includes('生存テストの本文'), 'プローブが本文を取得できるべき');
  } finally {
    probe.provider.destroy();
    writer.provider.destroy();
  }
});

test('唯一の接続が閉じると文書は破棄され、再接続で本文が消える（非永続性）', async () => {
  const id = rid('vanish');
  const a = await connectDoc(id, { presence: 'host' });
  appendParagraph(a.ydoc, id, '消えるはずの本文');
  await sleep(300);

  // 接続中（2接続）のうちは本文が見えること。
  const check = await connectDoc(id);
  const before = fragmentText(check.ydoc.getXmlFragment(`content-${id}`)).trim();
  assert.ok(before.includes('消えるはずの本文'), '接続中は本文が存在するべき');

  // すべての接続を閉じる → 接続ゼロ → サーバが文書をアンロード（非永続）。
  check.provider.destroy();
  a.provider.destroy();
  await sleep(1500);

  // 新規接続で再取得 → 空になっているべき。
  const after = await connectDoc(id);
  try {
    const text = fragmentText(after.ydoc.getXmlFragment(`content-${id}`)).trim();
    assert.strictEqual(text, '', '接続ゼロ後の再接続で本文が消えているべき');
  } finally {
    after.provider.destroy();
  }
});

test('awarenessプレゼンス数で「自分が最後の接続か」を判定でき、プローブは数に入らない', async () => {
  const id = rid('aware');
  const a = await connectDoc(id, { presence: 'host' }); // 実画面相当
  await sleep(400);
  assert.strictEqual(a.provider.awareness.getStates().size, 1, '自分だけのとき size===1');

  // プローブ（presenceなし）を足しても接続数は増えない＝最後の1人の離脱確認を誤抑止しない。
  const probe = await connectDoc(id);
  await sleep(600);
  assert.strictEqual(a.provider.awareness.getStates().size, 1, 'プローブを足しても size===1 のまま');
  probe.provider.destroy();

  // 実クライアント（presenceあり）を足すと size===2。
  const b = await connectDoc(id, { presence: 'guest' });
  await sleep(800);
  assert.strictEqual(a.provider.awareness.getStates().size, 2, '実クライアント2人で size===2');

  // 1人に戻ると size===1。
  b.provider.destroy();
  await sleep(800);
  try {
    assert.strictEqual(a.provider.awareness.getStates().size, 1, '1人に戻ると size===1');
  } finally {
    a.provider.destroy();
  }
});
