"use client";

import React, { useRef, useState, useCallback } from "react";
import { getBasePath } from "@/lib/basePath";

/**
 * タブ音声キャプチャ → リアルタイム文字起こしテストページ。
 * getDisplayMedia() でブラウザタブの音声を取得し、
 * 既存の /api/realtime-ws WebSocket パイプラインに流す。
 */

// --- audio utility ---
const floatTo16BitPCM = (float32: Float32Array): Int16Array => {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
};

const arrayBufferToBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
};

const resampleTo24k = (input: Float32Array, srcRate: number): Float32Array => {
  const targetRate = 24000;
  if (srcRate === targetRate) return input;
  const ratio = targetRate / srcRate;
  const len = Math.floor(input.length * ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const si = i / ratio;
    const idx = Math.floor(si);
    const frac = si - idx;
    out[i] =
      idx + 1 < input.length
        ? input[idx] * (1 - frac) + input[idx + 1] * frac
        : input[idx] || 0;
  }
  return out;
};

export default function TabCaptureClient() {
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingRef = useRef(false);
  const accBufRef = useRef<Int16Array[]>([]);

  const [isCapturing, setIsCapturing] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [text, setText] = useState("");
  const [pendingText, setPendingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("待機中");

  // 設定
  const BUFFER_SIZE = 8192;
  const BATCH_MULTIPLIER = 8;

  // --- WebSocket ---
  const connectWs = useCallback((): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const protocol =
        window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}${getBasePath()}/api/realtime-ws`;
      console.log("[TabCapture] WS connecting:", url);

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[TabCapture] WS connected");
        setIsConnected(true);
        setError(null);

        // 基本設定を送信
        ws.send(JSON.stringify({ type: "set_transcription_model", model: "gpt-4o-transcribe" }));
        ws.send(JSON.stringify({ type: "set_vad_params", enabled: true, threshold: 0.5, silence_duration_ms: 600, prefix_padding_ms: 300, paragraph_break_threshold_ms: 2500 }));
        ws.send(JSON.stringify({ type: "set_speech_break_detection", enabled: true, marker: "↩️" }));

        resolve(ws);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          switch (msg.type) {
            case "ready":
              setStatus("OpenAI接続完了");
              break;
            case "speech_started":
              setStatus("発話検出中...");
              break;
            case "speech_stopped":
              setStatus("処理中...");
              break;
            case "transcription":
              setText((prev) => prev + msg.text + "\n");
              setPendingText("");
              setStatus("キャプチャ中");
              break;
            case "transcription_delta":
              setPendingText((prev) => prev + msg.delta);
              break;
            case "paragraph_break":
              setText((prev) => prev + msg.marker + "\n");
              break;
            case "error":
            case "transcription_error":
              setError(msg.error);
              break;
          }
        } catch {
          // ignore non-JSON
        }
      };

      ws.onclose = () => {
        console.log("[TabCapture] WS closed");
        setIsConnected(false);
        setStatus("切断");
      };

      ws.onerror = (e) => {
        console.error("[TabCapture] WS error", e);
        setError("WebSocket接続エラー");
        reject(e);
      };
    });
  }, []);

  // --- Audio capture via getDisplayMedia ---
  const startCapture = useCallback(async () => {
    try {
      setError(null);
      setStatus("タブ選択中...");

      // 1. getDisplayMedia でタブ音声を取得
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // video は必須（タブ選択UIのため）
        audio: true, // 音声トラックを要求
      });

      // 映像トラックは不要なので停止
      stream.getVideoTracks().forEach((t) => t.stop());

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error("音声トラックが取得できませんでした。タブ共有時に「タブの音声も共有」を有効にしてください。");
      }
      console.log("[TabCapture] Audio track obtained:", audioTracks[0].label);
      streamRef.current = stream;

      // タブ共有停止イベント
      audioTracks[0].addEventListener("ended", () => {
        console.log("[TabCapture] Audio track ended (user stopped sharing)");
        stopCapture();
      });

      // 2. WebSocket 接続
      setStatus("WebSocket接続中...");
      const ws = await connectWs();

      // 3. AudioContext パイプライン構築
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
      const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorRef.current = processor;

      recordingRef.current = true;
      accBufRef.current = [];

      processor.onaudioprocess = (ev) => {
        if (!recordingRef.current) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const raw = ev.inputBuffer.getChannelData(0);
        const resampled = resampleTo24k(raw, ev.inputBuffer.sampleRate);
        const pcm = floatTo16BitPCM(resampled);

        accBufRef.current.push(pcm);

        if (accBufRef.current.length >= BATCH_MULTIPLIER) {
          const total = accBufRef.current.reduce((s, a) => s + a.length, 0);
          const merged = new Int16Array(total);
          let off = 0;
          for (const chunk of accBufRef.current) {
            merged.set(chunk, off);
            off += chunk.length;
          }
          accBufRef.current = [];

          const b64 = arrayBufferToBase64(merged.buffer as ArrayBuffer);
          ws.send(JSON.stringify({ type: "audio_chunk", audio: b64 }));
        }
      };

      // ScriptProcessor は destination に接続しないとイベントが発火しない
      const gain = ctx.createGain();
      gain.gain.value = 0; // 音声出力はミュート
      source.connect(processor);
      processor.connect(gain);
      gain.connect(ctx.destination);

      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      setIsCapturing(true);
      setStatus("キャプチャ中");
      console.log("[TabCapture] Capture started, sampleRate:", ctx.sampleRate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[TabCapture] Error:", msg);
      // ユーザーがキャンセルした場合
      if (msg.includes("Permission denied") || msg.includes("AbortError") || msg.includes("NotAllowedError")) {
        setError("タブ共有がキャンセルされました");
      } else {
        setError(msg);
      }
      setStatus("エラー");
    }
  }, [connectWs]);

  // --- Stop ---
  const stopCapture = useCallback(() => {
    recordingRef.current = false;

    // 残りバッファをフラッシュ
    if (accBufRef.current.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
      const total = accBufRef.current.reduce((s, a) => s + a.length, 0);
      const merged = new Int16Array(total);
      let off = 0;
      for (const chunk of accBufRef.current) {
        merged.set(chunk, off);
        off += chunk.length;
      }
      accBufRef.current = [];
      const b64 = arrayBufferToBase64(merged.buffer as ArrayBuffer);
      wsRef.current.send(JSON.stringify({ type: "audio_chunk", audio: b64 }));
      wsRef.current.send(JSON.stringify({ type: "audio_commit" }));
    }

    // AudioContext クリーンアップ
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    // MediaStream 停止
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    // WebSocket クローズ
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsCapturing(false);
    setIsConnected(false);
    setStatus("停止");
    console.log("[TabCapture] Capture stopped");
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Tab Audio Capture テスト</h1>
        <p className="text-gray-600 mb-6 text-sm">
          getDisplayMedia() でブラウザタブの音声をキャプチャし、リアルタイム文字起こしに送信します。
        </p>

        {/* ステータス */}
        <div className="mb-4 flex items-center gap-3">
          <span
            className={`inline-block w-3 h-3 rounded-full ${
              isCapturing
                ? "bg-green-500 animate-pulse"
                : isConnected
                ? "bg-yellow-500"
                : "bg-gray-400"
            }`}
          />
          <span className="text-sm font-medium">{status}</span>
        </div>

        {/* エラー表示 */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* コントロール */}
        <div className="mb-6 flex gap-3">
          {!isCapturing ? (
            <button
              onClick={startCapture}
              className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
            >
              タブ音声キャプチャ開始
            </button>
          ) : (
            <button
              onClick={stopCapture}
              className="px-6 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition"
            >
              停止
            </button>
          )}
          <button
            onClick={() => { setText(""); setPendingText(""); }}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition"
          >
            クリア
          </button>
        </div>

        {/* 使い方 */}
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded text-sm">
          <p className="font-medium mb-1">使い方:</p>
          <ol className="list-decimal ml-4 space-y-1">
            <li>「タブ音声キャプチャ開始」をクリック</li>
            <li>表示されるダイアログで、音声を再生中のタブを選択</li>
            <li>「タブの音声も共有」にチェックを入れて共有</li>
            <li>選択したタブで再生されている音声が文字起こしされます</li>
          </ol>
        </div>

        {/* 認識中テキスト */}
        {pendingText && (
          <div className="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800">
            認識中: {pendingText}
          </div>
        )}

        {/* 文字起こし結果 */}
        <div className="bg-white border rounded p-4 min-h-[300px] whitespace-pre-wrap text-sm font-mono">
          {text || (
            <span className="text-gray-400">
              文字起こし結果がここに表示されます...
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
