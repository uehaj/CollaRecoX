"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { getAllRecordings, type AudioRecording } from '@/lib/indexedDB';

interface PromptPreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'none',
    name: 'プロンプトなし',
    description: 'デフォルトの文字起こし',
    prompt: ''
  },
  {
    id: 'filler-removal',
    name: 'フィラー除去',
    description: '「えー」「あのー」などのフィラーを除去',
    prompt: 'フィラー（「えー」「あのー」「その」「まあ」など）を除去し、明瞭で読みやすい文章に変換してください。'
  },
  {
    id: 'clean-formal',
    name: '整理・敬語化',
    description: 'フィラー除去 + 敬語への変換',
    prompt: 'フィラーを除去し、敬語を使った丁寧で読みやすい文章に整理して変換してください。'
  },
  {
    id: 'summary-style',
    name: '要約スタイル',
    description: '冗長な表現を簡潔にまとめる',
    prompt: 'フィラーや冗長な表現を除去し、要点を簡潔にまとめた読みやすい文章に変換してください。'
  },
  {
    id: 'meeting-minutes',
    name: '議事録スタイル',
    description: '会議録に適した形式に整理',
    prompt: 'フィラーを除去し、議事録に適した明確で簡潔な文章に整理してください。重要なポイントを明確にしてください。'
  }
];

interface TranscriptionMessage {
  type: 'transcription';
  text: string;
  item_id: string;
}

interface ErrorMessage {
  type: 'error' | 'transcription_error';
  error: string;
  item_id?: string;
}

interface StatusMessage {
  type: 'ready' | 'speech_started' | 'speech_stopped';
  message?: string;
  audio_start_ms?: number;
  audio_end_ms?: number;
}

interface DummyAudioMessage {
  type: 'dummy_audio_started' | 'dummy_audio_completed';
  filename?: string;
}

type WebSocketMessage = TranscriptionMessage | ErrorMessage | StatusMessage | DummyAudioMessage;

