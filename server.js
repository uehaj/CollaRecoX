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
    
    // Audio buffer tracking
    let audioBufferDuration = 0; // in milliseconds
    let lastAudioTimestamp = Date.now();
    let accumulatedSilenceDuration = 0; // 累積無音時間（ms）- 有音チャンクでリセット
    let audioChunkCount = 0;
    let autoCommitTimer = null;
    let paragraphBreakTimer = null; // Timer for delayed paragraph break detection
    let responseInProgress = false;
    let lastCommitTime = 0; // Prevent too frequent commits
    let isDummyAudioSending = false; // Flag to prevent duplicate dummy audio sends
    let dummyAudioTimeoutId = null; // Timeout ID for stopping dummy audio sending
    
    // Transcription prompt tracking
    let transcriptionPrompt = '';
    
    // Transcription model tracking
    let transcriptionModel = 'gpt-4o-transcribe'; // Default model
    
    // Speech break detection settings
    let speechBreakDetection = false;
    let speechBreakMarker = '↩️'; // デフォルト: 改行絵文字

    // VAD parameters - controls when OpenAI detects speech end (Server VAD mode only)
    // vadSilenceDuration: OpenAI's VAD will fire speech_stopped after this much silence
    let vadEnabled = true; // VAD enabled/disabled (default: true)
    let localPendingCount = 0; // local_pending受信数（ログ間引き用）
    let vadThreshold = 0.2;
    let vadSilenceDuration = 600; // VAD発話終了判定時間: OpenAIがspeech_stoppedを発火する無音時間（推奨: 500-700ms）
    let vadPrefixPadding = 300;

    // Paragraph break threshold - controls when to insert paragraph break marker
    // This is independent from VAD silence duration
    // Paragraph break is inserted only when actual silence gap >= this threshold
    let paragraphBreakThreshold = 2500; // パラグラフ区切り判定時間: この時間以上の無音でマーカー挿入（推奨: 2000-2500ms）

    // Auto-rewrite on paragraph break - automatically rewrite the completed paragraph
    let autoRewriteOnParagraphBreak = false; // デフォルト: 無効

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
    };
    let rewriteModel = 'gpt-4.1-mini'; // AI再編モデル（デフォルト: gpt-4.1-mini）

    // Force line break at period - adds newline after each Japanese period (。)
    let forceLineBreakAtPeriod = true; // デフォルト: 有効

    // Auto-commit threshold (milliseconds) - can be adjusted by client
    let autoCommitThresholdMs = 5000; // Default: 5 seconds for VA-Cable testing (longer segments = better transcription)
    let autoCommitTimerDelayMs = 3000; // Default: 3 seconds delay before timer-commit
    let audioBufferSize = 4096; // Default buffer size
    let batchMultiplier = 8; // Default batch multiplier

    // Session management for Hocuspocus integration
    let currentSessionId = null;
    let forceCommitObserver = null; // Store observer function for cleanup
    let forceCommitStatusMap = null; // Store statusMap reference for cleanup

    // Use Realtime API GA transcription session (no realtime model billed)
    const openaiUrl = 'wss://api.openai.com/v1/realtime?intent=transcription';
    console.log('Connecting to OpenAI Realtime API (transcription session):', openaiUrl);

    // Create proxy agent if HTTPS_PROXY is set
    const proxyAgent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined;

    const openaiWs = new WebSocket(openaiUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      agent: proxyAgent
    });

    // Function to create session configuration (GA transcription session shape)
    const createSessionConfig = (prompt = '', asrModel = 'gpt-4o-transcribe') => ({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: {
              model: asrModel,  // Use dedicated ASR model (gpt-4o-transcribe)
              language: 'ja',   // Explicitly specify Japanese to prevent other language detection
              ...(prompt ? { prompt: prompt } : {})
            },
            // Conditionally enable/disable VAD based on vadEnabled flag
            turn_detection: vadEnabled ? {
              type: 'server_vad',
              threshold: vadThreshold,
              prefix_padding_ms: vadPrefixPadding,
              silence_duration_ms: vadSilenceDuration
            } : null  // null = disable VAD
          }
        }
      }
    });

    // Initial session configuration (will be updated when prompt/model is received)
    let sessionConfig = createSessionConfig(transcriptionPrompt, transcriptionModel);

    openaiWs.on('open', () => {
      console.log('🔗 Connected to OpenAI Realtime API');
      console.log('📋 Sending session config:', JSON.stringify(sessionConfig, null, 2));
      openaiWs.send(JSON.stringify(sessionConfig));
      
      // Send ready signal to client
      clientWs.send(JSON.stringify({
        type: 'ready',
        message: 'Connected to OpenAI Realtime API'
      }));
    });

    openaiWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log('OpenAI message type:', message.type);
        
        // Handle different message types
        switch (message.type) {
          case 'session.created':
            console.log('OpenAI session created:', message.session?.id || 'unknown');
            break;
            
          case 'session.updated':
            console.log('OpenAI session updated successfully');
            break;
            
          case 'conversation.item.created':
            console.log('Conversation item created:', message.item?.id);
            break;
            
          case 'conversation.item.input_audio_transcription.completed':
            console.log('✅ Audio transcription completed:', message.transcript);
            responseInProgress = false; // Reset response flag

            // Clear any pending auto-commit timer to prevent race condition
            if (autoCommitTimer) {
              clearTimeout(autoCommitTimer);
              autoCommitTimer = null;
              console.log('🧹 Cleared auto-commit timer after transcription completion');
            }

            // Reset buffer tracking after successful transcription
            audioBufferDuration = 0;
            audioChunkCount = 0;
            console.log('Buffer reset after transcription completion');
            
            // Apply force line break at period processing if enabled
            let processedTranscript = message.transcript;
            if (forceLineBreakAtPeriod && processedTranscript) {
              processedTranscript = processedTranscript.replace(/。/g, '。\n');
              console.log('📝 Applied force line break at period');
            }

            // Send the actual transcription to client
            clientWs.send(JSON.stringify({
              type: 'transcription',
              text: processedTranscript,
              item_id: message.item_id
            }));

            // Note: dummy_audio_completed is now sent from sendDummyAudioData when all chunks are sent

            // Send text to Hocuspocus document if session is active
            console.log(`[Debug] currentSessionId: "${currentSessionId}", processedTranscript: "${processedTranscript}"`);
            if (currentSessionId && processedTranscript) {
              sendTextToHocuspocusDocument(currentSessionId, processedTranscript);
              // Clear pending text after transcription is complete
              clearPendingText(currentSessionId);
              // 自動校正のトリガー（実行条件は関数内で判定）
              maybeAutoProofread(currentSessionId, clientWs, autoProofreadState)
                .catch((e) => console.error('[Auto-Proofread] ❌ trigger error:', e));
            } else {
              console.log(`[Debug] ❌ Hocuspocus integration NOT triggered - currentSessionId: ${currentSessionId ? 'SET' : 'UNDEFINED'}, transcript: ${processedTranscript ? 'HAS_CONTENT' : 'EMPTY'}`);
            }
            break;
            
          case 'conversation.item.input_audio_transcription.failed':
            console.log('Transcription failed:', message.error);
            responseInProgress = false; // Reset response flag on failure

            // Clear any pending auto-commit timer to prevent race condition
            if (autoCommitTimer) {
              clearTimeout(autoCommitTimer);
              autoCommitTimer = null;
              console.log('🧹 Cleared auto-commit timer after transcription failure');
            }

            clientWs.send(JSON.stringify({
              type: 'transcription_error',
              error: message.error?.message || 'Transcription failed',
              item_id: message.item_id
            }));
            break;
            
          case 'input_audio_buffer.committed':
            console.log('✅ Audio buffer committed successfully:', message.item_id);
            break;
            
          case 'conversation.item.input_audio_transcription.started':
            console.log('🎤 Audio transcription started:', message.item_id);
            break;

          case 'conversation.item.input_audio_transcription.delta':
            // Forward partial transcription to client for "recognition in progress" display
            console.log('🔤 Transcription delta:', message.delta, '(item_id:', message.item_id, ')');
            if (message.delta) {
              clientWs.send(JSON.stringify({
                type: 'transcription_delta',
                delta: message.delta,
                item_id: message.item_id
              }));
              // Also broadcast pending text to collaborative editor via Yjs
              if (currentSessionId) {
                updatePendingText(currentSessionId, message.delta);
              }
            }
            break;

          case 'input_audio_buffer.cleared':
            console.log('Audio buffer cleared');
            break;
            
          case 'input_audio_buffer.speech_started':
            console.log('Speech detected');
            // Cancel pending paragraph break timer (speech resumed before threshold reached)
            if (paragraphBreakTimer) {
              clearTimeout(paragraphBreakTimer);
              paragraphBreakTimer = null;
              console.log('⏹️ Cancelled pending paragraph break timer (speech resumed)');
            }
            // Reset accumulated silence when speech starts
            accumulatedSilenceDuration = 0;

            clientWs.send(JSON.stringify({
              type: 'speech_started',
              audio_start_ms: message.audio_start_ms,
              item_id: message.item_id
            }));
            // Update transcription status in Hocuspocus document
            if (currentSessionId) {
              updateTranscriptionStatus(currentSessionId, true);
            }
            break;
            
          case 'input_audio_buffer.speech_stopped':
            // VAD fires speech_stopped after detecting vadSilenceDuration ms of silence
            // Use the larger of: accumulated silence OR vadSilenceDuration (VAD's minimum)
            const silenceGapMs = Math.max(accumulatedSilenceDuration, vadSilenceDuration);
            console.log(`Speech ended (accumulated: ${accumulatedSilenceDuration.toFixed(0)}ms, VAD min: ${vadSilenceDuration}ms, using: ${silenceGapMs.toFixed(0)}ms, paragraph threshold: ${paragraphBreakThreshold}ms)`);

            // Send speech_stopped to client immediately
            clientWs.send(JSON.stringify({
              type: 'speech_stopped',
              audio_end_ms: message.audio_end_ms,
              item_id: message.item_id,
              marker: speechBreakDetection ? speechBreakMarker : null,
              silence_gap_ms: silenceGapMs,
              silence_threshold_ms: paragraphBreakThreshold
            }));

            // For paragraph breaks: if current silence is already enough, insert immediately
            // Otherwise, set a timer to wait for more silence and insert if speech doesn't resume
            if (speechBreakDetection && silenceGapMs >= paragraphBreakThreshold) {
              console.log(`🔸 Immediate paragraph break (silence: ${silenceGapMs.toFixed(0)}ms >= threshold: ${paragraphBreakThreshold}ms)`);
              // Send marker to client for text display
              clientWs.send(JSON.stringify({
                type: 'paragraph_break',
                marker: speechBreakMarker
              }));
              if (currentSessionId) {
                createParagraphBreak(currentSessionId, speechBreakMarker);
                // Auto-rewrite the completed paragraph if enabled
                if (autoRewriteOnParagraphBreak) {
                  autoRewriteLastParagraph(currentSessionId, clientWs, rewriteModel);
                }
              }
            } else if (speechBreakDetection && paragraphBreakThreshold > vadSilenceDuration) {
              // Set a delayed timer to insert paragraph break if silence continues
              const remainingWaitMs = paragraphBreakThreshold - silenceGapMs;
              console.log(`⏳ Waiting ${remainingWaitMs}ms more for paragraph break...`);

              // Store the timer so we can cancel it if speech_started fires
              if (paragraphBreakTimer) {
                clearTimeout(paragraphBreakTimer);
              }
              paragraphBreakTimer = setTimeout(() => {
                console.log(`🔸 Delayed paragraph break after ${paragraphBreakThreshold}ms total silence`);
                clientWs.send(JSON.stringify({
                  type: 'paragraph_break',
                  marker: speechBreakMarker
                }));
                if (currentSessionId) {
                  createParagraphBreak(currentSessionId, speechBreakMarker);
                  // Auto-rewrite the completed paragraph if enabled
                  if (autoRewriteOnParagraphBreak) {
                    autoRewriteLastParagraph(currentSessionId, clientWs, rewriteModel);
                  }
                }
                paragraphBreakTimer = null;
              }, remainingWaitMs);
            }
            // Clear transcription status (will be confirmed in transcription_completed)
            if (currentSessionId) {
              updateTranscriptionStatus(currentSessionId, false);
            }
            break;
            
          case 'response.created':
            console.log('Response created:', message.response?.id);
            break;
            
          case 'response.done':
            console.log('Response completed:', message.response?.id);
            responseInProgress = false; // Reset response flag when response is done
            break;
            
          case 'rate_limits.updated':
            // Handle rate limit updates silently
            console.log('Rate limits updated');
            break;
            
          case 'response.output_item.added':
            console.log('Output item added:', message.item?.type);
            break;
            
          case 'response.text.delta':
            // Handle streaming text deltas
            if (message.delta) {
              console.log('Text delta received:', message.delta);
              // Don't reset response flag - text is still streaming
            }
            break;
            
          case 'response.text.done':
            // Text streaming completed
            console.log('Text streaming completed');
            // Don't reset response flag yet - wait for content_part.done
            break;
            
          case 'response.content_part.added':
            if (message.part?.type === 'text') {
              console.log('Text content added:', message.part.text);
            }
            break;
            
          case 'response.content_part.done':
            if (message.part?.type === 'text') {
              console.log('⚠️ Text response completed (ignoring for transcription):', message.part.text);
              responseInProgress = false; // Reset response flag
              
              // Don't send generic text responses to client - only real transcriptions
              // The actual transcriptions come from conversation.item.input_audio_transcription.completed
            }
            break;
            
          case 'response.output_item.done':
            console.log('Output item completed:', message.item?.id);
            // Don't reset response flag - wait for response.done
            break;
            
          case 'error':
            console.log('OpenAI API error:', message.error);
            responseInProgress = false; // Reset response flag on error

            // Handle buffer-related errors gracefully
            if (message.error && message.error.message && message.error.message.includes('buffer')) {
              // This is expected when Server VAD auto-commits an already-committed buffer
              // Just log as warning and don't send to client (it's not a real error)
              console.log('⚠️  Buffer-related warning (expected with Server VAD):', message.error.message);
              console.log('📝 This occurs when OpenAI VAD tries to auto-commit after manual commit - not a problem');
              audioBufferDuration = 0;
              audioChunkCount = 0;
              // Clear any pending timer
              if (autoCommitTimer) {
                clearTimeout(autoCommitTimer);
                autoCommitTimer = null;
              }
              // Don't send this error to client - it's not a user-facing issue
              break;
            }

            // Send other errors to client
            clientWs.send(JSON.stringify({
              type: 'error',
              error: message.error?.message || 'Unknown error from OpenAI'
            }));
            break;
            
          default:
            // Log other message types for debugging
            console.log('Unhandled OpenAI message type:', message.type);
            
            // Don't automatically reset response flag - let specific handlers manage it
            // Only reset on actual error conditions, not unknown message types
        }
      } catch (error) {
        console.error('Error parsing OpenAI message:', error);
        // Reset response flag on parsing error
        responseInProgress = false;
      }
    });

    openaiWs.on('error', (error) => {
      console.error('OpenAI WebSocket error:', error);
      clientWs.send(JSON.stringify({
        type: 'error',
        error: 'Connection to OpenAI failed: ' + error.message
      }));
    });

    openaiWs.on('close', () => {
      console.log('OpenAI WebSocket closed');
      clientWs.close();
    });

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

              // Set up forceCommit observer on statusMap
              // Clean up previous observer if exists
              if (forceCommitObserver && forceCommitStatusMap) {
                try {
                  forceCommitStatusMap.unobserve(forceCommitObserver);
                  console.log(`[Yjs] 🧹 Cleaned up previous forceCommit observer`);
                } catch (cleanupError) {
                  console.warn(`[Yjs] ⚠️ Failed to clean up previous observer:`, cleanupError);
                }
              }

              try {
                const roomName = `transcribe-editor-v2-${message.sessionId}`;
                const document = hocuspocus.documents.get(roomName);
                if (document) {
                  const statusMap = document.getMap(`status-${message.sessionId}`);

                  // Create observer function and store reference for cleanup
                  forceCommitObserver = (event) => {
                    const forceCommit = statusMap.get('forceCommit');
                    if (forceCommit === true) {
                      console.log(`[Yjs] 🎤 Force commit requested for session ${message.sessionId}`);
                      statusMap.set('forceCommit', false); // Reset immediately

                      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        openaiWs.send(JSON.stringify({
                          type: 'input_audio_buffer.commit'
                        }));
                        console.log('[Server] 🎤 Force commit sent to OpenAI');
                      } else {
                        console.log('[Server] ⚠️ No active OpenAI connection for force commit');
                      }
                    }
                  };
                  forceCommitStatusMap = statusMap;

                  statusMap.observe(forceCommitObserver);
                  console.log(`[Yjs] 👀 ForceCommit observer set up for session ${message.sessionId}`);
                } else {
                  console.log(`[Yjs] ⚠️ Document not found for forceCommit observer: ${roomName}`);
                }
              } catch (observerError) {
                console.error(`[Yjs] ❌ Error setting up forceCommit observer:`, observerError);
              }
            } else {
              console.log(`[Debug] ❌ set_session_id message received but sessionId is empty:`, message);
            }
            break;
            
          case 'set_prompt':
            // Update transcription prompt
            if (message.prompt !== undefined) {
              transcriptionPrompt = message.prompt;
              console.log('📝 Received transcription prompt:', transcriptionPrompt || '(empty)');
              
              // Update session configuration with new prompt
              sessionConfig = createSessionConfig(transcriptionPrompt, transcriptionModel);
              
              // Send updated session config to OpenAI if connection is open
              if (openaiWs.readyState === 1) { // WebSocket.OPEN
                console.log('🔄 Updating OpenAI session with new prompt...');
                openaiWs.send(JSON.stringify(sessionConfig));
                console.log('✅ Session updated with transcription prompt');
              }
            }
            break;
            
          case 'set_transcription_model':
            // Update transcription model
            if (message.model) {
              const validTranscriptionModels = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];
              if (validTranscriptionModels.includes(message.model)) {
                transcriptionModel = message.model;
                console.log('🎤 Received transcription model:', transcriptionModel);
                
                // Update session configuration with new model
                sessionConfig = createSessionConfig(transcriptionPrompt, transcriptionModel);
                
                // Send updated session config to OpenAI if connection is open
                if (openaiWs.readyState === 1) { // WebSocket.OPEN
                  console.log('🔄 Updating OpenAI session with new transcription model...');
                  openaiWs.send(JSON.stringify(sessionConfig));
                  console.log('✅ Session updated with transcription model');
                }
              } else {
                console.error('❌ Invalid transcription model:', message.model);
                clientWs.send(JSON.stringify({
                  type: 'error',
                  error: `Invalid transcription model. Use: ${validTranscriptionModels.join(', ')}`
                }));
              }
            }
            break;
            
          case 'set_speech_break_detection':
            // Update speech break detection settings
            if (message.enabled !== undefined) {
              speechBreakDetection = message.enabled;
              console.log('🔸 Speech break detection enabled:', speechBreakDetection);
            }
            if (message.marker) {
              speechBreakMarker = message.marker;
              console.log('🔸 Speech break marker set to:', speechBreakMarker);
            }
            break;
            
          case 'set_vad_params':
            // Update VAD parameters (with validation to prevent null values)
            // VAD発話終了判定時間: OpenAIがspeech_stoppedを発火する無音時間
            if (message.enabled !== undefined) {
              vadEnabled = message.enabled;
              console.log('🎛️ VAD enabled set to:', vadEnabled);
            }
            if (message.threshold !== undefined && message.threshold !== null && typeof message.threshold === 'number') {
              vadThreshold = Math.max(0.0, Math.min(1.0, Number(message.threshold))); // Ensure number and clamp to 0.0-1.0
              console.log('🎛️ VAD threshold set to:', vadThreshold);
            }
            if (message.silence_duration_ms !== undefined && message.silence_duration_ms !== null && typeof message.silence_duration_ms === 'number') {
              vadSilenceDuration = Math.max(200, Math.min(10000, Number(message.silence_duration_ms))); // Ensure number and clamp to valid range
              console.log('🎛️ VAD発話終了判定時間 set to:', vadSilenceDuration + 'ms');
            }
            if (message.prefix_padding_ms !== undefined && message.prefix_padding_ms !== null && typeof message.prefix_padding_ms === 'number') {
              vadPrefixPadding = Math.max(0, Math.min(2000, Number(message.prefix_padding_ms))); // Ensure number and clamp to 0-2000
              console.log('🎛️ VAD prefix padding set to:', vadPrefixPadding + 'ms');
            }
            // パラグラフ区切り判定時間: この時間以上の無音でマーカー挿入
            if (message.paragraph_break_threshold_ms !== undefined && message.paragraph_break_threshold_ms !== null && typeof message.paragraph_break_threshold_ms === 'number') {
              paragraphBreakThreshold = Math.max(500, Math.min(30000, Number(message.paragraph_break_threshold_ms))); // Ensure number and clamp to 500-30000
              console.log('📝 パラグラフ区切り判定時間 set to:', paragraphBreakThreshold + 'ms');
            }

            // Update session configuration with new VAD parameters
            sessionConfig = createSessionConfig(transcriptionPrompt, transcriptionModel);

            // Send updated session config to OpenAI if connection is open
            if (openaiWs.readyState === 1) { // WebSocket.OPEN
              console.log('🔄 Updating OpenAI session with new VAD parameters...');
              openaiWs.send(JSON.stringify(sessionConfig));
              console.log('✅ Session updated with VAD parameters');
            }
            break;

          case 'set_auto_rewrite':
            // Update auto-rewrite on paragraph break setting
            if (message.enabled !== undefined) {
              autoRewriteOnParagraphBreak = message.enabled;
              console.log('🔄 Auto-rewrite on paragraph break:', autoRewriteOnParagraphBreak ? 'enabled' : 'disabled');
            }
            // Update rewrite model
            if (message.model) {
              const validRewriteModels = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];
              if (validRewriteModels.includes(message.model)) {
                rewriteModel = message.model;
                console.log('🤖 Rewrite model set to:', rewriteModel);
              } else {
                console.error('❌ Invalid rewrite model:', message.model);
                clientWs.send(JSON.stringify({
                  type: 'error',
                  error: `Invalid rewrite model. Use: ${validRewriteModels.join(', ')}`
                }));
              }
            }
            break;

          case 'set_force_line_break':
            // Update force line break at period setting
            if (message.enabled !== undefined) {
              forceLineBreakAtPeriod = message.enabled;
              console.log('📝 Force line break at period:', forceLineBreakAtPeriod ? 'enabled' : 'disabled');
            }
            break;

          case 'set_commit_threshold':
            // Update auto-commit threshold from client
            if (message.threshold_ms !== undefined && message.threshold_ms > 0) {
              autoCommitThresholdMs = message.threshold_ms;
              autoCommitTimerDelayMs = Math.max(autoCommitThresholdMs * 2, 2000); // At least 2 seconds
              if (message.buffer_size !== undefined) {
                audioBufferSize = message.buffer_size;
              }
              if (message.batch_multiplier !== undefined) {
                batchMultiplier = message.batch_multiplier;
              }
              console.log(`⏱️ Auto-commit threshold set to: ${autoCommitThresholdMs}ms (buffer: ${audioBufferSize}, batch: ${batchMultiplier}, timer delay: ${autoCommitTimerDelayMs}ms)`);
            }
            break;
            
          case 'audio_chunk':
            // Only process if we have actual audio data
            if (!message.audio || message.audio.length === 0) {
              console.warn('Received empty audio chunk, skipping');
              return;
            }
            
            // Validate audio data first
            const audioData = Buffer.from(message.audio, 'base64');
            // Node.js Bufferの共有プール問題とbyteOffsetアライメント問題を回避
            // audioData.bufferは共有プールを指す可能性があり、byteOffsetが2バイト境界でない場合、
            // Int16Arrayの読み取りが正しく動作しない
            const arrayBuffer = audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.length);
            const int16Array = new Int16Array(arrayBuffer);
            // Use loop instead of spread operator to avoid stack overflow with large arrays
            let maxSample = 0;
            let sumSample = 0;
            for (let i = 0; i < int16Array.length; i++) {
              const absVal = Math.abs(int16Array[i]);
              if (absVal > maxSample) maxSample = absVal;
              sumSample += absVal;
            }
            const avgSample = sumSample / int16Array.length;
            
            audioChunkCount++;

            // Log silent audio chunks but don't skip (for accurate VAD detection)
            // Track accumulated silence duration for paragraph break detection
            const sampleDurationMs = (audioData.length / 2 / 24000) * 1000; // ms per chunk at 24kHz
            if (maxSample < 100) {
              // Silent chunk - accumulate silence duration
              accumulatedSilenceDuration += sampleDurationMs;
              // 低遅延設定（約43ms間隔）ではチャンク毎のログがI/O負荷になるため間引く
              if (audioChunkCount <= 5 || audioChunkCount % 20 === 0) {
                console.log(`📊 Silent audio chunk ${audioChunkCount}: max sample=${maxSample}, accumulated silence=${accumulatedSilenceDuration.toFixed(0)}ms`);
              }
            } else {
              // Voice detected - reset accumulated silence
              if (accumulatedSilenceDuration > 0) {
                console.log(`🎤 Voice detected - resetting accumulated silence (was ${accumulatedSilenceDuration.toFixed(0)}ms)`);
              }
              accumulatedSilenceDuration = 0;
            }

            // Track audio buffer duration for all chunks (including silent)
            const sampleCount = audioData.length / 2; // 16-bit = 2 bytes per sample
            const chunkDurationMs = (sampleCount / 24000) * 1000; // duration at 24kHz
            audioBufferDuration += chunkDurationMs;
            lastAudioTimestamp = Date.now();
            
            if (audioChunkCount <= 5 || audioChunkCount % 20 === 0) {
              console.log(`Audio chunk ${audioChunkCount}: buffer=${audioBufferDuration}ms, size=${message.audio.length} chars, max sample=${maxSample}`);
            }
            
            // Log first few samples for debugging
            if (audioChunkCount <= 3) {
              console.log(`First 10 samples:`, Array.from(int16Array.slice(0, 10)));
            }
            
            // Send valid audio data with actual content
            const audioEvent = {
              type: 'input_audio_buffer.append',
              audio: message.audio // Base64 encoded PCM16 audio
            };
            
            // Check WebSocket state before sending
            if (openaiWs.readyState === 1) { // WebSocket.OPEN
              openaiWs.send(JSON.stringify(audioEvent));
              if (audioChunkCount <= 5 || audioChunkCount % 20 === 0) {
                console.log(`✅ Audio sent to OpenAI: ${audioData.length} bytes, max sample: ${maxSample}`);
              }
            } else {
              console.log(`⚠️ OpenAI WebSocket not ready (state: ${openaiWs.readyState}), skipping audio chunk`);
            }
            
            // Clear any existing timer
            if (autoCommitTimer) {
              clearTimeout(autoCommitTimer);
            }

            // When Server VAD is enabled, skip manual commit - let OpenAI handle it automatically
            if (vadEnabled) {
              // VAD mode: OpenAI's Server VAD handles transcription timing automatically
              // Just track buffer for logging purposes, don't send manual commits
              break;
            }

            // Auto-commit when we have enough audio with rate limiting (only when VAD is disabled)
            const now = Date.now();
            const timeSinceLastCommit = now - lastCommitTime;

            if (audioBufferDuration >= autoCommitThresholdMs && !responseInProgress && timeSinceLastCommit >= (autoCommitThresholdMs * 2)) {
              console.log(`Auto-committing audio buffer: ${audioBufferDuration}ms (threshold: ${autoCommitThresholdMs}ms), ${audioChunkCount} chunks`);
              responseInProgress = true;
              lastCommitTime = now;

              // Just commit the audio buffer - transcription should happen automatically
              const commitEvent = {
                type: 'input_audio_buffer.commit'
              };

              if (openaiWs.readyState === 1) { // WebSocket.OPEN
                openaiWs.send(JSON.stringify(commitEvent));
                console.log('✅ Audio buffer committed, waiting for automatic transcription...');
              } else {
                console.log(`⚠️ OpenAI WebSocket not ready for commit (state: ${openaiWs.readyState})`);
                responseInProgress = false; // Reset flag
              }

              // Don't reset buffer tracking immediately - let transcription complete first
              // audioBufferDuration = 0;
              // audioChunkCount = 0;
            } else {
              // Set a timer to commit after specified delay with no new audio
              autoCommitTimer = setTimeout(() => {
                const timerNow = Date.now();
                const timerTimeSinceLastCommit = timerNow - lastCommitTime;

                // Check buffer duration again to prevent race condition with transcription completion
                const minBufferForTimer = Math.max(500, autoCommitThresholdMs * 0.5); // At least 50% of threshold
                const minTimeSinceLastCommit = Math.max(1500, autoCommitThresholdMs * 1.5); // At least 1.5x threshold

                if (audioBufferDuration >= minBufferForTimer && !responseInProgress && timerTimeSinceLastCommit >= minTimeSinceLastCommit) {
                  console.log(`Timer-based commit: ${audioBufferDuration}ms (min: ${minBufferForTimer}ms), ${audioChunkCount} chunks`);
                  responseInProgress = true;
                  lastCommitTime = timerNow;

                  // Just commit the audio buffer - transcription should happen automatically
                  const commitEvent = {
                    type: 'input_audio_buffer.commit'
                  };

                  if (openaiWs.readyState === 1) { // WebSocket.OPEN
                    openaiWs.send(JSON.stringify(commitEvent));
                    console.log('✅ Audio buffer committed (timer), waiting for automatic transcription...');
                  } else {
                    console.log(`⚠️ OpenAI WebSocket not ready for timer commit (state: ${openaiWs.readyState})`);
                    responseInProgress = false; // Reset flag
                  }

                  // Don't reset buffer tracking immediately
                  // audioBufferDuration = 0;
                  // audioChunkCount = 0;
                } else {
                  // Log why commit was skipped
                  if (audioBufferDuration < minBufferForTimer) {
                    console.log(`⏭️  Skipping timer commit - buffer too small: ${audioBufferDuration}ms (minimum: ${minBufferForTimer}ms)`);
                  } else if (responseInProgress) {
                    console.log('⏭️  Skipping timer commit - response already in progress');
                  } else if (timerTimeSinceLastCommit < minTimeSinceLastCommit) {
                    console.log(`⏭️  Skipping timer commit - too soon after last commit: ${timerTimeSinceLastCommit}ms (minimum: ${minTimeSinceLastCommit}ms)`);
                  }
                }
              }, autoCommitTimerDelayMs);
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
              autoProofreadState.rawBuffer += message.text;
              autoProofreadState.lastBufferChangeAt = Date.now();
              // 校正が失敗し続けた場合の安全弁: バッファ過大なら未校正のまま書き出す
              if (autoProofreadState.rawBuffer.length > 8000) {
                const degraded = autoProofreadState.rawBuffer.slice(0, 4000);
                autoProofreadState.rawBuffer = autoProofreadState.rawBuffer.slice(4000);
                console.warn('[Auto-Proofread] ⚠️ バッファ過大のため4000文字を未校正のまま書き出します');
                sendTextToHocuspocusDocument(currentSessionId, degraded, false);
              }
              setPendingText(currentSessionId, autoProofreadState.rawBuffer + autoProofreadState.pendingInterim);
              maybeAutoProofread(currentSessionId, clientWs, autoProofreadState)
                .catch((e) => console.error('[Auto-Proofread] ❌ trigger error:', e));
              break;
            }

            let localText = message.text;
            if (forceLineBreakAtPeriod) {
              localText = localText.replace(/。/g, '。\n');
            }
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
              if (!autoProofreadState.timer) {
                autoProofreadState.timer = setInterval(() => {
                  maybeAutoProofread(currentSessionId, clientWs, autoProofreadState)
                    .catch((e) => console.error('[Auto-Proofread] ❌ timer error:', e));
                }, 20000);
              }
              console.log(`[Auto-Proofread] 🪄 Enabled (model=${autoProofreadState.model}, バッファ方式)`);
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
              setPendingText(currentSessionId, composite);
            }
            break;

          case 'audio_commit':
            // Only commit if we have enough audio and not already processing
            if (audioBufferDuration >= 100 && !responseInProgress) {
              console.log(`Manual commit: ${audioBufferDuration}ms, ${audioChunkCount} chunks`);
              responseInProgress = true;
              lastCommitTime = Date.now();
              
              // Just commit the audio buffer - transcription should happen automatically
              const commitEvent = {
                type: 'input_audio_buffer.commit'
              };
              
              if (openaiWs.readyState === 1) { // WebSocket.OPEN
                openaiWs.send(JSON.stringify(commitEvent));
                console.log('✅ Audio buffer committed (manual), waiting for automatic transcription...');
              } else {
                console.log(`⚠️ OpenAI WebSocket not ready for manual commit (state: ${openaiWs.readyState})`);
                responseInProgress = false; // Reset flag
              }
              
              // Don't reset buffer tracking immediately
              // audioBufferDuration = 0;
              // audioChunkCount = 0;
            } else {
              console.log(`Skipping manual commit - insufficient audio: ${audioBufferDuration}ms (need >= 100ms) or response in progress: ${responseInProgress}`);
            }
            break;
            
          case 'clear_audio_buffer':
            // Clear the audio buffer
            const clearEvent = {
              type: 'input_audio_buffer.clear'
            };
            
            if (openaiWs.readyState === 1) { // WebSocket.OPEN
              openaiWs.send(JSON.stringify(clearEvent));
              console.log('Audio buffer cleared');
            } else {
              console.log(`⚠️ OpenAI WebSocket not ready for clear (state: ${openaiWs.readyState})`);
            }
            
            // Reset buffer tracking
            audioBufferDuration = 0;
            audioChunkCount = 0;
            break;
            
          case 'send_dummy_audio_data':
            // Send dummy audio data directly from client (localStorage)
            if (isDummyAudioSending) {
              console.log('⚠️ Dummy audio is already being sent, ignoring new request');
              clientWs.send(JSON.stringify({
                type: 'error',
                error: '録音データ送信中です。完了をお待ちください。'
              }));
              break;
            }
            if (message.audioData) {
              isDummyAudioSending = true;
              const sendInterval = message.sendInterval || 50; // Default to 50ms if not specified
              console.log(`[Dummy Audio] Using send interval: ${sendInterval}ms`);
              dummyAudioTimeoutId = sendDummyAudioData(message.audioData, message.name || 'Client Recording', clientWs, openaiWs, () => {
                responseInProgress = true;
                lastCommitTime = Date.now();
              }, () => {
                // onComplete callback - reset flag when sending is done
                isDummyAudioSending = false;
                dummyAudioTimeoutId = null;
              }, sendInterval);
            } else {
              console.error('❌ No audio data provided for dummy audio');
              clientWs.send(JSON.stringify({
                type: 'error',
                error: 'No audio data provided for dummy audio'
              }));
            }
            break;

          case 'stop_dummy_audio':
            // Stop dummy audio sending
            console.log('[Dummy Audio] 🛑 Stop dummy audio requested');
            if (dummyAudioTimeoutId) {
              clearTimeout(dummyAudioTimeoutId);
              dummyAudioTimeoutId = null;
            }
            isDummyAudioSending = false;
            clientWs.send(JSON.stringify({
              type: 'dummy_audio_completed'
            }));
            console.log('[Dummy Audio] ✅ Dummy audio stopped');
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
      // Clean up forceCommit observer
      if (forceCommitObserver && forceCommitStatusMap) {
        try {
          forceCommitStatusMap.unobserve(forceCommitObserver);
          console.log('[Yjs] 🧹 Cleaned up forceCommit observer on disconnect');
        } catch (cleanupError) {
          console.warn('[Yjs] ⚠️ Failed to cleanup observer on disconnect:', cleanupError);
        }
        forceCommitObserver = null;
        forceCommitStatusMap = null;
      }
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    clientWs.on('error', (error) => {
      console.error('Client WebSocket error:', error);
      // Clean up forceCommit observer
      if (forceCommitObserver && forceCommitStatusMap) {
        try {
          forceCommitStatusMap.unobserve(forceCommitObserver);
          console.log('[Yjs] 🧹 Cleaned up forceCommit observer on error');
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        forceCommitObserver = null;
        forceCommitStatusMap = null;
      }
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
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

  // Function to update transcription status in Hocuspocus document
  function updateTranscriptionStatus(sessionId, isTranscribing) {
    try {
      if (!sessionId) return;

      const roomName = `transcribe-editor-v2-${sessionId}`;
      const document = hocuspocus.documents.get(roomName);

      if (document) {
        const statusMap = document.getMap(`status-${sessionId}`);
        statusMap.set('isTranscribing', isTranscribing);
        console.log(`[Hocuspocus Integration] 📊 Transcription status updated: ${isTranscribing}`);
      }
    } catch (error) {
      console.error(`[Hocuspocus Integration] ❌ Error updating transcription status:`, error);
    }
  }

  // Pending text accumulator per session
  const pendingTextBySession = new Map();

  // Function to update pending text (recognition in progress) in Hocuspocus document
  function updatePendingText(sessionId, delta) {
    try {
      if (!sessionId) return;

      // Accumulate delta text
      const currentText = pendingTextBySession.get(sessionId) || '';
      const newText = currentText + delta;
      pendingTextBySession.set(sessionId, newText);

      const roomName = `transcribe-editor-v2-${sessionId}`;
      const document = hocuspocus.documents.get(roomName);

      if (document) {
        const statusMap = document.getMap(`status-${sessionId}`);
        statusMap.set('pendingText', newText);
        console.log(`[Hocuspocus Integration] 🔤 Pending text updated: "${newText}"`);
      }
    } catch (error) {
      console.error(`[Hocuspocus Integration] ❌ Error updating pending text:`, error);
    }
  }

  // クライアント主認識（オンデバイス認識）のinterim用: pending textを全文置き換えで更新する
  // OpenAI deltaの累積方式（updatePendingText）と異なり、Web Speechのinterimは
  // 毎回その時点の認識仮説の全文が届き、仮説は後続音声で修正（バックトラック）されうる
  function setPendingText(sessionId, text) {
    try {
      if (!sessionId) return;
      // 同じ内容なら書き込まない（無駄なYjsブロードキャストの抑制）
      if (pendingTextBySession.get(sessionId) === text) return;
      pendingTextBySession.set(sessionId, text);
      const roomName = `transcribe-editor-v2-${sessionId}`;
      const document = hocuspocus.documents.get(roomName);
      if (document) {
        const statusMap = document.getMap(`status-${sessionId}`);
        statusMap.set('pendingText', text);
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
        statusMap.set('pendingText', '');
        console.log(`[Hocuspocus Integration] 🧹 Pending text cleared`);
      }
    } catch (error) {
      console.error(`[Hocuspocus Integration] ❌ Error clearing pending text:`, error);
    }
  }

  // Function to create a paragraph break in Hocuspocus document
  async function createParagraphBreak(sessionId, marker = '⏎') {
    try {
      console.log(`[Hocuspocus Integration] Creating paragraph break for session ${sessionId}`);
      
      const roomName = `transcribe-editor-v2-${sessionId}`;
      
      // Access existing document from server's documents collection
      const document = hocuspocus.documents.get(roomName);
      
      if (document) {
        // Use session-specific field name to match client
        const fieldName = `content-${sessionId}`;

        // TipTap Collaboration uses XmlFragment, not Text
        const fragment = document.getXmlFragment(fieldName);

        // 音声フロー由来の変更であることを編集側へ伝える（下線・変更履歴の除外対象）。
        // 重要: seq更新と段落挿入を同一Yjsトランザクションにまとめる。
        // 別トランザクションだと編集側のseq消費判定がズレて段落挿入に下線が付く
        // （sendTextToHocuspocusDocumentと同じ理由でtransactが必須）。
        document.transact(() => {
        const breakStatusMap = document.getMap(`status-${sessionId}`);
        breakStatusMap.set('speechAppendSeq', (breakStatusMap.get('speechAppendSeq') || 0) + 1);

        // Only create new paragraph if there's existing content
        const hasContent = fragment.length > 0;

        if (hasContent) {
          // ⏎は新段落のみ作成し、マーカー文字は追加しない（改行記号なので）
          // それ以外のマーカー（↩️, 🔄, 📝など）はテキストとして追加後、新段落を作成
          const isNewlineMarker = marker === '⏎';

          if (!isNewlineMarker) {
            // Get the last paragraph and append the marker to its end
            const lastParagraph = fragment.get(fragment.length - 1);
            if (lastParagraph && lastParagraph instanceof (require('yjs')).XmlElement) {
              // Find or create text node in the last paragraph to append marker
              let lastTextNode = null;
              for (let i = lastParagraph.length - 1; i >= 0; i--) {
                const child = lastParagraph.get(i);
                if (child instanceof (require('yjs')).XmlText) {
                  lastTextNode = child;
                  break;
                }
              }
              if (lastTextNode) {
                // Append marker to existing text
                lastTextNode.insert(lastTextNode.length, ' ' + marker);
              } else {
                // Create new text node with marker
                const newTextNode = new (require('yjs')).XmlText();
                newTextNode.insert(0, ' ' + marker);
                lastParagraph.insert(lastParagraph.length, [newTextNode]);
              }
              console.log(`[Hocuspocus Integration] ✅ Marker '${marker}' appended to last paragraph in '${fieldName}'`);
            }
          } else {
            console.log(`[Hocuspocus Integration] ℹ️ Newline marker '${marker}' - skipping text append, creating new paragraph only`);
          }

          // Create a new empty paragraph for the next content
          const newParagraph = new (require('yjs')).XmlElement('paragraph');
          fragment.insert(fragment.length, [newParagraph]);
          console.log(`[Hocuspocus Integration] ✅ New empty paragraph created in '${fieldName}' for speech break`);
        } else {
          console.log(`[Hocuspocus Integration] ⚠️ No existing content, skipping paragraph break`);
        }
        }); // end document.transact

      } else {
        console.log(`[Hocuspocus Integration] ⚠️ Document not found in server documents: ${roomName}`);
        
        // Debug: Show available documents
        const availableDocs = Array.from(hocuspocus.documents.keys());
        console.log(`[Hocuspocus Integration] Available documents (${availableDocs.length}):`, availableDocs);
      }
      
    } catch (error) {
      console.error(`[Hocuspocus Integration] ❌ Error creating paragraph break:`, error);
    }
  }

  // Function to get the text of the last (completed) paragraph from Hocuspocus document
  function getLastParagraphText(sessionId) {
    try {
      const roomName = `transcribe-editor-v2-${sessionId}`;
      const document = hocuspocus.documents.get(roomName);

      if (!document) {
        console.log(`[Auto-Rewrite] ⚠️ Document not found: ${roomName}`);
        return null;
      }

      const fieldName = `content-${sessionId}`;
      const fragment = document.getXmlFragment(fieldName);

      // Get the second-to-last paragraph (the one just completed, before the new empty paragraph)
      if (fragment.length < 2) {
        console.log(`[Auto-Rewrite] ⚠️ Not enough paragraphs for rewrite`);
        return null;
      }

      const lastCompletedParagraph = fragment.get(fragment.length - 2);
      if (!lastCompletedParagraph) {
        return null;
      }

      // Extract text from the paragraph
      let paragraphText = '';
      for (let i = 0; i < lastCompletedParagraph.length; i++) {
        const child = lastCompletedParagraph.get(i);
        if (child instanceof (require('yjs')).XmlText) {
          paragraphText += child.toString();
        }
      }

      return paragraphText.trim();
    } catch (error) {
      console.error(`[Auto-Rewrite] ❌ Error getting last paragraph text:`, error);
      return null;
    }
  }

  // Function to rewrite text using OpenAI Chat API
  async function rewriteText(text, model = 'gpt-4o-mini') {
    try {
      const systemPrompt = `あなたは日本語文章の校正アシスタントです。以下の文章を校正してください。

校正のルール:
1. 誤字脱字を修正
2. 句読点を適切に整理
3. 明らかに誤った専門用語があれば補完・修正
4. 文の意味や内容は変更しない
5. 原文の文体やトーンを維持

修正した文章のみを出力してください。説明は不要です。`;

      console.log(`[Auto-Rewrite] 🤖 Using model: ${model}`);
      const content = await callChatCompletion(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ], { temperature: 0.3, maxTokens: 2048 });

      return content || text;
    } catch (error) {
      console.error(`[Auto-Rewrite] ❌ Error rewriting text:`, error);
      return text; // Return original text on error
    }
  }

  // Function to replace the last completed paragraph with rewritten text
  function replaceLastParagraphText(sessionId, newText) {
    try {
      const roomName = `transcribe-editor-v2-${sessionId}`;
      const document = hocuspocus.documents.get(roomName);

      if (!document) {
        console.log(`[Auto-Rewrite] ⚠️ Document not found: ${roomName}`);
        return false;
      }

      const fieldName = `content-${sessionId}`;
      const fragment = document.getXmlFragment(fieldName);

      if (fragment.length < 2) {
        return false;
      }

      const lastCompletedParagraph = fragment.get(fragment.length - 2);
      if (!lastCompletedParagraph || !(lastCompletedParagraph instanceof (require('yjs')).XmlElement)) {
        return false;
      }

      // Clear existing content
      while (lastCompletedParagraph.length > 0) {
        lastCompletedParagraph.delete(0, 1);
      }

      // Add new text
      const newTextNode = new (require('yjs')).XmlText();
      newTextNode.insert(0, newText);
      lastCompletedParagraph.insert(0, [newTextNode]);

      console.log(`[Auto-Rewrite] ✅ Paragraph replaced with rewritten text`);
      return true;
    } catch (error) {
      console.error(`[Auto-Rewrite] ❌ Error replacing paragraph text:`, error);
      return false;
    }
  }

  // Function to auto-rewrite the last paragraph on paragraph break
  async function autoRewriteLastParagraph(sessionId, clientWs, model = 'gpt-4o-mini') {
    try {
      console.log(`[Auto-Rewrite] 🔄 Starting auto-rewrite for session: ${sessionId} with model: ${model}`);

      // Get the text of the last completed paragraph
      const originalText = getLastParagraphText(sessionId);
      if (!originalText || originalText.length < 5) {
        console.log(`[Auto-Rewrite] ⏭️ Skipping rewrite - text too short or empty`);
        return;
      }

      console.log(`[Auto-Rewrite] 📝 Original text: "${originalText.substring(0, 50)}..."`);

      // Notify client that rewrite is starting
      clientWs.send(JSON.stringify({
        type: 'auto_rewrite_started',
        originalText: originalText,
        model: model
      }));

      // Rewrite the text using OpenAI
      const rewrittenText = await rewriteText(originalText, model);

      if (rewrittenText !== originalText) {
        console.log(`[Auto-Rewrite] ✅ Rewritten text: "${rewrittenText.substring(0, 50)}..."`);

        // Replace the paragraph text in the document
        replaceLastParagraphText(sessionId, rewrittenText);

        // Notify client about the rewrite result
        clientWs.send(JSON.stringify({
          type: 'auto_rewrite_completed',
          originalText: originalText,
          rewrittenText: rewrittenText
        }));
      } else {
        console.log(`[Auto-Rewrite] ℹ️ No changes needed`);
        clientWs.send(JSON.stringify({
          type: 'auto_rewrite_completed',
          originalText: originalText,
          rewrittenText: originalText,
          noChanges: true
        }));
      }
    } catch (error) {
      console.error(`[Auto-Rewrite] ❌ Error in auto-rewrite:`, error);
      clientWs.send(JSON.stringify({
        type: 'auto_rewrite_error',
        error: error.message
      }));
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
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
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
    const systemPrompt = `あなたは日本語文字起こしテキストの校正アシスタントです。音声認識の生テキスト（句読点なし）を、読みやすい文章に整えます。

入力は2つの部分から成ります:
- 【文脈】: 直前までに確定済みの校正テキストの末尾。文のつながりを判断するための参考。変更・出力してはいけない
- 【校正対象】: 今回整える生テキスト。出力はこの部分の校正結果のみ

校正のルール:
1. 誤字脱字・音声認識の誤変換を文脈に基づいて修正する
2. 句読点（、。）を適切に補う（音声認識は句読点を出力しない）
3. 意味のまとまりで段落に分ける（1段落150〜300文字目安、段落の区切りは改行1つで表す）
4. 内容の追加・削除・要約・言い換えはしない（誤りの修正と句読点・段落の整理のみ）
5. 【校正対象】の末尾が文の途中で終わっている場合は、文を勝手に完結させず途中のまま終える
   （続きは次回の校正対象として送られてくる）
6. 文体（です・ます調など）を維持する

出力は【校正対象】の校正結果のみ。【文脈】の内容・説明・ラベルは出力しない。`;

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
    if (now - state.lastRunAt < 15000) return; // 最短実行間隔15秒

    const GUARD_CHARS = 100;      // バッファ末尾は発話継続中の可能性があるため残す
    const MAX_TARGET_CHARS = 1500; // 1回の校正対象上限（大きすぎるとAPIタイムアウト）
    const MIN_TARGET_CHARS = 100;  // 校正単位がたまるまで待つ

    // バッファが30秒以上増えていない（録音停止後など）なら、ガードなしで全量を処理する
    const stale = state.lastBufferChangeAt > 0 && now - state.lastBufferChangeAt > 30000;
    const available = stale ? state.rawBuffer.length : state.rawBuffer.length - GUARD_CHARS;
    if (available < (stale ? 10 : MIN_TARGET_CHARS)) return;
    const target = state.rawBuffer.slice(0, Math.min(available, MAX_TARGET_CHARS));

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

      const result = await proofreadText(target, state.model, state.sentTail);

      // 改行の保証: モデルが段落分割を返さなかった場合に備えて、長すぎる段落は句点で機械的に分割する
      const newParas = result
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .flatMap((p) => splitLongParagraph(p));
      if (newParas.length === 0) return;
      const outText = newParas.join('\n');

      // 段落の区切り規則: 直前の出力が文末（。！？）で終わっていて、かつドキュメントの
      // 最終段落がすでに十分長い場合は、最終段落への連結ではなく新しい段落として追記する。
      // （小さな校正出力が同じ段落に連結され続けて巨大段落になるのを防ぐ）
      let forceNewParagraph = false;
      const proofDoc = hocuspocus.documents.get(`transcribe-editor-v2-${sessionId}`);
      if (proofDoc) {
        const proofFragment = proofDoc.getXmlFragment(`content-${sessionId}`);
        if (proofFragment.length > 0) {
          const lastParaLen = (getParagraphTextByIndex(proofFragment, proofFragment.length - 1) || '').length;
          forceNewParagraph = state.lastOutEndedSentence === true && lastParaLen >= 250;
        }
      }

      // 校正結果のみを共有ドキュメントへ追記（句読点が区切りを担うため先頭スペースなし）
      await sendTextToHocuspocusDocument(sessionId, outText, false, forceNewParagraph);
      state.lastOutEndedSentence = /[。．！？!?]\s*$/.test(outText);

      // 校正済み分をバッファから取り除き、文脈用の送信済み末尾を更新する
      state.rawBuffer = state.rawBuffer.slice(target.length);
      state.sentTail = (state.sentTail + outText.replace(/\n/g, '')).slice(-300);

      // 校正画面の未確定（グレー）表示を更新（バッファが減ったため）
      setPendingText(sessionId, state.rawBuffer + state.pendingInterim);

      console.log(`[Auto-Proofread] ✅ 校正完了: ${newParas.length}段落を追記（残バッファ${state.rawBuffer.length}文字）`);
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

  // Function to send dummy audio data from client (localStorage)
  function sendDummyAudioData(base64AudioData, recordingName, clientWs, openaiWs, setResponseInProgress, onComplete, sendInterval = 50) {
    let currentTimeoutId = null;

    const startSending = () => {
      try {
        console.log(`[Dummy Audio Data] 📁 Sending client audio data: ${recordingName}`);

        // Convert base64 to buffer
        const audioBuffer = Buffer.from(base64AudioData, 'base64');
        console.log(`[Dummy Audio Data] 📊 Audio data size: ${audioBuffer.length} bytes`);

        // Double-check WebSocket is ready
        if (openaiWs.readyState !== 1) { // WebSocket.OPEN
          console.error(`❌ OpenAI WebSocket not ready after wait (state: ${openaiWs.readyState})`);
          clientWs.send(JSON.stringify({
            type: 'error',
            error: 'WebSocket connection not ready'
          }));
          if (onComplete) onComplete();
          return;
        }

        // Continue with the rest of the function...
        sendAudioChunks(audioBuffer);
      } catch (error) {
        console.error('[Dummy Audio Data] ❌ Error in startSending:', error);
        clientWs.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
        if (onComplete) onComplete();
      }
    };

    const sendAudioChunks = (audioBuffer) => {

      // Calculate total duration (24kHz, 16-bit = 2 bytes per sample)
      const totalSamples = audioBuffer.length / 2;
      const totalSeconds = totalSamples / 24000;
      console.log(`[Dummy Audio Data] ⏱️ Total duration: ${totalSeconds.toFixed(2)} seconds`);

      // Convert audio data to base64 and send in chunks
      const chunkSize = 4096; // Match typical audio chunk size
      const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
      console.log(`[Dummy Audio Data] 📦 Sending ${totalChunks} chunks of ${chunkSize} bytes each`);

      let chunkIndex = 0;
      let sentBytes = 0;
      let lastChunkSendTime = Date.now();  // For timing analysis

      const sendNextChunk = () => {
        if (chunkIndex >= totalChunks) {
          console.log(`[Dummy Audio Data] ✅ All ${totalChunks} chunks sent successfully`);

          // Send final progress update
          clientWs.send(JSON.stringify({
            type: 'dummy_audio_progress',
            currentSeconds: totalSeconds,
            totalSeconds: totalSeconds,
            progress: 100
          }));

          // Auto-commit the audio after sending all chunks
          setTimeout(() => {
            console.log(`[Dummy Audio Data] 🔄 Auto-committing client audio buffer`);
            setResponseInProgress();

            const commitEvent = {
              type: 'input_audio_buffer.commit'
            };

            if (openaiWs.readyState === 1) { // WebSocket.OPEN
              openaiWs.send(JSON.stringify(commitEvent));
              console.log('✅ Client audio buffer committed, waiting for transcription...');

              // Wait for transcription to complete before sending dummy_audio_completed
              // This ensures all transcription results are received
              setTimeout(() => {
                console.log(`[Dummy Audio Data] ⏰ Sending dummy_audio_completed after transcription delay`);
                clientWs.send(JSON.stringify({
                  type: 'dummy_audio_completed'
                }));
                console.log(`[Dummy Audio Data] 📤 Sent dummy_audio_completed to client`);

                // Call onComplete callback to reset the sending flag
                if (onComplete) {
                  onComplete();
                }
              }, 3000); // Wait 3 seconds after commit for transcription to complete
            } else {
              console.log(`⚠️ OpenAI WebSocket not ready for commit (state: ${openaiWs.readyState})`);
              // Still send completion event if WebSocket is not ready
              clientWs.send(JSON.stringify({
                type: 'dummy_audio_completed'
              }));
              if (onComplete) {
                onComplete();
              }
            }
          }, 1000); // Wait 1 second before committing

          return;
        }

        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, audioBuffer.length);
        const chunk = audioBuffer.slice(start, end);
        const base64Chunk = chunk.toString('base64');

        const audioEvent = {
          type: 'input_audio_buffer.append',
          audio: base64Chunk
        };

        try {
          const now = Date.now();
          const actualInterval = now - lastChunkSendTime;
          lastChunkSendTime = now;

          openaiWs.send(JSON.stringify(audioEvent));
          sentBytes += chunk.length;

          // Calculate current progress
          const currentSamples = sentBytes / 2;
          const currentSeconds = currentSamples / 24000;
          const progressPercent = (sentBytes / audioBuffer.length) * 100;
          const samplesInChunk = chunk.length / 2;  // 16-bit = 2 bytes per sample

          // Send progress update every 10 chunks or on last chunk
          if (chunkIndex % 10 === 0 || chunkIndex === totalChunks - 1) {
            console.log(`[Timing Analysis] 📤 DUMMY #${chunkIndex + 1}/${totalChunks} | interval: ${actualInterval}ms | samples: ${samplesInChunk} | progress: ${currentSeconds.toFixed(2)}s / ${totalSeconds.toFixed(2)}s`);

            clientWs.send(JSON.stringify({
              type: 'dummy_audio_progress',
              currentSeconds: currentSeconds,
              totalSeconds: totalSeconds,
              progress: progressPercent
            }));
          }

          chunkIndex++;

          // Send next chunk after a small delay to simulate real-time streaming
          currentTimeoutId = setTimeout(sendNextChunk, sendInterval); // Configurable delay between chunks

        } catch (error) {
          console.error(`❌ Error sending client audio chunk ${chunkIndex}:`, error);
          clientWs.send(JSON.stringify({
            type: 'error',
            error: `Failed to send client audio chunk ${chunkIndex}: ${error.message}`
          }));
          // Reset sending flag on error
          if (onComplete) {
            onComplete();
          }
        }
      };

      // Start sending chunks
      clientWs.send(JSON.stringify({
        type: 'dummy_audio_started',
        filename: recordingName,
        totalSize: audioBuffer.length,
        totalChunks: totalChunks,
        totalSeconds: totalSeconds
      }));

      sendNextChunk();
    };

    // Wait for OpenAI WebSocket to be ready before sending
    if (openaiWs.readyState === 1) { // WebSocket.OPEN
      console.log(`[Dummy Audio Data] ✅ OpenAI WebSocket already open, starting immediately`);
      startSending();
    } else if (openaiWs.readyState === 0) { // WebSocket.CONNECTING
      console.log(`[Dummy Audio Data] ⏳ Waiting for OpenAI WebSocket to connect...`);
      clientWs.send(JSON.stringify({
        type: 'status',
        message: 'OpenAI APIへ接続中...'
      }));

      const onOpen = () => {
        console.log(`[Dummy Audio Data] ✅ OpenAI WebSocket connected, starting to send audio`);
        openaiWs.removeListener('open', onOpen);
        openaiWs.removeListener('error', onError);
        startSending();
      };

      const onError = (error) => {
        console.error(`[Dummy Audio Data] ❌ OpenAI WebSocket connection error:`, error);
        openaiWs.removeListener('open', onOpen);
        openaiWs.removeListener('error', onError);
        clientWs.send(JSON.stringify({
          type: 'error',
          error: 'OpenAI APIへの接続に失敗しました'
        }));
        if (onComplete) onComplete();
      };

      openaiWs.on('open', onOpen);
      openaiWs.on('error', onError);

      // Timeout after 10 seconds
      setTimeout(() => {
        if (openaiWs.readyState !== 1) {
          openaiWs.removeListener('open', onOpen);
          openaiWs.removeListener('error', onError);
          console.error(`[Dummy Audio Data] ❌ OpenAI WebSocket connection timeout`);
          clientWs.send(JSON.stringify({
            type: 'error',
            error: 'OpenAI APIへの接続がタイムアウトしました'
          }));
          if (onComplete) onComplete();
        }
      }, 10000);
    } else {
      console.error(`❌ OpenAI WebSocket in invalid state (state: ${openaiWs.readyState})`);
      clientWs.send(JSON.stringify({
        type: 'error',
        error: 'WebSocket connection not available'
      }));
      if (onComplete) onComplete();
    }

    return currentTimeoutId;
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
