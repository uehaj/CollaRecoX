"use client";

import React, { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';

interface AudioRecording {
  id: string;
  name: string;
  timestamp: number;
  duration: number;
  data: string; // base64 encoded PCM data
  sampleRate: number;
}

export default function DummyRecorderPage() {
  const [isRecording, setIsRecording] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [recordings, setRecordings] = useState<AudioRecording[]>([]);
  const [recordingName, setRecordingName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  // processorRef removed - using MediaRecorder instead
  const recordingDataRef = useRef<Int16Array[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const durationTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingStateRef = useRef<boolean>(false);

  // Load recordings from localStorage on mount
  useEffect(() => {
    loadRecordingsFromStorage();
  }, []);

  // Load recordings from localStorage
  const loadRecordingsFromStorage = useCallback(() => {
    try {
      const stored = localStorage.getItem('dummy-audio-recordings');
      if (stored) {
        const parsed = JSON.parse(stored);
        setRecordings(parsed);
        console.log('[Storage] Loaded', parsed.length, 'recordings from localStorage');
      }
    } catch (error) {
      console.error('[Storage] Error loading recordings:', error);
      setError('録音データの読み込みに失敗しました');
    }
  }, []);

  // Save recordings to localStorage
  const saveRecordingsToStorage = useCallback((newRecordings: AudioRecording[]) => {
    try {
      localStorage.setItem('dummy-audio-recordings', JSON.stringify(newRecordings));
      console.log('[Storage] Saved', newRecordings.length, 'recordings to localStorage');
    } catch (error) {
      console.error('[Storage] Error saving recordings:', error);
      setError('録音データの保存に失敗しました');
    }
  }, []);

  // Get available audio input devices
  const getAudioDevices = useCallback(async () => {
    try {
      console.log('[Audio Devices] Getting available audio input devices...');
      
      if (!navigator?.mediaDevices) {
        throw new Error('MediaDevices API not available');
      }

      // Request permission first
      await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Get all devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(device => device.kind === 'audioinput');
      console.log('[Audio Devices] Found', audioInputs.length, 'audio input devices');
      
      setAudioDevices(audioInputs);
      
      // Set default device if none selected
      if (audioInputs.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(audioInputs[0].deviceId);
      }
    } catch (error) {
      console.error('[Audio Devices] Error getting audio devices:', error);
      setError('オーディオデバイスの取得に失敗しました。マイクのアクセス許可を確認してください。');
    }
  }, [selectedDeviceId]);

  // Convert Float32Array to Int16Array (PCM16)
  const floatTo16BitPCM = useCallback((float32Array: Float32Array): Int16Array => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  }, []);

  // Convert Int16Array to base64
  const int16ArrayToBase64 = useCallback((int16Array: Int16Array): string => {
    const uint8Array = new Uint8Array(int16Array.buffer);
    let binary = '';
    for (let i = 0; i < uint8Array.byteLength; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }, []);

  // Start recording
  const startRecording = useCallback(async () => {
    try {
      console.log('[Recording] Starting audio recording...');
      setError(null);
      recordingDataRef.current = [];
      
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia not supported in this browser');
      }

      const audioConstraints: MediaStreamConstraints['audio'] = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        sampleRate: 24000, // Target 24kHz for OpenAI API
      };

      // Use selected device if available
      if (selectedDeviceId) {
        (audioConstraints as MediaTrackConstraints).deviceId = { exact: selectedDeviceId };
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints
      });

      // Create AudioContext for processing
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass({ sampleRate: 24000 });
      audioContextRef.current = audioContext;

      // Use MediaRecorder for reliable recording
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm'
      });
      mediaRecorderRef.current = mediaRecorder;
      
      const audioChunks: Blob[] = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
          console.log(`[Recording] Audio chunk received: ${event.data.size} bytes`);
        }
      };
      
      mediaRecorder.onstop = async () => {
        console.log('[Recording] MediaRecorder stopped, processing audio...');
        
        if (audioChunks.length > 0) {
          try {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            console.log(`[Recording] Audio blob created: ${audioBlob.size} bytes`);
            
            // Convert blob to PCM16 using AudioContext
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioData = await audioContext.decodeAudioData(arrayBuffer);
            
            // Convert to PCM16
            const channelData = audioData.getChannelData(0);
            const pcm16 = floatTo16BitPCM(channelData);
            
            console.log(`[Recording] Converted to PCM16: ${pcm16.length} samples`);
            
            if (pcm16.length > 0) {
              // Convert to base64
              const base64Data = int16ArrayToBase64(pcm16);
              console.log(`[Recording] Base64 data length: ${base64Data.length} chars`);
              
              // Create recording object
              const recording: AudioRecording = {
                id: `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: recordingName || `録音_${new Date().toLocaleString('ja-JP')}`,
                timestamp: Date.now(),
                duration: recordingDuration,
                data: base64Data,
                sampleRate: 24000
              };
              
              console.log('[Recording] Created recording object:', recording);
              
              // Add to recordings list
              const currentRecordings = JSON.parse(localStorage.getItem('dummy-audio-recordings') || '[]');
              const newRecordings = [recording, ...currentRecordings];
              setRecordings(newRecordings);
              saveRecordingsToStorage(newRecordings);
              
              console.log('[Recording] Updated recordings list, new length:', newRecordings.length);
              
              // Clear recording name for next recording
              setRecordingName('');
              setRecordingDuration(0);
            }
          } catch (error) {
            console.error('[Recording] Error processing audio:', error);
            setError('録音データの処理に失敗しました。');
          }
        } else {
          console.warn('[Recording] No audio chunks recorded');
          setError('録音データが見つかりません。');
        }
      };
      
      // Start recording
      mediaRecorder.start(1000); // Collect data every second
      console.log('[Recording] MediaRecorder started')

      // Resume AudioContext if suspended
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      setIsRecording(true);
      recordingStateRef.current = true;
      recordingStartTimeRef.current = Date.now();
      
      // Start duration timer
      durationTimerRef.current = setInterval(() => {
        const elapsed = (Date.now() - recordingStartTimeRef.current) / 1000;
        setRecordingDuration(elapsed);
      }, 100);

      console.log('[Recording] Recording started successfully');
      
    } catch (error) {
      console.error('[Recording] Error starting recording:', error);
      setError(error instanceof Error ? error.message : '録音の開始に失敗しました');
    }
  }, [isRecording, selectedDeviceId, floatTo16BitPCM]);

  // Stop recording
  const stopRecording = useCallback(() => {
    console.log('[Recording] Stopping audio recording...');
    
    setIsRecording(false);
    recordingStateRef.current = false;
    
    // Clear duration timer
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    
    // Stop MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      console.log('[Recording] MediaRecorder stopped');
    }
    
    // Wait a bit for MediaRecorder to process, then handle data
    setTimeout(() => {
      // Process recorded data will be handled in MediaRecorder.onstop
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      
      // The actual data processing happens in MediaRecorder.onstop callback
    }, 500);

    // Recording data processing is handled in MediaRecorder.onstop callback
    
  }, [recordingName, recordingDuration, saveRecordingsToStorage, int16ArrayToBase64]);

  // Delete recording
  const deleteRecording = useCallback((id: string) => {
    const newRecordings = recordings.filter(rec => rec.id !== id);
    setRecordings(newRecordings);
    saveRecordingsToStorage(newRecordings);
    console.log('[Recording] Deleted recording:', id);
  }, [recordings, saveRecordingsToStorage]);

  // Export recording as downloadable file
  const exportRecording = useCallback((recording: AudioRecording) => {
    try {
      // Convert base64 back to binary
      const binaryString = atob(recording.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Create blob and download
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${recording.name}.pcm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      console.log('[Export] Exported recording:', recording.name);
    } catch (error) {
      console.error('[Export] Error exporting recording:', error);
      setError('録音のエクスポートに失敗しました');
    }
  }, []);

  // Upload and process audio file
  const uploadAudioFile = useCallback(async (file: File) => {
    try {
      setIsUploading(true);
      setError(null);
      
      console.log('[File Upload] Processing file:', file.name, file.type, file.size);
      
      // Create AudioContext for processing
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass({ sampleRate: 24000 });
      
      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      console.log('[File Upload] File read as ArrayBuffer:', arrayBuffer.byteLength, 'bytes');
      
      // Decode audio data
      const audioData = await audioContext.decodeAudioData(arrayBuffer);
      console.log('[File Upload] Audio decoded - duration:', audioData.duration, 'seconds, sample rate:', audioData.sampleRate);
      
      // Convert to PCM16
      const channelData = audioData.getChannelData(0);
      const pcm16 = floatTo16BitPCM(channelData);
      
      console.log('[File Upload] Converted to PCM16:', pcm16.length, 'samples');
      
      if (pcm16.length > 0) {
        // Convert to base64
        const base64Data = int16ArrayToBase64(pcm16);
        console.log('[File Upload] Base64 data length:', base64Data.length, 'chars');
        
        // Create recording object
        const recording: AudioRecording = {
          id: `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          name: file.name.replace(/\.[^/.]+$/, '') + '_アップロード', // Remove extension and add suffix
          timestamp: Date.now(),
          duration: audioData.duration,
          data: base64Data,
          sampleRate: 24000
        };
        
        console.log('[File Upload] Created recording object:', recording);
        
        // Add to recordings list
        const currentRecordings = JSON.parse(localStorage.getItem('dummy-audio-recordings') || '[]');
        const newRecordings = [recording, ...currentRecordings];
        setRecordings(newRecordings);
        saveRecordingsToStorage(newRecordings);
        
        console.log('[File Upload] Updated recordings list, new length:', newRecordings.length);
      }
      
      // Clean up
      audioContext.close();
      
    } catch (error) {
      console.error('[File Upload] Error processing file:', error);
      setError('ファイルの処理に失敗しました。対応している音声ファイル形式を確認してください。');
    } finally {
      setIsUploading(false);
    }
  }, [floatTo16BitPCM, int16ArrayToBase64, saveRecordingsToStorage]);

  // Handle file input change
  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      
      // Validate file type
      const supportedTypes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/m4a'];
      if (!supportedTypes.some(type => file.type.includes(type.split('/')[1]))) {
        setError('対応していないファイル形式です。WAV, MP3, OGG, WebM, M4Aファイルを選択してください。');
        event.target.value = ''; // Clear the input
        return;
      }
      
      // Validate file size (max 50MB)
      const maxSize = 50 * 1024 * 1024; // 50MB
      if (file.size > maxSize) {
        setError('ファイルサイズが大きすぎます。50MB以下のファイルを選択してください。');
        event.target.value = ''; // Clear the input
        return;
      }
      
      uploadAudioFile(file);
      event.target.value = ''; // Clear the input for next use
    }
  }, [uploadAudioFile]);

  // Clear all recordings
  const clearAllRecordings = useCallback(() => {
    if (confirm('すべての録音を削除しますか？この操作は取り消せません。')) {
      setRecordings([]);
      localStorage.removeItem('dummy-audio-recordings');
      console.log('[Storage] Cleared all recordings');
    }
  }, []);

  // Load audio devices on mount
  useEffect(() => {
    getAudioDevices();
  }, [getAudioDevices]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatFileSize = (base64Length: number) => {
    const bytes = (base64Length * 3) / 4; // Approximate binary size
    if (bytes < 1024) return `${bytes.toFixed(0)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <main className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">
            ダミーデータ作成
          </h1>
          <p className="text-gray-600 mt-2">
            ブラウザで音声を録音し、テスト用ダミーデータを作成・管理します
          </p>
          <div className="mt-4">
            <Link 
              href="/realtime" 
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              ← リアルタイム音声認識に戻る
            </Link>
          </div>
        </div>

        {/* Audio Device Selection */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            オーディオデバイス選択
          </h3>
          <div className="flex items-center space-x-4">
            <label htmlFor="device-select" className="text-sm font-medium text-gray-700">
              入力デバイス:
            </label>
            <select
              id="device-select"
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              disabled={isRecording}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            >
              {audioDevices.length === 0 ? (
                <option value="">デバイスを読み込み中...</option>
              ) : (
                audioDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `マイク ${device.deviceId.slice(0, 8)}...`}
                  </option>
                ))
              )}
            </select>
            <button
              onClick={getAudioDevices}
              disabled={isRecording}
              className="px-4 py-2 text-sm bg-gray-200 hover:bg-gray-300 rounded disabled:opacity-50"
            >
              更新
            </button>
          </div>
        </div>

        {/* Recording Controls */}
        <div className={`p-6 rounded-lg transition-colors ${
          isRecording ? "bg-red-50 border-2 border-red-200" : "bg-white shadow-md"
        }`}>
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            録音コントロール
          </h3>
          
          {/* Recording Name Input */}
          <div className="mb-4">
            <label htmlFor="recording-name" className="block text-sm font-medium text-gray-700 mb-2">
              録音名:
            </label>
            <input
              id="recording-name"
              type="text"
              value={recordingName}
              onChange={(e) => setRecordingName(e.target.value)}
              disabled={isRecording}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              placeholder="録音に名前を付けてください（省略可）"
            />
          </div>

          {/* Recording Status */}
          {isRecording && (
            <div className="mb-4 p-3 bg-red-100 border border-red-200 rounded-md">
              <div className="flex items-center space-x-3">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                <span className="text-red-800 font-medium">録音中...</span>
                <span className="text-red-600">{formatDuration(recordingDuration)}</span>
              </div>
            </div>
          )}

          {/* Control Buttons */}
          <div className="flex justify-center space-x-4 flex-wrap gap-2">
            <button
              onClick={isRecording ? stopRecording : startRecording}
              disabled={!selectedDeviceId && !isRecording}
              className={`px-8 py-4 text-lg font-semibold rounded-lg transition-colors ${
                isRecording
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-green-600 hover:bg-green-700 text-white disabled:bg-gray-400 disabled:cursor-not-allowed"
              }`}
            >
              {isRecording ? "録音停止" : "録音開始"}
            </button>
            
            <div className="relative">
              <input
                type="file"
                accept="audio/*"
                onChange={handleFileUpload}
                disabled={isRecording || isUploading}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                id="audio-file-upload"
              />
              <label
                htmlFor="audio-file-upload"
                className={`px-6 py-4 text-lg font-semibold rounded-lg transition-colors cursor-pointer inline-block ${
                  isRecording || isUploading
                    ? "bg-gray-400 text-gray-200 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 text-white"
                }`}
              >
                {isUploading ? "アップロード中..." : "ファイルアップロード"}
              </label>
            </div>
          </div>
          
          {isUploading && (
            <div className="mt-4 flex items-center justify-center space-x-2 text-blue-600">
              <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              <span className="text-sm font-medium">オーディオファイルを処理中...</span>
            </div>
          )}
        </div>

        {/* Recordings List */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">
              保存済み録音 ({recordings.length})
            </h3>
            {recordings.length > 0 && (
              <button
                onClick={clearAllRecordings}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
              >
                すべて削除
              </button>
            )}
          </div>

          {recordings.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              録音がまだありません。上の録音ボタンから始めてください。
            </div>
          ) : (
            <div className="space-y-3">
              {recordings.map((recording) => (
                <div key={recording.id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        {recording.id.startsWith('file_') ? (
                          <span className="text-blue-600" title="アップロードファイル">📁</span>
                        ) : (
                          <span className="text-red-600" title="録音データ">🎤</span>
                        )}
                        <h4 className="font-medium text-gray-900">{recording.name}</h4>
                      </div>
                      <div className="text-sm text-gray-500 mt-1">
                        <span>長さ: {formatDuration(recording.duration)}</span>
                        <span className="mx-2">•</span>
                        <span>サイズ: {formatFileSize(recording.data.length)}</span>
                        <span className="mx-2">•</span>
                        <span>作成: {new Date(recording.timestamp).toLocaleString('ja-JP')}</span>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => exportRecording(recording)}
                        className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                      >
                        エクスポート
                      </button>
                      <button
                        onClick={() => deleteRecording(recording.id)}
                        className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex">
              <div className="ml-3">
                <h3 className="text-sm font-medium text-red-800">エラー</h3>
                <div className="mt-2 text-sm text-red-700">
                  {error}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Instructions */}
        <div className="bg-blue-50 p-6 rounded-lg border border-blue-200">
          <h3 className="text-lg font-medium text-blue-900 mb-3">
            使用方法:
          </h3>
          <ol className="list-decimal list-inside space-y-2 text-blue-800">
            <li>オーディオデバイスを選択します</li>
            <li>録音名を入力します（省略可）</li>
            <li>「録音開始」ボタンをクリックして録音を開始します</li>
            <li>話した内容が録音されます</li>
            <li>「録音停止」ボタンをクリックして録音を終了します</li>
            <li>録音はlocalStorageに自動保存されます</li>
            <li>「エクスポート」でPCMファイルとしてダウンロードできます</li>
          </ol>
          <div className="mt-4 text-sm text-blue-700">
            <strong>注意:</strong> 録音データはブラウザのlocalStorageに保存されます。
            ブラウザのデータを消去すると録音も削除されます。
          </div>
        </div>
      </div>
    </main>
  );
}