export default function RealtimeClient() {
  const websocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | AudioWorkletNode | null>(null);
  const recordingStateRef = useRef<boolean>(false);
  
  // Hocuspocus client refs for test functionality
  const hocuspocusProviderRef = useRef<HocuspocusProvider | null>(null);  
  const hocuspocusDocRef = useRef<Y.Doc | null>(null);
  
  const [text, setText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [selectedPromptPreset, setSelectedPromptPreset] = useState<string>('none');
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [promptMode, setPromptMode] = useState<'preset' | 'custom'>('preset');
  const [autoLineBreak, setAutoLineBreak] = useState<boolean>(false);
  const [transcriptionModel, setTranscriptionModel] = useState<string>('gpt-4o-transcribe');
  const [speechBreakDetection, setSpeechBreakDetection] = useState<boolean>(false);
  const [breakMarker, setBreakMarker] = useState<string>('⏎');
  const [vadThreshold, setVadThreshold] = useState<number>(0.3);
  const [vadSilenceDuration, setVadSilenceDuration] = useState<number>(1000);
  const [vadPrefixPadding, setVadPrefixPadding] = useState<number>(300);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [sessionIdInput, setSessionIdInput] = useState<string>('');
  const [isDummyAudioSending, setIsDummyAudioSending] = useState<boolean>(false);
  const [localStorageRecordings, setLocalStorageRecordings] = useState<AudioRecording[]>([]);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string>('');
  const [existingSessionInput, setExistingSessionInput] = useState<string>('');
  const [isEditingSessionId, setIsEditingSessionId] = useState<boolean>(false);

  // Get current prompt for transcription
  const getCurrentPrompt = useCallback((): string => {
    let basePrompt = '';
    
    if (promptMode === 'custom') {
      basePrompt = customPrompt;
    } else {
      const preset = PROMPT_PRESETS.find(p => p.id === selectedPromptPreset);
      basePrompt = preset?.prompt || '';
    }
    
    // Add line break instruction if enabled
    if (autoLineBreak) {
      const lineBreakInstruction = '文脈が変わるポイントで適切に改行を入れて、読みやすい段落構造にしてください。';
      if (basePrompt) {
        basePrompt += ' ' + lineBreakInstruction;
      } else {
        basePrompt = lineBreakInstruction;
      }
    }
    
    return basePrompt;
  }, [promptMode, customPrompt, selectedPromptPreset, autoLineBreak]);


  // Audio processing utility functions
  const floatTo16BitPCM = useCallback((float32Array: Float32Array): Int16Array => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  }, []);

  const arrayBufferToBase64 = useCallback((buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }, []);

  // Get available audio input devices
  const getAudioDevices = useCallback(async () => {
    try {
      console.log('[Audio Devices] 🎤 Getting available audio input devices...');
      
      if (!navigator?.mediaDevices) {
        console.warn('[Audio Devices] ❌ MediaDevices API not available');
        return;
      }

      // Request permission first
      console.log('[Audio Devices] 🔐 Requesting microphone permission...');
      await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('[Audio Devices] ✅ Microphone permission granted');
      
      // Get all devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(device => device.kind === 'audioinput');
      console.log('[Audio Devices] 📋 Found audio input devices:', audioInputs.map(d => ({ id: d.deviceId, label: d.label })));
      
      setAudioDevices(audioInputs);
      
      // Set default device if none selected
      if (audioInputs.length > 0 && !selectedDeviceId) {
        console.log('[Audio Devices] 🎯 Setting default device:', audioInputs[0].deviceId);
        setSelectedDeviceId(audioInputs[0].deviceId);
      }
    } catch (error) {
      console.error('[Audio Devices] ❌ Error getting audio devices:', error);
      setError('Failed to access audio devices. Please grant microphone permission.');
    }
  }, [selectedDeviceId]);

  // WebSocket connection management
  const connectWebSocket = useCallback(() => {
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      console.log('[WebSocket] Already connected, skipping connection attempt');
      return;
    }

    const currentPrompt = getCurrentPrompt();
    // Automatically detect protocol and host
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' ? window.location.host : 'localhost:8888';
    const wsUrl = `${protocol}//${host}/api/realtime-ws`;
    console.log('[WebSocket] Connecting to:', wsUrl);
    console.log('[WebSocket] Using transcription prompt:', currentPrompt || '(none)');
    const ws = new WebSocket(wsUrl);
    websocketRef.current = ws;

    ws.onopen = () => {
      console.log('[WebSocket] ✅ Connected successfully');
      setIsConnected(true);
      setError(null);
      
      // Send session ID to server if available
      if (currentSessionId) {
        ws.send(JSON.stringify({
          type: 'set_session_id',
          sessionId: currentSessionId
        }));
        console.log('[WebSocket] 📋 Sent session ID to server:', currentSessionId);
      }
      
      // Send prompt configuration to server
      if (currentPrompt) {
        ws.send(JSON.stringify({
          type: 'set_prompt',
          prompt: currentPrompt
        }));
        console.log('[WebSocket] 📝 Sent transcription prompt to server');
      }
      
      // Send transcription model configuration to server
      ws.send(JSON.stringify({
        type: 'set_transcription_model',
        model: transcriptionModel
      }));
      console.log('[WebSocket] 🎤 Sent transcription model to server:', transcriptionModel);
      
      // Send speech break detection settings to server
      ws.send(JSON.stringify({
        type: 'set_speech_break_detection',
        enabled: speechBreakDetection,
        marker: breakMarker
      }));
      console.log('[WebSocket] 🔸 Sent speech break detection settings:', { enabled: speechBreakDetection, marker: breakMarker });
      
      // Send VAD parameters to server
      ws.send(JSON.stringify({
        type: 'set_vad_params',
        threshold: vadThreshold,
        silence_duration_ms: vadSilenceDuration,
        prefix_padding_ms: vadPrefixPadding
      }));
      console.log('[WebSocket] 🎛️ Sent VAD parameters:', { threshold: vadThreshold, silence_duration_ms: vadSilenceDuration, prefix_padding_ms: vadPrefixPadding });
    };

    ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        console.log('[WebSocket] 📨 Received message:', message.type, message);
        
        switch (message.type) {
          case 'ready':
            console.log('[Realtime API] 🚀 API ready for audio streaming');
            break;
            
          case 'transcription':
            console.log('[Transcription] 📝 Received text:', message.text);
            setText(prev => prev + message.text + ' ');
            break;
            
          case 'dummy_audio_started':
            console.log('[Dummy Audio] 🎵 Started sending dummy audio:', message.filename);
            setIsDummyAudioSending(true);
            break;
            
          case 'dummy_audio_completed':
            console.log('[Dummy Audio] ✅ Dummy audio processing completed');
            setIsDummyAudioSending(false);
            break;
            
          case 'speech_started':
            setIsSpeaking(true);
            console.log('[Speech Detection] 🎤 Speech started');
            break;
            
          case 'speech_stopped':
            setIsSpeaking(false);
            console.log('[Speech Detection] 🔇 Speech stopped');
            
            // Insert line break if speech break detection is enabled (for local display)
            if (speechBreakDetection) {
              setText(prev => prev + '\n\n');
              console.log('[Speech Break] Added paragraph break to local display');
            }
            break;
            
          case 'error':
          case 'transcription_error':
            setError(message.error);
            setIsDummyAudioSending(false);
            console.error('[WebSocket] ❌ Error:', message.error);
            break;
            
          default:
            console.log('[WebSocket] ❓ Unknown message type:', message);
        }
      } catch (err) {
        console.error('[WebSocket] ❌ Error parsing message:', err, 'Raw data:', event.data);
      }
    };

    ws.onerror = (error) => {
      console.error('[WebSocket] ❌ Connection error:', error);
      setError('WebSocket connection failed');
      setIsConnected(false);
    };

    ws.onclose = (event) => {
      console.log('[WebSocket] 🔌 Connection closed:', event.code, event.reason);
      setIsConnected(false);
      setIsRecording(false);
    };
  }, [getCurrentPrompt, currentSessionId, transcriptionModel, speechBreakDetection, breakMarker, vadThreshold, vadSilenceDuration, vadPrefixPadding]);

  const disconnectWebSocket = useCallback(() => {
    if (websocketRef.current) {
      console.log('[WebSocket] 🔌 Disconnecting WebSocket');
      websocketRef.current.close();
      websocketRef.current = null;
    }
    setIsConnected(false);
  }, []);

  // Audio streaming functions
  const startAudioStream = useCallback(async () => {
    try {
      console.log('[Audio] 🎵 Starting audio stream...');
      
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia not supported in this browser');
      }

      const audioConstraints: MediaStreamConstraints['audio'] = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        // Don't force specific sample rate, let browser choose optimal rate
      };

      // Use selected device if available
      if (selectedDeviceId) {
        console.log('[Audio] 🎤 Using selected device:', selectedDeviceId);
        (audioConstraints as MediaTrackConstraints).deviceId = { exact: selectedDeviceId };
      } else {
        console.warn('[Audio] ⚠️ No specific device selected, using default');
      }

      console.log('[Audio] 📋 Audio constraints:', audioConstraints);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints
      });
      console.log('[Audio] ✅ Media stream obtained');

      // Enhanced AudioContext compatibility check
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('AudioContext not supported in this browser');
      }

      // Create AudioContext for processing (don't force sample rate, let browser decide)
      console.log('[Audio] 🔧 Creating AudioContext...');
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;
      console.log('[Audio] ✅ AudioContext created, sample rate:', audioContext.sampleRate);

      const source = audioContext.createMediaStreamSource(stream);
      console.log('[Audio] 🔌 Media stream source created');

      // For now, use ScriptProcessor directly to avoid AudioWorklet cache issues
      // TODO: Re-enable AudioWorklet once cache issues are resolved
      console.warn('[Audio] ⚠️ Using ScriptProcessor for audio processing (AudioWorklet temporarily disabled due to cache issues)');
      
      // Use ScriptProcessor
      if (!audioContext.createScriptProcessor) {
        throw new Error('Audio processing not supported in this browser');
      }
      
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      console.log('[Audio] 🔧 ScriptProcessor created with 4096 buffer size');
      
      let audioChunkCount = 0;
      
      processor.onaudioprocess = (event) => {
        audioChunkCount++;
        
        // Log more chunks to debug
        if (audioChunkCount <= 20) {
          console.log(`[Audio Processing] 🔄 Event fired! Chunk #${audioChunkCount}`);
          console.log(`[Audio Processing] 📊 Recording state: ${recordingStateRef.current}, WebSocket ready: ${websocketRef.current?.readyState === WebSocket.OPEN}`);
        }
        
        if (!recordingStateRef.current) {
          console.log(`[Audio Processing] ⏸️ Skipping chunk #${audioChunkCount} - recording state is false`);
          return;
        }
        
        if (!websocketRef.current || websocketRef.current.readyState !== WebSocket.OPEN) {
          console.log(`[Audio Processing] ⏸️ Skipping chunk #${audioChunkCount} - WebSocket not ready`);
          return;
        }

        const inputBuffer = event.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);
        
        // Log every chunk for first 20, then every 20th
        if (audioChunkCount <= 20 || audioChunkCount % 20 === 0) {
          console.log(`[Audio Processing] 🎵 Processing chunk #${audioChunkCount}, buffer length: ${inputData.length}, sample rate: ${inputBuffer.sampleRate}`);
          
          // Check if there's actual audio data
          const audioLevel = Math.max(...Array.from(inputData).map(Math.abs));
          const avgLevel = Array.from(inputData).reduce((sum, val) => sum + Math.abs(val), 0) / inputData.length;
          console.log(`[Audio Processing] 📊 Audio level: max=${audioLevel.toFixed(4)}, avg=${avgLevel.toFixed(4)} (0=silence, 1=max)`);
          
          // Log some raw sample values
          if (audioChunkCount <= 5) {
            console.log(`[Audio Processing] 🔍 First 10 samples:`, Array.from(inputData.slice(0, 10)).map(v => v.toFixed(4)));
          }
          
          // Alert if we're getting silence
          if (audioLevel < 0.001) {
            console.warn(`[Audio Processing] ⚠️ Very low audio level detected! Check microphone.`);
          }
        }
        
        // Convert to 16-bit PCM at 24kHz (required by OpenAI Realtime API)
        let processedData = inputData;
        
        // Resample from whatever rate to 24kHz
        const targetSampleRate = 24000;
        const sourceSampleRate = inputBuffer.sampleRate;
        
        if (sourceSampleRate !== targetSampleRate) {
          const resampleRatio = targetSampleRate / sourceSampleRate;
          const outputLength = Math.floor(inputData.length * resampleRatio);
          const resampledData = new Float32Array(outputLength);
          
          for (let i = 0; i < outputLength; i++) {
            const sourceIndex = i / resampleRatio;
            const index = Math.floor(sourceIndex);
            const fraction = sourceIndex - index;
            
            if (index + 1 < inputData.length) {
              // Linear interpolation
              resampledData[i] = inputData[index] * (1 - fraction) + inputData[index + 1] * fraction;
            } else {
              resampledData[i] = inputData[index] || 0;
            }
          }
          processedData = resampledData;
        }
        
        const pcm16 = floatTo16BitPCM(processedData);
        const base64Audio = arrayBufferToBase64(pcm16.buffer as ArrayBuffer);

        // Log audio data size and validation
        if (audioChunkCount <= 5 || audioChunkCount % 20 === 0) {
          console.log(`[Audio Processing] 📦 PCM16 samples: ${pcm16.length}, Base64 size: ${base64Audio.length} chars`);
          console.log(`[Audio Processing] 🔍 Sample rate conversion: ${sourceSampleRate}Hz -> ${targetSampleRate}Hz, samples: ${inputData.length} -> ${processedData.length}`);
          
          // Log first few PCM16 values
          if (audioChunkCount <= 3) {
            console.log(`[Audio Processing] 🎯 First 10 PCM16 values:`, Array.from(pcm16.slice(0, 10)));
          }
        }

        // Check for actual audio content before sending
        const maxPcmValue = Math.max(...Array.from(pcm16).map(Math.abs));
        
        // Skip silent audio chunks (threshold: 100 for 16-bit PCM)
        if (maxPcmValue < 100) {
          if (audioChunkCount <= 10 || audioChunkCount % 50 === 0) {
            console.warn(`[Audio Processing] ⚠️ Skipping silent chunk #${audioChunkCount}: max PCM=${maxPcmValue}`);
          }
          return; // Don't send silent audio
        }

        // Send audio chunk to WebSocket
        try {
          websocketRef.current.send(JSON.stringify({
            type: 'audio_chunk',
            audio: base64Audio
          }));
          
          // Log successful transmission every 20th chunk
          if (audioChunkCount % 20 === 0) {
            console.log(`[WebSocket] 📤 Audio chunk #${audioChunkCount} sent successfully (max PCM: ${maxPcmValue})`);
          }
        } catch (sendError) {
          console.error(`[WebSocket] ❌ Failed to send audio chunk #${audioChunkCount}:`, sendError);
        }
      };

      // Create a gain node to prevent audio feedback while still allowing processing
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0; // Mute the output to prevent feedback
      
      // Critical: ScriptProcessor needs to be connected to destination to fire events
      source.connect(processor);
      processor.connect(gainNode);
      gainNode.connect(audioContext.destination);
      console.log('[Audio] 🔗 Audio pipeline connected');
      
      // Additional diagnostics
      console.log('[Audio] 🔍 AudioContext state:', audioContext.state);
      console.log('[Audio] 🔍 MediaStream active:', stream.active);
      console.log('[Audio] 🔍 MediaStream tracks:', stream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })));
      
      // CRITICAL: Resume AudioContext if suspended (required by browsers after user gesture)
      if (audioContext.state === 'suspended') {
        console.log('[Audio] 🔄 Resuming suspended AudioContext...');
        try {
          await audioContext.resume();
          console.log('[Audio] ✅ AudioContext resumed, new state:', audioContext.state);
        } catch (resumeError) {
          console.error('[Audio] ❌ Failed to resume AudioContext:', resumeError);
        }
      }
      
      // Force AudioContext to start processing immediately
      console.log('[Audio] 🎯 Final AudioContext state:', audioContext.state);
      if (audioContext.state !== 'running') {
        console.warn('[Audio] ⚠️ AudioContext is not running!');
        throw new Error('AudioContext failed to start. State: ' + audioContext.state);
      }

      // Set recording state immediately for audio processing
      recordingStateRef.current = true;
      
      setIsRecording(true);
      setIsProcessing(true);
      console.log('[Audio] ✅ Audio streaming started successfully');
      
      // Test audio processing after a short delay
      setTimeout(() => {
        console.log('[Audio] 🧪 Testing audio processing after 2 seconds...');
        console.log('[Audio] 🔍 Current AudioContext state:', audioContext.state);
        console.log('[Audio] 🔍 Current recording state:', isRecording);
        console.log('[Audio] 🔍 MediaStream still active:', stream.active);
      }, 2000);

    } catch (err) {
      console.error('[Audio] ❌ Error starting audio stream:', err);
      setError(err instanceof Error ? err.message : 'Failed to start audio stream');
    }
  }, [isRecording, floatTo16BitPCM, arrayBufferToBase64, selectedDeviceId]);

  const stopAudioStream = useCallback(() => {
    console.log('[Audio] 🛑 Stopping audio stream...');
    
    // Stop recording state immediately
    recordingStateRef.current = false;
    
    // Stop audio processing
    if (processorRef.current) {
      console.log('[Audio] 🔌 Disconnecting audio processor');
      // If it's an AudioWorkletNode, send stop message
      if ('port' in processorRef.current && processorRef.current.port) {
        processorRef.current.port.postMessage({ type: 'stop' });
      }
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    
    if (audioContextRef.current) {
      console.log('[Audio] 🔧 Closing AudioContext');
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Don't commit on stop - let the server handle remaining buffer automatically
    // The server will commit when it has enough audio or on timer
    console.log('[Audio] 📤 Stopping - server will handle remaining buffer');

    setIsRecording(false);
    setIsProcessing(false);
    setIsSpeaking(false);
    console.log('[Audio] ✅ Audio stream stopped successfully');
  }, []);

  // Function to send status messages to collaborative document
  const sendStatusToCollaboration = useCallback((message: string) => {
    if (!currentSessionId || !hocuspocusDocRef.current || !hocuspocusProviderRef.current) {
      return;
    }

    try {
      const fieldName = `content-${currentSessionId}`;
      const fragment = hocuspocusDocRef.current.getXmlFragment(fieldName);
      
      // Add status message to existing paragraph or create new one if needed
      const hasContent = fragment.length > 0;
      
      if (hasContent) {
        // Get the last element in the fragment
        const lastElement = fragment.get(fragment.length - 1);

        if (lastElement && lastElement instanceof Y.XmlElement && lastElement.nodeName === 'paragraph') {
          // Add status message to the existing last paragraph
          const existingTextNode = lastElement.get(0);
          if (existingTextNode && existingTextNode instanceof Y.XmlText) {
            // Append status message with space to existing text node
            existingTextNode.insert(existingTextNode.length, ` ${message}`);
          } else {
            // Create new text node in existing paragraph
            const newTextNode = new Y.XmlText();
            newTextNode.insert(0, ` ${message}`);
            lastElement.insert(lastElement.length, [newTextNode]);
          }
        } else {
          // Last element is not a paragraph, create new paragraph
          const newParagraph = new Y.XmlElement('paragraph');
          const newTextNode = new Y.XmlText();
          newTextNode.insert(0, ` ${message}`);
          newParagraph.insert(0, [newTextNode]);
          fragment.insert(fragment.length, [newParagraph]);
        }
      } else {
        // No content yet, create first paragraph
        const newParagraph = new Y.XmlElement('paragraph');
        const newTextNode = new Y.XmlText();
        newTextNode.insert(0, message);
        newParagraph.insert(0, [newTextNode]);
        fragment.insert(0, [newParagraph]);
      }
      
      console.log('[Hocuspocus Status] Status sent to collaborative document:', message);
    } catch (error) {
      console.error('[Hocuspocus Status] Error sending status:', error);
    }
  }, [currentSessionId]);

  // Main control functions
  const startRecording = useCallback(async () => {
    console.log('[Recording] 🎙️ Start recording requested');
    
    // Send detailed start notification to collaborative document
    const currentTime = new Date().toLocaleString('ja-JP');
    const currentPrompt = getCurrentPrompt();
    const promptModeText = promptMode === 'custom' ? 'カスタム' : 'プリセット';
    const promptName = promptMode === 'preset' 
      ? PROMPT_PRESETS.find(p => p.id === selectedPromptPreset)?.name || 'なし'
      : 'カスタムプロンプト';
    const autoBreakText = autoLineBreak ? '有効' : '無効';
    
    const statusMessage = `
📝 文字起こし開始 (${currentTime})
🎤 音声認識モデル: ${transcriptionModel}
💬 プロンプト設定: ${promptModeText} - ${promptName}
🔄 自動改行: ${autoBreakText}
${currentPrompt ? `📋 プロンプト内容: "${currentPrompt}"` : ''}`;
    
    sendStatusToCollaboration(statusMessage);
    
    if (!isConnected) {
      console.log('[Recording] 🔗 Not connected, connecting WebSocket first...');
      connectWebSocket();
      // Wait a bit for connection to establish
      console.log('[Recording] ⏳ Waiting 1 second for WebSocket connection...');
      setTimeout(() => {
        console.log('[Recording] ⏰ Starting audio stream after WebSocket delay');
        startAudioStream();
      }, 1000);
    } else {
      console.log('[Recording] 🚀 Already connected, starting audio stream immediately');
      startAudioStream();
    }
  }, [isConnected, connectWebSocket, startAudioStream, sendStatusToCollaboration, transcriptionModel, promptMode, selectedPromptPreset, autoLineBreak, getCurrentPrompt]);

  const stopRecording = useCallback(() => {
    console.log('[Recording] ⏹️ Stop recording requested');
    
    // Send detailed stop notification to collaborative document
    const currentTime = new Date().toLocaleString('ja-JP');
    const statusMessage = `
⏹️ 文字起こし終了 (${currentTime})
🎤 使用モデル: ${transcriptionModel}`;
    
    sendStatusToCollaboration(statusMessage);
    
    stopAudioStream();
  }, [stopAudioStream, sendStatusToCollaboration, transcriptionModel]);

  const clearText = useCallback(() => {
    console.log('[UI] 🧹 Clearing transcription text');
    setText("");
    setError(null);
    
    // Clear audio buffer
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      console.log('[Audio] 🗑️ Clearing server audio buffer');
      websocketRef.current.send(JSON.stringify({
        type: 'clear_audio_buffer'
      }));
    }
  }, []);

  // Generate or retrieve session ID
  const generateSessionId = useCallback(() => {
    if (!currentSessionId) {
      const newSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      setCurrentSessionId(newSessionId);
      return newSessionId;
    }
    return currentSessionId;
  }, [currentSessionId]);

  const createOrOpenEditingSession = useCallback(() => {
    const sessionId = generateSessionId();
    const editorUrl = `${window.location.origin}/editor/${sessionId}`;
    
    console.log('[Session] 🚀 Opening editing session:', sessionId);
    console.log('[Session] 📍 Editor URL:', editorUrl);
    
    // Send session ID to server if WebSocket is connected
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      websocketRef.current.send(JSON.stringify({
        type: 'set_session_id',
        sessionId: sessionId
      }));
      console.log('[WebSocket] 📋 Updated session ID on server:', sessionId);
    }
    
    // Open new tab with editor
    window.open(editorUrl, '_blank');
  }, [generateSessionId]);

  const connectToExistingSession = useCallback(() => {
    if (existingSessionInput.trim()) {
      const sessionId = existingSessionInput.trim();
      setCurrentSessionId(sessionId);
      setExistingSessionInput('');
      console.log('[Session] 🔗 Connected to existing session:', sessionId);
      
      // Send session ID to server if WebSocket is connected
      if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
        websocketRef.current.send(JSON.stringify({
          type: 'set_session_id',
          sessionId: sessionId
        }));
        console.log('[WebSocket] 📋 Updated session ID on server:', sessionId);
      }
      
    }
  }, [existingSessionInput]);

  const editSessionId = useCallback(() => {
    setSessionIdInput(currentSessionId);
    setIsEditingSessionId(true);
  }, [currentSessionId]);

  const cancelEditSessionId = useCallback(() => {
    setSessionIdInput('');
    setIsEditingSessionId(false);
  }, []);

  const saveSessionId = useCallback(() => {
    if (sessionIdInput.trim()) {
      const sessionId = sessionIdInput.trim();
      setCurrentSessionId(sessionId);
      setIsEditingSessionId(false);
      console.log('[Session] 💾 Session ID updated to:', sessionId);
      
      // Send session ID to server if WebSocket is connected
      if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
        websocketRef.current.send(JSON.stringify({
          type: 'set_session_id',
          sessionId: sessionId
        }));
        console.log('[WebSocket] 📋 Updated session ID on server:', sessionId);
      }
    }
  }, [sessionIdInput]);

  // Load recordings from IndexedDB
  const loadLocalStorageRecordings = useCallback(async () => {
    try {
      console.log('[IndexedDB] Loading recordings from IndexedDB...');
      const recordings = await getAllRecordings();
      setLocalStorageRecordings(recordings);
      console.log('[IndexedDB] Loaded', recordings.length, 'recordings:', recordings.map((r: AudioRecording) => ({ id: r.id, name: r.name })));
      if (recordings.length > 0 && !selectedRecordingId) {
        setSelectedRecordingId(recordings[0].id);
        console.log('[IndexedDB] Auto-selected first recording:', recordings[0].id);
      }
    } catch (error) {
      console.error('[IndexedDB] Error loading recordings:', error);
      setLocalStorageRecordings([]);
    }
  }, [selectedRecordingId]);

  // Send dummy audio from localStorage
  const sendDummyAudio = useCallback(() => {
    if (!isConnected) {
      setError('WebSocket接続が必要です。先に接続してください。');
      return;
    }
    
    // Send from localStorage
    const recording = localStorageRecordings.find(rec => rec.id === selectedRecordingId);
    if (!recording) {
      setError('選択された録音が見つかりません。録音データ作成画面で録音を作成してください。');
      setIsDummyAudioSending(false);
      return;
    }
    
    setIsDummyAudioSending(true);
    setError(null);
    
    console.log('[Dummy Audio] 🎵 Sending localStorage recording:', recording.name);
    websocketRef.current?.send(JSON.stringify({
      type: 'send_dummy_audio_data',
      audioData: recording.data,
      name: recording.name
    }));
  }, [isConnected, localStorageRecordings, selectedRecordingId]);

  // Initialize/cleanup Hocuspocus connection for test functionality
  const initializeHocuspocusClient = useCallback(() => {
    if (!currentSessionId || hocuspocusProviderRef.current) {
      return; // Already initialized or no session
    }

    console.log('[Hocuspocus Test Client] Initializing for session:', currentSessionId);

    // Create Y.Doc
    const ydoc = new Y.Doc();
    hocuspocusDocRef.current = ydoc;

    // Create provider
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' ? window.location.host : 'localhost:8888';
    const websocketUrl = `${protocol}//${host}/api/yjs-ws`;
    const roomName = `transcribe-editor-v2-${currentSessionId}`;

    const provider = new HocuspocusProvider({
      url: websocketUrl,
      name: roomName,
      document: ydoc,
    });

    hocuspocusProviderRef.current = provider;

    provider.on('connect', () => {
      console.log('[Hocuspocus Test Client] Connected to collaborative session');
    });

    provider.on('disconnect', () => {
      console.log('[Hocuspocus Test Client] Disconnected from collaborative session');
    });

    provider.on('error', (error: unknown) => {
      console.error('[Hocuspocus Test Client] Error:', error);
    });
  }, [currentSessionId]);

  const cleanupHocuspocusClient = useCallback(() => {
    if (hocuspocusProviderRef.current) {
      console.log('[Hocuspocus Test Client] Cleaning up connection');
      hocuspocusProviderRef.current.disconnect();
      hocuspocusProviderRef.current.destroy();
      hocuspocusProviderRef.current = null;
    }
    if (hocuspocusDocRef.current) {
      hocuspocusDocRef.current = null;
    }
  }, []);

  // Test text send function - send directly to Hocuspocus document as a client
  const sendTestText = useCallback(() => {
    if (!currentSessionId) {
      setError('セッションIDが設定されていません。先に編集セッションを作成してください。');
      return;
    }

    // Initialize Hocuspocus client if not already done
    initializeHocuspocusClient();

    if (!hocuspocusDocRef.current || !hocuspocusProviderRef.current) {
      setError('Hocuspocusクライアントが初期化されていません。');
      return;
    }

    const provider = hocuspocusProviderRef.current;
    
    // Check if provider is connected, if not, wait for connection
    const sendWhenReady = () => {
      const testTexts = [
        'テスト送信1: リアルタイム音声認識からの統合テストです。',
        'テスト送信2: このテキストは共同編集画面に表示されるはずです。',
        'テスト送信3: Hocuspocusサーバー経由で同期されます。',
        'テスト送信4: 複数のユーザーがリアルタイムで確認できます。'
      ];

      const randomText = testTexts[Math.floor(Math.random() * testTexts.length)];
      
      try {
        // Add text to Hocuspocus document as a collaborative client using TipTap-compatible format
        const fieldName = `content-${currentSessionId}`;
        
        // TipTap Collaboration uses XmlFragment, not Text
        const fragment = hocuspocusDocRef.current!.getXmlFragment(fieldName);
        
        // Add text to existing paragraph or create new one if needed
        const hasContent = fragment.length > 0;
        
        if (hasContent) {
          // Get the last element in the fragment
          const lastElement = fragment.get(fragment.length - 1);

          if (lastElement && lastElement instanceof Y.XmlElement && lastElement.nodeName === 'paragraph') {
            // Add text to the existing last paragraph
            const existingTextNode = lastElement.get(0);
            if (existingTextNode && existingTextNode instanceof Y.XmlText) {
              // Append text with space to existing text node
              existingTextNode.insert(existingTextNode.length, ` ${randomText}`);
            } else {
              // Create new text node in existing paragraph
              const newTextNode = new Y.XmlText();
              newTextNode.insert(0, ` ${randomText}`);
              lastElement.insert(lastElement.length, [newTextNode]);
            }
          } else {
            // Last element is not a paragraph, create new paragraph
            const newParagraph = new Y.XmlElement('paragraph');
            const newTextNode = new Y.XmlText();
            newTextNode.insert(0, ` ${randomText}`);
            newParagraph.insert(0, [newTextNode]);
            fragment.insert(fragment.length, [newParagraph]);
          }
        } else {
          // No content yet, create first paragraph
          const newParagraph = new Y.XmlElement('paragraph');
          const newTextNode = new Y.XmlText();
          newTextNode.insert(0, randomText);
          newParagraph.insert(0, [newTextNode]);
          fragment.insert(0, [newParagraph]);
        }
        
        console.log('[Hocuspocus Test Client] Text sent to collaborative document as paragraph:', randomText);
        console.log('[Hocuspocus Test Client] Fragment length after insert:', fragment.length);
        console.log('[Hocuspocus Test Client] Fragment content preview:', fragment.toString().substring(0, 100) + '...');
        
        // Also add to local display for immediate feedback
        setText(prev => prev + randomText + ' ');
        
        // Clear any previous errors
        setError(null);
      } catch (error) {
        console.error('[Hocuspocus Test Client] Error sending text:', error);
        setError('テキストの送信に失敗しました。');
      }
    };

    // Always wait for connection to ensure reliable sending
    console.log('[Hocuspocus Test Client] Setting up connection listener for test text sending');
    
    // Try to send immediately first, if that fails, wait for connection
    try {
      sendWhenReady();
      console.log('[Hocuspocus Test Client] Text sent immediately (provider was ready)');
    } catch (error) {
      console.log('[Hocuspocus Test Client] Immediate send failed, waiting for connection...', error);
      
      // Wait for connection and then send
      const onConnect = () => {
        console.log('[Hocuspocus Test Client] Connection established, sending test text');
        provider.off('connect', onConnect);
        try {
          sendWhenReady();
        } catch (retryError) {
          console.error('[Hocuspocus Test Client] Failed to send after connection:', retryError);
          setError('テキストの送信に失敗しました。');
        }
      };
      
      provider.on('connect', onConnect);
      
      // Timeout after 5 seconds if connection doesn't happen
      setTimeout(() => {
        provider.off('connect', onConnect);
        setError('Hocuspocus接続タイムアウトです。編集セッションが開いているか確認してください。');
      }, 5000);
    }
  }, [currentSessionId, initializeHocuspocusClient]);

  // Initialize Hocuspocus when session changes
  useEffect(() => {
    if (currentSessionId) {
      initializeHocuspocusClient();
    } else {
      cleanupHocuspocusClient();
    }
  }, [currentSessionId, initializeHocuspocusClient, cleanupHocuspocusClient]);

  // Load audio devices when component mounts
  useEffect(() => {
    console.log('[Component] 🎬 RealtimeClient component mounted, loading audio devices...');
    getAudioDevices();
    loadLocalStorageRecordings();
  }, [getAudioDevices, loadLocalStorageRecordings]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('[Component] 🧹 RealtimeClient component unmounting, cleaning up...');
      stopAudioStream();
      disconnectWebSocket();
      cleanupHocuspocusClient();
    };
  }, [stopAudioStream, disconnectWebSocket, cleanupHocuspocusClient]);

  return (
    <main className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">
            Real-time Audio Transcription
          </h1>
          <p className="text-gray-600 mt-2">
            Streaming speech-to-text using OpenAI&apos;s Realtime API
          </p>
          <div className="mt-4">
            <a 
              href="/dummy-recorder" 
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors text-sm"
              target="_blank"
              rel="noopener noreferrer"
            >
              ダミーデータ作成画面 →
            </a>
          </div>
        </div>

        {/* Transcription Prompt Settings */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            文字起こしプロンプト設定
          </h3>
          
          {/* Prompt Mode Selection */}
          <div className="mb-4">
            <div className="flex space-x-4">
              <label className="flex items-center">
                <input
                  type="radio"
                  value="preset"
                  checked={promptMode === 'preset'}
                  onChange={(e) => setPromptMode(e.target.value as 'preset' | 'custom')}
                  disabled={isRecording || isConnected}
                  className="mr-2"
                />
                プリセット使用
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  value="custom"
                  checked={promptMode === 'custom'}
                  onChange={(e) => setPromptMode(e.target.value as 'preset' | 'custom')}
                  disabled={isRecording || isConnected}
                  className="mr-2"
                />
                カスタムプロンプト
              </label>
            </div>
          </div>

          {/* Preset Selection */}
          {promptMode === 'preset' && (
            <div className="mb-4">
              <label htmlFor="prompt-preset-select" className="block text-sm font-medium text-gray-700 mb-2">
                プリセット選択:
              </label>
              <select
                id="prompt-preset-select"
                value={selectedPromptPreset}
                onChange={(e) => setSelectedPromptPreset(e.target.value)}
                disabled={isRecording || isConnected}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              >
                {PROMPT_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} - {preset.description}
                  </option>
                ))}
              </select>
              <div className="mt-2 p-3 bg-gray-50 rounded-md">
                <p className="text-sm text-gray-600">
                  <strong>プロンプト内容:</strong>
                </p>
                <p className="text-sm text-gray-700 mt-1">
                  {getCurrentPrompt() || 'プロンプトなし'}
                </p>
              </div>
            </div>
          )}

          {/* Custom Prompt Input */}
          {promptMode === 'custom' && (
            <div className="mb-4">
              <label htmlFor="custom-prompt" className="block text-sm font-medium text-gray-700 mb-2">
                カスタムプロンプト:
              </label>
              <textarea
                id="custom-prompt"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                disabled={isRecording || isConnected}
                rows={4}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                placeholder="文字起こしをどのように処理するかの指示を入力してください..."
              />
              <p className="text-xs text-gray-500 mt-1">
                例: 「フィラーを除去し、敬語を使った読みやすい文章に変換してください」
              </p>
              {autoLineBreak && (
                <div className="mt-2 p-2 bg-blue-50 rounded border border-blue-200">
                  <p className="text-xs text-blue-700">
                    <strong>追加される指示:</strong> 文脈が変わるポイントで適切に改行を入れて、読みやすい段落構造にしてください。
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Auto Line Break Option */}
          <div className="mb-4">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={autoLineBreak}
                onChange={(e) => setAutoLineBreak(e.target.checked)}
                disabled={isRecording || isConnected}
                className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <span className="text-sm font-medium text-gray-700">
                自動的に改行を入れる
              </span>
            </label>
            <p className="text-xs text-gray-500 mt-1 ml-6">
              文脈が変わるポイントで適切に改行を入れて、読みやすい段落構造にします
            </p>
          </div>

          {/* Speech Break Detection Option */}
          <div className="mb-4">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={speechBreakDetection}
                onChange={(e) => setSpeechBreakDetection(e.target.checked)}
                disabled={isRecording || isConnected}
                className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <span className="text-sm font-medium text-gray-700">
                発話区切り検出を有効にする
              </span>
            </label>
            <p className="text-xs text-gray-500 mt-1 ml-6">
              発話の区切りを検出して絵文字マーカーを挿入します
            </p>
            
            {speechBreakDetection && (
              <div className="mt-3 ml-6">
                <label htmlFor="break-marker" className="block text-xs font-medium text-gray-600 mb-1">
                  区切りマーカー:
                </label>
                <select
                  id="break-marker"
                  value={breakMarker}
                  onChange={(e) => setBreakMarker(e.target.value)}
                  disabled={isRecording || isConnected}
                  className="block w-32 px-2 py-1 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="⏎">⏎ (改行)</option>
                  <option value="↵">↵ (Return)</option>
                  <option value="🔄">🔄 (更新)</option>
                  <option value="📝">📝 (メモ)</option>
                  <option value="🔃">🔃 (緑改行)</option>
                </select>
              </div>
            )}
          </div>

          {/* VAD Parameters */}
          <div className="mb-4 p-4 bg-gray-50 rounded-md border border-gray-200">
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              音声検出パラメータ (VAD設定)
            </h4>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Threshold */}
              <div>
                <label htmlFor="vad-threshold" className="block text-xs font-medium text-gray-600 mb-1">
                  検出感度 (Threshold):
                </label>
                <input
                  id="vad-threshold"
                  type="number"
                  min="0.1"
                  max="1.0"
                  step="0.1"
                  value={vadThreshold}
                  onChange={(e) => setVadThreshold(parseFloat(e.target.value))}
                  disabled={isRecording || isConnected}
                  className="block w-full px-2 py-1 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  0.1-1.0 (低いほど敏感)
                </p>
              </div>
              
              {/* Silence Duration */}
              <div>
                <label htmlFor="vad-silence" className="block text-xs font-medium text-gray-600 mb-1">
                  発話終了判定時間 (ms):
                </label>
                <input
                  id="vad-silence"
                  type="number"
                  min="200"
                  max="3000"
                  step="100"
                  value={vadSilenceDuration}
                  onChange={(e) => setVadSilenceDuration(parseInt(e.target.value))}
                  disabled={isRecording || isConnected}
                  className="block w-full px-2 py-1 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  200-3000ms (短いほど区切りやすい)
                </p>
              </div>
              
              {/* Prefix Padding */}
              <div>
                <label htmlFor="vad-padding" className="block text-xs font-medium text-gray-600 mb-1">
                  開始余裕時間 (ms):
                </label>
                <input
                  id="vad-padding"
                  type="number"
                  min="100"
                  max="1000"
                  step="50"
                  value={vadPrefixPadding}
                  onChange={(e) => setVadPrefixPadding(parseInt(e.target.value))}
                  disabled={isRecording || isConnected}
                  className="block w-full px-2 py-1 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  100-1000ms
                </p>
              </div>
            </div>
            
            <div className="mt-3 text-xs text-blue-600">
              <strong>推奨設定:</strong> 短い区切りなら感度0.2、終了時間500ms
            </div>
          </div>

          <p className="text-xs text-gray-500">
            Note: プロンプト設定は接続前にのみ変更可能です
          </p>
        </div>

        {/* Audio Device Selection and Transcription Model Selection - Responsive 2-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Transcription Model Selection */}
          <div className="bg-white p-6 rounded-lg shadow-md">
            <label htmlFor="transcription-model-select" className="block text-sm font-medium text-gray-700 mb-2">
              音声認識モデル:
            </label>
            <select
              id="transcription-model-select"
              value={transcriptionModel}
              onChange={(e) => setTranscriptionModel(e.target.value)}
              disabled={isRecording || isConnected}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="whisper-1">
                Whisper-1 (従来モデル)
              </option>
              <option value="gpt-4o-mini-transcribe">
                GPT-4o Mini Transcribe (軽量・高速)
              </option>
              <option value="gpt-4o-transcribe">
                GPT-4o Transcribe (高精度)
              </option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              接続前に音声認識モデルを選択してください
            </p>
          </div>

          {/* Audio Input Device Selection */}
          <div className="bg-white p-6 rounded-lg shadow-md">
            <label htmlFor="device-select" className="block text-sm font-medium text-gray-700 mb-2">
              Select Audio Input Device:
            </label>
            <select
              id="device-select"
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              disabled={isRecording}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            >
              {audioDevices.length === 0 ? (
                <option value="">Loading devices...</option>
              ) : (
                audioDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${device.deviceId.slice(0, 8)}...`}
                  </option>
                ))
              )}
            </select>
            <div className="mt-2 flex items-center space-x-2">
              <button
                onClick={getAudioDevices}
                disabled={isRecording}
                className="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Refresh Devices
              </button>
              <p className="text-xs text-gray-500">
                {audioDevices.length} device(s) found
              </p>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Note: Input device can only be changed when not recording
            </p>
          </div>
        </div>

        {/* Connection Status */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="text-center space-y-4">
            <div className="flex items-center justify-center space-x-3">
              <div className={`w-4 h-4 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span className="text-lg font-medium">
                {isConnected ? 'Connected to Realtime API' : 'Disconnected'}
              </span>
            </div>
            
            {/* Connection and Dummy Audio Controls */}
            <div className="flex items-center justify-center space-x-4 flex-wrap gap-2">
              <button
                onClick={isConnected ? disconnectWebSocket : connectWebSocket}
                className={`px-6 py-3 text-lg font-semibold rounded-lg transition-colors ${
                  isConnected
                    ? "bg-red-600 hover:bg-red-700 text-white"
                    : "bg-blue-600 hover:bg-blue-700 text-white"
                }`}
              >
                {isConnected ? 'Disconnect' : 'Connect'}
              </button>
              
              {/* Dummy Audio Controls */}
              <button
                onClick={sendDummyAudio}
                disabled={!isConnected || isDummyAudioSending}
                className={`px-6 py-3 text-sm font-medium rounded-lg transition-colors ${
                  !isConnected || isDummyAudioSending
                    ? "bg-gray-400 cursor-not-allowed text-gray-200"
                    : "bg-orange-600 hover:bg-orange-700 text-white"
                }`}
              >
                {isDummyAudioSending ? '送信中...' : 'ダミーデータ認識'}
              </button>
              
              <div className="flex items-center space-x-2">
                <label htmlFor="dummy-recording-select" className="text-sm font-medium text-gray-700">
                  録音データ:
                </label>
                <select
                  id="dummy-recording-select"
                  value={selectedRecordingId}
                  onChange={(e) => setSelectedRecordingId(e.target.value)}
                  disabled={isDummyAudioSending}
                  className="px-3 py-2 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 min-w-[200px]"
                >
                  {localStorageRecordings.length === 0 ? (
                    <option value="">録音データがありません</option>
                  ) : (
                    localStorageRecordings.map((recording) => (
                      <option key={recording.id} value={recording.id}>
                        {recording.name} ({(recording.duration || 0).toFixed(1)}秒)
                      </option>
                    ))
                  )}
                </select>
                <button
                  onClick={loadLocalStorageRecordings}
                  disabled={isDummyAudioSending}
                  className="px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 rounded disabled:opacity-50 transition-colors"
                >
                  更新
                </button>
              </div>
            </div>
            
            {isDummyAudioSending && (
              <div className="flex items-center justify-center space-x-2 text-orange-600">
                <div className="w-4 h-4 border-2 border-orange-600 border-t-transparent rounded-full animate-spin"></div>
                <span className="text-sm font-medium">ダミーオーディオを送信中...</span>
              </div>
            )}
          </div>
        </div>

        {/* Session Management */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            編集セッション管理
          </h3>
          
          {/* Current Session Display */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              現在のセッションID:
            </label>
            {isEditingSessionId ? (
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={sessionIdInput}
                  onChange={(e) => setSessionIdInput(e.target.value)}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  placeholder="セッションIDを入力..."
                />
                <button
                  onClick={saveSessionId}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  保存
                </button>
                <button
                  onClick={cancelEditSessionId}
                  className="px-4 py-2 text-sm bg-gray-300 text-gray-700 rounded-md hover:bg-gray-400"
                >
                  キャンセル
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-2">
                <div className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">
                  <span className="text-gray-700">
                    {currentSessionId || 'セッションが作成されていません'}
                  </span>
                </div>
                <button
                  onClick={editSessionId}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  変更
                </button>
              </div>
            )}
          </div>

          {/* Connect to Existing Session */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              既存セッションに接続:
            </label>
            <div className="flex space-x-2">
              <input
                type="text"
                value={existingSessionInput}
                onChange={(e) => setExistingSessionInput(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                placeholder="既存のセッションIDを入力..."
              />
              <button
                onClick={connectToExistingSession}
                disabled={!existingSessionInput.trim()}
                className="px-4 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                接続
              </button>
            </div>
          </div>

          {/* Session Status */}
          {currentSessionId && (
            <div className="space-y-3">
              <div className="p-3 bg-green-50 border border-green-200 rounded-md">
                <div className="flex items-center space-x-2">
                  <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                  <span className="text-sm font-medium text-green-800">
                    セッション接続中: {currentSessionId}
                  </span>
                </div>
              </div>
              
              {/* Share Session URL */}
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-blue-700">
                    このURLを共有して他の人を招待
                  </div>
                  <button
                    onClick={() => {
                      const editorUrl = `${window.location.origin}/editor/${currentSessionId}`;
                      navigator.clipboard.writeText(editorUrl);
                      // Optional: Show feedback (could add a toast notification here)
                      const button = document.activeElement as HTMLButtonElement;
                      const originalText = button.textContent;
                      button.textContent = 'コピー完了！';
                      setTimeout(() => {
                        button.textContent = originalText;
                      }, 2000);
                    }}
                    className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                  >
                    URLをコピー
                  </button>
                </div>
                <div className="mt-2 text-xs text-blue-600 font-mono">
                  {typeof window !== 'undefined' && `${window.location.origin}/editor/${currentSessionId}`}
                </div>
              </div>
            </div>
          )}
          
          {/* Create/Open Session Button */}
          <div className="flex justify-center space-x-4">
            <button
              onClick={createOrOpenEditingSession}
              className="px-6 py-3 rounded-lg font-medium text-white bg-green-600 hover:bg-green-700 transition-colors"
            >
              {currentSessionId ? '編集セッションを開く' : '編集セッションの作成'}
            </button>
            
            <button
              onClick={sendTestText}
              disabled={!currentSessionId}
              className="px-6 py-3 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              title={!currentSessionId ? "セッションIDを設定してください" : "テスト文字列を共同編集セッションに送信"}
            >
              テスト文字列送信
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className={`p-6 rounded-lg transition-colors ${
          isRecording 
            ? "bg-red-50 border-2 border-red-200" 
            : "bg-white"
        }`}>
          <div className="flex justify-center space-x-4 flex-wrap gap-2">
          <button
            onClick={isRecording ? stopRecording : startRecording}
            disabled={!isConnected && !isRecording}
            className={`px-6 py-3 rounded-lg font-medium text-white transition-colors ${
              isRecording
                ? "bg-red-600 hover:bg-red-700"
                : "bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            }`}
          >
            {isRecording ? "文字起こし終了" : "文字起こし開始"}
          </button>
          
          <button
            onClick={clearText}
            disabled={isRecording}
            className="px-6 py-3 rounded-lg font-medium text-gray-700 bg-gray-200 hover:bg-gray-300 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
          >
            Clear Text
          </button>
          </div>
        </div>

        {/* Status Indicators */}
        <div className="text-center space-y-2">
          {isRecording && (
            <div className="flex items-center justify-center space-x-2 text-blue-600">
              <div className="w-3 h-3 bg-blue-600 rounded-full animate-pulse"></div>
              <span className="font-medium">Streaming Audio...</span>
            </div>
          )}
          {isSpeaking && (
            <div className="flex items-center justify-center space-x-2 text-green-600">
              <div className="w-3 h-3 bg-green-600 rounded-full animate-pulse"></div>
              <span className="font-medium">Speech Detected</span>
            </div>
          )}
          {isProcessing && !isRecording && (
            <div className="flex items-center justify-center space-x-2 text-orange-600">
              <div className="w-4 h-4 border-2 border-orange-600 border-t-transparent rounded-full animate-spin"></div>
              <span className="font-medium">Processing...</span>
            </div>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex">
              <div className="ml-3">
                <h3 className="text-sm font-medium text-red-800">Error</h3>
                <div className="mt-2 text-sm text-red-700">
                  {error}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Transcription Output */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h2 className="text-lg font-medium text-gray-900 mb-4">
            Real-time Transcription:
          </h2>
          <div className="min-h-[200px] p-4 border border-gray-300 rounded-md bg-gray-50">
            {text ? (
              <p className="text-gray-900 whitespace-pre-wrap leading-relaxed">
                {text}
              </p>
            ) : (
              <p className="text-gray-500 italic">
                Start streaming to see real-time transcription...
              </p>
            )}
          </div>
          {text && (
            <div className="mt-4 text-sm text-gray-600">
              Characters: {text.length} | Words: {text.split(/\s+/).filter(word => word.length > 0).length}
            </div>
          )}
        </div>

        {/* Instructions */}
        <div className="bg-blue-50 p-6 rounded-lg border border-blue-200">
          <h3 className="text-lg font-medium text-blue-900 mb-3">
            How to use Real-time Transcription:
          </h3>
          <ol className="list-decimal list-inside space-y-2 text-blue-800">
            <li>Select your preferred realtime model</li>
            <li>Click &quot;Connect&quot; to establish WebSocket connection</li>
            <li>Click &quot;Start Streaming&quot; and allow microphone access</li>
            <li>Speak naturally - transcription appears in real-time</li>
            <li>Click &quot;Stop Streaming&quot; when finished</li>
          </ol>
          <div className="mt-4 text-sm text-blue-700">
            <strong>Note:</strong> Real-time API has higher costs but provides instant transcription as you speak.
          </div>
          <div className="mt-2 text-sm text-blue-600">
            <strong>Cost:</strong> ~$0.06-0.24 per minute (significantly higher than batch transcription)
          </div>
        </div>
      </div>
    </main>
  );
}