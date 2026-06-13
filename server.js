#!/usr/bin/env node
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { Hocuspocus } = require('@hocuspocus/server'); // ← ここ重要（Server ではなく Hocuspocus）
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ ERROR: OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';

// ログ出力用サニタイズ: 制御文字（ANSIエスケープ等）を除去し上限長で切り詰める
// （クライアント由来テキストによるログインジェクション・ログ肥大の防止）
const sanitizeForLog = (value, maxLength = 100) =>
  String(value).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, maxLength);

// Port
let port = 8888;
const portArgIndex = process.argv.findIndex(arg => arg === '-p');
if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
  port = parseInt(process.argv[portArgIndex + 1], 10) || 8888;
} else if (process.env.PORT) {
  port = parseInt(process.env.PORT, 10) || 8888;
}
console.log('Using port:', port);

const app = next({ dev, hostname });
const handle = app.getRequestHandler();

// Hocuspocus（内蔵サーバなし）
const hocuspocus = new Hocuspocus({
  async onAuthenticate({ connection, document, context }) {
    console.log(`[Hocuspocus] Authentication request for document: ${document?.name || 'unknown'}`);
    return true;
  },
  async onLoadDocument({ documentName }) {
    console.log(`[Hocuspocus] Loading document: ${documentName}`);
    return null; // 空で開始
  },
  onConnect({ connection, document }) {
    console.log(`[Hocuspocus] ✅ Client connected to document: ${document?.name || 'unknown'}`);
  },
  onDisconnect({ connection, document }) {
    console.log(`[Hocuspocus] 🔌 Client disconnected from document: ${document?.name || 'unknown'}`);
  },
  onStateless({ payload, document }) {
    console.log(`[Hocuspocus] 📨 Stateless for ${document.name}:`, payload);
  },
});

