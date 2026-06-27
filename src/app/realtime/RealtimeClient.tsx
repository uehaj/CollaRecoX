"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
// yjs and HocuspocusProvider are dynamically imported to avoid SSR localStorage issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YDocType = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HocuspocusProviderType = any;
import { getBasePath } from '@/lib/basePath';
import { addRecentSession } from '@/lib/recentSessions';
import { useLeaveConfirmation } from '@/lib/useLeaveConfirmation';
import { newSessionId } from '@/lib/sessionId';
import { createBroadcastSession, getHostToken } from '@/lib/session';
import { getBrowserLanguageModel, probeBrowserLlm, ensureBrowserLlmReady, type BrowserLlmState, type NanoPromptSession } from '@/lib/browserLlm';
import packageJson from '../../../package.json';
import * as Diff from 'diff';

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
  type: 'auto_proofread_started' | 'auto_proofread_completed' | 'auto_proofread_error' | 'auto_proofread_warning';
  paragraphs?: number;
  chars?: number;
  error?: string;
}

// サーバからのオンデバイス校正要求。録音端末のブラウザLLMで systemPrompt のもと userContent を校正して返す。
interface ProofreadRequestMessage {
  type: 'proofread_request';
  requestId: string;
  systemPrompt: string;
  userContent: string;
}

type WebSocketMessage = AutoProofreadMessage | ProofreadRequestMessage;

// design(リアルタイム文字起こし.dc.html)のinlineスタイルを忠実移植するためのヘルパー。
// "a:b;c:d" 形式のCSS文字列を React.CSSProperties に変換する（kebab→camel、-webkit対応）。
const css = (s: string): React.CSSProperties => {
  const o: Record<string, string> = {};
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    if (k) o[k] = decl.slice(i + 1).trim();
  }
  return o as React.CSSProperties;
};
// 白カードの共通スタイル（design）。
const DC_CARD = 'background:#fff;border:1px solid #e4e7eb;border-radius:16px;padding:26px;box-shadow:0 1px 2px rgba(16,24,40,.04);';
const DC_LABEL = 'display:block;font-size:12px;font-weight:500;color:#7b8794;margin-bottom:8px;';
const DC_SECTITLE = 'margin:0;font-size:15px;font-weight:700;';

