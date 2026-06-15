// E2E（ヘッドレス実ブラウザ）共通ヘルパー。
// 実Chromiumを起動し、実サーバ(8888/collarecox)のUIを検証する。
//
// ブラウザバイナリの解決:
//  - PUPPETEER_EXECUTABLE_PATH が設定されていればそれを使う（任意OSのローカルChrome等）。
//  - 未設定なら @sparticuz/chromium の同梱バイナリを使う（Linux/CI向け。npm経由で取得済み）。
// 接続先は E2E_ORIGIN で上書き可能（既定: http://localhost:8888/collarecox）。
const puppeteer = require('puppeteer-core');

const ORIGIN = process.env.E2E_ORIGIN || 'http://localhost:8888/collarecox';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchBrowser() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    return puppeteer.launch({
      executablePath: envPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  const chromium = require('@sparticuz/chromium');
  return puppeteer.launch({
    args: [...chromium.default.args, '--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: await chromium.default.executablePath(),
    headless: true,
  });
}

// 指定文字列を含む console ログが出るまで待つ（接続検知などに使う）。
function waitForConsole(page, substr, timeout = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => fin(false), timeout);
    page.on('console', (msg) => {
      if (msg.text().includes(substr)) { clearTimeout(t); fin(true); }
    });
  });
}

// in-page で beforeunload を発火し、ハンドラが preventDefault したか（=確認が出るか）を返す。
function wouldPrompt(page) {
  return page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
}

const rid = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

module.exports = { ORIGIN, sleep, launchBrowser, waitForConsole, wouldPrompt, rid };
