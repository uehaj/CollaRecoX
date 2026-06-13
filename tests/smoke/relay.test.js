// 認識WS中継経路のスモークテスト（OpenAI非依存・決定的）。
// オンデバイス認識結果が中継WS→サーバ→Hocuspocus共有docへ正しく流れることを確認する。
const { test } = require('node:test');
const assert = require('node:assert');
const { sleep, fragmentText, connectDoc, connectRelay } = require('./helpers');

test('local_transcriptionが共有docへ確定追記され、local_pendingがinterim反映される', async () => {
  const sessionId = `smoke-relay-${Date.now()}`;
  const field = `content-${sessionId}`;
  const mark = '中継スモーク確認テキスト';

  // 校正画面役のYjsクライアントを先に接続し、該当roomのdocをサーバ上に生成させる。
  const { ydoc, provider } = await connectDoc(sessionId);
  const fragment = ydoc.getXmlFragment(field);
  const statusMap = ydoc.getMap(`status-${sessionId}`);

  // 録音者役で中継WSへ接続する。
  const ws = await connectRelay();
  try {
    ws.send(JSON.stringify({ type: 'set_session_id', sessionId }));
    await sleep(150);
    // 自動校正OFF＝確定テキストを直接docへ書く経路を使う（OpenAI非依存で決定的）。
    ws.send(JSON.stringify({ type: 'set_auto_proofread', enabled: false }));
    await sleep(150);

    // interim(未確定)はstatusMap.pendingTextへ全文置き換えで反映される。
    ws.send(JSON.stringify({ type: 'local_pending', text: '未確定テキスト途中…' }));
    await sleep(500);
    assert.strictEqual(statusMap.get('pendingText'), '未確定テキスト途中…', 'interimがpendingTextへ反映される');

    // 確定テキストは共有docへ段落として追記される。
    ws.send(JSON.stringify({ type: 'local_transcription', text: mark, continuation: false }));
    await sleep(1200);
    assert.ok(fragmentText(fragment).includes(mark), '確定テキストが共有docへ反映される');

    // 確定時にpendingText(interim)はクリアされる。
    assert.strictEqual(statusMap.get('pendingText') || '', '', '確定でpendingTextがクリアされる');
  } finally {
    ws.close();
    provider.destroy();
  }
});
