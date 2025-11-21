"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";

type RealtimeModel = "gpt-4o-realtime-preview" | "gpt-4o-mini-realtime-preview";

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

type WebSocketMessage = TranscriptionMessage | ErrorMessage | StatusMessage;

export default function MediaRecorderClient() {
  const websocketRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  const [text, setText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [model, setModel] = useState<RealtimeModel>("gpt-4o-mini-realtime-preview");
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

  // Audio processing utility functions
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

    const wsUrl = `wss://genai.dgi.ntt-tx.co.jp:8000/api/realtime-ws?model=${model}`;
    console.log('[WebSocket] Connecting to:', wsUrl);
    const ws = new WebSocket(wsUrl);
    websocketRef.current = ws;

    ws.onopen = () => {
      console.log('[WebSocket] ✅ Connected successfully');
      setIsConnected(true);
      setError(null);
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
            
          case 'speech_started':
            setIsSpeaking(true);
            console.log('[Speech Detection] 🎤 Speech started');
            break;
            
          case 'speech_stopped':
            setIsSpeaking(false);
            console.log('[Speech Detection] 🔇 Speech stopped');
            break;
            
          case 'error':
          case 'transcription_error':
            setError(message.error);
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
  }, [model]);

  const disconnectWebSocket = useCallback(() => {
    if (websocketRef.current) {
      console.log('[WebSocket] 🔌 Disconnecting WebSocket');
      websocketRef.current.close();
      websocketRef.current = null;
    }
    setIsConnected(false);
  }, []);

  // MediaRecorder-based audio streaming
  const startAudioStream = useCallback(async () => {
    try {
      console.log('[Audio] 🎵 Starting MediaRecorder-based audio stream...');
      
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia not supported in this browser');
      }

      const audioConstraints: MediaStreamConstraints['audio'] = {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      };

      // Use selected device if available
      if (selectedDeviceId) {
        console.log('[Audio] 🎤 Using selected device:', selectedDeviceId);
        (audioConstraints as MediaTrackConstraints).deviceId = { exact: selectedDeviceId };
      }

      console.log('[Audio] 📋 Audio constraints:', audioConstraints);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints
      });
      streamRef.current = stream;
      console.log('[Audio] ✅ Media stream obtained');
      console.log('[Audio] 🔍 MediaStream active:', stream.active);
      console.log('[Audio] 🔍 MediaStream tracks:', stream.getTracks().map(t => ({ 
        kind: t.kind, 
        enabled: t.enabled, 
        readyState: t.readyState,
        label: t.label 
      })));

      // Check MediaRecorder support
      if (!window.MediaRecorder) {
        throw new Error('MediaRecorder not supported in this browser');
      }

      // Try different MIME types for better compatibility
      const mimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus', 
        'audio/mp4',
        'audio/wav'
      ];

      let selectedMimeType = '';
      for (const mimeType of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          selectedMimeType = mimeType;
          console.log('[Audio] ✅ Using MIME type:', mimeType);
          break;
        }
      }

      if (!selectedMimeType) {
        console.warn('[Audio] ⚠️ No supported MIME type found, using default');
      }

      // Create MediaRecorder with small timeslice for real-time streaming
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: selectedMimeType || undefined,
        audioBitsPerSecond: 16000 // Low bitrate for real-time streaming
      });
      mediaRecorderRef.current = mediaRecorder;

      let chunkCount = 0;

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
          chunkCount++;
          console.log(`[MediaRecorder] 📦 Audio chunk #${chunkCount}, size: ${event.data.size} bytes`);
          
          try {
            // Convert Blob to ArrayBuffer
            const arrayBuffer = await event.data.arrayBuffer();
            const base64Audio = arrayBufferToBase64(arrayBuffer);
            
            console.log(`[MediaRecorder] 📤 Sending chunk #${chunkCount}, base64 size: ${base64Audio.length} chars`);
            
            // Send audio chunk to WebSocket
            websocketRef.current.send(JSON.stringify({
              type: 'audio_chunk',
              audio: base64Audio,
              format: selectedMimeType || 'audio/webm'
            }));
          } catch (err) {
            console.error(`[MediaRecorder] ❌ Error processing chunk #${chunkCount}:`, err);
          }
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error('[MediaRecorder] ❌ Recording error:', event);
        setError('MediaRecorder error occurred');
      };

      mediaRecorder.onstart = () => {
        console.log('[MediaRecorder] ▶️ Recording started');
      };

      mediaRecorder.onstop = () => {
        console.log('[MediaRecorder] ⏹️ Recording stopped');
      };

      // Start recording with 100ms intervals for real-time streaming
      mediaRecorder.start(100);
      console.log('[MediaRecorder] 🎬 Started with 100ms timeslice');

      setIsRecording(true);
      setIsProcessing(true);
      console.log('[Audio] ✅ MediaRecorder streaming started successfully');

    } catch (err) {
      console.error('[Audio] ❌ Error starting MediaRecorder stream:', err);
      setError(err instanceof Error ? err.message : 'Failed to start audio stream');
    }
  }, [selectedDeviceId, arrayBufferToBase64]);

  const stopAudioStream = useCallback(() => {
    console.log('[Audio] 🛑 Stopping MediaRecorder stream...');
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      console.log('[MediaRecorder] ⏹️ Stopping MediaRecorder');
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    
    if (streamRef.current) {
      console.log('[Audio] 🔌 Stopping MediaStream tracks');
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('[Audio] ⏹️ Stopped track:', track.kind, track.label);
      });
      streamRef.current = null;
    }

    // Commit any remaining audio buffer
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      console.log('[Audio] 📤 Committing remaining audio buffer');
      websocketRef.current.send(JSON.stringify({
        type: 'audio_commit'
      }));
    }

    setIsRecording(false);
    setIsProcessing(false);
    setIsSpeaking(false);
    console.log('[Audio] ✅ MediaRecorder stream stopped successfully');
  }, []);

  // Main control functions
  const startRecording = useCallback(async () => {
    console.log('[Recording] 🎙️ Start recording requested');
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
  }, [isConnected, connectWebSocket, startAudioStream]);

  const stopRecording = useCallback(() => {
    console.log('[Recording] ⏹️ Stop recording requested');
    stopAudioStream();
  }, [stopAudioStream]);

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

  // Load audio devices when component mounts
  useEffect(() => {
    console.log('[Component] 🎬 MediaRecorderClient component mounted, loading audio devices...');
    getAudioDevices();
  }, [getAudioDevices]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('[Component] 🧹 MediaRecorderClient component unmounting, cleaning up...');
      stopAudioStream();
      disconnectWebSocket();
    };
  }, [stopAudioStream, disconnectWebSocket]);

  return (
    <main className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">
            Real-time Audio Transcription (MediaRecorder)
          </h1>
          <p className="text-gray-600 mt-2">
            Streaming speech-to-text using OpenAI&apos;s Realtime API with MediaRecorder
          </p>
        </div>

        {/* Connection Status */}
        <div className="bg-white p-4 rounded-lg shadow-md">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span className="text-sm font-medium">
                {isConnected ? 'Connected to Realtime API' : 'Disconnected'}
              </span>
            </div>
            <button
              onClick={isConnected ? disconnectWebSocket : connectWebSocket}
              className="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded"
            >
              {isConnected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        </div>

        {/* Model Selection */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <label htmlFor="model-select" className="block text-sm font-medium text-gray-700 mb-2">
            Select Realtime Model:
          </label>
          <select
            id="model-select"
            value={model}
            onChange={(e) => setModel(e.target.value as RealtimeModel)}
            disabled={isRecording || isConnected}
            className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="gpt-4o-mini-realtime-preview">
              GPT-4o Mini Realtime (~$0.06/min input, $0.24/min output)
            </option>
            <option value="gpt-4o-realtime-preview">
              GPT-4o Realtime (~$0.06/min input, $0.24/min output)
            </option>
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Note: Model can only be changed when disconnected
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

        {/* Controls */}
        <div className="flex justify-center space-x-4">
          <button
            onClick={isRecording ? stopRecording : startRecording}
            disabled={!isConnected && !isRecording}
            className={`px-6 py-3 rounded-lg font-medium text-white transition-colors ${
              isRecording
                ? "bg-red-600 hover:bg-red-700"
                : "bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            }`}
          >
            {isRecording ? "Stop Streaming" : "Start Streaming"}
          </button>
          
          <button
            onClick={clearText}
            disabled={isRecording}
            className="px-6 py-3 rounded-lg font-medium text-gray-700 bg-gray-200 hover:bg-gray-300 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
          >
            Clear Text
          </button>
        </div>

        {/* Status Indicators */}
        <div className="text-center space-y-2">
          {isRecording && (
            <div className="flex items-center justify-center space-x-2 text-blue-600">
              <div className="w-3 h-3 bg-blue-600 rounded-full animate-pulse"></div>
              <span className="font-medium">Streaming Audio via MediaRecorder...</span>
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
            How to use MediaRecorder Transcription:
          </h3>
          <ol className="list-decimal list-inside space-y-2 text-blue-800">
            <li>Select your preferred realtime model</li>
            <li>Click &quot;Connect&quot; to establish WebSocket connection</li>
            <li>Click &quot;Start Streaming&quot; and allow microphone access</li>
            <li>Speak naturally - audio is captured via MediaRecorder API</li>
            <li>Click &quot;Stop Streaming&quot; when finished</li>
          </ol>
          <div className="mt-4 text-sm text-blue-700">
            <strong>Note:</strong> This version uses MediaRecorder API for more reliable audio capture.
          </div>
        </div>
      </div>
    </main>
  );
}