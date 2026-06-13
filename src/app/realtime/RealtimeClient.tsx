"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
// yjs and HocuspocusProvider are dynamically imported to avoid SSR localStorage issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YDocType = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HocuspocusProviderType = any;
import { getBasePath } from '@/lib/basePath';
import packageJson from '../../../package.json';

// ===== オンデバイス認識（ChromeオンデバイスWeb Speech API） =====
// Chrome 139+のオンデバイス認識（processLocally）とChrome 135+のMediaStreamTrack入力
// （start(track)）を併用し、話している最中から粗いドラフトを表示する。
// 実験的APIでlib.domに型がないため、必要最小限の型を自前で宣言する。

interface LocalSpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string }; length: number };
  };
}

interface LocalSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((event: LocalSpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: (track?: MediaStreamTrack) => void;
  stop: () => void;
  abort: () => void;
}

interface LocalSpeechRecognitionStatic {
  new (): LocalSpeechRecognition;
  available?: (options: { langs: string[]; processLocally?: boolean }) => Promise<string>;
  install?: (options: { langs: string[]; processLocally?: boolean }) => Promise<boolean>;
}

const getSpeechRecognitionCtor = (): LocalSpeechRecognitionStatic | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: LocalSpeechRecognitionStatic;
    webkitSpeechRecognition?: LocalSpeechRecognitionStatic;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
};

type LocalAsrStatus = 'checking' | 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

// オンデバイス認識テキストを共有ドキュメントへ中継するWebSocketから受け取るメッセージ。
// （自動校正の進捗通知のみ。OpenAI音声認識経路は撤去済み）
interface AutoProofreadMessage {
  type: 'auto_proofread_started' | 'auto_proofread_completed' | 'auto_proofread_error';
  paragraphs?: number;
  chars?: number;
  error?: string;
}

type WebSocketMessage = AutoProofreadMessage;

