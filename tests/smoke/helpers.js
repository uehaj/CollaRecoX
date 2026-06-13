// スモークテスト共通ヘルパー。
// 実サーバ（bin/dev.sh で起動した 8888）へ実接続して検証する。モックは一切しない。
// 接続先は SMOKE_BASE で上書き可能（既定: ws://localhost:8888/collarecox）。
const WebSocket = require('ws');
const Y = require('yjs');
const { HocuspocusProvider } = require('@hocuspocus/provider');

const BASE = process.env.SMOKE_BASE || 'ws://localhost:8888/collarecox';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 共有doc(XmlFragment)の各段落テキストを改行連結で取り出す。
function fragmentText(fragment) {
  const paragraphs = [];
  for (let i = 0; i < fragment.length; i++) {
    const el = fragment.get(i);
    if (el instanceof Y.XmlElement) {
      let text = '';
      for (let j = 0; j < el.length; j++) {
        const child = el.get(j);
        if (child instanceof Y.XmlText) text += child.toString();
      }
      paragraphs.push(text);
    }
  }
  return paragraphs.join('\n');
}

// 校正画面役: Hocuspocus共有docへ接続し、同期完了まで待つ。
// 先に接続することで、該当room(transcribe-editor-v2-<id>)のdocがサーバ上に生成される。
async function connectDoc(sessionId) {
  const roomName = `transcribe-editor-v2-${sessionId}`;
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `${BASE}/api/yjs-ws`,
    name: roomName,
    document: ydoc,
    WebSocketPolyfill: WebSocket,
  });
  // 同期完了(synced)を待つ。所定時間で来なければ失敗扱いにする。
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hocuspocus同期タイムアウト(5s)')), 5000);
    provider.on('synced', () => { clearTimeout(timer); resolve(); });
  });
  return { ydoc, provider, roomName };
}

// 録音者役: オンデバイス認識結果の中継WS(/api/realtime-ws)へ接続する。
async function connectRelay() {
  const ws = new WebSocket(`${BASE}/api/realtime-ws`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('realtime-ws接続タイムアウト(5s)')), 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', reject);
  });
  return ws;
}

module.exports = { BASE, sleep, fragmentText, connectDoc, connectRelay };
