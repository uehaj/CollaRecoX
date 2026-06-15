// 自動校正（オーバーラップ＋文字化け修正）パスのスモークテスト。
// OpenAIの実呼び出しを伴う（コスト・ネットワーク・非決定的）ため、RUN_AI_SMOKE=1 のときだけ実行する。
const { test } = require('node:test');
const assert = require('node:assert');
const { sleep, fragmentText, connectDoc, connectRelay } = require('./helpers');

const runAi = process.env.RUN_AI_SMOKE === '1';

test(
  'OpenAI校正結果が共有docへ確定し、文字化け(U+FFFD)が無い',
  { skip: runAi ? false : 'RUN_AI_SMOKE=1 で有効化（OpenAI実呼び出しのため既定はスキップ）' },
  async () => {
    const sessionId = `smoke-ai-${Date.now()}`;
    const field = `content-${sessionId}`;

    const { ydoc, provider } = await connectDoc(sessionId);
    const fragment = ydoc.getXmlFragment(field);
    const ws = await connectRelay();
    try {
      ws.send(JSON.stringify({ type: 'set_session_id', sessionId }));
      await sleep(150);
      ws.send(JSON.stringify({ type: 'set_auto_proofread', enabled: true, model: 'gpt-4.1-mini' }));
      await sleep(150);

      // ポーズ(gapMs>=1200)を挟んで複数文を送り、機械分割の区切り＝校正対象を作る。
      ws.send(JSON.stringify({ type: 'local_transcription', text: 'きょうの会議では新しい音声認識機能について議論しました', continuation: false, gapMs: 0 }));
      await sleep(300);
      ws.send(JSON.stringify({ type: 'local_transcription', text: 'オンデバイス認識なので音声は外部に送信されません', continuation: false, gapMs: 1500 }));
      await sleep(300);
      ws.send(JSON.stringify({ type: 'local_transcription', text: 'そして校正はAIがおこないます', continuation: false, gapMs: 1500 }));

      // 校正(OpenAI)が走って確定段落がdocへ現れるまで待つ（最大約26秒）。
      let confirmed = '';
      for (let i = 0; i < 25; i++) {
        await sleep(1000);
        confirmed = fragmentText(fragment);
        if (confirmed.replace(/\s/g, '').length >= 10) break;
      }
      await sleep(1500);
      confirmed = fragmentText(fragment);

      assert.ok(confirmed.replace(/\s/g, '').length >= 8, '校正結果の確定段落が共有docへ出現する');
      // 文字化け(U+FFFD 置換文字)が混入していないこと。Buffer.concatデコード修正の回帰防止。
      assert.ok(!/�/.test(confirmed), '文字化け(U+FFFD)が無い');
    } finally {
      ws.close();
      provider.destroy();
    }
  },
);