app.prepare().then(() => {
  console.log('Next.js app prepared successfully');

  const server = createServer(async (req, res) => {
    console.log('🔵 [HTTP] Request received:', req.method, req.url);
    try {
      const parsedUrl = parse(req.url, true);
      console.log('🔵 [HTTP] Parsed URL:', parsedUrl.pathname);

      // /collarecox/api/yjs-sessions エンドポイント: アクティブなYjsセッション一覧を返す
      if (parsedUrl.pathname === '/collarecox/api/yjs-sessions') {
        const sessions = Array.from(hocuspocus.documents.keys()).map(roomName => {
          const sessionId = roomName.replace('transcribe-editor-v2-', '');
          const doc = hocuspocus.documents.get(roomName);
          return {
            sessionId,
            roomName,
            connectionCount: doc?.getConnectionsCount?.() || 0
          };
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ sessions }));
        return;
      }

      // Next.js へ
      console.log('🔵 [HTTP] Calling Next.js handle()...');
      await handle(req, res, parsedUrl);
      console.log('🔵 [HTTP] Next.js handle() completed');
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  // WebSocket servers
  const yjsWss = new WebSocketServer({ noServer: true }); // For Hocuspocus
  const realtimeWss = new WebSocketServer({ noServer: true }); // For realtime audio
  
  // Add comprehensive upgrade debugging
  server.on('upgrade', (request, socket, head) => {
    // Guard against mid-upgrade disconnections
    socket.on('error', (err) => {
      console.error('[WebSocket] Upgrade socket error:', err.message);
      socket.destroy();
    });

    console.log(`[WebSocket] 🔄 UPGRADE EVENT TRIGGERED!`);
    console.log(`[WebSocket] Request URL: ${request.url}`);
    console.log(`[WebSocket] Request headers:`, request.headers);
    
    const { pathname } = parse(request.url);
    console.log(`[WebSocket] Parsed pathname: ${pathname}`);
    
    if (pathname.startsWith('/collarecox/api/yjs-ws')) {
      console.log('[WebSocket] Processing /collarecox/api/yjs-ws upgrade request');
      try {
        yjsWss.handleUpgrade(request, socket, head, (ws) => {
          console.log('[WebSocket] ✅ WebSocket upgrade successful, passing to Hocuspocus');
          try {
            // ここが肝：Hocuspocus に WebSocket を引き渡す
            hocuspocus.handleConnection(ws, request);
            console.log('[WebSocket] ✅ Hocuspocus handleConnection called successfully');
          } catch (hocuspocusError) {
            console.error('[WebSocket] ❌ Hocuspocus handleConnection error:', hocuspocusError);
            ws.close();
          }
        });
      } catch (upgradeError) {
        console.error('[WebSocket] ❌ WebSocket upgrade error:', upgradeError);
        socket.destroy();
      }
    } else if (pathname === '/collarecox/api/realtime-ws') {
      console.log('[WebSocket] Processing /collarecox/api/realtime-ws upgrade request');
      console.log('[WebSocket] Socket readable:', socket.readable);
      console.log('[WebSocket] Socket writable:', socket.writable);
      console.log('[WebSocket] Head length:', head.length);
      console.log('[WebSocket] About to call handleUpgrade...');
      try {
        realtimeWss.handleUpgrade(request, socket, head, (ws) => {
          console.log('[WebSocket] ✅ handleUpgrade callback called, about to emit connection event');
          realtimeWss.emit('connection', ws, request);
          console.log('[WebSocket] ✅ connection event emitted');
        });
        console.log('[WebSocket] handleUpgrade called (but callback may not have executed yet)');
      } catch (upgradeError) {
        console.error('[WebSocket] ❌ Realtime WebSocket upgrade error:', upgradeError);
        socket.destroy();
      }
    } else if (pathname === '/_next/webpack-hmr' || pathname === '/collarecox/_next/webpack-hmr') {
      console.log('[WebSocket] Processing HMR WebSocket upgrade request');
      // Let Next.js handle HMR WebSocket
      if (handle.upgrade) {
        handle.upgrade(request, socket, head);
      } else {
        console.error('[WebSocket] ❌ Next.js handle.upgrade not available');
        socket.destroy();
      }
    } else {
      console.log(`[WebSocket] ❌ Unknown WebSocket path: ${pathname}, destroying socket`);
      socket.destroy();
    }
  });

  // Additional error handlers
  server.on('error', (error) => {
    console.error('[Server] ❌ HTTP Server error:', error);
  });

  yjsWss.on('error', (error) => {
    console.error('[WebSocket] ❌ YJS WebSocketServer error:', error);
  });

  realtimeWss.on('error', (error) => {
    console.error('[WebSocket] ❌ Realtime WebSocketServer error:', error);
  });

  // Handle realtime audio WebSocket connections
  realtimeWss.on('connection', function connection(clientWs, request) {
    console.log('Client connected to realtime WebSocket');
    
    // No need to parse model parameter - using fixed model
    
    let localPendingCount = 0; // local_pending受信数（ログ間引き用）

    // 自動校正の状態（バッファ方式: 確定テキストを溜めて、校正結果だけをドキュメントへ追記する）
    const autoProofreadState = {
      enabled: true, // デフォルト: 有効（クライアントのset_auto_proofreadで上書きされる）
      inFlight: false, // 校正API実行中フラグ
      lastRunAt: 0,    // 前回実行時刻（最短間隔の制御）
      model: 'gpt-4.1-mini',
      timer: null,     // 定期トリガー（録音停止後の残り分も拾う）
      rawBuffer: '',   // 校正待ちの生テキスト（自動校正ON時は直接ドキュメントへ書かない）
      sentTail: '',    // 送信済み校正テキストの末尾（オーバーラップ文脈用、最大300文字）
      pendingInterim: '',     // クライアントの認識途中テキスト（未確定表示の合成用）
      lastBufferChangeAt: 0,  // バッファ最終更新時刻（停止後の残り全量処理の判定用）
      lastOutEndedSentence: false, // 前回の校正出力が文末（。！？）で終わったか（新段落開始の判定用）
      pausePositions: [],     // rawBuffer内の「無音ポーズ境界」オフセット（機械的パラグラフ分割の一次区切り）
    };

    // Session management for Hocuspocus integration
    let currentSessionId = null;

    // Handle messages from client
    clientWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'set_session_id':
            // Set current session ID for Hocuspocus integration
            if (message.sessionId) {
              // 検証: 制御文字を含まない100文字以内の文字列のみ受け付ける
              // （ログインジェクション・異常に長いYjsルーム名の防止）
              const sidCandidate = String(message.sessionId);
              if (sidCandidate.length > 100 || /[\x00-\x1f\x7f]/.test(sidCandidate)) {
                console.warn('⚠️ Invalid session ID format rejected');
                break;
              }
              currentSessionId = sidCandidate;
              console.log(`📋 Set current session ID: ${currentSessionId}`);
              console.log(`[Debug] Session ID successfully stored for Hocuspocus integration`);
            } else {
              console.log(`[Debug] ❌ set_session_id message received but sessionId is empty:`, message);
            }
            break;
            
          case 'local_transcription': {
            // クライアント主認識（オンデバイス認識）モードの確定テキストを共有ドキュメントへ転送する
            // OpenAIは関与しない（音声は送信されない）
            if (!message.text) break;
            // 検証: 文字列かつ上限長以内（巨大ペイロードのYjs書き込み・全クライアント配信を防止）
            if (typeof message.text !== 'string' || message.text.length > 2000) {
              console.warn('[LocalASR] ⚠️ local_transcription rejected: text too long or invalid');
              break;
            }

            // 自動校正ON: 直接ドキュメントへは書かず、校正バッファに溜める。
            // 校正画面には生テキストを未確定（グレー）として見せ続け、
            // AI校正の結果が「確定文」として追記された時点で黒字になる
            if (autoProofreadState.enabled && currentSessionId) {
              // 無音ポーズ境界を記録（このチャンクの直前で機械的に段落を区切る一次シグナル）。
              // continuation（発話途中の継続確定）はポーズではないため記録しない。
              if (!message.continuation && typeof message.gapMs === 'number'
                  && message.gapMs >= PAUSE_BREAK_MS && autoProofreadState.rawBuffer.length > 0) {
                autoProofreadState.pausePositions.push(autoProofreadState.rawBuffer.length);
              }
              autoProofreadState.rawBuffer += message.text;
              autoProofreadState.lastBufferChangeAt = Date.now();
              // 校正が失敗し続けた場合の安全弁: バッファ過大なら未校正のまま書き出す
              if (autoProofreadState.rawBuffer.length > 8000) {
                const degraded = autoProofreadState.rawBuffer.slice(0, 4000);
                autoProofreadState.rawBuffer = autoProofreadState.rawBuffer.slice(4000);
                // ポーズ境界も同じ分だけ前方シフトする
                autoProofreadState.pausePositions = autoProofreadState.pausePositions
                  .map((p) => p - 4000).filter((p) => p > 0);
                console.warn('[Auto-Proofread] ⚠️ バッファ過大のため4000文字を未校正のまま書き出します');
                sendTextToHocuspocusDocument(currentSessionId, degraded, false);
              }
              {
                const pt = autoProofreadState.rawBuffer + autoProofreadState.pendingInterim;
                setPendingText(currentSessionId, pt, greenDisplayBreaks(autoProofreadState.rawBuffer, autoProofreadState.pausePositions), autoProofreadState.rawBuffer.length);
              }
              maybeAutoProofread(currentSessionId, clientWs, autoProofreadState)
                .catch((e) => console.error('[Auto-Proofread] ❌ trigger error:', e));
              break;
            }

            const localText = message.text;
            if (currentSessionId) {
              console.log(`[LocalASR] 📝 Local transcription → Hocuspocus(${currentSessionId}): "${sanitizeForLog(message.text)}"${message.continuation ? ' (継続)' : ''}`);
              // continuation=true は発話途中からの部分確定なので、区切りスペースを入れない
              sendTextToHocuspocusDocument(currentSessionId, localText, message.continuation !== true);
              // 確定したので未確定（pending）表示をクリア
              clearPendingText(currentSessionId);
            } else {
              console.log('[LocalASR] ⚠️ No session ID set, local transcription not forwarded');
            }
            break;
          }

          case 'set_auto_proofread': {
            // 自動校正のON/OFF（バッファ方式: 確定テキストを溜めて校正結果だけを追記する）
            autoProofreadState.enabled = message.enabled === true;
            if (typeof message.model === 'string' && message.model.length < 50) {
              autoProofreadState.model = message.model;
            }
            if (autoProofreadState.enabled) {
              autoProofreadState.rawBuffer = '';
              autoProofreadState.sentTail = '';
              autoProofreadState.pendingInterim = '';
              autoProofreadState.lastBufferChangeAt = 0;
              autoProofreadState.pausePositions = [];
              if (!autoProofreadState.timer) {
                autoProofreadState.timer = setInterval(() => { // 6秒ごとに校正をトリガー（高頻度化）
                  maybeAutoProofread(currentSessionId, clientWs, autoProofreadState)
                    .catch((e) => console.error('[Auto-Proofread] ❌ timer error:', e));
                }, 6000);
              }
              console.log(`[Auto-Proofread] 🪄 Enabled (model=${autoProofreadState.model}, バッファ方式)`);
              setProofreadTailParas(currentSessionId, 0); // 開始直後は再補正窓なし
            } else {
              if (autoProofreadState.timer) {
                clearInterval(autoProofreadState.timer);
                autoProofreadState.timer = null;
              }
              // OFF時は校正待ちの生テキストを失わないよう、そのままドキュメントへ書き出す
              if (autoProofreadState.rawBuffer && currentSessionId) {
                console.log(`[Auto-Proofread] 📤 無効化に伴いバッファ${autoProofreadState.rawBuffer.length}文字を未校正のまま書き出します`);
                sendTextToHocuspocusDocument(currentSessionId, autoProofreadState.rawBuffer, false);
                autoProofreadState.rawBuffer = '';
                setPendingText(currentSessionId, autoProofreadState.pendingInterim);
              }
              console.log('[Auto-Proofread] Disabled');
            setProofreadTailParas(currentSessionId, 0); // 自動校正OFFで保護解除（全文編集可）
            }
            break;
          }

          case 'local_pending':
            // クライアント主認識モードの認識途中テキスト（毎回全文置き換え）を校正画面へ反映する
            localPendingCount++;
            if (localPendingCount <= 3 || localPendingCount % 20 === 0) {
              console.log(`[LocalASR] 🔤 local_pending #${localPendingCount} (session=${currentSessionId || 'NONE'}): "${sanitizeForLog(message.text || '', 40)}"`);
            }
            if (currentSessionId && typeof message.text === 'string') {
              // 表示用なので上限長で切り詰める（巨大ペイロードの全クライアント配信を防止）
              const interimText = message.text.slice(0, 500);
              autoProofreadState.pendingInterim = interimText;
              // 自動校正ON時は校正待ちの生バッファも未確定（グレー）として見せる
              const composite = autoProofreadState.enabled
                ? autoProofreadState.rawBuffer + interimText
                : interimText;
              // そとづけの改行情報（機械分割オフセット）。自動校正ON時のみ算出する。
              const compositeBreaks = autoProofreadState.enabled
                ? greenDisplayBreaks(autoProofreadState.rawBuffer, autoProofreadState.pausePositions)
                : [];
              setPendingText(currentSessionId, composite, compositeBreaks, autoProofreadState.enabled ? autoProofreadState.rawBuffer.length : 0);
            }
            break;

          default:
            console.log('Unhandled client message type:', message.type);
        }
      } catch (error) {
        console.error('Error processing client message:', error);
        clientWs.send(JSON.stringify({
          type: 'error',
          error: 'Invalid message format'
        }));
      }
    });

    clientWs.on('close', () => {
      console.log('Client WebSocket disconnected');
      // 自動校正タイマーの解放
      if (autoProofreadState.timer) {
        clearInterval(autoProofreadState.timer);
        autoProofreadState.timer = null;
      }
      // 校正待ちバッファが残っていれば未校正のまま書き出す（テキスト喪失防止）
      if (autoProofreadState.rawBuffer && currentSessionId) {
        console.log(`[Auto-Proofread] 📤 切断に伴いバッファ${autoProofreadState.rawBuffer.length}文字を未校正のまま書き出します`);
        sendTextToHocuspocusDocument(currentSessionId, autoProofreadState.rawBuffer, false);
        autoProofreadState.rawBuffer = '';
      }
      // 録音者切断で再補正は起きないため保護解除（全文編集可に戻す）
      setProofreadTailParas(currentSessionId, 0);
    });

    clientWs.on('error', (error) => {
      console.error('Client WebSocket error:', error);
    });
  });

  // Function to send text to Hocuspocus document
  // leadingSpace=false: 発話途中からの継続テキスト（部分確定）のため、区切りスペースを入れずに連結する
  // forceNewParagraph=true: 1行目を最終段落への連結ではなく、新しい段落として追加する
  async function sendTextToHocuspocusDocument(sessionId, text, leadingSpace = true, forceNewParagraph = false) {
    try {
      console.log(`[Hocuspocus Integration] Adding text directly to document for session ${sessionId}: "${sanitizeForLog(text)}"`);

      const roomName = `transcribe-editor-v2-${sessionId}`;

      // Access existing document from server's documents collection
      const document = hocuspocus.documents.get(roomName);

      if (document) {
        // Use session-specific field name to match client
        const fieldName = `content-${sessionId}`;

        // TipTap Collaboration uses XmlFragment, not Text
        const fragment = document.getXmlFragment(fieldName);

        // テキストを改行で分割し、各行を個別のパラグラフとして挿入する
        // (\n をリテラル文字としてXmlTextに入れると段落構造が壊れるため)
        const lines = text.split('\n').filter(line => line.trim() !== '');
        if (lines.length === 0) return;

        const Y = require('yjs');

        // 音声追記であることを編集側が判別できるよう、本文追記とspeechAppendSeqの更新を
        // 同一Yjsトランザクションにまとめる（編集側はこれを下線・変更履歴の対象から除外する）
        document.transact(() => {
        const statusMap = document.getMap(`status-${sessionId}`);
        statusMap.set('speechAppendSeq', (statusMap.get('speechAppendSeq') || 0) + 1);
        const hasContent = fragment.length > 0;

        if (hasContent) {
          // 1行目: 既存の最後のパラグラフに追加（forceNewParagraph時は新規段落として追加）
          const lastElement = fragment.get(fragment.length - 1);

          if (!forceNewParagraph && lastElement && lastElement.nodeName === 'paragraph') {
            const existingTextNode = lastElement.get(0);
            const firstLine = `${leadingSpace ? ' ' : ''}${lines[0]}`;
            if (existingTextNode && existingTextNode instanceof Y.XmlText) {
              existingTextNode.insert(existingTextNode.length, firstLine);
            } else {
              const newTextNode = new Y.XmlText();
              newTextNode.insert(0, firstLine);
              lastElement.insert(lastElement.length, [newTextNode]);
            }
            console.log(`[Hocuspocus Integration] ✅ First line appended to existing paragraph in '${fieldName}'`);
          } else {
            // 最後の要素がパラグラフでない場合、新規パラグラフ作成
            const newParagraph = new Y.XmlElement('paragraph');
            const newTextNode = new Y.XmlText();
            newTextNode.insert(0, `${leadingSpace ? ' ' : ''}${lines[0]}`);
            newParagraph.insert(0, [newTextNode]);
            fragment.insert(fragment.length, [newParagraph]);
            console.log(`[Hocuspocus Integration] ✅ First line added as new paragraph to '${fieldName}'`);
          }

          // 2行目以降: 新規パラグラフとして挿入
          for (let i = 1; i < lines.length; i++) {
            const newParagraph = new Y.XmlElement('paragraph');
            const newTextNode = new Y.XmlText();
            newTextNode.insert(0, lines[i]);
            newParagraph.insert(0, [newTextNode]);
            fragment.insert(fragment.length, [newParagraph]);
          }
          if (lines.length > 1) {
            console.log(`[Hocuspocus Integration] ✅ ${lines.length - 1} additional paragraphs created in '${fieldName}'`);
          }
        } else {
          // コンテンツなし: 各行を個別のパラグラフとして作成
          for (const line of lines) {
            const newParagraph = new Y.XmlElement('paragraph');
            const newTextNode = new Y.XmlText();
            newTextNode.insert(0, line);
            newParagraph.insert(0, [newTextNode]);
            fragment.insert(fragment.length, [newParagraph]);
          }
          console.log(`[Hocuspocus Integration] ✅ ${lines.length} paragraphs added as first content to '${fieldName}'`);
        }
        }); // document.transact（音声追記の単一トランザクション化）

        console.log(`[Hocuspocus Integration] ✅ Text added to XmlFragment '${fieldName}' in document: ${roomName} (${lines.length} lines)`);
      } else {
        console.log(`[Hocuspocus Integration] ⚠️ Document not found, creating via direct connection: ${roomName}`);

        // Create document using direct connection
        try {
          const directConnection = await hocuspocus.openDirectConnection(roomName, {});

          const directDoc = directConnection.document;
          const fieldName = `content-${sessionId}`;
          const fragment = directDoc.getXmlFragment(fieldName);

          // Create initial content - 改行で分割してパラグラフごとに挿入
          const Y = require('yjs');
          const dcLines = text.split('\n').filter(line => line.trim() !== '');
          for (const line of (dcLines.length > 0 ? dcLines : [text])) {
            const newParagraph = new Y.XmlElement('paragraph');
            const newTextNode = new Y.XmlText();
            newTextNode.insert(0, line);
            newParagraph.insert(0, [newTextNode]);
            fragment.insert(fragment.length, [newParagraph]);
          }

          console.log(`[Hocuspocus Integration] ✅ Document created and text added via direct connection: ${roomName} (${dcLines.length} lines)`);

          // Keep the connection alive for a short time to ensure sync
          setTimeout(() => {
            directConnection.disconnect();
            console.log(`[Hocuspocus Integration] 📤 Direct connection closed: ${roomName}`);
          }, 1000);

        } catch (directError) {
          console.error(`[Hocuspocus Integration] ❌ Failed to create document via direct connection:`, directError);

          // Debug: Show available documents
          const availableDocs = Array.from(hocuspocus.documents.keys());
          console.log(`[Hocuspocus Integration] Available documents (${availableDocs.length}):`, availableDocs);
        }
      }

    } catch (error) {
      console.error(`[Hocuspocus Integration] ❌ Error adding text to document:`, error);
    }
  }

  // Pending text accumulator per session
  const pendingTextBySession = new Map();

  // クライアント主認識（オンデバイス認識）のinterim用: pending textを全文置き換えで更新する。
  // Web Speechのinterimは毎回その時点の認識仮説の全文が届き、仮説は後続音声で修正（バックトラック）されうる
  // breaks: 未確定テキスト内の「改行（段落区切り）オフセット」配列（そとづけの区切り情報）。
  // greenLen: 先頭から greenLen 文字は「オンデバイス確定済・AI校正待ち（緑）」、以降は
  //           「オンデバイス未確定 interim（グレー）」。校正画面・認識画面で色分けに使う。
  //   （3状態: グレー=interim / 緑=rawBuffer(AI校正待ち) / 黒=AI確定済の共有doc）
  function setPendingText(sessionId, text, breaks = [], greenLen = 0) {
    try {
      if (!sessionId) return;
      // 同じ内容なら書き込まない（無駄なYjsブロードキャストの抑制）。greenLenも比較に含める。
      const dedupKey = `${greenLen} ${text}`;
      if (pendingTextBySession.get(sessionId) === dedupKey) return;
      pendingTextBySession.set(sessionId, dedupKey);
      const roomName = `transcribe-editor-v2-${sessionId}`;
      const document = hocuspocus.documents.get(roomName);
      if (document) {
        const statusMap = document.getMap(`status-${sessionId}`);
        // pendingText / pendingBreaks / pendingGreenLen を同一トランザクションで更新する
        document.transact(() => {
          statusMap.set('pendingText', text);
          statusMap.set('pendingBreaks', Array.isArray(breaks) ? breaks : []);
          statusMap.set('pendingGreenLen', Math.max(0, Math.min(greenLen, text.length)));
        });
      }
    } catch (error) {
      console.error(`[Hocuspocus Integration] ❌ Error setting pending text:`, error);
    }
  }

  // Function to clear pending text when transcription is completed
  function clearPendingText(sessionId) {
    try {
      if (!sessionId) return;

      // Clear accumulated text
      pendingTextBySession.delete(sessionId);

      const roomName = `transcribe-editor-v2-${sessionId}`;
      const document = hocuspocus.documents.get(roomName);

      if (document) {
        const statusMap = document.getMap(`status-${sessionId}`);
        document.transact(() => {
          statusMap.set('pendingText', '');
          statusMap.set('pendingBreaks', []);
          statusMap.set('pendingGreenLen', 0);
        });
        console.log(`[Hocuspocus Integration] 🧹 Pending text cleared`);
      }
    } catch (error) {
      console.error(`[Hocuspocus Integration] ❌ Error clearing pending text:`, error);
    }
  }

  // ===== 自動校正 =====
  // 前回校正済み位置から「最後から2番目」までの段落範囲に対して、誤字修正と
  // 冪等なパラグラフ整理を行う。最後の段落は音声の追記中のため対象に含めない。
  // 冪等性の担保: (1)同じ範囲は二度校正しない（doneParasで範囲を前進させる）
  //               (2)プロンプトで「既存の区切り維持・短い段落の再分割禁止」を指示

  // OpenAI Chat Completions を https 直叩きで呼ぶ。
  // openai SDK v5はfetchベースで HTTPS_PROXY / httpAgent を無視するため、
  // 企業プロキシ環境では接続できずタイムアウトする。WSプロキシと同じ
  // HttpsProxyAgent を使って確実にプロキシを通す
  function callChatCompletion(model, messages, { temperature = 0.2, maxTokens = 2048, timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens });
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        agent: process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined,
        timeout: timeoutMs,
      }, (res) => {
        // チャンクごとに文字列連結すると、マルチバイト文字(日本語=UTF-8 3バイト)がチャンク境界で
        // 分断されて文字化け(�)する。Bufferで蓄積し、末尾で一括してUTF-8デコードする。
        const chunks = [];
        res.on('data', (chunk) => { chunks.push(chunk); });
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          try {
            const json = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(`OpenAI API ${res.statusCode}: ${json.error?.message || data.slice(0, 200)}`));
              return;
            }
            resolve(json.choices?.[0]?.message?.content || '');
          } catch (parseError) {
            reject(new Error(`OpenAI API response parse error: ${parseError.message}`));
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`Request timed out (${timeoutMs}ms)`)); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function proofreadText(text, model, overlapText = '') {
    // 役割: 段落分割は機械処理(mechanicalSplit)が済ませている。AIは「誤って割れた行の結合」と
    // 「誤字・句読点」だけを担い、新たな分割はしない（ミス分割の結合に特化したプロンプト）。
    const systemPrompt = `あなたは日本語の会議文字起こしを整える校正アシスタントです。
【校正対象】には、機械処理で改行（段落区切り）が挿入されています。改行が正しい位置とは限らず、一文の途中で割れていることがあります。

最優先のルール（改行の扱い）:
- 機械改行は仮の区切りで、位置は不正確です。各行が「文末（句点。や！？で文が完結する位置）」で終わっているかで判断してください。音声認識は句読点を出力しないため、改行＝文末とは限りません。
- 文末で終わっていない行（体言止め・列挙の途中など、文がまだ続く／読点や助詞でつながる場合を含む）は、句読点を補いながら次の行と結合し、1つの文にしてください。「答え」「こと」などの名詞で終わっていても、文として完結していなければ結合します。
- 句点（。！？）で文が完結している行は、その段落区切りを維持します（完結文どうしを無理に1段落へまとめる必要はありません）。
- 文の途中に新たな改行（分割）は追加しません。

その他の校正:
- 音声認識の誤変換・誤字脱字を文脈に基づいて修正する
- 句読点（、。）を適切に補う（音声認識は句読点を出力しない）
- 内容の追加・削除・要約・言い換えはしない。文体（です・ます調など）も変えない
- 認識ミスらしく、正しい語を文脈から確信を持って復元できない語句は、推測で別の語に書き換えたり削除したりせず、元の認識結果のまま半角の [ ] で囲んで残す（例: 文の流れに合わない不明瞭な語 → [元の語]）。文の枠（「〜というところ」等）の中にあっても、その語自体に確信が持てなければ囲む。明確に直せる誤字脱字だけ修正する
- すでに [ ] で囲まれている箇所は変更せず、そのまま維持する（二重に囲まない）
- 末尾が文の途中なら勝手に完結させない（続きは次回送られてくる）

不明瞭語の扱いの例（認識ミスらしく正しい語が復元できない部分は [ ] で囲んで原文保持。削除も推測書き換えもしない）:
- 入力: それでですねぐぬぐぬあーっていう仕組みについて話します
- 出力: それでですね[ぐぬぐぬあー]という仕組みについて話します
- 入力: コストは[ふがふが]円くらいでした
- 出力: コストは[ふがふが]円くらいでした（すでに囲まれている箇所はそのまま）

入力:
- 【文脈】: 直前までに確定した校正テキストの末尾。つながり判断の参考のみ。変更・出力しない
- 【校正対象】: 今回整える、機械的に改行済みのテキスト

出力は【校正対象】を上記ルールで整えた結果のみ（段落区切りは改行1つで表す）。【文脈】やラベルは出力しない。`;

    const userContent = `【文脈】\n${overlapText || '（なし）'}\n\n【校正対象】\n${text}`;

    const content = await callChatCompletion(model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ], { temperature: 0.2, maxTokens: 4096, timeoutMs: 60000 });
    return content || text;
  }

  // 改行の保証（決定的なフォールバック）: モデルが段落分割を返さなかった場合に備えて、
  // 長すぎる段落は句点位置で機械的に分割する。400文字以下はそのまま返すため冪等
  function splitLongParagraph(paragraph, maxLength = 400, targetLength = 250) {
    if (paragraph.length <= maxLength) return [paragraph];
    const parts = [];
    let rest = paragraph;
    while (rest.length > maxLength) {
      // targetLength以降の最初の句点で区切る（見つからなければmaxLengthで強制分割）
      let cut = rest.indexOf('。', targetLength);
      if (cut === -1 || cut > maxLength * 1.5) {
        cut = maxLength;
      } else {
        cut += 1; // 句点を含める
      }
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    return parts;
  }

  // ===== 機械的パラグラフ分割（ヒューリスティクス） =====
  // AIに頼らず、無音ポーズ境界と「字数＋語境界」で確定テキストを段落に割る。
  // 過分割が起きうるが、その結合は後段のAI(proofreadText)が担う。
  const PAUSE_BREAK_MS = 1200; // この無音(ms)以上で段落区切りを入れる（クライアントのgapMs基準）
  const MECH_MAX_LINE = 120;   // 確定(AI校正)単位: この文字数を超えたら語境界で機械分割（結合品質を保つ単位）
  const REWRITE_CHARS = 80;     // AI補正: 再補正で「置き換える」末尾量（=青字＋編集不可の書き換え対象領域）
  const CONTEXT_CHARS = 80;     // AI補正: 書き換え対象の手前を【文脈】として渡す読み取り専用量（編集可・青字なし）
  const OVERLAP_MAX_PARAS = 12; // AI補正: 書き換え対象として置換する最大段落数（入力サイズ/コストの上限）
  let _jaWordSegmenter = null;
  function getJaWordSegmenter() {
    if (_jaWordSegmenter === null) {
      try {
        _jaWordSegmenter = new Intl.Segmenter('ja', { granularity: 'word' });
      } catch {
        _jaWordSegmenter = false; // 非対応環境では文字境界にフォールバック
      }
    }
    return _jaWordSegmenter || null;
  }

  // [from, to) の範囲で最後の句読点位置を返す（なければ -1）
  function findLastPunct(text, from, to) {
    let idx = -1;
    const limit = Math.min(to, text.length);
    for (let i = from; i < limit; i++) {
      if ('、。！？!?'.includes(text[i])) idx = i;
    }
    return idx;
  }

  // 1セグメントが maxLen を超える場合の、字数＋語境界の「切れ目オフセット」配列を返す
  // （句読点直後 → 語境界(Intl.Segmenter) → 強制 の優先順）。各行の開始位置。
  function wordBoundaryCuts(text, maxLen) {
    if (text.length <= maxLen) return [];
    const seg = getJaWordSegmenter();
    let boundaries = null;
    if (seg) {
      boundaries = [];
      for (const { index } of seg.segment(text)) boundaries.push(index);
      boundaries.push(text.length);
    }
    const cuts = [];
    let start = 0;
    while (text.length - start > maxLen) {
      const hard = start + maxLen;
      const punct = findLastPunct(text, start + Math.floor(maxLen / 2), hard);
      let cut;
      if (punct !== -1) {
        cut = punct + 1;
      } else if (boundaries) {
        const cand = boundaries.filter((b) => b > start && b <= hard);
        cut = cand.length > 0 ? cand[cand.length - 1] : hard;
      } else {
        cut = hard;
      }
      cuts.push(cut);
      start = cut;
    }
    return cuts;
  }

  // テキストに対する「機械的パラグラフ区切り」のオフセット配列（各行の開始位置）を返す。
  // 一次=無音ポーズ境界、二次=長いセグメントの字数＋語境界。未確定表示と確定で同一ロジックを使う。
  function mechanicalBreakOffsets(text, pauseOffsets = [], maxLen = MECH_MAX_LINE) {
    const pauseCuts = [...new Set(pauseOffsets)]
      .filter((o) => o > 0 && o < text.length)
      .sort((a, b) => a - b);
    const cuts = new Set(pauseCuts);
    const bounds = [0, ...pauseCuts, text.length];
    for (let i = 0; i < bounds.length - 1; i++) {
      const segStart = bounds[i];
      const seg = text.slice(segStart, bounds[i + 1]);
      for (const c of wordBoundaryCuts(seg, maxLen)) cuts.add(segStart + c);
    }
    return [...cuts].filter((c) => c > 0 && c < text.length).sort((a, b) => a - b);
  }

  // 緑(未確定)の表示用改行: 無音ポーズ境界のみを返す。横幅での折返しはクライアントが
  // 実際の描画幅・フォントを実測して行う（文字数ではなく見た目の1行ぴったりで改行）。
  function greenDisplayBreaks(text, pauseOffsets = []) {
    return [...new Set(pauseOffsets)]
      .filter((o) => o > 0 && o < text.length)
      .sort((a, b) => a - b);
  }

  // 指定オフセットでテキストを行配列に分割する（空行は除外）
  function splitAtOffsets(text, offsets) {
    const cuts = [...new Set(offsets)].filter((o) => o > 0 && o < text.length).sort((a, b) => a - b);
    const lines = [];
    let start = 0;
    for (const c of cuts) {
      const s = text.slice(start, c);
      if (s.trim()) lines.push(s);
      start = c;
    }
    const last = text.slice(start);
    if (last.trim()) lines.push(last);
    return lines;
  }

  // ポーズ境界＋字数/語境界で段落(行)配列に機械分割する（確定追記用）
  function mechanicalSplit(text, pauseOffsets = [], maxLen = MECH_MAX_LINE) {
    return splitAtOffsets(text, mechanicalBreakOffsets(text, pauseOffsets, maxLen));
  }

  // 指定インデックスの段落テキストを取得（段落でないノードはnull）
  function getParagraphTextByIndex(fragment, index) {
    const Y = require('yjs');
    const el = fragment.get(index);
    if (!el || !(el instanceof Y.XmlElement)) return null;
    let text = '';
    for (let i = 0; i < el.length; i++) {
      const child = el.get(i);
      if (child instanceof Y.XmlText) text += child.toString();
    }
    return text;
  }

  // オーバーラップ補正用: 末尾の deleteCount 段落を削除し、text（改行区切り）を新段落として追記する。
  // 削除と追記を単一トランザクションにまとめ、speechAppendSeq を更新して編集追跡（下線）の対象から除外する。
  async function replaceTailParagraphs(sessionId, deleteCount, text) {
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) return;
    const roomName = `transcribe-editor-v2-${sessionId}`;
    const document = hocuspocus.documents.get(roomName);
    if (!document) {
      // ドキュメント未生成時は通常の追記にフォールバック
      await sendTextToHocuspocusDocument(sessionId, text, false, true);
      return;
    }
    const Y = require('yjs');
    const fieldName = `content-${sessionId}`;
    const fragment = document.getXmlFragment(fieldName);
    document.transact(() => {
      const statusMap = document.getMap(`status-${sessionId}`);
      statusMap.set('speechAppendSeq', (statusMap.get('speechAppendSeq') || 0) + 1);
      // 置換対象（末尾deleteCount段落）を削除。await中に人が編集した場合に備え現在長で丸める。
      const del = Math.max(0, Math.min(deleteCount, fragment.length));
      if (del > 0) fragment.delete(fragment.length - del, del);
      // 再補正結果（オーバーラップ＋緑）を新段落として追記
      for (const line of lines) {
        const paragraph = new Y.XmlElement('paragraph');
        const textNode = new Y.XmlText();
        textNode.insert(0, line);
        paragraph.insert(0, [textNode]);
        fragment.insert(fragment.length, [paragraph]);
      }
      // この書き込み後、次回のAI再補正が上書きする末尾段落数（=校正画面で編集禁止＋青字にする範囲）を公開
      let _acc = 0, _tail = 0;
      for (let idx = fragment.length - 1; idx >= 0 && _acc < REWRITE_CHARS && _tail < OVERLAP_MAX_PARAS; idx--) {
        const t = getParagraphTextByIndex(fragment, idx);
        if (t === null) break;
        _acc += t.length; _tail++;
      }
      statusMap.set('proofreadTailParas', _tail);
    });
    console.log(`[Auto-Proofread] 🔁 末尾${deleteCount}段落を置換し${lines.length}段落を確定 ('${fieldName}')`);
  }

  // AI再補正で上書きされる末尾段落数を共有docへ公開（校正画面の編集禁止＋青字の範囲）。0で解除。
  function setProofreadTailParas(sessionId, count) {
    if (!sessionId) return;
    const document = hocuspocus.documents.get(`transcribe-editor-v2-${sessionId}`);
    if (!document) return;
    const statusMap = document.getMap(`status-${sessionId}`);
    document.transact(() => { statusMap.set('proofreadTailParas', Math.max(0, count | 0)); });
  }

  // バッファ方式の自動校正:
  // ローカル認識の確定テキストは（自動校正ON時）直接ドキュメントへは書かず、
  // サーバ側バッファ（state.rawBuffer）に溜める。一定量たまったら、送信済み校正
  // テキストの末尾（state.sentTail）をオーバーラップ文脈としてAI校正（誤字修正・
  // 句読点補完・段落分け）し、校正結果だけを「次の確定文」として共有ドキュメントへ
  // 追記する。ドキュメントの置き換えを行わないため、人の編集との競合が原理的に
  // 発生しない（オーバーラップ部分は送信済みなので再送信しない）
  async function maybeAutoProofread(sessionId, clientWs, state) {
    if (!state.enabled || state.inFlight || !sessionId) return;
    const now = Date.now();
    if (now - state.lastRunAt < 5000) return; // 最短実行間隔5秒（緑→黒の確定を高頻度化）

    const MAX_TARGET_CHARS = 1500; // 1回の校正対象上限（大きすぎるとAPIタイムアウト）

    // 確定対象は「緑範囲（rawBuffer）の最後のヒューリスティクス改行まで」に限定する。
    // 最後の改行より後ろ＝今まさに話している部分なので、AI（結合・修正）にも確定にもかけず、
    // 緑のまま残す。録音停止後など12秒更新がなければ、ライブ末尾も無くなったとみなして全量を確定する。
    const stale = state.lastBufferChangeAt > 0 && now - state.lastBufferChangeAt > 12000;
    let targetLen;
    if (stale) {
      if (state.rawBuffer.length < 10) return;
      targetLen = state.rawBuffer.length;
    } else {
      const breaks = mechanicalBreakOffsets(state.rawBuffer, state.pausePositions, MECH_MAX_LINE);
      if (breaks.length === 0) return; // まだ区切りがない＝全体がライブ末尾。確定しない
      targetLen = breaks[breaks.length - 1]; // 最後の改行まで（その後ろは緑のまま残す）
      if (targetLen > MAX_TARGET_CHARS) {
        // 上限超過時は MAX 以内の最後の改行位置まで（区切りで切る）
        const within = breaks.filter((b) => b <= MAX_TARGET_CHARS);
        targetLen = within.length ? within[within.length - 1] : MAX_TARGET_CHARS;
      }
    }
    const target = state.rawBuffer.slice(0, targetLen);

    state.inFlight = true;
    state.lastRunAt = now;
    try {
      console.log(`[Auto-Proofread] 🪄 校正開始: ${target.length}文字（バッファ${state.rawBuffer.length}文字, model=${state.model}）`);
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({
          type: 'auto_proofread_started',
          chars: target.length
        }));
      }

      // ① 新しい緑（target）を機械的パラグラフ分割（無音ポーズ境界＋字数/語境界）。
      const pausesInTarget = state.pausePositions.filter((p) => p > 0 && p < target.length);
      const mechLines = mechanicalSplit(target, pausesInTarget);
      const greenSplit = mechLines.length > 0 ? mechLines.join('\n') : target;

      // ② オーバーラップを2分割して既確定テキストから読み戻す：
      //    (a) 書き換え対象（末尾・累計REWRITE_CHARS字）＝再補正して置換する＝青字＋編集不可。
      //    (b) 文脈（その手前・累計CONTEXT_CHARS字）＝AIに【文脈】として渡すだけで上書きしない＝編集可・青字なし。
      const rewriteLines = [];
      let overlapDeleteCount = 0; // 置換する末尾段落数（=青/ロック領域）
      let contextBefore = '';
      const proofDoc = hocuspocus.documents.get(`transcribe-editor-v2-${sessionId}`);
      if (proofDoc) {
        const proofFragment = proofDoc.getXmlFragment(`content-${sessionId}`);
        let idx = proofFragment.length - 1;
        // (a) 書き換え対象：末尾から累計REWRITE_CHARS字（最大OVERLAP_MAX_PARAS段落）
        let acc = 0;
        for (; idx >= 0 && acc < REWRITE_CHARS && overlapDeleteCount < OVERLAP_MAX_PARAS; idx--) {
          const t = getParagraphTextByIndex(proofFragment, idx);
          if (t === null) break; // 段落以外（画像等）に当たったら打ち切り
          rewriteLines.unshift(t);
          acc += t.length;
          overlapDeleteCount++;
        }
        // (b) 文脈：さらに手前の段落を累計CONTEXT_CHARS字まで（読み取り専用・出力されない・編集可）
        let cacc = 0;
        for (; idx >= 0 && cacc < CONTEXT_CHARS; idx--) {
          const t = getParagraphTextByIndex(proofFragment, idx);
          if (t === null) break;
          contextBefore = t + (contextBefore ? '\n' + contextBefore : '');
          cacc += t.length;
        }
      }

      // ③ AI補正の入力 = 書き換え対象（既確定・再補正対象）＋新しい緑。空段落は入力から除外する。
      const rewriteForInput = rewriteLines.filter((l) => l.trim() !== '');
      const combinedInput = rewriteForInput.length > 0
        ? rewriteForInput.join('\n') + '\n' + greenSplit
        : greenSplit;
      const rewriteChars = rewriteLines.reduce((n, l) => n + l.length, 0);
      console.log(`[Auto-Proofread] ✂️ 機械分割: 緑${mechLines.length}行 + 書き換え対象${overlapDeleteCount}段落(${rewriteChars}字) + 文脈${contextBefore.length}字`);

      // ④ AIは「ミス分割の結合＋誤字・句読点」のみ（新たな分割はしない）
      const result = await proofreadText(combinedInput, state.model, contextBefore);

      // 改行の保証: AIが結合しすぎて巨大段落になった場合の安全弁（長すぎる段落は句点で分割）
      const newParas = result
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .flatMap((p) => splitLongParagraph(p));
      if (newParas.length === 0) return;
      const outText = newParas.join('\n');

      // ⑤ 書き換え対象（末尾overlapDeleteCount段落）を削除し、再補正結果（書き換え対象＋緑）を
      //    新段落として追記して置き換える（単一トランザクション）。対象が空＝初回は実質追記になる。
      await replaceTailParagraphs(sessionId, overlapDeleteCount, outText);
      state.lastOutEndedSentence = /[。．！？!?]\s*$/.test(outText);

      // 校正済み分をバッファから取り除き、文脈用の送信済み末尾を更新する
      state.rawBuffer = state.rawBuffer.slice(target.length);
      // ポーズ境界も消費分だけ前方シフト（負になったものは破棄）
      state.pausePositions = state.pausePositions
        .map((p) => p - target.length)
        .filter((p) => p > 0);
      state.sentTail = (state.sentTail + outText.replace(/\n/g, '')).slice(-300);

      // 校正画面の未確定（グレー）表示を更新（バッファが減ったため）。区切り情報も添える。
      {
        const pt = state.rawBuffer + state.pendingInterim;
        setPendingText(sessionId, pt, greenDisplayBreaks(state.rawBuffer, state.pausePositions), state.rawBuffer.length);
      }

      console.log(`[Auto-Proofread] ✅ 校正完了: ${newParas.length}段落を確定/置換（残バッファ${state.rawBuffer.length}文字）`);
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({
          type: 'auto_proofread_completed',
          paragraphs: newParas.length,
          chars: outText.length
        }));
      }
    } catch (error) {
      console.error('[Auto-Proofread] ❌ 校正エラー:', error);
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ type: 'auto_proofread_error', error: error.message }));
      }
    } finally {
      state.inFlight = false;
    }
  }

  server.listen(port, hostname, () => {
    const displayHost = hostname === '0.0.0.0' ? 'localhost' : hostname;
    console.log(`🚀 Server ready at http://${displayHost}:${port}/collarecox`);
    console.log(`📡 Hocuspocus WebSocket ready at ws://${displayHost}:${port}/collarecox/api/yjs-ws`);
    console.log(`🎤 Realtime Audio WebSocket ready at ws://${displayHost}:${port}/collarecox/api/realtime-ws`);
    console.log(`🌐 Next.js UI available at http://${displayHost}:${port}/collarecox`);
  });

  // Graceful shutdown: close WebSocket servers and HTTP server
  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    realtimeWss.close(() => console.log('Realtime WebSocket server closed'));
    yjsWss.close(() => console.log('YJS WebSocket server closed'));
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    // Force exit after 5 seconds if graceful shutdown stalls
    setTimeout(() => process.exit(1), 5000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
