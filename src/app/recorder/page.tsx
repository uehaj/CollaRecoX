"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";

type TranscriptionModel = "gpt-4o-mini-transcribe" | "gpt-4o-transcribe";

export default function RecorderPage() {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [text, setText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [model, setModel] = useState<TranscriptionModel>("gpt-4o-mini-transcribe");
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

  // Function to process audio blob after recording stops
  const processAudioBlob = useCallback(async (audioBlob: Blob) => {
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      const response = await fetch(`/api/transcribe?model=${model}`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Process streaming response
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const textDecoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += textDecoder.decode(value, { stream: true });
        
        // Process complete lines (JSON objects)
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            try {
              const chunk = JSON.parse(line);
              if (chunk.error) {
                setError(chunk.error);
              } else if (chunk.text) {
                setText(prev => prev + chunk.text);
              }
            } catch (parseError) {
              console.error("JSON parse error:", parseError, "Line:", line);
            }
          }
        }
      }
    } catch (fetchError) {
      console.error("Fetch error:", fetchError);
      setError(fetchError instanceof Error ? fetchError.message : "Network error");
    }
  }, [model]);

  // Get available audio input devices
  const getAudioDevices = useCallback(async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
        return;
      }

      // Request permission first
      await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Get all devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(device => device.kind === 'audioinput');
      
      setAudioDevices(audioInputs);
      
      // Set default device if none selected
      if (audioInputs.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(audioInputs[0].deviceId);
      }
    } catch (error) {
      console.error('Error getting audio devices:', error);
      setError('Failed to access audio devices. Please grant microphone permission.');
    }
  }, [selectedDeviceId]);

  // Load audio devices on component mount
  useEffect(() => {
    getAudioDevices();
  }, [getAudioDevices]);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      setText("");
      
      // Request microphone access
      const audioConstraints: MediaStreamConstraints['audio'] = {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      };

      // Use selected device if available
      if (selectedDeviceId) {
        (audioConstraints as MediaTrackConstraints).deviceId = { exact: selectedDeviceId };
      }

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: audioConstraints
      });

      // Check if browser supports the preferred audio format
      const mimeTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ];
      
      let selectedMimeType = "";
      for (const mimeType of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          selectedMimeType = mimeType;
          break;
        }
      }

      if (!selectedMimeType) {
        throw new Error("No supported audio format found");
      }

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, { 
        mimeType: selectedMimeType,
        audioBitsPerSecond: 128000,
      });
      
      mediaRecorderRef.current = mediaRecorder;
      
      // Collect audio chunks
      const audioChunks: Blob[] = [];
      
      // Handle data available events
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      // Handle recording stop
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        setIsRecording(false);
        
        // Create final audio blob and send to API
        if (audioChunks.length > 0) {
          const audioBlob = new Blob(audioChunks, { type: selectedMimeType });
          await processAudioBlob(audioBlob);
        }
        setIsProcessing(false);
      };

      // Handle errors
      mediaRecorder.onerror = (event) => {
        console.error("MediaRecorder error:", event);
        setError("Recording error occurred");
        setIsRecording(false);
        setIsProcessing(false);
      };

      // Start recording with 1 second intervals
      mediaRecorder.start(1000);
      setIsRecording(true);
      setIsProcessing(true);

    } catch (err) {
      console.error("Start recording error:", err);
      setError(err instanceof Error ? err.message : "Failed to start recording");
      setIsRecording(false);
      setIsProcessing(false);
    }
  }, [processAudioBlob, selectedDeviceId]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  }, [isRecording]);

  const clearText = useCallback(() => {
    setText("");
    setError(null);
  }, []);

  return (
    <main className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">
            Audio Transcription
          </h1>
          <p className="text-gray-600 mt-2">
            Real-time speech-to-text using OpenAI&apos;s latest transcribe models
          </p>
        </div>

        {/* Model Selection */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <label htmlFor="model-select" className="block text-sm font-medium text-gray-700 mb-2">
            Select Transcription Model:
          </label>
          <select
            id="model-select"
            value={model}
            onChange={(e) => setModel(e.target.value as TranscriptionModel)}
            disabled={isRecording}
            className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="gpt-4o-mini-transcribe">
              GPT-4o Mini Transcribe (~$0.003/min - Faster & Cheaper)
            </option>
            <option value="gpt-4o-transcribe">
              GPT-4o Transcribe (~$0.006/min - Higher Accuracy)
            </option>
          </select>
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
            disabled={isProcessing && !isRecording}
            className={`px-6 py-3 rounded-lg font-medium text-white transition-colors ${
              isRecording
                ? "bg-red-600 hover:bg-red-700"
                : "bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            }`}
          >
            {isRecording ? "Stop Recording" : "Start Recording"}
          </button>
          
          <button
            onClick={clearText}
            disabled={isRecording || isProcessing}
            className="px-6 py-3 rounded-lg font-medium text-gray-700 bg-gray-200 hover:bg-gray-300 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
          >
            Clear Text
          </button>
        </div>

        {/* Status */}
        <div className="text-center">
          {isRecording && (
            <div className="flex items-center justify-center space-x-2 text-red-600">
              <div className="w-3 h-3 bg-red-600 rounded-full animate-pulse"></div>
              <span className="font-medium">Recording...</span>
            </div>
          )}
          {isProcessing && !isRecording && (
            <div className="flex items-center justify-center space-x-2 text-blue-600">
              <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
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
            Transcription Output:
          </h2>
          <div className="min-h-[200px] p-4 border border-gray-300 rounded-md bg-gray-50">
            {text ? (
              <p className="text-gray-900 whitespace-pre-wrap leading-relaxed">
                {text}
              </p>
            ) : (
              <p className="text-gray-500 italic">
                Transcribed text will appear here...
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
            How to use:
          </h3>
          <ol className="list-decimal list-inside space-y-2 text-blue-800">
            <li>Select your preferred transcription model</li>
            <li>Click &quot;Start Recording&quot; and allow microphone access</li>
            <li>Speak clearly into your microphone</li>
            <li>Click &quot;Stop Recording&quot; when finished</li>
            <li>Wait for transcription to process and appear below</li>
          </ol>
          <div className="mt-4 text-sm text-blue-700">
            <strong>Note:</strong> Make sure your OpenAI API key is configured in the environment variables.
          </div>
        </div>
      </div>
    </main>
  );
}