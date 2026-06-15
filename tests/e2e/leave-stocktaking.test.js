// ヘッドレス実ブラウザによる UI E2E テスト。
//  A. 離脱確認: 自分が最後の接続のとき beforeunload が確認される / 他に接続者がいれば されない
//  B. 棚卸し: ホームの「最近のセッション」から本文が空(=死んだ)セッションが除去され、生存は残る
//
// 前提: 事前に dev サーバを 8888 で起動しておくこと（bin/dev.sh -f）。
// 実行: npm run test:e2e
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { ORIGIN, sleep, launchBrowser, waitForConsole, wouldPrompt, rid } = require('./helpers');

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

test('離脱確認: 自分が最後の接続のときだけ beforeunload で確認される', async () => {
  const sid = rid('e2e');

  // 単独接続 → 確認が出る
  const p1 = await browser.newPage();
  const connected1 = waitForConsole(p1, '[Hocuspocus Provider V2] Connected');
  await p1.goto(`${ORIGIN}/editor/${sid}`, { waitUntil: 'networkidle2' });
  await connected1;
  await sleep(1200); // awareness(自分)確立を待つ
  assert.strictEqual(await wouldPrompt(p1), true, '単独接続では確認される');

  // 2人目が接続 → 確認は出ない
  const p2 = await browser.newPage();
  const userCount2 = waitForConsole(p1, 'User count changed: 2');
  const connected2 = waitForConsole(p2, '[Hocuspocus Provider V2] Connected');
  await p2.goto(`${ORIGIN}/editor/${sid}`, { waitUntil: 'networkidle2' });
  await connected2;
  await userCount2;
  await sleep(800);
  assert.strictEqual(await wouldPrompt(p1), false, '他に接続者がいると確認されない');

  // 単独に戻ると再び確認される
  await p2.close({ runBeforeUnload: false });
  await waitForConsole(p1, 'User count changed: 1');
  await sleep(800);
  assert.strictEqual(await wouldPrompt(p1), true, '単独に戻ると再び確認される');

  await p1.close({ runBeforeUnload: false });
});

test('棚卸し: 空セッションは一覧と localStorage から除去され、生存は残る', async () => {
  const deadId = rid('dead');
  const aliveId = rid('alive');

  // 生存セッションを作る: editor で本文を入力し接続を維持する。
  const ed = await browser.newPage();
  const edConnected = waitForConsole(ed, '[Hocuspocus Provider V2] Connected');
  await ed.goto(`${ORIGIN}/editor/${aliveId}`, { waitUntil: 'networkidle2' });
  await edConnected;
  await sleep(800);
  await ed.click('.ProseMirror').catch(() => {});
  await ed.type('.ProseMirror', '生存セッションの本文', { delay: 10 }).catch(() => {});
  await sleep(800);

  // ホームを開き localStorage に dead/alive を仕込んで再読み込み。
  const home = await browser.newPage();
  await home.goto(ORIGIN, { waitUntil: 'networkidle2' });
  await home.evaluate((dead, alive) => {
    const now = Date.now();
    localStorage.setItem('collarecox-recent-sessions', JSON.stringify([
      { id: dead, role: 'guest', at: now },
      { id: alive, role: 'guest', at: now },
    ]));
  }, deadId, aliveId);
  await home.reload({ waitUntil: 'networkidle2' });

  // 「最近のセッション」一覧内の session id だけを取り出す。
  const listIds = () => home.$$eval('ul.space-y-2 li span.font-mono', (els) => els.map((e) => e.textContent));

  // 棚卸し完了を待つ（dead が消える）。最大10秒ポーリング。
  let deadGone = false;
  for (let i = 0; i < 20; i++) {
    if (!(await listIds()).includes(deadId)) { deadGone = true; break; }
    await sleep(500);
  }
  assert.ok(deadGone, '棚卸しで dead セッションが一覧から消える');

  assert.ok((await listIds()).includes(aliveId), '生存セッション(alive)は一覧に残る');

  const stored = await home.evaluate(() =>
    JSON.parse(localStorage.getItem('collarecox-recent-sessions') || '[]').map((s) => s.id)
  );
  assert.ok(!stored.includes(deadId), 'localStorage からも dead が除去される');

  await home.close();
  await ed.close({ runBeforeUnload: false });
});
