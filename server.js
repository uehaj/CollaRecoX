const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const Y = require('yjs');
const { setupWSConnection } = require('y-websocket/bin/utils');
const { HttpsProxyAgent } = require('https-proxy-agent');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
// Parse port from arguments or environment variable
let port = 8888;
const portArgIndex = process.argv.findIndex(arg => arg === '-p');
if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
  port = parseInt(process.argv[portArgIndex + 1]) || 8888;
} else if (process.env.PORT) {
  port = parseInt(process.env.PORT) || 8888;
}
console.log('Using port:', port);

const app = next({ dev, hostname });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    // WebSocketパスはNext.jsに送らず、アップグレード処理を待つ
    if (req.url?.startsWith('/api/realtime-ws') || req.url?.startsWith('/api/yjs-ws')) {
      // WebSocketアップグレードを待つ（何もしない）
      return;
    }
    
    // 通常のHTTPリクエストのみNext.jsに転送
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  // Create WebSocket servers
  const wss = new WebSocketServer({ 
    noServer: true
  });
  
  const yjsWss = new WebSocketServer({ 
    noServer: true
  });

  // Handle WebSocket upgrades properly
  server.on('upgrade', (request, socket, head) => {
    const pathname = parse(request.url).pathname;
    
    if (pathname === '/api/realtime-ws') {
      // Let realtime WebSocket server handle this
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/api/yjs-ws') {
      // Let YJS WebSocket server handle this
      yjsWss.handleUpgrade(request, socket, head, (ws) => {
        yjsWss.emit('connection', ws, request);
      });
    } else if (pathname === '/_next/webpack-hmr') {
      // Let Next.js handle HMR WebSocket
      handle.upgrade?.(request, socket, head);
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', function connection(clientWs, request) {
    console.log('Client connected to WebSocket');
    
    const url = new URL(request.url, `http://${request.headers.host}`);
    const model = url.searchParams.get('model') || 'gpt-4o-realtime-preview';
    
    // Audio buffer tracking
    let audioBufferDuration = 0; // in milliseconds
    let lastAudioTimestamp = Date.now();
    let audioChunkCount = 0;
    let autoCommitTimer = null;
    let responseInProgress = false;
    let lastCommitTime = 0; // Prevent too frequent commits
    
    // Transcription prompt tracking
    let transcriptionPrompt = '';
    
    // Validate model - try both old and new naming conventions
    const validModels = [
      'gpt-4o-realtime-preview', 
      'gpt-4o-mini-realtime-preview',
      'gpt-4o-realtime-preview-2024-10-01', 
      'gpt-4o-mini-realtime-preview-2024-10-01'
    ];
    if (!validModels.includes(model)) {
      clientWs.send(JSON.stringify({
        type: 'error',
        error: 'Invalid model. Use gpt-4o-realtime-preview or gpt-4o-mini-realtime-preview'
      }));
      clientWs.close();
      return;
    }

    // Connect to OpenAI Realtime API with model parameter
    const openaiUrl = `wss://api.openai.com/v1/realtime?model=${model}`;
    console.log('Connecting to OpenAI Realtime API:', openaiUrl);
    
    // Create proxy agent if HTTPS_PROXY is set
    const proxyAgent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined;
    
    const openaiWs = new WebSocket(openaiUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      },
      agent: proxyAgent
    });

    // Function to create session configuration with optional prompt
    const createSessionConfig = (prompt = '') => ({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: 'You are a transcription assistant. When you receive audio input, transcribe exactly what you hear without adding any commentary.',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
          ...(prompt ? { prompt: prompt } : {})
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.3,
          prefix_padding_ms: 300,
          silence_duration_ms: 1000
        },
        temperature: 0.6,
        max_response_output_tokens: 200
      }
    });

    // Initial session configuration (will be updated when prompt is received)
    let sessionConfig = createSessionConfig();

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
            
            // Reset buffer tracking after successful transcription
            audioBufferDuration = 0;
            audioChunkCount = 0;
            console.log('Buffer reset after transcription completion');
            
            // Send the actual transcription to client
            clientWs.send(JSON.stringify({
              type: 'transcription',
              text: message.transcript,
              item_id: message.item_id
            }));
            break;
            
          case 'conversation.item.input_audio_transcription.failed':
            console.log('Transcription failed:', message.error);
            responseInProgress = false; // Reset response flag on failure
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
            
          case 'input_audio_buffer.cleared':
            console.log('Audio buffer cleared');
            break;
            
          case 'input_audio_buffer.speech_started':
            console.log('Speech detected');
            clientWs.send(JSON.stringify({
              type: 'speech_started',
              audio_start_ms: message.audio_start_ms
            }));
            break;
            
          case 'input_audio_buffer.speech_stopped':
            console.log('Speech ended');
            clientWs.send(JSON.stringify({
              type: 'speech_stopped',
              audio_end_ms: message.audio_end_ms
            }));
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
            
            // Reset buffer if error is related to buffer issues
            if (message.error && message.error.message && message.error.message.includes('buffer')) {
              console.log('Buffer-related error detected, resetting buffer tracking');
              audioBufferDuration = 0;
              audioChunkCount = 0;
            }
            
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
          case 'set_prompt':
            // Update transcription prompt
            if (message.prompt !== undefined) {
              transcriptionPrompt = message.prompt;
              console.log('📝 Received transcription prompt:', transcriptionPrompt || '(empty)');
              
              // Update session configuration with new prompt
              sessionConfig = createSessionConfig(transcriptionPrompt);
              
              // Send updated session config to OpenAI if connection is open
              if (openaiWs.readyState === 1) { // WebSocket.OPEN
                console.log('🔄 Updating OpenAI session with new prompt...');
                openaiWs.send(JSON.stringify(sessionConfig));
                console.log('✅ Session updated with transcription prompt');
              }
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
            const int16Array = new Int16Array(audioData.buffer, audioData.byteOffset, audioData.length / 2);
            const maxSample = Math.max(...Array.from(int16Array).map(Math.abs));
            const avgSample = Array.from(int16Array).reduce((sum, val) => sum + Math.abs(val), 0) / int16Array.length;
            
            audioChunkCount++;
            
            // Skip silent audio chunks (threshold: 100 for very quiet audio)
            if (maxSample < 100) {
              console.warn(`⚠️ Skipping silent audio chunk ${audioChunkCount}: max sample=${maxSample}`);
              return;
            }
            
            // Track audio buffer duration only for non-silent chunks
            const sampleCount = audioData.length / 2; // 16-bit = 2 bytes per sample
            const chunkDurationMs = (sampleCount / 24000) * 1000; // duration at 24kHz
            audioBufferDuration += chunkDurationMs;
            lastAudioTimestamp = Date.now();
            
            console.log(`Audio chunk ${audioChunkCount}: buffer=${audioBufferDuration}ms, size=${message.audio.length} chars, max sample=${maxSample}`);
            
            // Log first few samples for debugging
            if (audioChunkCount <= 3) {
              console.log(`First 10 samples:`, Array.from(int16Array.slice(0, 10)));
            }
            
            // Send valid audio data with actual content
            const audioEvent = {
              type: 'input_audio_buffer.append',
              audio: message.audio // Base64 encoded PCM16 audio
            };
            openaiWs.send(JSON.stringify(audioEvent));
            console.log(`✅ Audio sent to OpenAI: ${audioData.length} bytes, max sample: ${maxSample}`);
            
            // Clear any existing timer
            if (autoCommitTimer) {
              clearTimeout(autoCommitTimer);
            }
            
            // Auto-commit when we have enough audio with rate limiting
            const now = Date.now();
            const timeSinceLastCommit = now - lastCommitTime;
            
            if (audioBufferDuration >= 1000 && !responseInProgress && timeSinceLastCommit >= 2000) {
              console.log(`Auto-committing audio buffer: ${audioBufferDuration}ms, ${audioChunkCount} chunks`);
              responseInProgress = true;
              lastCommitTime = now;
              
              // Just commit the audio buffer - transcription should happen automatically
              const commitEvent = {
                type: 'input_audio_buffer.commit'
              };
              openaiWs.send(JSON.stringify(commitEvent));
              console.log('✅ Audio buffer committed, waiting for automatic transcription...');
              
              // Don't reset buffer tracking immediately - let transcription complete first
              // audioBufferDuration = 0;
              // audioChunkCount = 0;
            } else {
              // Set a timer to commit after 1 second of no new audio
              autoCommitTimer = setTimeout(() => {
                const timerNow = Date.now();
                const timerTimeSinceLastCommit = timerNow - lastCommitTime;
                
                if (audioBufferDuration >= 500 && !responseInProgress && timerTimeSinceLastCommit >= 1500) {
                  console.log(`Timer-based commit: ${audioBufferDuration}ms, ${audioChunkCount} chunks`);
                  responseInProgress = true;
                  lastCommitTime = timerNow;
                  
                  // Just commit the audio buffer - transcription should happen automatically
                  const commitEvent = {
                    type: 'input_audio_buffer.commit'
                  };
                  openaiWs.send(JSON.stringify(commitEvent));
                  console.log('✅ Audio buffer committed (timer), waiting for automatic transcription...');
                  
                  // Don't reset buffer tracking immediately
                  // audioBufferDuration = 0;
                  // audioChunkCount = 0;
                } else if (responseInProgress) {
                  console.log('Skipping timer commit - response already in progress');
                }
              }, 2000);
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
              openaiWs.send(JSON.stringify(commitEvent));
              console.log('✅ Audio buffer committed (manual), waiting for automatic transcription...');
              
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
            openaiWs.send(JSON.stringify(clearEvent));
            
            // Reset buffer tracking
            audioBufferDuration = 0;
            audioChunkCount = 0;
            console.log('Audio buffer cleared');
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
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    clientWs.on('error', (error) => {
      console.error('Client WebSocket error:', error);
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });
  });

  // Handle YJS WebSocket connections
  yjsWss.on('connection', (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const sessionId = url.searchParams.get('sessionId') || 'default';
    
    console.log(`YJS client connected to session: ${sessionId}`);
    
    // Setup YJS WebSocket connection with session-specific document name
    const docName = `transcribe-editor-${sessionId}`;
    setupWSConnection(ws, request, { docName });
    
    ws.on('close', () => {
      console.log(`YJS client disconnected from session: ${sessionId}`);
    });
    
    ws.on('error', (error) => {
      console.error(`YJS WebSocket error for session ${sessionId}:`, error);
    });
  });

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket server ready on ws://${hostname}:${port}/api/realtime-ws`);
    console.log(`> YJS WebSocket server ready on ws://${hostname}:${port}/api/yjs-ws`);
  });
});