export default function RealtimeClient() {
  const websocketRef = useRef<WebSocket | null>(null);
  const recordingStateRef = useRef<boolean>(false);

  // Hocuspocus client refs（共有ドキュメント同期用）
  const hocuspocusProviderRef = useRef<HocuspocusProviderType | null>(null);
  const hocuspocusDocRef = useRef<YDocType | null>(null);

  const [text, setText] = useState("");
  // 送信した生テキストの累積（サーバのrawBufferと同じ素材）。3色表示の素材にする。
  // 黒=AI確定済(先頭 sentRaw.length-greenLen 文字) / 緑=AI校正待ち(末尾 greenLen 文字) / グレー=interim
  const [sentRaw, setSentRaw] = useState("");
  const [pendingGreenLen, setPendingGreenLen] = useState(0); // サーバ配信のrawBuffer長（緑の文字数）
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
          // URLにもlocalStorageにも無い＝新規来訪。配信権付きのセッションをサーバーに発行させる。
          createBroadcastSession()
            .then(({ sessionId }) => {
              setCurrentSessionId(sessionId);
              console.log('[Session] 🆔 Created broadcast session on fresh visit');
            })
            .catch((e) => {
              console.error('[Session] failed to create session on mount:', e);
              // フォールバック: ローカル生成（配信権なし。SERVER_SECRET未設定の開発時のみ配信可能）
              setCurrentSessionId(newSessionId());
            });
        }
      }
    }
  }, []); // Empty dependency array - runs only once on mount

  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false); // 共有ドキュメント中継WebSocketの接続状態
  const [collabConnected, setCollabConnected] = useState(false); // 共有文書(Hocuspocus)への接続状態
  const [error, setError] = useState<string | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [audioSource, setAudioSource] = useState<'microphone' | 'tab-capture'>('tab-capture');
  const tabCaptureStreamRef = useRef<MediaStream | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [sessionIdInput, setSessionIdInput] = useState<string>('');

  // セッションIDの変更を永続化（手動切り替え・新規生成も含めてリロード後に復元される）
  // localStorageに加えてURLの?session=にも反映し、リロード・ブックマークに耐える
  useEffect(() => {
    if (currentSessionId && typeof window !== 'undefined') {
      window.localStorage.setItem('collarecox-realtime-session-id', currentSessionId);
      // 配信を開始した代表者として履歴に記録（ホームの「最近のセッション」に出る）。
      addRecentSession(currentSessionId, 'host');
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
  const [showClearConfirmDialog, setShowClearConfirmDialog] = useState<boolean>(false); // テキストクリア確認ダイアログ
  const [showDebugDialog, setShowDebugDialog] = useState<boolean>(false); // 差分検証ダイアログ
  const [debugDocText, setDebugDocText] = useState<string>(''); // 確定doc本文（取りこぼし比較の対象）
  const [debugRaw, setDebugRaw] = useState<string>(''); // 生テキスト（共有 raw-<id> Y.Text。校正画面と同一ソース）
  const [autoProofread, setAutoProofread] = useState<boolean>(true); // 自動校正（誤字修正+パラグラフ整理）デフォルト: 有効
  const [autoProofreadStatus, setAutoProofreadStatus] = useState<string>(''); // 自動校正の状態表示
  // 共同校正画面でのAI再編に使用するモデル（このモデル選択UIは撤去し、サーバ既定に従う）
  const rewriteModel = 'gpt-4.1-mini';

  // ===== 自動校正エンジン（サーバOpenAI / 録音端末のブラウザLLM・オンデバイス） =====
  const [browserLlm, setBrowserLlm] = useState<BrowserLlmState>('unsupported'); // オンデバイスLLMの対応状態
  // 保存値を同期的に読み、初期値から正しいengineにする。これで ws.onopen が probe 完了を待たずに
  // 正しいengineを送れる（probe遅延時に誤って'server'=OpenAIへ流す privacy leak を構造的に防ぐ）。
  // 'on-device'保存でモデル未準備でも、サーバはOpenAIへフォールバックせず未校正追記するため外部送信は起きない。
  const [proofreadEngine, setProofreadEngine] = useState<'server' | 'on-device'>(() => {
    if (typeof window === 'undefined') return 'server';
    try { return window.localStorage.getItem('collarecox-proofread-engine') === 'on-device' ? 'on-device' : 'server'; } catch { return 'server'; }
  });
  const proofreadEngineRef = useRef<'server' | 'on-device'>(proofreadEngine); // ws.onopen等でのstale closure回避用（初期値=保存値）
  const [nanoPreparing, setNanoPreparing] = useState(false); // モデルDL/準備中フラグ
  const [nanoDlProgress, setNanoDlProgress] = useState<number | null>(null); // DL進捗(%)
  const onDeviceBusyRef = useRef(false); // proofread_request の多重実行ガード

  // proofreadEngine を更新し ref/localStorage へ反映、ws接続中なら即サーバへ通知する（onChange/復元の単一経路）。
  const applyProofreadEngine = (engine: 'server' | 'on-device') => {
    setProofreadEngine(engine);
    proofreadEngineRef.current = engine;
    try { window.localStorage.setItem('collarecox-proofread-engine', engine); } catch { /* localStorage不可時は無視 */ }
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      websocketRef.current.send(JSON.stringify({
        type: 'set_auto_proofread',
        enabled: autoProofread,
        model: rewriteModel,
        engine,
      }));
    }
  };
  // オンデバイスを選んだ瞬間にモデルDLを確認し、完了するまで確定させない。失敗時はフォールバックせず server に戻す。
  const chooseOnDeviceEngine = async () => {
    if (proofreadEngine === 'on-device' || nanoPreparing) return;
    setNanoPreparing(true); setNanoDlProgress(null); setAutoProofreadStatus('');
    try {
      await ensureBrowserLlmReady((loaded) => setNanoDlProgress(Math.round(loaded * 100)));
      setBrowserLlm('available');
      applyProofreadEngine('on-device');
    } catch (e) {
      setAutoProofreadStatus('⚠️ オンデバイスAIの準備に失敗しました: ' + (e instanceof Error ? e.message : '不明なエラー'));
      applyProofreadEngine('server');
    } finally {
      setNanoPreparing(false); setNanoDlProgress(null);
    }
  };
  // マウント時にオンデバイスLLMの対応を検出（UIの表示可否とDLゲート用）。
  // engineは既に保存値で同期初期化済みなので復元は不要。非対応ブラウザ（APIなし）で'on-device'保存値だけは
  // サーバへ矯正する（この環境にオンデバイス手段がなく、ラジオも隠れて選択不能のため）。
  // 対応ブラウザ（available/downloadable/downloading）では保存値を維持。未準備でもサーバはOpenAIへ流さず未校正追記する。
  useEffect(() => {
    let alive = true;
    probeBrowserLlm().then((s) => {
      if (!alive) return;
      setBrowserLlm(s);
      if (s === 'unsupported' && proofreadEngineRef.current === 'on-device') {
        applyProofreadEngine('server');
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const lastCommitAtRef = useRef<number>(0); // 直前の確定コミット時刻（ポーズ=無音間隔の算出用）
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
      setText(prev => prev + chunk + (closeUtterance ? ' ' : ''));
      // 生テキストの累積（サーバのrawBufferと同素材＝greenLenで確定境界をマップできる）
      setSentRaw(prev => prev + chunk);
      // 前回確定からの間隔（無音=ポーズの近似）。サーバ側の機械的パラグラフ分割に使う。
      // continuation（発話途中の継続確定）はポーズではないため0扱い。
      const now = performance.now();
      const gapMs = !continuation && lastCommitAtRef.current > 0
        ? Math.round(now - lastCommitAtRef.current)
        : 0;
      lastCommitAtRef.current = now;
      if (websocketRef.current?.readyState === WebSocket.OPEN) {
        websocketRef.current.send(JSON.stringify({ type: 'local_transcription', text: chunk, continuation, gapMs }));
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
  }, [updateDraftText, localForceFinalizeSec]);

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

      // 配信権の証明として hostToken を付与する。配信者でない（hostToken を持たない）端末は
      // サーバーが配信WSを 403 で拒否する。
      const hostToken = getHostToken(currentSessionId);
      if (!hostToken) {
        console.warn('[WebSocket] ⚠️ No hostToken for this session — broadcasting will be rejected by server');
      }

      // Automatically detect protocol and host
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = typeof window !== 'undefined' ? window.location.host : 'localhost:8888';
      const params = new URLSearchParams({ session: currentSessionId, hostToken: hostToken || '' });
      const wsUrl = `${protocol}//${host}${getBasePath()}/api/realtime-ws?${params.toString()}`;
      console.log('[WebSocket] 🔗 Connecting (relay channel)');
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

        // 自動校正設定を送信（set_session_id送信後である必要がある）
        ws.send(JSON.stringify({
          type: 'set_auto_proofread',
          enabled: autoProofread,
          model: rewriteModel,
          engine: proofreadEngineRef.current
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

            case 'auto_proofread_warning':
              setAutoProofreadStatus(`⚠️ オンデバイス校正できず未校正で追記しました: ${message.error ?? ''}`);
              break;

            case 'proofread_request': {
              // サーバからのオンデバイス校正要求。録音端末のブラウザLLMで処理し proofread_response を返す（外部送信なし）。
              const reqId = message.requestId;
              const sysPrompt = message.systemPrompt;
              const userContent = message.userContent;
              (async () => {
                // 多重実行ガード（サーバはinFlightで直列化するが録音側でも保険として持つ）
                if (onDeviceBusyRef.current) {
                  ws.send(JSON.stringify({ type: 'proofread_response', requestId: reqId, ok: false, error: 'busy' }));
                  return;
                }
                onDeviceBusyRef.current = true;
                try {
                  // create+prompt をクライアント側タイムアウト（サーバ12sより僅かに短い11s）でレースする。
                  // 推論が停止/長時間化してもサーバのタイムアウト後に busy が残らず、次の要求を受けられるようにする。
                  // session の破棄は work 内に閉じ込める（タイムアウトで放棄しても遅延完了時に確実に destroy される）。
                  const work = (async (): Promise<string> => {
                    const LM = getBrowserLanguageModel();
                    if (!LM) throw new Error('on-device LM unavailable');
                    // モデルは選択時にDL済みのため create は軽量。毎回新規セッション（履歴を持たないステートレス校正）。
                    const s: NanoPromptSession = await LM.create({ initialPrompts: [{ role: 'system', content: sysPrompt }] });
                    try {
                      return await s.prompt(userContent);
                    } finally {
                      s.destroy?.();
                    }
                  })();
                  work.catch(() => { /* タイムアウト後に遅れて来る結果/拒否は無視（未処理reject防止） */ });
                  const out = await Promise.race([
                    work,
                    new Promise<string>((_, rej) => setTimeout(() => rej(new Error('client on-device timeout 11s')), 11000)),
                  ]);
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'proofread_response', requestId: reqId, ok: true, text: out || '' }));
                  }
                } catch (e) {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'proofread_response', requestId: reqId, ok: false, error: e instanceof Error ? e.message : String(e) }));
                  }
                } finally {
                  onDeviceBusyRef.current = false;
                }
              })().catch(() => { /* ws切断時のsend失敗等は無視（サーバ側はタイムアウトで未校正追記にフォールバック） */ });
              break;
            }

            default:
              console.log('[WebSocket] ❓ Unknown message type:', message);
          }
        } catch (err) {
          console.error('[WebSocket] ❌ Error parsing message:', err, 'Raw data:', event.data);
        }
      };

      ws.onerror = (error) => {
        console.error('[WebSocket] ❌ Connection error:', error);
        // hostToken を持たない場合はサーバーが配信を拒否する（配信権なし）。
        setError(
          getHostToken(currentSessionId)
            ? '共有ドキュメントへの中継接続に失敗しました'
            : 'このセッションの配信権がありません。配信できるのはセッションを作成した配信者だけです。'
        );
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
  }, [currentSessionId, autoProofread]);

  const disconnectWebSocket = useCallback(() => {
    if (websocketRef.current) {
      console.log('[WebSocket] 🔌 Disconnecting WebSocket');
      websocketRef.current.close();
      websocketRef.current = null;
    }
    setIsConnected(false);
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
    setSentRaw("");
    setPendingGreenLen(0);
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
    if (!sentRaw) {
      console.log('[UI] ⚠️ No text to copy');
      return;
    }

    try {
      await navigator.clipboard.writeText(sentRaw);
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
  }, [sentRaw, error]);

  // 差分検証: 共有docの確定本文(content-<id>)と、共有の生テキスト(raw-<id> Y.Text)を取り出してダイアログを開く。
  // 生は校正画面と同一の共有ソース(raw-<id>)を使う（単一の真実源。ローカルのsentRawではなくdoc側を比較）。
  const openDebugDialog = useCallback(async () => {
    let docText = '';
    let raw = '';
    try {
      const ydoc = hocuspocusDocRef.current;
      if (ydoc && currentSessionId) {
        const Y = await import('yjs');
        const fragment = ydoc.getXmlFragment(`content-${currentSessionId}`);
        const paras: string[] = [];
        for (let i = 0; i < fragment.length; i++) {
          const el = fragment.get(i);
          // XmlElement(段落)内のXmlTextを連結し、段落は改行で結合する（スモークのfragmentTextと同方式）。
          if (el instanceof Y.XmlElement) {
            let t = '';
            for (let j = 0; j < el.length; j++) {
              const child = el.get(j);
              if (child instanceof Y.XmlText) t += child.toString();
            }
            paras.push(t);
          }
        }
        docText = paras.join('\n');
        // 生テキストは共有 raw Y.Text(校正画面と同一ソース)から取得する。
        raw = ydoc.getText(`raw-${currentSessionId}`).toString();
      }
    } catch (e) {
      console.warn('[Debug] doc/raw の取得に失敗:', e);
    }
    setDebugDocText(docText);
    setDebugRaw(raw);
    setShowDebugDialog(true);
  }, [currentSessionId]);

  // Generate or retrieve session ID
  const generateSessionId = useCallback(() => {
    if (!currentSessionId) {
      const generatedId = newSessionId();
      setCurrentSessionId(generatedId);
      return generatedId;
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

  // 新規セッションを作成する。サーバーが配信権(hostToken)付きのセッションを発行する。
  const createNewSession = useCallback(async () => {
    try {
      const { sessionId } = await createBroadcastSession();
      console.log('[Session] 🆕 Created new broadcast session');
      setCurrentSessionId(sessionId);
      setExistingSessionInput('');
      if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
        websocketRef.current.send(JSON.stringify({ type: 'set_session_id', sessionId }));
      }
    } catch (e) {
      console.error('[Session] failed to create session:', e);
      setError('セッションの作成に失敗しました。もう一度お試しください。');
    }
  }, []);

  const connectToExistingSession = useCallback(() => {
    if (existingSessionInput.trim()) {
      // 入力はセッションID、または /editor/<id> 形式のURL/パスを許容する。
      // リンクシークレットモデルでは、アクセスにはこのIDを「知っている」ことが必要。
      const raw = existingSessionInput.trim();
      const sessionId = raw.split('/editor/').pop()?.split(/[?#]/)[0].trim() || raw;
      console.log('[Session] 🔗 Connecting to existing session');

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

      // 自分のプレゼンスを awareness に publish する。
      // これにより離脱確認フックが「自分が最後の接続か」を接続数で判定できる
      // （ブロードキャスタは CollaborationCursor を持たないため明示的に設定する）。
      try {
        provider.awareness?.setLocalStateField('presence', { role: 'host' });
      } catch (e) {
        console.warn('[Hocuspocus Client] failed to set awareness presence:', e);
      }

      // サーバが配信する rawBuffer長(pendingGreenLen)を購読し、認識画面の3色表示に使う。
      // 黒=確定済(sentRaw先頭) / 緑=AI校正待ち(sentRaw末尾greenLen分) / グレー=interim
      try {
        const statusMap = ydoc.getMap(`status-${currentSessionId}`);
        const syncGreen = () => {
          const g = statusMap.get('pendingGreenLen');
          setPendingGreenLen(typeof g === 'number' ? g : 0);
        };
        syncGreen();
        statusMap.observe(syncGreen);
      } catch (e) {
        console.warn('[Hocuspocus Client] greenLen observe failed:', e);
      }

      provider.on('connect', () => {
        console.log('[Hocuspocus Client] Connected to collaborative session');
        setCollabConnected(true);
      });

      provider.on('disconnect', () => {
        console.log('[Hocuspocus Client] Disconnected from collaborative session');
        setCollabConnected(false);
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
    setCollabConnected(false);
  }, []);

  // 自分が最後の接続のとき、画面を閉じる/リロードすると共有文書が失われるため確認する。
  useLeaveConfirmation(() => hocuspocusProviderRef.current, collabConnected);

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
    <div className="dc-realtime" style={css("min-height:100vh;background:#f4f6f7;font-family:'Noto Sans JP',sans-serif;color:#1f2933;-webkit-font-smoothing:antialiased;")}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        @keyframes recPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.78)}}
        @keyframes barFlow{0%{transform:scaleY(.35)}50%{transform:scaleY(1)}100%{transform:scaleY(.5)}}
        .dc-realtime ::placeholder{color:#9aa5b1}
        @media(max-width:880px){.dc-grid{grid-template-columns:1fr!important}.dc-main{padding:24px 16px 48px!important}.dc-head{padding:18px 16px!important}}`}</style>

      {/* Header (design) */}
      <header style={css("background:#ffffff;border-bottom:1px solid #e4e7eb;")}>
        <div className="dc-head" style={css("max-width:1240px;margin:0 auto;padding:22px 40px;display:flex;align-items:center;justify-content:space-between;gap:24px;")}>
          <div style={css("display:flex;align-items:center;gap:16px;")}>
            <div style={css("width:42px;height:42px;border-radius:11px;background:#157a8c;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 4px 12px rgba(21,122,140,.28);")}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" fill="#fff"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/></svg>
            </div>
            <div>
              <h1 style={css("margin:0;font-size:20px;font-weight:700;letter-spacing:.01em;line-height:1.3;")}>リアルタイム文字起こし・共同校正システムCollaReco</h1>
              <p style={css("margin:3px 0 0;font-size:12.5px;color:#7b8794;")}>オンデバイス音声認識 ・ Chrome 端末内処理</p>
            </div>
          </div>
          <div style={css("display:flex;align-items:center;gap:14px;")}>
            <span style={css("font-size:11px;font-weight:500;color:#9aa5b1;font-family:'IBM Plex Mono',monospace;")}>v{packageJson.version}</span>
            <a href={`${getBasePath()}/manual.html`} target="_blank" rel="noopener noreferrer" style={css("font-size:13px;font-weight:500;color:#3e4c59;background:#fff;border:1px solid #d2d9e0;border-radius:8px;padding:8px 16px;cursor:pointer;text-decoration:none;")}>マニュアル</a>
          </div>
        </div>
      </header>

      <main className="dc-main" style={css("max-width:1240px;margin:0 auto;padding:32px 40px 56px;")}>

        {/* Error */}
        {error && (
          <div style={css("background:#fdeceb;border:1px solid #f6c9c5;border-radius:12px;padding:13px 18px;margin-bottom:20px;color:#c0392b;font-size:13px;line-height:1.6;")}>
            <span style={css("font-weight:700;")}>エラー: </span>{error}
          </div>
        )}

        {/* Top row: session + transcription source */}
        <div className="dc-grid" style={css("display:grid;grid-template-columns:1fr 1.15fr;gap:24px;align-items:start;")}>

          {/* Session management (design) */}
          <section style={css(DC_CARD)}>
            <div style={css("display:flex;align-items:center;gap:9px;margin-bottom:20px;")}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M16 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" stroke="#157a8c" strokeWidth="1.7" strokeLinecap="round"/><rect x="9" y="3" width="6" height="3.5" rx="1.2" stroke="#157a8c" strokeWidth="1.7"/><path d="M8.5 12h7M8.5 15.5h4.5" stroke="#157a8c" strokeWidth="1.7" strokeLinecap="round"/></svg>
              <h2 style={css(DC_SECTITLE)}>共同校正セッション</h2>
            </div>

            <label style={css(DC_LABEL)}>現在のセッションID</label>
            {isEditingSessionId ? (
              <div style={css("display:flex;gap:8px;margin-bottom:22px;")}>
                <input type="text" value={sessionIdInput} onChange={(e) => setSessionIdInput(e.target.value)} placeholder="セッションIDを入力..." style={css("flex:1;font-size:13px;color:#1f2933;background:#fff;border:1px solid #d2d9e0;border-radius:9px;padding:11px 13px;outline:none;")} />
                <button onClick={saveSessionId} style={css("font-size:13px;font-weight:500;color:#fff;background:#157a8c;border:1px solid #157a8c;border-radius:9px;padding:0 16px;cursor:pointer;white-space:nowrap;")}>保存</button>
                <button onClick={cancelEditSessionId} style={css("font-size:13px;font-weight:500;color:#3e4c59;background:#fff;border:1px solid #d2d9e0;border-radius:9px;padding:0 14px;cursor:pointer;white-space:nowrap;")}>キャンセル</button>
              </div>
            ) : (
              <div style={css("display:flex;gap:8px;margin-bottom:22px;")}>
                <div style={css("flex:1;font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#3e4c59;background:#f4f6f7;border:1px solid #e4e7eb;border-radius:9px;padding:11px 13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{currentSessionId || 'セッションが作成されていません'}</div>
                <button onClick={editSessionId} style={css("font-size:13px;font-weight:500;color:#157a8c;background:#eef6f7;border:1px solid #cfe6ea;border-radius:9px;padding:0 16px;cursor:pointer;white-space:nowrap;")}>変更</button>
              </div>
            )}

            <label style={css(DC_LABEL)}>セッションに接続</label>
            <div style={css("display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;")}>
              <input type="text" value={existingSessionInput} onChange={(e) => setExistingSessionInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') connectToExistingSession(); }} placeholder="共有されたID または リンクを貼り付け" style={css("flex:1;min-width:150px;font-size:13px;color:#1f2933;background:#fff;border:1px solid #d2d9e0;border-radius:9px;padding:11px 13px;outline:none;")} />
              <button onClick={createNewSession} title="推測不能なIDで新しいセッションを作成" style={css("font-size:13px;font-weight:500;color:#3e4c59;background:#fff;border:1px solid #d2d9e0;border-radius:9px;padding:0 13px;cursor:pointer;white-space:nowrap;")}>＋新規</button>
              <button onClick={connectToExistingSession} disabled={!existingSessionInput.trim()} style={css("font-size:13px;font-weight:500;border-radius:9px;padding:0 16px;white-space:nowrap;" + (!existingSessionInput.trim() ? "color:#b9c3cd;background:#f4f6f7;border:1px solid #e4e7eb;cursor:not-allowed;" : "color:#fff;background:#157a8c;border:1px solid #157a8c;cursor:pointer;"))}>接続</button>
              {isConnected && (
                <button onClick={disconnectWebSocket} style={css("font-size:13px;font-weight:500;color:#c0392b;background:#fff;border:1px solid #f0cdc8;border-radius:9px;padding:0 13px;cursor:pointer;white-space:nowrap;")}>切断</button>
              )}
            </div>
            <p style={css("margin:0 0 22px;font-size:11.5px;line-height:1.6;color:#9aa5b1;")}>他の参加者のセッションは一覧表示されません。アクセスには共有リンク（ID）が必要です。</p>

            {currentSessionId && isConnected && (
              <div style={css("background:#f0f8f4;border:1px solid #cfeada;border-radius:12px;padding:13px 15px;margin-bottom:18px;")}>
                <div style={css("display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;")}>
                  <span style={css("font-size:12px;font-weight:700;color:#157a4a;")}>● 接続中・このURLを共有して招待</span>
                  <button onClick={() => { const editorUrl = `${window.location.origin}${getBasePath()}/editor/${currentSessionId}`; navigator.clipboard.writeText(editorUrl); const b = document.activeElement as HTMLButtonElement; const t = b.textContent; b.textContent = 'コピー完了！'; setTimeout(() => { b.textContent = t; }, 2000); }} style={css("font-size:12px;font-weight:500;color:#fff;background:#157a8c;border:none;border-radius:7px;padding:6px 12px;cursor:pointer;white-space:nowrap;")}>URLをコピー</button>
                </div>
                <div style={css("font-family:'IBM Plex Mono',monospace;font-size:11px;color:#3e6b54;word-break:break-all;")}>{typeof window !== 'undefined' && `${window.location.origin}${getBasePath()}/editor/${currentSessionId}`}</div>
              </div>
            )}

            <button onClick={createOrOpenEditingSession} style={css("width:100%;font-size:14px;font-weight:700;color:#fff;background:#157a8c;border:none;border-radius:11px;padding:14px;cursor:pointer;box-shadow:0 4px 12px rgba(21,122,140,.24);display:flex;align-items:center;justify-content:center;gap:8px;")}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M17 7 7 17M9 7h8v8" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>
              {currentSessionId ? '共同校正セッションを開く' : '共同校正セッションの作成'}
            </button>
          </section>

          {/* Transcription source (design) */}
          <section style={css(DC_CARD)}>
            <div style={css("display:flex;align-items:center;gap:9px;margin-bottom:20px;")}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" stroke="#157a8c" strokeWidth="1.7"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3" stroke="#157a8c" strokeWidth="1.7" strokeLinecap="round"/></svg>
              <h2 style={css(DC_SECTITLE)}>音声入力からの文字起こし</h2>
            </div>

            {/* Audio source */}
            <label style={css(DC_LABEL)}>音声ソース</label>
            {(() => {
              const segBase = 'font-size:13.5px;font-weight:500;border-radius:10px;padding:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .12s;';
              const on = segBase + 'color:#fff;background:#157a8c;border:1px solid #157a8c;box-shadow:0 2px 8px rgba(21,122,140,.22);';
              const off = segBase + 'color:#52606d;background:#fff;border:1px solid #d2d9e0;';
              const dim: React.CSSProperties = isRecording ? { opacity: 0.5, cursor: 'not-allowed' } : {};
              return (
                <div style={css("display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:9px;")}>
                  <button type="button" onClick={() => setAudioSource('microphone')} disabled={isRecording} style={{ ...css(audioSource === 'microphone' ? on : off), ...dim }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" stroke="currentColor" strokeWidth="1.7"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
                    マイク
                  </button>
                  <button type="button" onClick={() => setAudioSource('tab-capture')} disabled={isRecording} style={{ ...css(audioSource === 'tab-capture' ? on : off), ...dim }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.7"/><path d="M9 21h6M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
                    タブ音声キャプチャ
                  </button>
                </div>
              );
            })()}
            <p style={css("margin:0 0 18px;font-size:11.5px;line-height:1.6;color:#9aa5b1;")}>{audioSource === 'tab-capture' ? '開始時にタブ選択ダイアログが表示されます。「タブの音声も共有」を有効にしてください。' : '開始時にマイクへのアクセス許可を求められます。静かな環境での利用を推奨します。'}</p>

            {/* on-device badge (status-adaptive) */}
            <div style={css("background:#f0f8f4;border:1px solid #cfeada;border-radius:12px;padding:14px 16px;margin-bottom:14px;")}>
              <div style={css("display:flex;align-items:center;gap:7px;margin-bottom:6px;")}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#1f9d63" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <span style={css("font-size:13px;font-weight:700;color:#157a4a;")}>オンデバイス認識</span>
              </div>
              <div style={css("font-size:11.5px;line-height:1.65;color:#3e6b54;")}>
                {localAsrStatus === 'checking' && <span>オンデバイス認識の対応状況を確認中...</span>}
                {localAsrStatus === 'unsupported' && <span style={css("color:#c0392b;")}>このブラウザでは利用できません。Chrome 139以降でこのページを開いてください。</span>}
                {localAsrStatus === 'unavailable' && <span style={css("color:#c0392b;")}>日本語のオンデバイス認識が利用できません。Chrome 139以降でお試しください。</span>}
                {localAsrStatus === 'downloadable' && (
                  <span>日本語の言語パック（約60MB）が未インストールです。
                    <button onClick={installLocalAsr} disabled={isRecording} style={css("font-size:11px;font-weight:500;color:#fff;background:#157a8c;border:none;border-radius:6px;padding:3px 10px;cursor:pointer;margin-left:6px;")}>インストール</button>
                  </span>
                )}
                {localAsrStatus === 'downloading' && <span>言語パックをインストール中...（数分かかる場合があります）</span>}
                {localAsrStatus === 'available' && <span>Chrome 端末内エンジンで文字起こし（音声の外部送信なし）。認識途中のテキストは薄色で表示されます。</span>}
              </div>
              {localAsrStatus === 'available' && (
                <div style={css("display:flex;align-items:center;gap:10px;margin-top:12px;")}>
                  <span style={css("font-size:12px;color:#52606d;white-space:nowrap;")}>部分確定間隔</span>
                  <select value={localForceFinalizeSec} onChange={(e) => setLocalForceFinalizeSec(parseInt(e.target.value))} disabled={isRecording} style={css("flex:1;font-size:12.5px;color:#1f2933;background:#fff;border:1px solid #cfeada;border-radius:8px;padding:8px 12px;cursor:pointer;outline:none;")}>
                    <option value="3">3秒</option>
                    <option value="5">5秒</option>
                    <option value="8">8秒</option>
                    <option value="10">10秒</option>
                    <option value="0">なし（自然な区切りのみ）</option>
                  </select>
                </div>
              )}
            </div>

            {/* device select (mic only) */}
            {audioSource === 'microphone' && (
              <div style={css("margin-bottom:14px;")}>
                <label style={css(DC_LABEL)}>音声入力デバイス</label>
                <select value={selectedDeviceId} onChange={(e) => setSelectedDeviceId(e.target.value)} disabled={isRecording} style={css("width:100%;font-size:12.5px;color:#1f2933;background:#fff;border:1px solid #d2d9e0;border-radius:9px;padding:9px 12px;cursor:pointer;outline:none;")}>
                  {audioDevices.length === 0 ? (
                    <option value="">デバイスを読み込み中...</option>
                  ) : (
                    audioDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label || `マイク ${device.deviceId.slice(0, 8)}...`}</option>
                    ))
                  )}
                </select>
                <div style={css("display:flex;align-items:center;gap:10px;margin-top:8px;")}>
                  <button onClick={getAudioDevices} disabled={isRecording} style={css("font-size:11px;color:#3e4c59;background:#fff;border:1px solid #d2d9e0;border-radius:7px;padding:5px 10px;cursor:pointer;")}>デバイス更新</button>
                  <span style={css("font-size:11px;color:#9aa5b1;")}>{audioDevices.length} 個のデバイス</span>
                </div>
              </div>
            )}

            {/* auto correct */}
            <div style={css(autoProofread ? 'background:#f7fafb;border:1px solid #dde7ea;border-radius:12px;padding:16px;' : 'background:#fafbfc;border:1px solid #e4e7eb;border-radius:12px;padding:16px;')}>
              <label style={css("display:flex;align-items:flex-start;gap:10px;cursor:pointer;")}>
                <input
                  type="checkbox"
                  checked={autoProofread}
                  onChange={(e) => {
                    setAutoProofread(e.target.checked);
                    setAutoProofreadStatus('');
                    if (websocketRef.current?.readyState === WebSocket.OPEN) {
                      websocketRef.current.send(JSON.stringify({ type: 'set_auto_proofread', enabled: e.target.checked, model: rewriteModel, engine: proofreadEngineRef.current }));
                    }
                  }}
                  style={css("margin-top:3px;accent-color:#157a8c;width:16px;height:16px;")}
                />
                <span>
                  <span style={css("font-size:13.5px;font-weight:700;color:#1f2933;")}>自動校正（誤字修正＋パラグラフ整理）</span>
                  <span style={css("display:block;margin-top:5px;font-size:11.5px;line-height:1.65;color:#7b8794;")}>ONにすると認識テキストをAI校正してから校正画面に反映します。校正前テキストはグレーの未確定表示。100文字以上たまり次第・最短15秒間隔で処理します。</span>
                </span>
              </label>
              {autoProofread && browserLlm !== 'unsupported' && (
                <div style={css("margin-top:14px;padding-top:14px;border-top:1px dashed #d2d9e0;")}>
                  <span style={css("display:block;font-size:12px;font-weight:500;color:#52606d;margin-bottom:9px;")}>校正エンジン</span>
                  {(() => {
                    const eb = 'flex:1;font-size:12.5px;font-weight:500;border-radius:9px;padding:10px;cursor:pointer;transition:all .12s;';
                    const eon = eb + 'color:#157a8c;background:#eef6f7;border:1px solid #157a8c;';
                    const eoff = eb + 'color:#52606d;background:#fff;border:1px solid #d2d9e0;';
                    return (
                      <div style={css("display:flex;gap:9px;")}>
                        <button onClick={() => applyProofreadEngine('server')} style={css(proofreadEngine === 'server' ? eon : eoff)}>サーバ（OpenAI）</button>
                        <button onClick={chooseOnDeviceEngine} disabled={nanoPreparing} style={css(proofreadEngine === 'on-device' ? eon : eoff)}>オンデバイス（ブラウザLLM）{nanoPreparing && `（準備中 ${nanoDlProgress ?? 0}%）`}</button>
                      </div>
                    );
                  })()}
                  <p style={css("margin:11px 0 0;font-size:11px;line-height:1.6;color:#9aa5b1;")}>{proofreadEngine === 'on-device' ? '録音端末のブラウザ内蔵LLM（Chrome=Gemini Nano / Edge=Phi 等）で校正します（外部送信なし）。初回はモデルDLを確認します。校正できなかった分は未校正のまま追記し警告を表示します。' : 'OpenAI サーバへ送信して校正します。長文でも安定した精度ですが、テキストが外部に送信されます。'}</p>
                </div>
              )}
              {autoProofreadStatus && (<p style={css("margin:11px 0 0;font-size:11px;color:#157a8c;")}>{autoProofreadStatus}</p>)}
            </div>

            {/* record button */}
            <button onClick={isRecording ? stopRecording : startRecording} style={css(isRecording
              ? 'width:100%;margin-top:18px;font-size:15px;font-weight:700;color:#fff;background:#c0392b;border:none;border-radius:12px;padding:15px;cursor:pointer;box-shadow:0 4px 14px rgba(192,57,43,.26);display:flex;align-items:center;justify-content:center;gap:9px;'
              : 'width:100%;margin-top:18px;font-size:15px;font-weight:700;color:#fff;background:#157a8c;border:none;border-radius:12px;padding:15px;cursor:pointer;box-shadow:0 4px 14px rgba(21,122,140,.26);display:flex;align-items:center;justify-content:center;gap:9px;')}>
              <span style={isRecording ? css("width:11px;height:11px;border-radius:3px;background:#fff;display:inline-block;") : css("width:11px;height:11px;border-radius:50%;background:#fff;display:inline-block;animation:recPulse 1.6s ease-in-out infinite;")}></span>
              {isRecording ? '録音を停止' : '録音開始'}
            </button>

            {isRecording && (
              <div style={css("display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;color:#52606d;")}>
                <span style={css("width:8px;height:8px;border-radius:50%;background:#157a8c;display:inline-block;animation:recPulse 1.4s ease-in-out infinite;")}></span>
                <span style={css("font-size:13px;font-weight:500;")}>認識中</span>
                <span style={css("font-size:18px;font-weight:300;font-variant-numeric:tabular-nums;color:#1f2933;")}>{Math.floor(recordingElapsedTime / 60).toString().padStart(2, '0')}:{Math.floor(recordingElapsedTime % 60).toString().padStart(2, '0')}</span>
                <span style={css("font-size:12px;color:#9aa5b1;")}>経過</span>
              </div>
            )}
          </section>
        </div>

        {/* Result panel (design) */}
        <section style={css(DC_CARD + 'margin-top:24px;')}>
          <div style={css("display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap;")}>
            <div style={css("display:flex;align-items:center;gap:11px;flex-wrap:wrap;")}>
              <h2 style={css(DC_SECTITLE)}>文字起こし結果</h2>
              {isRecording && (
                <span style={css("display:inline-flex;align-items:center;gap:6px;background:#fdeceb;border:1px solid #f6c9c5;border-radius:999px;padding:4px 11px;")}>
                  <span style={css("width:7px;height:7px;border-radius:50%;background:#e0584f;display:inline-block;animation:recPulse 1.4s ease-in-out infinite;")}></span>
                  <span style={css("font-size:11px;font-weight:700;color:#c0392b;")}>録音中</span>
                </span>
              )}
              <span style={css("font-size:11.5px;color:#9aa5b1;")}>自動校正・改行挿入なし</span>
            </div>
            {(() => {
              const ab = 'font-size:13px;font-weight:500;border-radius:9px;padding:9px 14px;display:flex;align-items:center;gap:7px;transition:all .12s;';
              const aOn = ab + 'color:#3e4c59;background:#fff;border:1px solid #d2d9e0;cursor:pointer;';
              const aOff = ab + 'color:#b9c3cd;background:#f4f6f7;border:1px solid #e4e7eb;cursor:not-allowed;';
              const clearOn = ab + 'color:#c0392b;background:#fff;border:1px solid #f0cdc8;cursor:pointer;';
              const noText = !sentRaw;
              return (
                <div style={css("display:flex;gap:9px;flex-wrap:wrap;")}>
                  <button onClick={copyText} disabled={noText} style={css(noText ? aOff : aOn)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7"/><path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
                    コピー
                  </button>
                  <button onClick={openDebugDialog} disabled={noText} title="生テキスト(認識結果)と確定doc本文を文字単位で比較し、差分を検出します" style={css(noText ? aOff : aOn)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7"/><path d="m20 20-4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
                    差分検証
                  </button>
                  <button onClick={() => setShowClearConfirmDialog(true)} disabled={isRecording || noText} style={css((isRecording || noText) ? aOff : clearOn)}>テキストをクリア</button>
                </div>
              );
            })()}
          </div>

          <div ref={transcriptScrollRef} onScroll={() => { const el = transcriptScrollRef.current; if (el) { transcriptAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; } }} style={css("position:relative;border:1px solid #e4e7eb;border-radius:12px;background:#fafbfc;min-height:300px;max-height:60vh;overflow-y:auto;resize:vertical;")}>
            {(sentRaw || (isRecording && draftText)) ? (
              <div style={css("padding:20px 22px;font-size:14.5px;line-height:1.9;white-space:pre-wrap;")}>
                <span style={css("color:#1f2933;")}>{sentRaw.slice(0, Math.max(0, sentRaw.length - pendingGreenLen))}</span>
                <span style={css("color:#3fa874;")}>{sentRaw.slice(Math.max(0, sentRaw.length - pendingGreenLen))}</span>
                {isRecording && draftText && (<span style={css("color:#9aa5b1;")}>{draftText}</span>)}
                {isRecording && (<span style={css("display:inline-block;width:2px;height:18px;background:#157a8c;margin-left:2px;vertical-align:text-bottom;animation:recPulse 1s step-end infinite;")}></span>)}
              </div>
            ) : (
              <div style={css("position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:20px;")}>
                <div style={css("display:flex;align-items:flex-end;gap:4px;height:30px;")}>
                  {[0, 1, 2, 3, 4].map((i) => {
                    const dur = [1.1, 0.8, 1.3, 0.9, 1.05][i];
                    const delay = [0, .2, .4, .15, .35][i];
                    return (<span key={i} style={{ ...css("width:4px;height:100%;background:#cfe6ea;border-radius:2px;transform-origin:bottom;"), animation: `barFlow ${dur}s ease-in-out ${delay}s infinite` }}></span>);
                  })}
                </div>
                <p style={css("margin:0;font-size:13.5px;color:#9aa5b1;")}>録音を開始すると、ここに文字起こしが表示されます</p>
              </div>
            )}
          </div>
          {sentRaw && (<div style={css("margin-top:14px;font-size:12.5px;color:#7b8794;")}>文字数: {sentRaw.length}</div>)}
        </section>

        {/* How to use (design) */}
        <section style={css("background:#eef6f7;border:1px solid #d6e9ec;border-radius:16px;padding:26px 30px;margin-top:24px;")}>
          <div style={css("display:flex;align-items:center;gap:9px;margin-bottom:18px;")}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#157a8c" strokeWidth="1.7"/><path d="M12 11v5M12 8h.01" stroke="#157a8c" strokeWidth="1.9" strokeLinecap="round"/></svg>
            <h2 style={css("margin:0;font-size:15px;font-weight:700;color:#0f5f6e;")}>使い方</h2>
          </div>
          <div style={css("display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px 22px;")}>
            {['音声ソース（マイク／タブ音声）を選ぶ', '「録音開始」をクリック（共有ドキュメントへ自動接続）', 'アクセスを許可し、自然に話す', '端末内認識でリアルタイムに表示される', '終了時は「録音を停止」をクリック'].map((t, i) => (
              <div key={i} style={css("display:flex;gap:11px;")}>
                <span style={css("flex-shrink:0;width:23px;height:23px;border-radius:50%;background:#157a8c;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;")}>{i + 1}</span>
                <span style={css("font-size:13px;line-height:1.55;color:#3e4c59;")}>{t}</span>
              </div>
            ))}
          </div>
          <p style={css("margin:18px 0 0;padding-top:16px;border-top:1px solid #d6e9ec;font-size:11.5px;line-height:1.7;color:#5a7a80;")}>オンデバイス認識について: 音声は Chrome の端末内エンジンで処理され、外部サーバーへは送信されません。初回利用時は日本語の言語パック（約60MB）のインストールが必要です。Chrome 139 以降が必要です。</p>
        </section>
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

      {/* 差分検証ダイアログ（生テキスト vs 確定doc・文字単位diff） */}
      {showDebugDialog && (
        <div
          className="fixed inset-0 bg-surface-ink/40 flex items-center justify-center z-50"
          onClick={() => setShowDebugDialog(false)}
        >
          <div
            className="bg-surface rounded-lg p-6 max-w-3xl w-full mx-4 max-h-[85vh] overflow-hidden flex flex-col border border-hairline shadow-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-medium text-ink mb-2">
              🔍 差分検証（生テキスト vs 確定doc・文字単位diff）
            </h3>
            {!debugRaw ? (
              <p className="text-body py-6">
                生テキスト(raw)が記録されていません（録音セッションがまだ無い、または共有ドキュメント未接続の可能性があります）。
              </p>
            ) : (
              (() => {
                // old=確定doc / new=生テキスト(共有raw)。added=生にあってdocに無い(差分候補)、removed=docにあって生に無い(AI付加/変更)。
                const parts = Diff.diffChars(debugDocText, debugRaw);
                const dropped = parts.filter((p) => p.added).reduce((n, p) => n + p.value.length, 0);
                const aiAdded = parts.filter((p) => p.removed).reduce((n, p) => n + p.value.length, 0);
                return (
                  <>
                    <div className="text-sm text-body mb-2">
                      生(認識): <b>{debugRaw.length}</b>字 / 確定doc: <b>{debugDocText.length}</b>字
                      <span className="ml-3" style={{ color: '#b91c1c' }}>
                        差分候補(赤): {dropped}字
                      </span>
                      <span className="ml-3" style={{ color: '#2563eb' }}>
                        AI付加/変更(青): {aiAdded}字
                      </span>
                    </div>
                    <p className="text-xs text-muted mb-3 leading-relaxed">
                      赤＝生にあって確定docに無い文字（差分候補）。青＝確定docにあって生に無い文字（AIの整形・かな→漢字等）。
                      ※「文字単位の厳密diff」のため、AIの言い換え・漢字変換も差分として現れます。
                    </p>
                    <div className="flex-1 overflow-y-auto p-3 border border-hairline rounded-md bg-surface-soft whitespace-pre-wrap leading-relaxed text-sm">
                      {parts.map((p, i) => (
                        <span
                          key={i}
                          style={
                            p.added
                              ? { backgroundColor: 'rgba(185,28,28,0.18)', color: '#b91c1c', textDecoration: 'underline' }
                              : p.removed
                                ? { backgroundColor: 'rgba(37,99,235,0.12)', color: '#2563eb' }
                                : undefined
                          }
                        >
                          {p.value}
                        </span>
                      ))}
                    </div>
                  </>
                );
              })()
            )}
            <div className="flex justify-end mt-4">
              <button
                onClick={() => setShowDebugDialog(false)}
                className="px-4 py-2 rounded-lg font-medium text-ink bg-surface border border-hairline hover:bg-surface-soft transition-colors"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}