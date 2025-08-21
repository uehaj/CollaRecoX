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

// Port
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
    // Next.js へ
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
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
    console.log(`[WebSocket] 🔄 UPGRADE EVENT TRIGGERED!`);
    console.log(`[WebSocket] Request URL: ${request.url}`);
    console.log(`[WebSocket] Request headers:`, request.headers);
    
    const { pathname } = parse(request.url);
    console.log(`[WebSocket] Parsed pathname: ${pathname}`);
    
    if (pathname.startsWith('/api/yjs-ws')) {
      console.log('[WebSocket] Processing /api/yjs-ws upgrade request');
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
    } else if (pathname === '/api/realtime-ws') {
      console.log('[WebSocket] Processing /api/realtime-ws upgrade request');
      try {
        realtimeWss.handleUpgrade(request, socket, head, (ws) => {
          realtimeWss.emit('connection', ws, request);
        });
      } catch (upgradeError) {
        console.error('[WebSocket] ❌ Realtime WebSocket upgrade error:', upgradeError);
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
    let audioChunkCount = 0;
    let autoCommitTimer = null;
    let responseInProgress = false;
    let lastCommitTime = 0; // Prevent too frequent commits
    
    // Transcription prompt tracking
    let transcriptionPrompt = '';
    
    // Transcription model tracking
    let transcriptionModel = 'gpt-4o-transcribe'; // Default model
    
    // Session management for Hocuspocus integration
    let currentSessionId = null;
    
    // Fixed Realtime model for audio transcription (lightweight and cost-effective)
    const fixedRealtimeModel = 'gpt-4o-mini-realtime-preview';
    
    // Connect to OpenAI Realtime API with fixed model
    const openaiUrl = `wss://api.openai.com/v1/realtime?model=${fixedRealtimeModel}`;
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

    // Function to create session configuration with optional prompt and transcription model
    const createSessionConfig = (prompt = '', transcriptionModel = 'gpt-4o-transcribe') => ({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: 'You are a transcription assistant. When you receive audio input, transcribe exactly what you hear without adding any commentary.',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: transcriptionModel,
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
            
            // Send text to Hocuspocus document if session is active
            console.log(`[Debug] currentSessionId: "${currentSessionId}", message.transcript: "${message.transcript}"`);
            if (currentSessionId && message.transcript) {
              sendTextToHocuspocusDocument(currentSessionId, message.transcript);
            } else {
              console.log(`[Debug] ❌ Hocuspocus integration NOT triggered - currentSessionId: ${currentSessionId ? 'SET' : 'UNDEFINED'}, transcript: ${message.transcript ? 'HAS_CONTENT' : 'EMPTY'}`);
            }
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
          case 'set_session_id':
            // Set current session ID for Hocuspocus integration
            if (message.sessionId) {
              currentSessionId = message.sessionId;
              console.log(`📋 Set current session ID: ${currentSessionId}`);
              console.log(`[Debug] Session ID successfully stored for Hocuspocus integration`);
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
            
            // Check WebSocket state before sending
            if (openaiWs.readyState === 1) { // WebSocket.OPEN
              openaiWs.send(JSON.stringify(audioEvent));
              console.log(`✅ Audio sent to OpenAI: ${audioData.length} bytes, max sample: ${maxSample}`);
            } else {
              console.log(`⚠️ OpenAI WebSocket not ready (state: ${openaiWs.readyState}), skipping audio chunk`);
            }
            
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

  // Function to send text to Hocuspocus document
  async function sendTextToHocuspocusDocument(sessionId, text) {
    try {
      console.log(`[Hocuspocus Integration] Adding text directly to document for session ${sessionId}: "${text}"`);
      
      const roomName = `transcribe-editor-v2-${sessionId}`;
      
      // Access existing document from server's documents collection
      const document = hocuspocus.documents.get(roomName);
      
      if (document) {
        // Use session-specific field name to match client
        const fieldName = `content-${sessionId}`;
        
        // TipTap Collaboration uses XmlFragment, not Text
        const fragment = document.getXmlFragment(fieldName);
        
        // Create a simple paragraph with the transcribed text
        // This mimics what TipTap would create when inserting text
        const paragraph = new (require('yjs')).XmlElement('paragraph');
        const textNode = new (require('yjs')).XmlText();
        
        // Add space before text if the fragment already has content
        const hasContent = fragment.length > 0;
        const textContent = hasContent ? ` ${text}` : text;
        textNode.insert(0, textContent);
        paragraph.insert(0, [textNode]);
        
        // Insert the paragraph at the end of the document
        fragment.insert(fragment.length, [paragraph]);
        
        console.log(`[Hocuspocus Integration] ✅ Text added as paragraph to XmlFragment '${fieldName}' in document: ${roomName}`);
      } else {
        console.log(`[Hocuspocus Integration] ⚠️ Document not found in server documents: ${roomName}`);
        
        // Debug: Show available documents
        const availableDocs = Array.from(hocuspocus.documents.keys());
        console.log(`[Hocuspocus Integration] Available documents (${availableDocs.length}):`, availableDocs);
      }
      
    } catch (error) {
      console.error(`[Hocuspocus Integration] ❌ Error adding text to document:`, error);
    }
  }

  server.listen(port, hostname, () => {
    console.log(`🚀 Server ready at http://${hostname}:${port}`);
    console.log(`📡 Hocuspocus WebSocket ready at ws://${hostname}:${port}/api/yjs-ws`);
    console.log(`🎤 Realtime Audio WebSocket ready at ws://${hostname}:${port}/api/realtime-ws`);
    console.log(`🌐 Next.js UI available at http://${hostname}:${port}`);
  });
});