export default function RealtimeClient() {
  const websocketRef = useRef<WebSocket | null>(null);
  const recordingStateRef = useRef<boolean>(false);

  // Hocuspocus client refs（共有ドキュメント同期用）
  const hocuspocusProviderRef = useRef<HocuspocusProviderType | null>(null);
  const hocuspocusDocRef = useRef<YDocType | null>(null);

  const [text, setText] = useState("");
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null); // 文字起こし結果のスクロールボックス
  const transcriptAtBottomRef = useRef<boolean>(true); // ユーザーが最下部付近にいるか（自動追従の判定用）

  // Initialize session ID on component mount
  // リロードのたびにセッションIDが変わると校正画面とのペアリングが切れるため、
  // 優先順位: URLの?session=パラメータ → localStorage → 新規生成 で復元する。
  // セッション変更時はURLとlocalStorageの両方に反映される（下の永続化effect）ので、
  // リロード・ブックマーク・URL共有のいずれでも同じ配信セッションを継続できる
  useEffect(() => {
    if (!currentSessionId && typeof window !== 'undefined') {
      const fromUrl = new URLSearchParams(window.location.search).get('session');
      // サーバ側の検証と同条件（制御文字なし・100文字以内）のみ受け付ける
      const isValidSessionId = (id: string | null): id is string =>
        !!id && id.length <= 100 && !/[\x00-\x1f\x7f]/.test(id);

      if (isValidSessionId(fromUrl)) {
        setCurrentSessionId(fromUrl);
        console.log('[Session] 🆔 Restored session ID from URL:', fromUrl);
      } else {
        const stored = window.localStorage.getItem('collarecox-realtime-session-id');
        if (isValidSessionId(stored)) {
          setCurrentSessionId(stored);
          console.log('[Session] 🆔 Restored session ID from localStorage:', stored);
        } else {
          const newSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          setCurrentSessionId(newSessionId);
          console.log('[Session] 🆔 Auto-generated session ID:', newSessionId);
        }
      }
    }
  }, []); // Empty dependency array - runs only once on mount

  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false); // 共有ドキュメント中継WebSocketの接続状態
  const [error, setError] = useState<string | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [audioSource, setAudioSource] = useState<'microphone' | 'tab-capture'>('tab-capture');
  const tabCaptureStreamRef = useRef<MediaStream | null>(null);
  const [forceLineBreakAtPeriod, setForceLineBreakAtPeriod] = useState<boolean>(true); // 句点で強制改行（デフォルト: 有効）
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [sessionIdInput, setSessionIdInput] = useState<string>('');

  // セッションIDの変更を永続化（手動切り替え・新規生成も含めてリロード後に復元される）
  // localStorageに加えてURLの?session=にも反映し、リロード・ブックマークに耐える
  useEffect(() => {
    if (currentSessionId && typeof window !== 'undefined') {
      window.localStorage.setItem('collarecox-realtime-session-id', currentSessionId);
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('session') !== currentSessionId) {
          url.searchParams.set('session', currentSessionId);
          window.history.replaceState(null, '', url.toString());
        }
      } catch (err) {
        console.warn('[Session] ⚠️ Failed to update URL with session ID:', err);
      }
    }
  }, [currentSessionId]);
  const [recordingElapsedTime, setRecordingElapsedTime] = useState<number>(0);
  const recordingStartTimeRef = useRef<number>(0);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [existingSessionInput, setExistingSessionInput] = useState<string>('');
  const [isEditingSessionId, setIsEditingSessionId] = useState<boolean>(false);
  const [activeSessions, setActiveSessions] = useState<{sessionId: string, connectionCount: number}[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState<boolean>(false);
  const [showClearConfirmDialog, setShowClearConfirmDialog] = useState<boolean>(false); // テキストクリア確認ダイアログ
  const [autoProofread, setAutoProofread] = useState<boolean>(true); // 自動校正（誤字修正+パラグラフ整理）デフォルト: 有効
  const [autoProofreadStatus, setAutoProofreadStatus] = useState<string>(''); // 自動校正の状態表示
  // 共同校正画面でのAI再編に使用するモデル（このモデル選択UIは撤去し、サーバ既定に従う）
  const rewriteModel = 'gpt-4.1-mini';

  // ===== オンデバイス認識用の状態 =====
  const primaryStreamRef = useRef<MediaStream | null>(null); // 主認識モードで取得したストリーム（停止用）
  const [localAsrStatus, setLocalAsrStatus] = useState<LocalAsrStatus>('checking'); // ja-JPオンデバイス認識の利用可否
  const localRecognitionRef = useRef<LocalSpeechRecognition | null>(null);
  const localAsrRestartTimerRef = useRef<NodeJS.Timeout | null>(null); // 自動再起動用タイマー
  const [localForceFinalizeSec, setLocalForceFinalizeSec] = useState<number>(5); // 強制確定間隔（秒、0=なし）
  const interimStartedAtRef = useRef<number | null>(null); // 現在の未確定部分が始まった時刻（部分確定の判定用）
  const forceFinalizeTimerRef = useRef<NodeJS.Timeout | null>(null); // 部分確定の監視タイマー
  // 部分確定の管理: 認識結果インデックス（results[i]）ごとに「その結果のうち何文字目まで
  // コミット済みか」を持つ。文字列前置の照合やリセットを行わないため、セグメント切り替わりや
  // バックトラックが起きても同じテキストを二度コミットすることが構造的にない
  const committedByResultRef = useRef<Map<number, number>>(new Map());
  const lastInterimResultRef = useRef<{ index: number; transcript: string } | null>(null); // 最新の未確定結果
  const lastPendingSentAtRef = useRef<number>(0); // local_pending送信のスロットリング用
  const draftFinalsRef = useRef<Array<{ text: string; finalizedAt: number }>>([]); // 未置換のローカル確定分
  const draftInterimRef = useRef<string>(''); // 認識途中のテキスト
  const [draftText, setDraftText] = useState<string>(''); // 表示用（確定分+interim）

  // 文字起こし結果の自動追従スクロール
  // ユーザーが最下部付近にいるときだけ、新しいテキストに合わせて最下部へスクロールする
  // （上へスクロールして読み返している間は追従しない）
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (el && transcriptAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text, draftText]);

  // ===== オンデバイス認識 =====

  // マウント時にja-JPオンデバイス認識の利用可否を確認
  useEffect(() => {
    const ctor = getSpeechRecognitionCtor();
    if (!ctor || typeof ctor.available !== 'function') {
      setLocalAsrStatus('unsupported');
      return;
    }
    ctor.available({ langs: ['ja-JP'], processLocally: true })
      .then((result) => {
        console.log('[LocalDraft] ja-JPオンデバイス認識の状態:', result);
        if (result === 'available' || result === 'downloadable' || result === 'downloading') {
          setLocalAsrStatus(result);
        } else {
          setLocalAsrStatus('unavailable');
        }
      })
      .catch((err) => {
        console.warn('[LocalDraft] 利用可否チェック失敗:', err);
        setLocalAsrStatus('unsupported');
      });
  }, []);

  // 言語パック（約60MB）のインストール
  const installLocalAsr = useCallback(async () => {
    const ctor = getSpeechRecognitionCtor();
    if (!ctor || typeof ctor.install !== 'function') return;
    setLocalAsrStatus('downloading');
    try {
      const ok = await ctor.install({ langs: ['ja-JP'], processLocally: true });
      console.log('[LocalDraft] 言語パックインストール結果:', ok);
      setLocalAsrStatus(ok ? 'available' : 'unavailable');
    } catch (err) {
      console.warn('[LocalDraft] 言語パックインストール失敗:', err);
      setLocalAsrStatus('unavailable');
    }
  }, []);

  // ドラフト表示テキストを再構築（未置換のローカル確定分 + 認識途中分）
  const updateDraftText = useCallback(() => {
    const finals = draftFinalsRef.current.map((s) => s.text).join('');
    setDraftText(finals + draftInterimRef.current);
  }, []);

  // オンデバイス認識を停止してドラフトをクリア
  const stopLocalDraftRecognition = useCallback(() => {
    if (localAsrRestartTimerRef.current) {
      clearTimeout(localAsrRestartTimerRef.current);
      localAsrRestartTimerRef.current = null;
    }
    if (forceFinalizeTimerRef.current) {
      clearInterval(forceFinalizeTimerRef.current);
      forceFinalizeTimerRef.current = null;
    }
    interimStartedAtRef.current = null;
    committedByResultRef.current = new Map();
    lastInterimResultRef.current = null;
    const rec = localRecognitionRef.current;
    localRecognitionRef.current = null; // 先にnull化してonendの自動再起動を抑止する
    if (rec) {
      try { rec.abort(); } catch { /* already stopped */ }
      console.log('[LocalASR] 🛑 オンデバイス認識を停止');
    }
    draftFinalsRef.current = [];
    draftInterimRef.current = '';
    setDraftText('');
    // 校正画面の未確定テキスト表示もクリアする
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      websocketRef.current.send(JSON.stringify({ type: 'local_pending', text: '' }));
    }
  }, []);

  // オンデバイス認識を起動（録音開始時に音声ストリームを直接入力する）。
  // 確定テキストを本文に直接追加し、共有ドキュメントへ転送する。未確定は薄色表示する
  const startLocalDraftRecognition = useCallback((stream: MediaStream) => {
    const ctor = getSpeechRecognitionCtor();
    const track = stream.getAudioTracks()[0];
    if (!ctor || !track) return;

    // 多重起動ガード: 既存の認識インスタンスが残っていれば必ず停止する
    // （複数の認識が同時に動くと同じ音声が重複コミットされる）
    if (localRecognitionRef.current) {
      const prev = localRecognitionRef.current;
      localRecognitionRef.current = null;
      try { prev.abort(); } catch { /* already stopped */ }
      console.warn('[LocalASR] ⚠️ 既存のローカル認識を停止してから起動します');
    }
    if (forceFinalizeTimerRef.current) {
      clearInterval(forceFinalizeTimerRef.current);
      forceFinalizeTimerRef.current = null;
    }
    committedByResultRef.current = new Map();
    lastInterimResultRef.current = null;
    interimStartedAtRef.current = null;

    // 確定テキストを本文と共有ドキュメントへ反映する
    // continuation=true: 発話の途中からの継続（区切りスペースを入れない）
    // closeUtterance=true: 発話の締め（末尾にスペースを付ける）
    const commitChunk = (chunk: string, continuation: boolean, closeUtterance: boolean) => {
      if (!chunk) return;
      const processed = forceLineBreakAtPeriod ? chunk.replace(/。/g, '。\n') : chunk;
      setText(prev => prev + processed + (closeUtterance ? ' ' : ''));
      if (websocketRef.current?.readyState === WebSocket.OPEN) {
        websocketRef.current.send(JSON.stringify({ type: 'local_transcription', text: chunk, continuation }));
      }
    };

    const launch = () => {
      try {
        const rec = new ctor();
        rec.lang = 'ja-JP';
        rec.processLocally = true; // オンデバイス認識を強制（外部送信なし）
        rec.continuous = true;
        rec.interimResults = true;

        rec.onresult = (event) => {
          let displayTail = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = result[0]?.transcript || '';
            if (result.isFinal) {
              // 結果インデックスごとのコミット済み文字数を参照し、未コミットの残りだけを確定する。
              // 文字列照合やリセットを行わないため、同じテキストの重複コミットは構造的に起きない
              const done = committedByResultRef.current.get(i) || 0;
              const remainder = transcript.length > done ? transcript.slice(done) : '';
              commitChunk(remainder, done > 0, true);
              committedByResultRef.current.set(i, transcript.length);
              if (lastInterimResultRef.current?.index === i) {
                lastInterimResultRef.current = null;
              }
              console.log(`[LocalASR] ✅ 確定(result#${i}): ${transcript}`);
            } else {
              // 未確定: コミット済み分を除いた残りだけを表示・配信の対象にする
              const done = committedByResultRef.current.get(i) || 0;
              if (transcript.length > done) {
                displayTail += transcript.slice(done);
              }
              lastInterimResultRef.current = { index: i, transcript };
            }
          }
          draftInterimRef.current = displayTail;
          updateDraftText();
          // 部分確定の判定用に、未確定部分の開始時刻を記録する
          if (displayTail) {
            if (interimStartedAtRef.current === null) {
              interimStartedAtRef.current = performance.now();
            }
          } else {
            interimStartedAtRef.current = null;
          }
          // 未確定テキストも共有ドキュメント（校正画面）へ随時配信する。
          // interimの発火は高頻度なため200msでスロットリングする（クリア（空文字）は即時送信）
          if (websocketRef.current?.readyState === WebSocket.OPEN) {
            const nowMs = performance.now();
            if (displayTail === '' || nowMs - lastPendingSentAtRef.current > 200) {
              websocketRef.current.send(JSON.stringify({ type: 'local_pending', text: displayTail }));
              lastPendingSentAtRef.current = nowMs;
            }
          }
        };

        rec.onerror = (event) => {
          console.warn('[LocalASR] 認識エラー:', event.error);
        };

        rec.onend = () => {
          // Web Speechは無音等で勝手に停止するため、録音継続中は自動再起動する
          if (recordingStateRef.current && localRecognitionRef.current === rec) {
            localAsrRestartTimerRef.current = setTimeout(() => {
              if (recordingStateRef.current && localRecognitionRef.current === rec) {
                try {
                  // 再起動で認識結果リスト（results）が新規になるため、コミット管理もリセットする
                  committedByResultRef.current = new Map();
                  lastInterimResultRef.current = null;
                  interimStartedAtRef.current = null;
                  rec.start(track);
                  console.log('[LocalASR] 🔄 ローカル認識を自動再起動');
                } catch (err) {
                  console.warn('[LocalASR] 自動再起動失敗:', err);
                }
              }
            }, 250);
          }
        };

        rec.start(track); // MediaStreamTrack入力（Chrome 135+）。タブ音声を直接認識できる
        localRecognitionRef.current = rec;
        console.log('[LocalASR] 🎙️ オンデバイス認識を開始（ja-JP）');
      } catch (err) {
        console.warn('[LocalASR] 起動失敗:', err);
      }
    };
    launch();

    // 部分確定の監視: 連続音声ではWeb Speechの確定（final）が話の切れ目まで出ないため、
    // 未確定（interim）が一定時間続いたら、バックトラックで変わりやすい末尾を残して
    // 安定した前半部分を自前で確定する。認識は止めないので音声の欠落は発生しない。
    // （stop()による強制確定はオンデバイス認識では仮説を破棄してしまうため使えない）
    if (localForceFinalizeSec > 0) {
      const TAIL_GUARD_CHARS = 12; // 揺れやすい末尾は確定しない
      const MIN_COMMIT_CHARS = 4;  // 細切れ確定を避ける最小文字数
      forceFinalizeTimerRef.current = setInterval(() => {
        if (!recordingStateRef.current) return;
        const startedAt = interimStartedAtRef.current;
        if (startedAt === null || performance.now() - startedAt < localForceFinalizeSec * 1000) return;
        const last = lastInterimResultRef.current;
        if (!last) return;
        const done = committedByResultRef.current.get(last.index) || 0;
        const tail = last.transcript.length > done ? last.transcript.slice(done) : '';
        if (tail.length < TAIL_GUARD_CHARS + MIN_COMMIT_CHARS) return;
        const chunk = tail.slice(0, tail.length - TAIL_GUARD_CHARS);
        console.log(`[LocalASR] ⏱️ 部分確定（${localForceFinalizeSec}秒間隔, result#${last.index}）: "${chunk}"`);
        commitChunk(chunk, done > 0, false);
        committedByResultRef.current.set(last.index, done + chunk.length);
        draftInterimRef.current = last.transcript.slice(done + chunk.length);
        updateDraftText();
        if (websocketRef.current?.readyState === WebSocket.OPEN) {
          websocketRef.current.send(JSON.stringify({ type: 'local_pending', text: draftInterimRef.current }));
        }
        interimStartedAtRef.current = performance.now();
      }, 500);
    }
  }, [updateDraftText, forceLineBreakAtPeriod, localForceFinalizeSec]);

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

  // WebSocket connection management - returns Promise for async flow
  // オンデバイス認識テキストを共有ドキュメントへ中継するWebSocket接続を確立する。
  // この接続はサーバ経由で local_transcription / local_pending を共有ドキュメントへ転送する
  // 中継チャネルとしてのみ使う（OpenAIへ音声を送る経路は撤去済み）
  const connectWebSocket = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (websocketRef.current?.readyState === WebSocket.OPEN) {
        console.log('[WebSocket] Already connected, skipping connection attempt');
        resolve();
        return;
      }

      // Automatically detect protocol and host
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = typeof window !== 'undefined' ? window.location.host : 'localhost:8888';
      const wsUrl = `${protocol}//${host}${getBasePath()}/api/realtime-ws`;
      console.log('[WebSocket] 🔗 Connecting (relay channel) to:', wsUrl);
      const ws = new WebSocket(wsUrl);
      websocketRef.current = ws;

      ws.onopen = () => {
        console.log('[WebSocket] ✅ Connected successfully (relay channel)');
        setIsConnected(true);
        setError(null);

        // セッションIDをサーバーへ通知（共有ドキュメントの宛先決定に使う）
        if (currentSessionId) {
          ws.send(JSON.stringify({
            type: 'set_session_id',
            sessionId: currentSessionId
          }));
          console.log('[WebSocket] 📋 Sent session ID to server:', currentSessionId);
        }

        // 句点で強制改行設定をサーバーへ通知
        ws.send(JSON.stringify({
          type: 'set_force_line_break',
          enabled: forceLineBreakAtPeriod
        }));
        console.log('[WebSocket] 📝 Sent force line break at period:', forceLineBreakAtPeriod);

        // 自動校正設定を送信（set_session_id送信後である必要がある）
        ws.send(JSON.stringify({
          type: 'set_auto_proofread',
          enabled: autoProofread,
          model: rewriteModel
        }));
        console.log('[WebSocket] 🪄 Sent auto proofread setting:', autoProofread);

        // Promiseを解決して接続完了を通知
        resolve();
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          console.log('[WebSocket] 📨 Received message:', message.type, message);

          switch (message.type) {
            case 'auto_proofread_started':
              setAutoProofreadStatus(`🪄 校正中...（${message.paragraphs ?? '-'}段落・${message.chars ?? '-'}文字）`);
              break;

            case 'auto_proofread_completed':
              setAutoProofreadStatus(`✅ 校正完了: ${message.paragraphs ?? '-'}段落に整理（${new Date().toLocaleTimeString('ja-JP')}）`);
              break;

            case 'auto_proofread_error':
              setAutoProofreadStatus(`❌ 校正エラー: ${message.error ?? '不明なエラー'}`);
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
        setError('共有ドキュメントへの中継接続に失敗しました');
        setIsConnected(false);
        reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = (event) => {
        console.log('[WebSocket] 🔌 Connection closed:', event.code, event.reason);
        setIsConnected(false);
        // 接続確立前にクローズされた場合はreject
        if (!websocketRef.current || websocketRef.current.readyState !== WebSocket.OPEN) {
          reject(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
        }
      };
    }); // Promise終了
  }, [currentSessionId, forceLineBreakAtPeriod, autoProofread]);

  const disconnectWebSocket = useCallback(() => {
    if (websocketRef.current) {
      console.log('[WebSocket] 🔌 Disconnecting WebSocket');
      websocketRef.current.close();
      websocketRef.current = null;
    }
    setIsConnected(false);
  }, []);

  // 句点で強制改行設定をサーバーに送信する関数
  const sendForceLineBreakToServer = useCallback((enabled: boolean) => {
    if (!websocketRef.current || websocketRef.current.readyState !== WebSocket.OPEN) {
      console.log('[Force Line Break] ⚠️ WebSocket not connected, settings will be applied on next connection');
      return false;
    }

    const message = {
      type: 'set_force_line_break',
      enabled: enabled
    };

    websocketRef.current.send(JSON.stringify(message));
    console.log('[Force Line Break] 📝 Sent force line break setting to server:', enabled);

    return true;
  }, []);

  // セッションIDが変更されたときに、既存のWebSocket接続経由でサーバーに通知
  useEffect(() => {
    if (currentSessionId && websocketRef.current?.readyState === WebSocket.OPEN) {
      websocketRef.current.send(JSON.stringify({
        type: 'set_session_id',
        sessionId: currentSessionId
      }));
      console.log('[WebSocket] 📋 Sent updated session ID to server:', currentSessionId);
    }
  }, [currentSessionId]);

  // Audio streaming functions
  const startAudioStream = useCallback(async () => {
    try {
      console.log('[Audio] 🎵 Starting audio stream (オンデバイス認識)... source:', audioSource);

      // オンデバイス認識が利用可能であることが前提
      if (localAsrStatus !== 'available') {
        // 状態に応じて、インストールボタンの場所まで具体的に案内する
        if (localAsrStatus === 'downloadable') {
          setError('オンデバイス認識には日本語の言語パックが必要です。「音声入力からの文字起こし」セクション内の「オンデバイス認識」欄にある「インストール」ボタンを押して言語パック（約60MB）を導入してください。');
        } else if (localAsrStatus === 'downloading') {
          setError('言語パックをインストール中です（数分かかる場合があります）。完了までお待ちください。');
        } else {
          // unsupported / unavailable / checking
          setError('このブラウザではオンデバイス認識が利用できません。Chrome 139以降でこのページを開いてください。');
        }
        return;
      }

      let stream: MediaStream;

      if (audioSource === 'tab-capture') {
        // タブ音声キャプチャモード: getDisplayMedia
        if (!navigator?.mediaDevices?.getDisplayMedia) {
          throw new Error('getDisplayMedia not supported in this browser');
        }
        console.log('[Audio] 🖥️ Requesting tab audio capture...');
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        // 映像トラックは不要なので停止
        displayStream.getVideoTracks().forEach((t) => t.stop());
        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length === 0) {
          throw new Error('音声トラックが取得できませんでした。タブ共有時に「タブの音声も共有」を有効にしてください。');
        }
        console.log('[Audio] 🖥️ Tab audio track obtained:', audioTracks[0].label);
        stream = new MediaStream(audioTracks);
        tabCaptureStreamRef.current = displayStream;
        // タブ共有停止時の自動停止（recordingStateRefで制御）
        audioTracks[0].addEventListener('ended', () => {
          console.log('[Audio] 🖥️ Tab audio track ended (user stopped sharing)');
          recordingStateRef.current = false;
          setIsRecording(false);
        });
      } else {
        // マイクモード: getUserMedia
        if (!navigator?.mediaDevices?.getUserMedia) {
          throw new Error('getUserMedia not supported in this browser');
        }

        const audioConstraints: MediaStreamConstraints['audio'] = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        };

        if (selectedDeviceId) {
          console.log('[Audio] 🎤 Using selected device:', selectedDeviceId);
          (audioConstraints as MediaTrackConstraints).deviceId = { exact: selectedDeviceId };
        } else {
          console.warn('[Audio] ⚠️ No specific device selected, using default');
        }

        console.log('[Audio] 📋 Audio constraints:', audioConstraints);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints
        });
      }
      console.log('[Audio] ✅ Media stream obtained');

      // オンデバイス認識にストリームを直接入力して文字起こしする（APIコストなし・音声の外部送信なし）
      primaryStreamRef.current = stream;
      recordingStateRef.current = true;
      recordingStartTimeRef.current = Date.now();
      setRecordingElapsedTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingElapsedTime((Date.now() - recordingStartTimeRef.current) / 1000);
      }, 100);
      setIsRecording(true);
      startLocalDraftRecognition(stream);
      console.log('[Audio] ✅ オンデバイス認識で開始（音声の外部送信なし）');
    } catch (err) {
      console.error('[Audio] ❌ Error starting audio stream:', err);
      setError(err instanceof Error ? err.message : 'Failed to start audio stream');
    }
  }, [selectedDeviceId, audioSource, localAsrStatus, startLocalDraftRecognition]);

  const stopAudioStream = useCallback(() => {
    console.log('[Audio] 🛑 Stopping audio stream...');

    // Stop recording state immediately
    recordingStateRef.current = false;

    // オンデバイス認識を停止
    stopLocalDraftRecognition();

    // Stop recording timer
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setRecordingElapsedTime(0);

    // タブキャプチャストリームの停止
    if (tabCaptureStreamRef.current) {
      tabCaptureStreamRef.current.getTracks().forEach(t => t.stop());
      tabCaptureStreamRef.current = null;
    }

    // オンデバイス認識に入力していたストリームを停止
    if (primaryStreamRef.current) {
      primaryStreamRef.current.getTracks().forEach(t => t.stop());
      primaryStreamRef.current = null;
    }

    setIsRecording(false);
    console.log('[Audio] ✅ Audio stream stopped successfully');
  }, [stopLocalDraftRecognition]);

  // Main control functions
  const startRecording = useCallback(async () => {
    console.log('[Recording] 🎙️ Start recording requested');

    // 共有ドキュメント中継チャネルを確立してからオンデバイス認識を開始する。
    // 認識した確定テキストはこのチャネル経由で共有ドキュメントへ転送される
    if (!isConnected) {
      console.log('[Recording] 🔗 Not connected, connecting relay channel first...');
      try {
        await connectWebSocket();
        console.log('[Recording] ✅ Relay channel connected, starting audio stream');
        startAudioStream();
      } catch (err) {
        console.error('[Recording] ❌ Failed to connect relay channel:', err);
        setError('共有ドキュメントへの中継接続に失敗しました');
      }
    } else {
      console.log('[Recording] 🚀 Already connected, starting audio stream immediately');
      startAudioStream();
    }
  }, [isConnected, connectWebSocket, startAudioStream]);

  const stopRecording = useCallback(() => {
    console.log('[Recording] ⏹️ Stop recording requested');
    console.log(`[Recording] 📊 Total characters: ${text.length}`);
    stopAudioStream();
  }, [stopAudioStream, text]);

  const clearText = useCallback(() => {
    console.log('[UI] 🧹 Clearing transcription text');
    setText("");
    setError(null);

    // 共有ドキュメント側の未確定（ドラフト）表示もクリアする
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      console.log('[UI] 🗑️ Clearing draft on collaborative document');
      websocketRef.current.send(JSON.stringify({
        type: 'local_pending',
        text: ''
      }));
    }
  }, []);

  const copyText = useCallback(async () => {
    if (!text) {
      console.log('[UI] ⚠️ No text to copy');
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      console.log('[UI] 📋 Text copied to clipboard');
      // Show temporary success message
      const originalError = error;
      setError('✅ コピーしました');
      setTimeout(() => {
        setError(originalError);
      }, 2000);
    } catch (err) {
      console.error('[UI] ❌ Failed to copy text:', err);
      setError('コピーに失敗しました');
    }
  }, [text, error]);

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
    const editorUrl = `${window.location.origin}${getBasePath()}/editor/${sessionId}`;
    
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

  // アクティブなYjsセッション一覧を取得
  const fetchSessions = useCallback(async () => {
    setIsLoadingSessions(true);
    try {
      const res = await fetch(`${getBasePath()}/api/yjs-sessions`);
      const data = await res.json();
      setActiveSessions(data.sessions || []);
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
      setActiveSessions([]);
    } finally {
      setIsLoadingSessions(false);
    }
  }, []);

  // 初回ロード時にセッション一覧を取得
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const connectToExistingSession = useCallback(() => {
    if (existingSessionInput.trim()) {
      let sessionId: string;

      // Handle new session creation
      if (existingSessionInput === '__new__') {
        sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        console.log('[Session] 🆕 Created new session:', sessionId);
      } else {
        sessionId = existingSessionInput.trim();
        console.log('[Session] 🔗 Connected to existing session:', sessionId);
      }

      setCurrentSessionId(sessionId);
      setExistingSessionInput('');

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

  // Initialize/cleanup Hocuspocus connection for collaborative document delivery
  const initializeHocuspocusClient = useCallback(() => {
    if (!currentSessionId || hocuspocusProviderRef.current) {
      return; // Already initialized or no session
    }

    console.log('[Hocuspocus Client] Initializing for session:', currentSessionId);

    // Dynamic import both yjs and HocuspocusProvider to avoid SSR localStorage issues
    Promise.all([
      import('yjs'),
      import('@hocuspocus/provider')
    ]).then(([Y, { HocuspocusProvider }]) => {
      // Create Y.Doc
      const ydoc = new Y.Doc();
      hocuspocusDocRef.current = ydoc;

      // Create provider
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = typeof window !== 'undefined' ? window.location.host : 'localhost:8888';
      const websocketUrl = `${protocol}//${host}${getBasePath()}/api/yjs-ws`;
      const roomName = `transcribe-editor-v2-${currentSessionId}`;

      const provider = new HocuspocusProvider({
        url: websocketUrl,
        name: roomName,
        document: ydoc,
      });

      hocuspocusProviderRef.current = provider;

      provider.on('connect', () => {
        console.log('[Hocuspocus Client] Connected to collaborative session');
      });

      provider.on('disconnect', () => {
        console.log('[Hocuspocus Client] Disconnected from collaborative session');
      });

      provider.on('error', (error: unknown) => {
        console.error('[Hocuspocus Client] Error:', error);
      });
    }).catch((error) => {
      console.error('[Hocuspocus Client] Failed to load yjs/HocuspocusProvider:', error);
    });
  }, [currentSessionId]);

  const cleanupHocuspocusClient = useCallback(() => {
    if (hocuspocusProviderRef.current) {
      console.log('[Hocuspocus Client] Cleaning up connection');
      hocuspocusProviderRef.current.disconnect();
      hocuspocusProviderRef.current.destroy();
      hocuspocusProviderRef.current = null;
    }
    if (hocuspocusDocRef.current) {
      hocuspocusDocRef.current = null;
    }
  }, []);

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
  }, [getAudioDevices]);

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
    <div className="min-h-screen bg-canvas">
      {/* Header - editorと同様の構造 */}
      <header className="bg-surface border-b border-hairline">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-light text-ink">リアルタイム文字起こし</h1>
              <p className="text-sm text-body mt-1">オンデバイス音声認識（Chrome・端末内処理）</p>
            </div>
            <div className="flex items-center space-x-3">
              <div className="text-xs text-muted">
                v{packageJson.version}
              </div>
              <a
                href={`${getBasePath()}/manual.html`}
                className="px-3 py-1 text-sm bg-surface text-ink border border-hairline rounded-md hover:bg-surface-soft transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                マニュアル
              </a>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-6">

        {/* Connection Status & Session Management - Side by Side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Connection Status - 共有ドキュメント中継チャネルの接続状態 */}
          <div className="bg-surface p-6 rounded-lg border border-hairline shadow-sm">
            <h3 className="text-lg font-light text-ink mb-4">
              共有ドキュメントへの中継接続
            </h3>
            <div className="space-y-4">
              {/* 接続状態インジケータ（3状態: 未接続/接続済み/エラー） */}
              <div className={`p-4 rounded-lg border ${
                error ? 'bg-error/10 border-error/40' :
                isConnected ? 'bg-success/10 border-success/40' :
                'bg-surface-soft border-hairline'
              }`}>
                <div className="flex items-center space-x-3">
                  <div className={`w-3 h-3 rounded-full ${
                    error ? 'bg-error animate-pulse' :
                    isConnected ? 'bg-success' :
                    'bg-muted-soft'
                  }`}></div>
                  <div>
                    <span className={`text-lg font-normal ${
                      error ? 'text-error' :
                      isConnected ? 'text-success' :
                      'text-muted'
                    }`}>
                      {error ? 'エラー' :
                       isConnected ? '接続済み' :
                       '未接続'}
                    </span>
                    <p className={`text-sm ${
                      error ? 'text-error' :
                      isConnected ? 'text-body' :
                      'text-muted'
                    }`}>
                      {error ? error :
                       isConnected ? '認識結果を共有ドキュメントへ配信できます' :
                       '「録音開始」で自動的に接続されます'}
                    </p>
                  </div>
                </div>
              </div>

              {/* 切断ボタン（接続中のみ表示） */}
              {isConnected && (
                <div className="flex items-center justify-center">
                  <button
                    onClick={disconnectWebSocket}
                    className="px-4 py-2 text-sm bg-surface text-error border border-error/50 rounded-lg hover:bg-error/10 transition-colors"
                  >
                    接続を切断
                  </button>
                </div>
              )}

              <p className="text-xs text-muted text-center">
                オンデバイス認識の確定テキストは、この中継接続を通じて共有ドキュメント（校正画面）へ送られます。音声は端末内で処理され、外部へは送信されません。
              </p>
            </div>
          </div>

          {/* Session Management */}
          <div className="bg-surface p-6 rounded-lg border border-hairline shadow-sm">
          <h3 className="text-lg font-light text-ink mb-4">
            共同校正セッション管理
          </h3>

          {/* Current Session Display */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-body mb-2">
              現在のセッションID:
            </label>
            {isEditingSessionId ? (
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={sessionIdInput}
                  onChange={(e) => setSessionIdInput(e.target.value)}
                  className="flex-1 px-3 py-2 border border-hairline rounded-md focus:outline-none focus:ring-2 focus:ring-celadon focus:border-celadon"
                  placeholder="セッションIDを入力..."
                />
                <button
                  onClick={saveSessionId}
                  className="px-4 py-2 text-sm bg-celadon text-on-celadon rounded-md hover:bg-celadon-active"
                >
                  保存
                </button>
                <button
                  onClick={cancelEditSessionId}
                  className="px-4 py-2 text-sm bg-surface text-ink border border-hairline rounded-md hover:bg-surface-soft"
                >
                  キャンセル
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-2">
                <div className="flex-1 px-3 py-2 bg-surface-soft border border-hairline rounded-md">
                  <span className="text-body">
                    {currentSessionId || 'セッションが作成されていません'}
                  </span>
                </div>
                <button
                  onClick={editSessionId}
                  className="px-4 py-2 text-sm bg-celadon text-on-celadon rounded-md hover:bg-celadon-active"
                >
                  変更
                </button>
              </div>
            )}
          </div>

          {/* Connect to Session */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-body mb-2">
              セッションに接続:
            </label>
            <div className="flex space-x-2">
              <select
                value={existingSessionInput}
                onChange={(e) => setExistingSessionInput(e.target.value)}
                onFocus={fetchSessions}
                className="flex-1 px-3 py-2 border border-hairline rounded-md focus:outline-none focus:ring-2 focus:ring-celadon focus:border-celadon"
              >
                <option value="">セッションを選択...</option>
                <option value="__new__">＋ 新しいセッションを作成</option>
                {activeSessions.map(s => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {s.sessionId} ({s.connectionCount}人接続中)
                  </option>
                ))}
              </select>
              <button
                onClick={fetchSessions}
                disabled={isLoadingSessions}
                className="px-3 py-2 text-sm bg-surface text-ink border border-hairline rounded-md hover:bg-surface-soft disabled:opacity-50"
                title="一覧を更新"
              >
                ↻
              </button>
              <button
                onClick={connectToExistingSession}
                disabled={!existingSessionInput.trim()}
                className="px-4 py-2 text-sm bg-celadon text-on-celadon rounded-md hover:bg-celadon-active disabled:bg-celadon-disabled disabled:cursor-not-allowed"
              >
                接続
              </button>
            </div>
            {activeSessions.length === 0 && !isLoadingSessions && (
              <p className="text-xs text-muted mt-1">アクティブなセッションがありません</p>
            )}
          </div>

          {/* Session Status */}
          {currentSessionId && isConnected && (
            <div className="space-y-3">
              <div className="p-3 bg-success/10 border border-success/40 rounded-md">
                <div className="flex items-center space-x-2">
                  <div className="w-2.5 h-2.5 bg-success rounded-full"></div>
                  <span className="text-sm font-medium text-success">
                    セッション接続中: {currentSessionId}
                  </span>
                </div>
              </div>

              {/* Share Session URL */}
              <div className="p-3 bg-celadon-soft border border-celadon/30 rounded-md">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-celadon-active">
                    このURLを共有して他の人を招待
                  </div>
                  <button
                    onClick={() => {
                      const editorUrl = `${window.location.origin}${getBasePath()}/editor/${currentSessionId}`;
                      navigator.clipboard.writeText(editorUrl);
                      // Optional: Show feedback (could add a toast notification here)
                      const button = document.activeElement as HTMLButtonElement;
                      const originalText = button.textContent;
                      button.textContent = 'コピー完了！';
                      setTimeout(() => {
                        button.textContent = originalText;
                      }, 2000);
                    }}
                    className="px-3 py-1 text-sm bg-celadon text-on-celadon rounded hover:bg-celadon-active transition-colors"
                  >
                    URLをコピー
                  </button>
                </div>
                <div className="mt-2 text-xs text-celadon-active font-mono">
                  {typeof window !== 'undefined' && `${window.location.origin}${getBasePath()}/editor/${currentSessionId}`}
                </div>
              </div>
            </div>
          )}

          {/* Create/Open Session Button */}
          <div className="flex justify-center space-x-4">
            <button
              onClick={createOrOpenEditingSession}
              className="px-6 py-3 rounded-lg font-medium bg-celadon text-on-celadon hover:bg-celadon-active transition-colors"
            >
              {currentSessionId ? '共同校正セッションを開く' : '共同校正セッションの作成'}
            </button>
          </div>
          </div>
        </div>

        {/* Controls */}
        <div className={`p-6 rounded-lg border transition-colors ${
          isRecording
            ? "bg-celadon-soft border-celadon/30"
            : "bg-surface border-hairline shadow-sm"
        }`}>
          <div className="max-w-2xl mx-auto">
            {/* Main Recording Controls */}
            <div className="space-y-4 bg-surface p-4 rounded-lg border border-hairline shadow-sm">
              <h4 className="text-md font-medium text-ink text-center">
                音声入力からの文字起こし
              </h4>

              {/* Audio Source Selection */}
              <div className="px-4">
                <label className="block text-sm font-medium text-body mb-2">
                  音声ソース:
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAudioSource('microphone')}
                    disabled={isRecording}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                      audioSource === 'microphone'
                        ? 'bg-celadon text-on-celadon'
                        : 'bg-surface-soft text-body hover:bg-celadon-soft'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span>🎤</span> マイク
                  </button>
                  <button
                    type="button"
                    onClick={() => setAudioSource('tab-capture')}
                    disabled={isRecording}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                      audioSource === 'tab-capture'
                        ? 'bg-celadon text-on-celadon'
                        : 'bg-surface-soft text-body hover:bg-celadon-soft'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span>🖥️</span> タブ音声キャプチャ
                  </button>
                </div>
                {audioSource === 'tab-capture' && (
                  <p className="text-xs text-muted mt-1">
                    開始時にタブ選択ダイアログが表示されます。「タブの音声も共有」を有効にしてください。
                  </p>
                )}

                {/* オンデバイス認識ステータス */}
                <div className="mt-3 p-2 bg-surface-soft rounded-md border border-hairline">
                  <label className="block text-sm font-medium text-body mb-1">
                    オンデバイス認識:
                  </label>
                  <div className="mt-1 text-xs text-muted flex items-center gap-2 flex-wrap">
                    {localAsrStatus === 'checking' && <span>オンデバイス認識の対応状況を確認中...</span>}
                    {localAsrStatus === 'unsupported' && <span className="text-warning">このブラウザでは利用できません。Chrome 139以降でこのページを開いてください</span>}
                    {localAsrStatus === 'unavailable' && <span className="text-warning">日本語のオンデバイス認識が利用できません。Chrome 139以降でお試しください</span>}
                    {localAsrStatus === 'downloadable' && (
                      <>
                        <span>日本語の言語パック（約60MB）が未インストール</span>
                        <button
                          onClick={installLocalAsr}
                          disabled={isRecording}
                          className="px-2 py-0.5 text-xs bg-celadon text-on-celadon rounded hover:bg-celadon-active disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          インストール
                        </button>
                      </>
                    )}
                    {localAsrStatus === 'downloading' && <span>言語パックをインストール中...（数分かかる場合があります）</span>}
                    {localAsrStatus === 'available' && (
                      <span className="text-success">
                        ✓ Chromeオンデバイス認識で文字起こしします（音声の外部送信なし）。認識途中のテキストは薄色で表示されます
                      </span>
                    )}
                  </div>
                  {localAsrStatus === 'available' && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-body flex-wrap">
                      <label htmlFor="force-finalize-select" className="font-medium">部分確定間隔:</label>
                      <select
                        id="force-finalize-select"
                        value={localForceFinalizeSec}
                        onChange={(e) => setLocalForceFinalizeSec(parseInt(e.target.value))}
                        disabled={isRecording}
                        className="px-2 py-0.5 border border-hairline rounded text-xs disabled:bg-surface-soft focus:outline-none focus:ring-2 focus:ring-celadon"
                      >
                        <option value="3">3秒</option>
                        <option value="5">5秒</option>
                        <option value="8">8秒</option>
                        <option value="10">10秒</option>
                        <option value="0">なし（自然な区切りのみ）</option>
                      </select>
                      <span className="text-muted">
                        話が続いていても、この間隔で安定した前半部分を順次確定します（揺れやすい末尾は未確定のまま残ります）
                      </span>
                    </div>
                  )}
                </div>

                {/* 句点で強制改行 */}
                <div className="mt-3 p-2 bg-surface-soft rounded-md border border-hairline">
                  <label className="flex items-center gap-2 text-sm font-medium text-body">
                    <input
                      type="checkbox"
                      checked={forceLineBreakAtPeriod}
                      onChange={(e) => {
                        const newValue = e.target.checked;
                        setForceLineBreakAtPeriod(newValue);
                        // 接続中なら即座にサーバーへ通知
                        if (isConnected) {
                          sendForceLineBreakToServer(newValue);
                        }
                      }}
                      className="rounded accent-celadon"
                    />
                    句点で強制改行（。の後に改行を追加）
                  </label>
                </div>

                {/* 自動校正設定 */}
                <div className="mt-3 p-2 bg-surface-soft rounded-md border border-hairline">
                  <label className="flex items-center gap-2 text-sm font-medium text-body">
                    <input
                      type="checkbox"
                      checked={autoProofread}
                      onChange={(e) => {
                        setAutoProofread(e.target.checked);
                        setAutoProofreadStatus('');
                        if (websocketRef.current?.readyState === WebSocket.OPEN) {
                          websocketRef.current.send(JSON.stringify({
                            type: 'set_auto_proofread',
                            enabled: e.target.checked,
                            model: rewriteModel
                          }));
                        }
                      }}
                      className="rounded accent-celadon"
                    />
                    🪄 自動校正（誤字修正＋パラグラフ整理）
                  </label>
                  <p className="mt-1 ml-6 text-xs text-muted">
                    ONにすると、認識テキストはAI校正（誤字修正・句読点補完・段落分け）を経てから校正画面に確定反映されます。
                    校正前のテキストはグレーの未確定表示のまま見えます（100文字以上たまり次第・最短15秒間隔で処理、録音停止後は残りも自動処理）。
                  </p>
                  {autoProofreadStatus && (
                    <p className="mt-1 ml-6 text-xs text-celadon-active">{autoProofreadStatus}</p>
                  )}
                </div>
              </div>

              {/* Audio Input Device Selection */}
              {audioSource === 'microphone' && (
              <div className="px-4">
                <label htmlFor="device-select" className="block text-sm font-medium text-body mb-2">
                  音声入力デバイス:
                </label>
                <select
                  id="device-select"
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  disabled={isRecording}
                  className="block w-full px-3 py-2 border border-hairline rounded-md focus:outline-none focus:ring-2 focus:ring-celadon focus:border-celadon disabled:bg-surface-soft"
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
                <div className="mt-2 flex items-center space-x-2">
                  <button
                    onClick={getAudioDevices}
                    disabled={isRecording}
                    className="px-3 py-1 text-xs bg-surface text-ink border border-hairline hover:bg-surface-soft rounded disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    デバイス更新
                  </button>
                  <p className="text-xs text-muted">
                    {audioDevices.length} 個のデバイス
                  </p>
                </div>
              </div>
              )}

              {/* Start/Stop Button */}
              <div className="flex justify-center pt-2">
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                    isRecording
                      ? "bg-surface text-error border border-error/50 hover:bg-error/10"
                      : "bg-celadon text-on-celadon hover:bg-celadon-active"
                  }`}
                >
                  {isRecording ? "録音を停止" : "録音開始"}
                </button>
              </div>

              {/* Recording Status Display */}
              {isRecording && (
                <div className="flex flex-col items-center justify-center space-y-2 text-celadon-active pt-3">
                  <div className="flex items-center space-x-2">
                    <div className="w-3 h-3 bg-celadon rounded-full animate-pulse"></div>
                    <span className="font-medium">認識中...</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl font-light tabular-nums text-ink">
                      {Math.floor(recordingElapsedTime / 60).toString().padStart(2, '0')}:
                      {Math.floor(recordingElapsedTime % 60).toString().padStart(2, '0')}
                    </span>
                    <span className="text-sm text-muted">経過</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="p-4 bg-error/10 border border-error/40 rounded-lg">
            <div className="flex">
              <div className="ml-3">
                <h3 className="text-sm font-medium text-error">エラー</h3>
                <div className="mt-2 text-sm text-error">
                  {error}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Transcription Output */}
        <div className="bg-surface p-6 rounded-lg border border-hairline shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-light text-ink">
              文字起こし結果
            </h2>
            <div className="flex gap-2">
              <button
                onClick={copyText}
                disabled={!text}
                className="px-4 py-2 rounded-lg font-medium bg-celadon text-on-celadon hover:bg-celadon-active disabled:bg-celadon-disabled disabled:cursor-not-allowed transition-colors"
              >
                📋 コピー
              </button>
              <button
                onClick={() => setShowClearConfirmDialog(true)}
                disabled={isRecording || !text}
                className="px-4 py-2 rounded-lg font-medium bg-surface text-error border border-error/50 hover:bg-error/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                テキストをクリア
              </button>
            </div>
          </div>
          <div
            ref={transcriptScrollRef}
            onScroll={() => {
              const el = transcriptScrollRef.current;
              if (el) {
                // 最下部から40px以内なら「最下部にいる」とみなして自動追従を有効にする
                transcriptAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }
            }}
            className="h-[300px] min-h-[160px] resize-y overflow-y-auto p-4 border border-hairline rounded-md bg-surface-soft"
          >
            {(text || (isRecording && draftText)) ? (
              <p className="text-ink whitespace-pre-wrap leading-relaxed">
                {text}
                {/* オンデバイス認識の暫定テキスト（薄色表示。確定すると本文に取り込まれる） */}
                {isRecording && draftText && (
                  <span className="text-muted-soft">{draftText}</span>
                )}
              </p>
            ) : (
              <p className="text-muted italic">
                録音を開始すると、ここに文字起こしが表示されます...
              </p>
            )}
            {/* 認識中表示（オンデバイス認識の暫定テキストがある間だけ表示） */}
            {isRecording && draftText && (
              <div className="flex items-center space-x-1 mt-2">
                <div className="w-2 h-2 bg-celadon rounded-full animate-pulse"></div>
                <span className="text-celadon-active text-sm font-medium">認識中</span>
              </div>
            )}
          </div>
          {text && (
            <div className="mt-4 text-sm text-body">
              文字数: {text.length}
            </div>
          )}
        </div>

        {/* Instructions */}
        <div className="bg-celadon-soft p-6 rounded-lg border border-celadon/30">
          <h3 className="text-lg font-light text-celadon-active mb-3">
            使い方
          </h3>
          <ol className="list-decimal list-inside space-y-2 text-body">
            <li>音声ソース（マイク／タブ音声）を選ぶ</li>
            <li>「録音開始」をクリック（共有ドキュメントへ自動接続されます）</li>
            <li>マイクまたはタブ音声へのアクセスを許可し、自然に話す</li>
            <li>端末内のオンデバイス認識でリアルタイムに文字起こしが表示される</li>
            <li>終了時は「録音を停止」をクリック</li>
          </ol>
          <div className="mt-4 text-sm text-body">
            <strong className="font-medium">オンデバイス認識について:</strong> 音声はChromeの端末内エンジンで処理され、外部サーバーへは送信されません。初回利用時は日本語の言語パック（約60MB）のインストールが必要です。Chrome 139以降が必要です。
          </div>
        </div>
        </div>
      </main>

      {/* テキストクリア確認ダイアログ */}
      {showClearConfirmDialog && (
        <div className="fixed inset-0 bg-surface-ink/40 flex items-center justify-center z-50">
          <div className="bg-surface rounded-lg p-6 max-w-md mx-4 border border-hairline shadow-sm">
            <h3 className="text-lg font-medium text-ink mb-4">
              テキストをクリアしますか？
            </h3>
            <p className="text-body mb-6">
              この操作は取り消せません。すべての文字起こしテキストが削除されます。
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowClearConfirmDialog(false)}
                className="px-4 py-2 rounded-lg font-medium text-ink bg-surface border border-hairline hover:bg-surface-soft transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={() => {
                  clearText();
                  setShowClearConfirmDialog(false);
                }}
                className="px-4 py-2 rounded-lg font-medium text-on-celadon bg-error hover:opacity-90 transition-colors"
              >
                クリアする
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}