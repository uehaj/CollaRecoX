"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { EditorContent, useEditor, Mark, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import TurndownService from 'turndown';
import { marked } from 'marked';
import { DOMSerializer } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ySyncPluginKey } from 'y-prosemirror';
import * as Diff from 'diff';
import { useKeyboardShortcuts } from '@/lib/hooks/useKeyboardShortcuts';
import { getBasePath } from '@/lib/basePath';
import { addRecentSession } from '@/lib/recentSessions';
import ShortcutHelpModal from './ShortcutHelpModal';

// Custom UserUnderline Mark - スキーマ互換のため残すが、視覚効果はなし
// 下線表示はProseMirror Decorationで管理する（Yjsとの干渉回避）
const UserUnderline = Mark.create({
  name: 'userUnderline',
  inclusive: false,

  addAttributes() {
    return {
      color: { default: null },
      userId: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-user-underline]' }];
  },

  renderHTML() {
    // 視覚効果なし - Decorationが下線表示を担当
    return ['span', {}, 0];
  },
});

// 2つの文字列の差分テキストを先頭一致で抽出（変更履歴プレビュー用）
// base=短い方、changed=長い方、diffLength=長さの差
const extractDiffPreview = (base: string, changed: string, diffLength: number): string => {
  let start = 0;
  while (start < base.length && changed[start] === base[start]) start++;
  const extracted = changed.slice(start, start + diffLength);
  return extracted.length > 30 ? extracted.slice(0, 30) + '...' : extracted;
};

// 編集追跡Decoration用PluginKey
const editTrackKey = new PluginKey('editTrack');

// 認識中（pending）テキストのインライン表示用PluginKey
// 確定テキストの直後にグレーで表示し、認識仮説の更新（バックトラック）をその場で反映する。
// Decorationなので共有ドキュメント本体・編集履歴には一切影響しない
const pendingTextKey = new PluginKey('pendingTextInline');

// AI再補正で上書きされる末尾領域（編集禁止＋青字）用PluginKey
const protectedTailKey = new PluginKey('protectedTail');

// 未確定spanを、そとづけの区切り情報(breaks=改行オフセット配列)で複数行描画する。
// テキストには \n を埋め込まず、breaksの位置で <br> を挿入して改行表示にする
// （ProseMirrorのテキストノードでは \n が空白に潰れるため）。
// 色分け: 先頭から greenLen 文字は緑（オンデバイス確定済・AI校正待ち）、以降はグレー（interim）。
// breakBeforeFirst=true: 直前に確定テキストがある場合、緑領域の冒頭を必ず行頭から始める
// （確定文の末尾に続けず <br> で改行する）。
const PENDING_GREEN = '#3fa874'; // 緑: AI校正待ち（rawBuffer）
const PENDING_GRAY = '#9ca3af';  // グレー: オンデバイス未確定（interim）

// 緑の折返しを「画面の実描画幅」で行うためのテキスト幅測定（canvasで実測・使い回し）。
let _measureCanvas: HTMLCanvasElement | null = null;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  return _measureCanvas.getContext('2d');
}
// pauseCuts（ポーズ＝段落境界）を保ちつつ、描画幅 availWidth(px) を超える位置に改行オフセットを足す。
// 文字数ではなく「見た目の1行ぴったり」で折り返す。
function widthCutOffsets(text: string, pauseCuts: Set<number>, font: string, availWidth: number): Set<number> {
  const cuts = new Set<number>(pauseCuts);
  const ctx = getMeasureCtx();
  if (!ctx || !(availWidth > 0)) return cuts;
  ctx.font = font;
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    if (pauseCuts.has(i)) acc = 0; // ポーズ境界で行頭リセット
    const w = ctx.measureText(text[i]).width;
    if (acc > 0 && acc + w > availWidth) {
      cuts.add(i); // 文字iの前で改行
      acc = w;
    } else {
      acc += w;
    }
  }
  return cuts;
}

function renderPendingSpan(span: HTMLSpanElement, text: string, breaks: number[], greenLen: number, breakBeforeFirst = false, wrap: { font: string; availWidth: number } | null = null) {
  span.textContent = '';
  if (!text) return;
  const green = Math.max(0, Math.min(greenLen || 0, text.length));
  const pauseCuts = new Set<number>(
    Array.isArray(breaks) ? [...new Set(breaks)].filter((o) => o > 0 && o < text.length) : []
  );
  // 横幅での折返しを実測して足す（pauseCutsは保持）。wrapが無ければポーズ境界のみ。
  const cutSet = wrap ? widthCutOffsets(text, pauseCuts, wrap.font, wrap.availWidth) : pauseCuts;
  const cuts = [...cutSet].filter((o) => o > 0 && o < text.length).sort((a, b) => a - b);
  const lines: Array<[number, number]> = [];
  let s = 0;
  for (const c of cuts) { lines.push([s, c]); s = c; }
  lines.push([s, text.length]);
  const addSeg = (str: string, color: string) => {
    if (!str) return;
    const seg = document.createElement('span');
    seg.style.color = color;
    seg.textContent = str;
    span.appendChild(seg);
  };
  lines.forEach(([ls, le], i) => {
    // 行頭の改行: 2行目以降は常に、1行目は直前に確定テキストがあるとき（緑の冒頭を行頭に揃える）。
    if (i > 0 || breakBeforeFirst) span.appendChild(document.createElement('br'));
    const gEnd = Math.min(le, green); // この行の緑部分の終端
    if (gEnd > ls) {
      addSeg(text.slice(ls, gEnd), PENDING_GREEN);
      addSeg(text.slice(gEnd, le), PENDING_GRAY);
    } else {
      addSeg(text.slice(ls, le), PENDING_GRAY);
    }
  });
}
// Chrome 内蔵 Prompt API（Gemini Nano・オンデバイス）。Node では使えずブラウザ専用。型は最小限で定義する。
interface NanoPromptSession { prompt: (input: string) => Promise<string>; destroy?: () => void; }
interface NanoPromptMonitor { addEventListener: (type: string, cb: (e: { loaded?: number; total?: number }) => void) => void; }
interface NanoLanguageModel {
  availability: () => Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create: (opts: { initialPrompts?: { role: string; content: string }[]; monitor?: (m: NanoPromptMonitor) => void }) => Promise<NanoPromptSession>;
}
const getNanoLanguageModel = (): NanoLanguageModel | null => {
  if (typeof self === 'undefined') return null;
  const w = self as unknown as { LanguageModel?: NanoLanguageModel; ai?: { languageModel?: NanoLanguageModel } };
  return w.LanguageModel || w.ai?.languageModel || null;
};
// AI編集の校正用システムプロンプト（サーバの /api/rewrite と同一。OpenAI/Nano 双方で使う）
const buildRewriteSystemPrompt = (prompt: string): string => `あなたは日本語文章の校正アシスタントです。以下の文章を校正してください。

校正のルール:
1. 誤字脱字を修正
2. 句読点を適切に整理
3. 明らかに誤った専門用語があれば補完・修正
4. 文の意味や内容は変更しない
5. 原文の文体やトーンを維持

${prompt ? `追加の指示: ${prompt}` : ''}

修正した文章のみを出力してください。説明は不要です。`;

// All yjs-related modules are dynamically imported to avoid SSR localStorage issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YDocType = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HocuspocusProviderType = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CollaborationType = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CollaborationCursorType = any;

// User colors for collaboration
const userColors = [
  '#958DF1', '#F98181', '#FBBC88', '#FAF594', '#70CFF8',
  '#94FADB', '#B9F18D', '#C3E2C2', '#EAECCC', '#AFC8AD',
];

// Default user info for SSR
const defaultUserInfo = { name: 'Anonymous', color: userColors[0] };

interface CollaborativeEditorV2Props {
  sessionId: string;
}

// Change history entry type
interface ChangeEntry {
  id: string;
  userName: string;
  userColor: string;
  action: 'insert' | 'delete' | 'modify';
  content: string;
  timestamp: Date;
}

// Connected user type
interface ConnectedUser {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
}

export default function CollaborativeEditorV2({ sessionId }: CollaborativeEditorV2Props) {
  // Mounted state to prevent any SSR execution
  const [mounted, setMounted] = useState(false);

  // Use refs to prevent React Strict Mode from creating duplicates
  const ydocRef = useRef<YDocType | null>(null);
  const providerRef = useRef<HocuspocusProviderType | null>(null);
  const initializedRef = useRef(false);

  const [provider, setProvider] = useState<HocuspocusProviderType | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [userCount, setUserCount] = useState(1);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [pendingText, setPendingText] = useState(''); // Recognition in progress text
  const [protectedTailParas, setProtectedTailParas] = useState(0); // AI再補正で上書きされる末尾段落数（編集禁止＋青字）
  const [changeHistory, setChangeHistory] = useState<ChangeEntry[]>([]);
  const [showHistory, setShowHistory] = useState(true);
  const lastContentRef = useRef<string>('');
  const [connectedUsers, setConnectedUsers] = useState<ConnectedUser[]>([]);
  const userIdRef = useRef<string | null>(null);

  // AI Rewrite states
  const [isRewriting, setIsRewriting] = useState(false);
  const [showRewriteModal, setShowRewriteModal] = useState(false);
  const [rewriteModalPhase, setRewriteModalPhase] = useState<'selection' | 'result'>('selection');
  const [selectedTextForRewrite, setSelectedTextForRewrite] = useState('');
  const [rewriteResult, setRewriteResult] = useState<{ original: string; rewritten: string } | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  // AI編集のエンジン: 'openai'（サーバ経由）or 'nano'（ブラウザのGemini Nano・オンデバイス）。localStorageに保存
  const [rewriteEngine, setRewriteEngine] = useState<'openai' | 'nano'>(() => {
    if (typeof window === 'undefined') return 'openai';
    try { return window.localStorage.getItem('collarecox-rewrite-engine') === 'nano' ? 'nano' : 'openai'; } catch { return 'openai'; }
  });
  const selectRewriteEngine = (engine: 'openai' | 'nano') => {
    setRewriteEngine(engine);
    try { window.localStorage.setItem('collarecox-rewrite-engine', engine); } catch { /* localStorage不可時は無視 */ }
  };

  // Markdown Edit states
  const [showMarkdownModal, setShowMarkdownModal] = useState(false);
  const [markdownText, setMarkdownText] = useState('');

  // Force Commit state
  const [isForceCommitPending, setIsForceCommitPending] = useState(false);

  // 閲覧(リードオンリー)モード: URLクエリ ?mode=view のときだけ編集不可。
  // 既定（mode=edit または未指定）は編集可。共有用の閲覧リンクを想定し、UIトグル・localStorage保存はしない。
  const [isReadOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('mode') === 'view';
  });

  // Keyboard Shortcuts state
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);

  // AI Rewrite - 定義済みテンプレート
  const promptTemplates = [
    { label: '見出し追加', prompt: 'パラグラフごとに内容に応じた見出しを追加する' },
    { label: 'パラグラフ分割', prompt: '内容をもとにしてパラグラフに分割する' },
    { label: '文の結合', prompt: '文が不要な句読点でとぎれている場合、それを結合して1文にする' },
    { label: '誤字脱字修正', prompt: '誤字脱字を修正する' },
    { label: '句読点整理', prompt: '句読点を適切な位置に配置し直す' },
    { label: '敬語に変換', prompt: '文章を敬語（です・ます調）に変換する' },
    { label: '箇条書き化', prompt: '内容を箇条書きに変換する' },
    { label: '要約', prompt: '内容を簡潔に要約する' },
    { label: 'URL→リンク', prompt: 'URLらしい文字列をMarkdownのリンク形式[テキスト](URL)に変換する' },
  ];

  // Edit highlighting state
  const [highlightEdits, setHighlightEdits] = useState(true);
  const highlightEditsRef = useRef(highlightEdits);
  highlightEditsRef.current = highlightEdits;

  // Font size state (prose-xs, prose-sm, prose-base, prose-lg)
  const [fontSize, setFontSize] = useState<'xs' | 'sm' | 'base' | 'lg'>('sm');

  // User info state (initialized with default, updated on client side)
  const [userInfo, setUserInfo] = useState(defaultUserInfo);
  const userInfoRef = useRef(userInfo);
  userInfoRef.current = userInfo;
  const [isEditingUserName, setIsEditingUserName] = useState(false);
  const [userNameInput, setUserNameInput] = useState('');

  // Dynamically loaded Collaboration extensions
  const [CollaborationExtension, setCollaborationExtension] = useState<CollaborationType | null>(null);
  const [CollaborationCursorExtension, setCollaborationCursorExtension] = useState<CollaborationCursorType | null>(null);
  const [modulesLoaded, setModulesLoaded] = useState(false);

  // Set mounted state to prevent SSR execution
  useEffect(() => {
    setMounted(true);
  }, []);

  // 校正に参加した配信として履歴に記録（ホームの「最近のセッション」に出る）。
  useEffect(() => {
    if (sessionId) addRecentSession(sessionId, 'guest');
  }, [sessionId]);

  // Load user info from localStorage on client side only
  useEffect(() => {
    if (!mounted) return;
    let userId = localStorage.getItem('editor-user-id');
    let userName = localStorage.getItem('editor-user-name');

    if (!userId) {
      // Generate unique user ID with timestamp for better uniqueness
      userId = `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('editor-user-id', userId);
    }
    if (!userName) {
      userName = `User ${Math.floor(Math.random() * 1000)}`;
      localStorage.setItem('editor-user-name', userName);
    }

    // Store userId in ref for use in Yjs user registration
    userIdRef.current = userId;

    const colorIndex = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % userColors.length;
    setUserInfo({ name: userName, color: userColors[colorIndex] });

    // プロンプト履歴を読み込み
    const savedHistory = localStorage.getItem('ai-rewrite-prompt-history');
    if (savedHistory) {
      try {
        const parsed = JSON.parse(savedHistory);
        if (Array.isArray(parsed)) {
          setPromptHistory(parsed.slice(0, 10)); // 最大10件
        }
      } catch (e) {
        console.error('Failed to parse prompt history:', e);
      }
    }
  }, [mounted]);

  // Initialize Y.Doc and load Collaboration extensions - dynamically import to avoid SSR localStorage issues
  useEffect(() => {
    if (!mounted || modulesLoaded) return;

    Promise.all([
      import('yjs'),
      import('@tiptap/extension-collaboration'),
      import('@tiptap/extension-collaboration-cursor'),
    ]).then(([Y, CollabModule, CollabCursorModule]) => {
      if (!ydocRef.current) {
        ydocRef.current = new Y.Doc();
        console.log('[Collaborative Editor V2] 📄 Created new Y.Doc for session:', sessionId);
      }
      setCollaborationExtension(() => CollabModule.default);
      setCollaborationCursorExtension(() => CollabCursorModule.default);
      setModulesLoaded(true);
      console.log('[Collaborative Editor V2] ✅ All yjs modules loaded dynamically');
    }).catch((error) => {
      console.error('[Collaborative Editor V2] ❌ Failed to load yjs modules:', error);
    });
  }, [mounted, sessionId, modulesLoaded]);

  // Initialize Hocuspocus provider with dynamic import (wait for modules to load first)
  useEffect(() => {
    // Wait for modules to load first
    if (!modulesLoaded || !ydocRef.current) {
      return;
    }

    // Prevent duplicate initialization in React Strict Mode
    if (initializedRef.current) {
      console.log('[Collaborative Editor V2] ⚠️ Skipping duplicate initialization');
      return;
    }

    initializedRef.current = true;
    console.log('[Collaborative Editor V2] 🚀 Initializing for session:', sessionId);

    // Dynamic import to avoid SSR localStorage issues
    import('@hocuspocus/provider').then(({ HocuspocusProvider }) => {
      if (!ydocRef.current) return;

      // Use the current hostname and port, automatically detecting protocol
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = typeof window !== 'undefined' ? window.location.host : 'localhost:8888';
      const websocketUrl = `${protocol}//${host}${getBasePath()}/api/yjs-ws`;
      const roomName = `transcribe-editor-v2-${sessionId}`;

      console.log('[Collaborative Editor V2] 🔗 Connecting to:', websocketUrl, 'Room:', roomName);

      const hocusProvider = new HocuspocusProvider({
        url: websocketUrl,
        name: roomName,
        document: ydocRef.current,
      });

      providerRef.current = hocusProvider;

      hocusProvider.on('status', (event: { status: string }) => {
        console.log('[Hocuspocus Provider V2] Status:', event.status);
        setIsConnected(event.status === 'connected');
      });

      hocusProvider.on('connect', () => {
        console.log('[Hocuspocus Provider V2] Connected');
        setIsConnected(true);
      });

      hocusProvider.on('disconnect', (event: unknown) => {
        console.log('[Hocuspocus Provider V2] Disconnected:', event);
        setIsConnected(false);
      });

      hocusProvider.on('close', (event: unknown) => {
        console.error('[Hocuspocus Provider V2] Connection closed:', event);
      });

      hocusProvider.on('error', (event: unknown) => {
        console.error('[Hocuspocus Provider V2] Error:', event);
      });

      // Track user count
      hocusProvider.awareness?.on('change', () => {
        const count = hocusProvider.awareness?.getStates().size || 1;
        console.log('[Awareness V2] User count changed:', count);
        setUserCount(count);
      });

      // 初期同期完了時に音声追記seqの基準値を現在値へ合わせる。
      // これをしないと、接続前にサーバ側で進んでいたseq（過去の音声追記分）を
      // 接続後の最初の編集で誤って消費してしまう。接続後に進んだ分だけが
      // 下線・履歴の除外対象になるよう、両方のlastSeenをここで初期化する。
      hocusProvider.on('synced', () => {
        try {
          const seq = ydocRef.current?.getMap(`status-${sessionId}`)?.get('speechAppendSeq');
          if (typeof seq === 'number') {
            speechSeqUnderlineRef.current = seq;
            speechSeqHistoryRef.current = seq;
            console.log('[EditTracker] 🔢 speechAppendSeq baseline initialized:', seq);
          }
        } catch (e) {
          console.warn('[EditTracker] ⚠️ Failed to init speechAppendSeq baseline:', e);
        }
      });

      setProvider(hocusProvider);
    }).catch((error) => {
      console.error('[Collaborative Editor V2] Failed to load HocuspocusProvider:', error);
    });

    return () => {
      console.log('[Collaborative Editor V2] 🧹 Cleaning up Hocuspocus provider');
      if (providerRef.current) {
        try {
          providerRef.current.disconnect();
          providerRef.current.destroy();
        } catch (error) {
          console.error('[Collaborative Editor V2] ❌ Error during cleanup:', error);
        }
        providerRef.current = null;
      }
      setProvider(null);
      setIsConnected(false);
      initializedRef.current = false;
    };
  }, [mounted, sessionId, modulesLoaded]);

  // Create editor with collaboration and cursor sharing (only when modules are loaded)
  // ===== 音声追記の判定 =====
  // サーバは音声由来の本文変更（確定テキスト追記・段落区切り）のたびに、その変更と
  // 同一Yjsトランザクションで status-map の speechAppendSeq を +1 する。
  // リモート変更の処理時に未消費のseq増分が残っていれば、その変更は音声認識からの
  // 自動追記と確定でき、下線・変更履歴の対象から除外する。
  //
  // 重要: 1回の発話でサーバが追記と段落区切りを連続して呼ぶとseqが+2以上進み、
  // editor側には複数のリモートtrが届く。そのため「seqが変わったか」ではなく
  // 「未消費の増分を1つずつ消費する」方式にする（変化検知方式だと2つ目以降の
  // リモートtrがすり抜けて下線が付いてしまう）。
  // （下線用と履歴用は処理タイミングが別のため、最後に見たseqを個別に持つ）
  const speechSeqUnderlineRef = useRef<number>(-1);
  const speechSeqHistoryRef = useRef<number>(-1);

  // 認識中（pending）インライン表示のspan要素（使い回してちらつきを防ぐ）
  const pendingSpanRef = useRef<HTMLSpanElement | null>(null);
  const pendingBreaksRef = useRef<number[]>([]); // 未確定テキストの改行オフセット（そとづけ区切り情報）
  const pendingGreenLenRef = useRef<number>(0); // 緑(AI校正待ち)で表示する先頭文字数。以降はグレー(interim)
  const pendingWrapRef = useRef<{ font: string; availWidth: number } | null>(null); // 緑の実幅折返し用（描画幅・フォント）

  // 本文スクロール領域: 自動追従スクロール＋手動操作時の停止＋▼ボタンで復帰
  const editorScrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef<boolean>(true); // 自動追従モード（最下部に追従するか）
  const lastScrollHeightRef = useRef<number>(0); // 直前のscrollHeight（内容が増えたかの判定用）
  const [showScrollDown, setShowScrollDown] = useState(false); // ▼（最新へ移動）ボタンの表示
  const consumeSpeechAppendSeq = (lastSeenRef: { current: number }): boolean => {
    try {
      const seq = ydocRef.current?.getMap(`status-${sessionId}`)?.get('speechAppendSeq') as number | undefined;
      if (typeof seq !== 'number') return false;
      // 初回（-1）はその時点のseqに同期するだけ（過去分を消費対象にしない）
      if (lastSeenRef.current < 0) {
        lastSeenRef.current = seq;
        return false;
      }
      // 未消費の増分が残っていれば1つだけ消費して音声追記と判定する
      if (seq > lastSeenRef.current) {
        lastSeenRef.current += 1;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const editor = useEditor({
    immediatelyRender: false, // SSR compatibility
    extensions: [
      StarterKit.configure({
        history: false, // Disable history for collaboration
      }),
      // Add Highlight extension for edit tracking
      Highlight.configure({
        multicolor: true,
      }),
      // UserUnderline - スキーマ互換のため残す（視覚効果なし）
      UserUnderline,
      // 編集追跡: ProseMirror Decorationで下線を表示（Yjsドキュメントを汚さない）
      Extension.create({
        name: 'editTracker',
        addProseMirrorPlugins() {
          return [
            new Plugin({
              key: editTrackKey,
              state: {
                init: () => DecorationSet.empty,
                apply(tr, decorationSet, _oldState, newState) {
                  // ドキュメント変更なし → そのまま
                  if (!tr.docChanged) return decorationSet;

                  // 既存のDecorationを位置マッピング
                  decorationSet = decorationSet.map(tr.mapping, tr.doc);

                  // リモート変更（Yjs同期）かローカル変更かを判定する。
                  // y-prosemirrorはリモート由来（音声認識のサーバ追記を含む全Yjs同期）の
                  // トランザクションに ySyncPluginKey メタの isChangeOrigin=true を付ける。
                  // これがリモート判定の一次情報。以前使っていた addToHistory===false は
                  // 履歴管理用フラグで、リモート/ローカルと必ずしも一致せず誤判定の原因だった。
                  const ySyncMeta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
                  const isRemote = ySyncMeta?.isChangeOrigin === true
                    || tr.getMeta('addToHistory') === false;

                  // 音声追記seqの消費判定は下線表示ON/OFFに関わらず先に行う
                  // （OFF中にseqが溜まると、ON復帰後の判定がズレるため）
                  const isSpeechAppend = isRemote && consumeSpeechAppendSeq(speechSeqUnderlineRef);

                  // 下線表示がOFFなら新しいDecorationを追加しない（mapping済みで返す）
                  if (!highlightEditsRef.current) return decorationSet;

                  // 音声認識からの自動追記は「変更」として扱わない（下線を付けない）
                  if (isSpeechAppend) return decorationSet;

                  // 下線色: ローカル=自分の色、リモート=青
                  const underlineColor = isRemote ? '#3b82f6' : userInfoRef.current.color;
                  const underlineStyle = `text-decoration: underline; text-decoration-color: ${underlineColor}; text-decoration-thickness: 2px; text-underline-offset: 2px;`;

                  const newDecos: Decoration[] = [];
                  if (isRemote) {
                    // 重要: y-prosemirrorはリモート変更を「文書全体を置き換える単一ReplaceStep」
                    // として適用するため、stepのmappingを見ると常に文書全体が変更範囲になって
                    // しまう（seq除外をすり抜けたリモートtrが1件あるだけで全文に下線が付き、
                    // その下線は以後の追記でも拡大し続ける）。
                    // そのため実際の差分（findDiffStart/findDiffEnd）から下線範囲を求める。
                    // 同一内容の全文再描画（エディタ初期化の_forceRerender等）は差分なし＝何も塗らない
                    const diffStart = tr.before.content.findDiffStart(tr.doc.content);
                    if (diffStart !== null) {
                      const diffEnd = tr.before.content.findDiffEnd(tr.doc.content);
                      if (diffEnd && diffEnd.b > diffStart && diffEnd.b <= newState.doc.content.size) {
                        newDecos.push(Decoration.inline(diffStart, diffEnd.b, { style: underlineStyle }));
                      }
                    }
                  } else {
                    // ローカル編集はProseMirrorのstepが実変更範囲を正しく表すのでmappingから取る
                    tr.steps.forEach((_step, i) => {
                      const map = tr.mapping.maps[i];
                      map.forEach((_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => {
                        if (newEnd > newStart && newEnd <= newState.doc.content.size) {
                          newDecos.push(Decoration.inline(newStart, newEnd, { style: underlineStyle }));
                        }
                      });
                    });
                  }

                  if (newDecos.length > 0) {
                    decorationSet = decorationSet.add(tr.doc, newDecos);
                  }
                  return decorationSet;
                },
              },
              props: {
                decorations(state) {
                  // 下線表示がOFFなら何も描画しない
                  if (!highlightEditsRef.current) return DecorationSet.empty;
                  return editTrackKey.getState(state);
                },
              },
            }),
          ];
        },
      }),
      // 認識中（pending）テキストを確定テキストの直後にインライン表示するDecoration
      Extension.create({
        name: 'pendingTextInline',
        addProseMirrorPlugins() {
          return [
            new Plugin({
              key: pendingTextKey,
              state: {
                init: () => '',
                apply(tr, prev) {
                  const meta = tr.getMeta(pendingTextKey);
                  return meta !== undefined ? (meta as string) : prev;
                },
              },
              props: {
                decorations(state) {
                  const text = pendingTextKey.getState(state) as string;
                  if (!text) return DecorationSet.empty;
                  const doc = state.doc;
                  // 最終ブロックが段落等のテキストブロックなら、その末尾の内側（=確定テキストの直後）に置く
                  let pos = doc.content.size;
                  if (doc.lastChild && doc.lastChild.isTextblock) {
                    pos = doc.content.size - 1;
                  }
                  // 最終ブロックに確定テキストがあるなら、緑の冒頭を行頭に揃えるため先頭で改行する
                  const lastChild = doc.lastChild;
                  const breakBeforeFirst = !!(lastChild && lastChild.isTextblock && lastChild.textContent.trim().length > 0);
                  // キーを固定し、span要素を使い回す。テキストの更新はuseEffect側で
                  // 同じ要素のtextContentを直接書き換える（キーにテキストを含めると
                  // 追記のたびにウィジェットDOMが再生成され、表示がちらつくため）
                  const widget = Decoration.widget(pos, () => {
                    if (!pendingSpanRef.current) {
                      const span = document.createElement('span');
                      span.setAttribute('data-pending-inline', 'true');
                      span.style.color = '#9ca3af';
                      pendingSpanRef.current = span;
                    }
                    renderPendingSpan(pendingSpanRef.current, text, pendingBreaksRef.current, pendingGreenLenRef.current, breakBeforeFirst, pendingWrapRef.current);
                    return pendingSpanRef.current;
                  }, { side: 1, key: 'pending-inline' });
                  return DecorationSet.create(doc, [widget]);
                },
              },
            }),
          ];
        },
      }),
      // AI再補正で上書きされる末尾領域: 青字＋人による編集(追加/変更/削除)を禁止。
      // 緑(AI待ち)は別Decorationで、ここは確定黒のうち再補正窓に入る段落のみが対象。
      Extension.create({
        name: 'protectedTail',
        addProseMirrorPlugins() {
          // 末尾から n 個のトップレベルブロックの開始位置（doc座標）
          const protectedStart = (doc: { childCount: number; child: (i: number) => { nodeSize: number } }, n: number): number => {
            const startIdx = Math.max(0, doc.childCount - n);
            let pos = 0;
            for (let i = 0; i < startIdx; i++) pos += doc.child(i).nodeSize;
            return pos;
          };
          return [
            new Plugin({
              key: protectedTailKey,
              state: {
                init: () => 0,
                apply(tr, prev) {
                  const meta = tr.getMeta(protectedTailKey);
                  return typeof meta === 'number' ? meta : prev;
                },
              },
              // 保護領域への「人による」編集を禁止。リモート(Yjs同期=音声追記/AI再補正)は許可する。
              filterTransaction(tr, state) {
                if (!tr.docChanged) return true;
                const ySyncMeta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
                if (ySyncMeta?.isChangeOrigin === true || tr.getMeta('addToHistory') === false) return true;
                const n = (protectedTailKey.getState(state) as number) || 0;
                if (n <= 0) return true;
                const from = protectedStart(state.doc, n);
                let blocked = false;
                tr.steps.forEach((step) => {
                  step.getMap().forEach((oldStart: number, oldEnd: number) => {
                    if (oldEnd >= from) blocked = true;
                  });
                });
                return !blocked;
              },
              props: {
                decorations(state) {
                  const n = (protectedTailKey.getState(state) as number) || 0;
                  if (n <= 0) return DecorationSet.empty;
                  const doc = state.doc;
                  const total = doc.childCount;
                  const startIdx = Math.max(0, total - n);
                  const decos: Decoration[] = [];
                  let pos = 0;
                  for (let i = 0; i < total; i++) {
                    const node = doc.child(i);
                    if (i >= startIdx) {
                      decos.push(Decoration.node(pos, pos + node.nodeSize, {
                        style: 'color:#2563eb',
                        title: 'AI再補正中のため編集できません',
                      }));
                    }
                    pos += node.nodeSize;
                  }
                  return DecorationSet.create(doc, decos);
                },
              },
            }),
          ];
        },
      }),
      // Add Link extension for handling links
      Link.configure({
        openOnClick: true,
        autolink: true,
        HTMLAttributes: {
          class: 'text-celadon underline hover:text-celadon-active',
        },
      }),
      // Add Collaboration when extension is loaded
      ...(CollaborationExtension && ydocRef.current ? [CollaborationExtension.configure({
        document: ydocRef.current,
        field: `content-${sessionId}`, // Use session-specific field name
      })] : []),
      // Add CollaborationCursor when provider is ready and extension is loaded
      ...(CollaborationCursorExtension && provider ? [CollaborationCursorExtension.configure({
        provider: provider,
        user: {
          name: userInfo.name,
          color: userInfo.color,
        },
      })] : []),
    ],
    content: `
      <h2>共同校正画面</h2>
      <p>この画面では複数の人が同時に文書を校正できます。</p>
      <p>リアルタイム文字起こしの結果がここに表示され、みんなで校正できます。</p>
    `,
    editorProps: {
      attributes: {
        class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl mx-auto focus:outline-none min-h-[500px] p-4',
      },
      // handleTextInput は使わない - 編集追跡はDecoration Pluginが担当
    },
    onCreate: ({ editor }) => {
      // Yjs同期後に古いuserUnderlineマークをクリーンアップ
      // （以前のバグで広範囲に適用されたマークがYjsドキュメントに残っている）
      setTimeout(() => {
        try {
          const { state } = editor;
          const markType = state.schema.marks.userUnderline;
          if (markType) {
            const tr = state.tr.removeMark(0, state.doc.content.size, markType);
            if (tr.docChanged) {
              editor.view.dispatch(tr);
              console.log('[EditTracker] 🧹 Cleaned up old userUnderline marks');
            }
          }
        } catch (e) {
          console.warn('[EditTracker] ⚠️ Mark cleanup failed:', e);
        }
      }, 3000); // Yjs同期完了を待つ
    },
    onUpdate: ({ editor, transaction }) => {
      const currentContent = editor.getText();

      // 音声認識からの自動追記は変更履歴に残さない
      // （比較基準だけ進めて、次の人の編集の差分計算に音声分が混ざらないようにする）
      if (transaction.getMeta('addToHistory') === false && consumeSpeechAppendSeq(speechSeqHistoryRef)) {
        lastContentRef.current = currentContent;
        return;
      }

      const previousContent = lastContentRef.current;

      if (currentContent !== previousContent) {
        // Determine action type based on content length difference
        let action: 'insert' | 'delete' | 'modify' = 'modify';
        let content = '';

        if (currentContent.length > previousContent.length) {
          action = 'insert';
          const diffLength = currentContent.length - previousContent.length;
          const preview = extractDiffPreview(previousContent, currentContent, diffLength);
          content = preview ? `"${preview}" (+${diffLength}文字)` : `+${diffLength}文字`;
        } else if (currentContent.length < previousContent.length) {
          action = 'delete';
          const diffLength = previousContent.length - currentContent.length;
          const preview = extractDiffPreview(currentContent, previousContent, diffLength);
          content = preview ? `"${preview}" (-${diffLength}文字)` : `-${diffLength}文字`;
        } else {
          content = '内容を変更';
        }

        // Add to history (only for local changes)
        const newEntry: ChangeEntry = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          userName: userInfo.name,
          userColor: userInfo.color,
          action,
          content,
          timestamp: new Date(),
        };

        setChangeHistory(prev => [newEntry, ...prev].slice(0, 50)); // Keep last 50 entries
        lastContentRef.current = currentContent;
      }
    },
  }, [provider, userInfo, CollaborationExtension, CollaborationCursorExtension, modulesLoaded, sessionId]);


  // 注: 以前はリモート変更のたびにエディタ全体を光らせる演出（remote-change-flash）が
  // あったが、音声認識の未確定テキスト（pendingText）が200ms間隔で更新されるように
  // なったことで画面全体が常時点滅する問題が発生したため撤去した。
  // リモート編集の可視化は編集追跡の下線（editTracker Decoration）が担う。

  // Transcription status listener - needs provider to ensure ydocRef is set
  useEffect(() => {
    if (!ydocRef.current || !provider) return;

    try {
      const statusMapName = `status-${sessionId}`;
      const statusMap = ydocRef.current.getMap(statusMapName);

      const onStatusChange = () => {
        const transcribing = statusMap.get('isTranscribing') as boolean;
        setIsTranscribing(transcribing || false);
        console.log('[Collaborative Editor V2] 📊 Transcription status:', transcribing);

        // Also update pending text for recognition in progress display
        // そとづけの区切り情報（改行オフセット）も取り込み、未確定表示を改行する
        const pBreaks = statusMap.get('pendingBreaks');
        pendingBreaksRef.current = Array.isArray(pBreaks) ? (pBreaks as number[]) : [];
        const pGreen = statusMap.get('pendingGreenLen');
        pendingGreenLenRef.current = typeof pGreen === 'number' ? pGreen : 0;
        const pending = statusMap.get('pendingText') as string;
        setPendingText(pending || '');
        if (pending) {
          console.log('[Collaborative Editor V2] 🔤 Pending text:', pending);
        }
        // AI再補正で上書きされる末尾段落数（編集禁止＋青字の範囲）
        const pTail = statusMap.get('proofreadTailParas');
        setProtectedTailParas(typeof pTail === 'number' ? pTail : 0);
      };

      // Initial check
      onStatusChange();

      statusMap.observe(onStatusChange);

      return () => {
        try {
          statusMap.unobserve(onStatusChange);
        } catch (error) {
          console.warn('[Collaborative Editor V2] ⚠️ Error during status unobserve:', error);
        }
      };
    } catch (error) {
      console.error('[Collaborative Editor V2] ❌ Error setting up status listener:', error);
    }
  }, [sessionId, provider]);

  // 認識中（pending）テキストの変化をDecorationに反映する
  // （メタ情報付きの空トランザクションを発行してdecorationsを再計算させる）
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    try {
      // ウィジェットのDOM要素は使い回しているため、テキストは直接書き換える（ちらつき防止）。
      // Decorationのキーが固定でもこの書き換えで表示は即時更新される
      if (pendingSpanRef.current) {
        // 直前に確定テキストがあれば緑の冒頭を行頭から始める（描画の都度、現在のdocから判定）
        const lastChild = editor.state.doc.lastChild;
        const breakBeforeFirst = !!(lastChild && lastChild.isTextblock && lastChild.textContent.trim().length > 0);
        // 本文の実描画幅とフォントを測定して緑を「見た目の1行ぴったり」で折り返す。widget側でも使えるようrefへ保存。
        let wrap: { font: string; availWidth: number } | null = null;
        try {
          const dom = editor.view.dom as HTMLElement;
          const cs = getComputedStyle(dom);
          const availWidth = dom.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
          wrap = { font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, availWidth };
        } catch { wrap = null; }
        pendingWrapRef.current = wrap;
        renderPendingSpan(pendingSpanRef.current, pendingText, pendingBreaksRef.current, pendingGreenLenRef.current, breakBeforeFirst, wrap);
      }
      editor.view.dispatch(editor.state.tr.setMeta(pendingTextKey, pendingText));
    } catch (error) {
      console.warn('[Collaborative Editor V2] ⚠️ Error updating pending decoration:', error);
    }
  }, [editor, pendingText]);

  // AI再補正で上書きされる末尾段落数を Decoration/filterTransaction へ反映する（青字＋編集禁止）
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    try { editor.view.dispatch(editor.state.tr.setMeta(protectedTailKey, protectedTailParas)); }
    catch (e) { console.warn('[Collaborative Editor V2] ⚠️ protectedTail update error:', e); }
  }, [editor, protectedTailParas]);

  // 閲覧(リードオンリー)モード: Tiptapを編集不可にする。音声追記などのリモート更新は引き続き反映される。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!isReadOnly);
  }, [editor, isReadOnly]);

  // ===== 本文スクロール領域の自動追従 =====
  // 最下部へスクロールし、自動追従モードに戻す
  const scrollToBottom = useCallback(() => {
    const el = editorScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    autoScrollRef.current = true;
    lastScrollHeightRef.current = el.scrollHeight;
    setShowScrollDown(false);
  }, []);

  // 内容増加時: 自動追従中なら最下部へ、停止中なら▼ボタンを出す
  const handleContentGrow = useCallback(() => {
    const el = editorScrollRef.current;
    if (!el) return;
    const grew = el.scrollHeight > lastScrollHeightRef.current + 1;
    if (autoScrollRef.current) {
      // DOM反映後に確実に最下部へ
      requestAnimationFrame(() => {
        const e2 = editorScrollRef.current;
        if (e2) { e2.scrollTop = e2.scrollHeight; lastScrollHeightRef.current = e2.scrollHeight; }
      });
      setShowScrollDown(false);
    } else {
      lastScrollHeightRef.current = el.scrollHeight;
      if (grew) setShowScrollDown(true); // 停止中に末尾が伸びた → ▼を表示
    }
  }, []);

  // エディタ更新（リモート追記・ローカル編集・pending反映）で内容増加を検知
  useEffect(() => {
    if (!editor) return;
    editor.on('update', handleContentGrow);
    return () => { editor.off('update', handleContentGrow); };
  }, [editor, handleContentGrow]);

  // pending（緑/グレー）の更新でも追従
  useEffect(() => { handleContentGrow(); }, [pendingText, handleContentGrow]);

  // スクロール操作: 最下部なら自動追従ON、上方向にスクロールしたらOFF
  const onEditorScroll = useCallback(() => {
    const el = editorScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) { autoScrollRef.current = true; setShowScrollDown(false); }
    else { autoScrollRef.current = false; }
  }, []);

  // 本文クリック（フォーカスがはずれたモード）で自動追従を停止
  const onEditorMouseDown = useCallback(() => { autoScrollRef.current = false; }, []);

  // User registration in Yjs - register/unregister user in the shared users map
  useEffect(() => {
    if (!ydocRef.current || !provider || !isConnected || !userIdRef.current) return;

    const userId = userIdRef.current;
    const usersMapName = `users-${sessionId}`;

    try {
      const usersMap = ydocRef.current.getMap(usersMapName);

      // Register this user to the shared users map
      const userEntry: ConnectedUser = {
        id: userId,
        name: userInfo.name,
        color: userInfo.color,
        joinedAt: Date.now(),
      };
      usersMap.set(userId, userEntry);
      console.log('[Collaborative Editor V2] 👤 User registered:', userId, userInfo.name);

      // Listen for changes to the users map
      const onUsersChange = () => {
        const users: ConnectedUser[] = [];
        usersMap.forEach((value: unknown) => {
          if (value && typeof value === 'object') {
            users.push(value as ConnectedUser);
          }
        });
        // Sort by join time
        users.sort((a, b) => a.joinedAt - b.joinedAt);
        setConnectedUsers(users);
        console.log('[Collaborative Editor V2] 👥 Connected users updated:', users.length, users.map(u => u.name));
      };

      // Initial load
      onUsersChange();

      usersMap.observe(onUsersChange);

      // Cleanup: remove user when disconnecting
      return () => {
        try {
          usersMap.delete(userId);
          console.log('[Collaborative Editor V2] 👤 User unregistered:', userId);
          usersMap.unobserve(onUsersChange);
        } catch (error) {
          console.warn('[Collaborative Editor V2] ⚠️ Error during user cleanup:', error);
        }
      };
    } catch (error) {
      console.error('[Collaborative Editor V2] ❌ Error setting up user registration:', error);
    }
  }, [sessionId, provider, isConnected, userInfo]);

  // User name editing functions
  const startEditingUserName = () => {
    setUserNameInput(userInfo.name);
    setIsEditingUserName(true);
  };

  const saveUserName = () => {
    const trimmedName = userNameInput.trim();
    if (trimmedName && trimmedName !== userInfo.name) {
      localStorage.setItem('editor-user-name', trimmedName);
      setUserInfo(prev => ({ ...prev, name: trimmedName }));
      // Update Yjs user map
      if (ydocRef.current && userIdRef.current) {
        const usersMap = ydocRef.current.getMap(`users-${sessionId}`);
        usersMap.set(userIdRef.current, {
          id: userIdRef.current,
          name: trimmedName,
          color: userInfo.color,
          lastSeen: Date.now()
        });
      }
    }
    setIsEditingUserName(false);
  };

  const cancelEditUserName = () => {
    setIsEditingUserName(false);
  };

  // HTML→Markdown変換
  const htmlToMarkdown = (html: string): string => {
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    return turndownService.turndown(html);
  };

  // Markdown→HTML変換
  const markdownToHtml = (markdown: string): string => {
    // markedの設定: GFM有効、改行をbrに変換
    const html = marked.parse(markdown, {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    // 末尾の余分な改行を削除
    return html.trim();
  };

  // 選択範囲のHTMLを取得
  const getSelectedHtml = (): string => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    const slice = editor.state.doc.slice(from, to);
    const serializer = DOMSerializer.fromSchema(editor.schema);
    const fragment = serializer.serializeFragment(slice.content);
    const div = document.createElement('div');
    div.appendChild(fragment);
    return div.innerHTML;
  };

  // AI Rewrite - モーダルを開く
  const handleRewrite = () => {
    if (!editor || isReadOnly) return;

    // 選択されたテキストを取得
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');

    if (!selectedText.trim()) {
      alert('テキストを選択してAI編集の範囲を指定してください');
      return;
    }

    // 選択範囲のHTMLを取得してMarkdownに変換
    const selectedHtml = getSelectedHtml();
    const markdown = htmlToMarkdown(selectedHtml);

    // モーダルを開く（選択フェーズ）
    setSelectedTextForRewrite(markdown);
    setRewriteModalPhase('selection');
    setRewriteResult(null);
    setShowRewriteModal(true);
  };

  // Gemini Nano（ブラウザのオンデバイスLLM）でAI編集を実行する。Nodeは関与せず外部送信なし。
  const rewriteWithNano = async (text: string, prompt: string): Promise<string> => {
    const LM = getNanoLanguageModel();
    if (!LM) throw new Error('このブラウザはオンデバイスAI(Gemini Nano)に未対応です。Chrome 138+ と chrome://flags の prompt-api 有効化を確認してください');
    const avail = await LM.availability();
    if (avail === 'unavailable') throw new Error('Gemini Nano が利用できません（フラグ未設定・非対応環境・ディスク不足など）');
    const session = await LM.create({
      initialPrompts: [{ role: 'system', content: buildRewriteSystemPrompt(prompt) }],
    });
    try {
      const out = await session.prompt(text);
      return out || text;
    } finally {
      session.destroy?.();
    }
  };

  // AI Rewrite - 実行（エンジンに応じて OpenAI(サーバ) か Gemini Nano(オンデバイス) を使う）
  const executeRewrite = async () => {
    if (!editor || isRewriting || !selectedTextForRewrite.trim()) return;

    // プロンプトは必須
    if (!customPrompt.trim()) {
      alert('編集プロンプトを入力してください');
      return;
    }

    setIsRewriting(true);
    try {
      let rewritten: string;
      if (rewriteEngine === 'nano') {
        // ブラウザ内のGemini Nanoで処理
        rewritten = await rewriteWithNano(selectedTextForRewrite, customPrompt);
      } else {
        // 従来どおりサーバ(OpenAI)で処理
        const response = await fetch(`${getBasePath()}/api/rewrite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: selectedTextForRewrite, prompt: customPrompt }),
        });
        if (!response.ok) {
          throw new Error('Rewrite failed');
        }
        const data = await response.json();
        rewritten = data.rewritten;
      }
      setRewriteResult({ original: selectedTextForRewrite, rewritten });
      setRewriteModalPhase('result');

      // プロンプト履歴に保存（重複排除、最大10件）
      const trimmedPrompt = customPrompt.trim();
      const newHistory = [trimmedPrompt, ...promptHistory.filter(p => p !== trimmedPrompt)].slice(0, 10);
      setPromptHistory(newHistory);
      localStorage.setItem('ai-rewrite-prompt-history', JSON.stringify(newHistory));
    } catch (error) {
      console.error('[AI Rewrite] Error:', error);
      alert(rewriteEngine === 'nano'
        ? 'オンデバイスAI(Gemini Nano)での編集に失敗しました: ' + (error instanceof Error ? error.message : '不明なエラー')
        : 'AI編集に失敗しました');
    } finally {
      setIsRewriting(false);
    }
  };

  // Apply rewritten text - 選択範囲を置換（Markdown→HTML変換）
  const applyRewrite = () => {
    if (!editor || !rewriteResult) return;

    // MarkdownをHTMLに変換
    const html = markdownToHtml(rewriteResult.rewritten);

    // 現在の選択範囲を置換（選択が変わっていない前提）
    const { from, to } = editor.state.selection;
    editor.chain().focus().deleteRange({ from, to }).insertContent(html).run();

    setShowRewriteModal(false);
    setRewriteResult(null);
    setSelectedTextForRewrite('');
  };

  // モーダルを閉じる
  const closeRewriteModal = () => {
    setShowRewriteModal(false);
    setRewriteResult(null);
    setSelectedTextForRewrite('');
    setRewriteModalPhase('selection');
  };

  // Markdown Edit - 開く
  const handleMarkdownEdit = () => {
    if (!editor || isReadOnly) return;

    // 選択範囲のHTMLを取得してMarkdownに変換
    const selectedHtml = getSelectedHtml();
    if (!selectedHtml.trim()) {
      alert('テキストを選択してMarkdown編集の範囲を指定してください');
      return;
    }

    const markdown = htmlToMarkdown(selectedHtml);
    setMarkdownText(markdown);
    setShowMarkdownModal(true);
  };

  // Markdown Edit - 適用
  const applyMarkdownEdit = () => {
    if (!editor) return;

    // MarkdownをHTMLに変換
    const html = markdownToHtml(markdownText);

    // 現在の選択範囲を置換
    const { from, to } = editor.state.selection;
    editor.chain().focus().deleteRange({ from, to }).insertContent(html).run();

    setShowMarkdownModal(false);
    setMarkdownText('');
  };

  // Markdown Edit - モーダルを閉じる
  const closeMarkdownModal = () => {
    setShowMarkdownModal(false);
    setMarkdownText('');
  };

  // Force Commit - 音声バッファを強制的にコミット
  const handleForceCommit = () => {
    if (!ydocRef.current || isForceCommitPending || !isTranscribing) return;

    setIsForceCommitPending(true);
    const statusMap = ydocRef.current.getMap(`status-${sessionId}`);
    statusMap.set('forceCommit', true);
    console.log('[Editor] 🎤 Force commit requested');

    // 1秒後にボタンを再有効化（デバウンス）
    setTimeout(() => setIsForceCommitPending(false), 1000);
  };

  // Keyboard Shortcuts - キーボードショートカットを有効化
  useKeyboardShortcuts({
    onRewrite: handleRewrite,
    onMarkdownEdit: handleMarkdownEdit,
    onForceCommit: handleForceCommit,
    onToggleHistory: () => setShowHistory(!showHistory),
    onShowHelp: () => setShowShortcutHelp(true),
  });

  // Early return during SSR - render nothing until mounted on client
  if (!mounted) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-celadon mx-auto mb-4"></div>
          <p className="text-body">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!editor) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-celadon mx-auto mb-4"></div>
          <p className="text-body">共同校正エディターを初期化中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 校正者マニュアルバナー */}
      <div className="bg-celadon text-on-celadon rounded-lg px-4 py-2 flex items-center justify-between">
        <span className="text-sm font-medium">初めての方へ: 校正の操作方法はマニュアルをご確認ください</span>
        <a
          href={`${getBasePath()}/manual.html#editor`}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-surface text-celadon-active px-3 py-1 rounded-md text-sm font-medium hover:bg-celadon-soft transition-colors flex-shrink-0"
        >
          校正者マニュアルを開く
        </a>
      </div>
      {/* Sticky Header - Connection Status + Toolbar */}
      <div className="sticky top-0 z-10 bg-canvas space-y-2 pb-2">
        {/* Connection Status */}
        <div className="bg-surface rounded-lg shadow-sm border border-hairline p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-success' : 'bg-error'}`}></div>
              <span className="text-sm font-medium text-ink">
                {isConnected ? '接続済み' : '接続中...'}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="text-sm text-body">
                {connectedUsers.length > 0 ? connectedUsers.length : userCount}人が参加中:
              </span>
              {/* Connected Users Avatars */}
              <div className="flex items-center -space-x-1">
                {connectedUsers.length > 0 ? (
                  connectedUsers.map((user) => (
                    <div
                      key={user.id}
                      className="w-6 h-6 rounded-full border-2 border-surface flex items-center justify-center text-xs text-white font-medium"
                      style={{ backgroundColor: user.color }}
                      title={`${user.name} (${user.id === userIdRef.current ? '自分' : '参加者'})`}
                    >
                      {user.name.charAt(0).toUpperCase()}
                    </div>
                  ))
                ) : (
                  <div
                    className="w-6 h-6 rounded-full border-2 border-surface flex items-center justify-center text-xs text-white font-medium"
                    style={{ backgroundColor: userInfo.color }}
                    title={userInfo.name}
                  >
                    {userInfo.name.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: userInfo.color }}
            ></div>
            {isEditingUserName ? (
              <div className="flex items-center space-x-1">
                <input
                  type="text"
                  value={userNameInput}
                  onChange={(e) => setUserNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveUserName();
                    if (e.key === 'Escape') cancelEditUserName();
                  }}
                  className="text-sm px-2 py-0.5 border border-hairline rounded-md w-24 focus:outline-none focus:border-celadon focus:ring-1 focus:ring-celadon"
                  autoFocus
                />
                <button
                  onClick={saveUserName}
                  className="text-xs px-2 py-0.5 bg-celadon text-on-celadon rounded-md hover:bg-celadon-active transition-colors"
                >
                  保存
                </button>
                <button
                  onClick={cancelEditUserName}
                  className="text-xs px-2 py-0.5 bg-surface text-ink border border-hairline rounded-md hover:bg-surface-soft transition-colors"
                >
                  取消
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-1">
                <span className="text-sm text-muted">
                  {userInfo.name} {provider ? '✓' : '⌛'}
                </span>
                <button
                  onClick={startEditingUserName}
                  className="text-xs text-muted hover:text-body transition-colors"
                  title="ユーザー名を編集"
                >
                  ✏️
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Editor Toolbar */}
      <div className="bg-surface rounded-lg shadow-sm border border-hairline p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            {/* 閲覧(view)モードの表示。既定(edit)は何も表示しない。URL ?mode=view で有効 */}
            {isReadOnly && (
              <span
                className="px-3 py-1 text-sm rounded-md bg-surface-soft text-muted border border-hairline"
                title="URLの mode=view により閲覧専用（編集不可）です"
              >
                閲覧モード（編集不可）
              </span>
            )}
            {!isReadOnly && (<>
            <button
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${editor.isActive('bold') ? 'bg-celadon text-on-celadon' : 'bg-surface text-ink border border-hairline hover:bg-surface-soft'}`}
            >
              太字
            </button>
            <button
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${editor.isActive('italic') ? 'bg-celadon text-on-celadon' : 'bg-surface text-ink border border-hairline hover:bg-surface-soft'}`}
            >
              斜体
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${editor.isActive('heading', { level: 2 }) ? 'bg-celadon text-on-celadon' : 'bg-surface text-ink border border-hairline hover:bg-surface-soft'}`}
            >
              見出し
            </button>
            <button
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${editor.isActive('bulletList') ? 'bg-celadon text-on-celadon' : 'bg-surface text-ink border border-hairline hover:bg-surface-soft'}`}
            >
              箇条書き
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHighlight({ color: userInfo.color }).run()}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${editor.isActive('highlight') ? 'text-on-celadon' : 'bg-surface text-ink border border-hairline hover:bg-surface-soft'}`}
              style={editor.isActive('highlight') ? { backgroundColor: userInfo.color } : {}}
              title="選択したテキストをハイライト"
            >
              🖍 ハイライト
            </button>
            </>)}
            <label className="flex items-center space-x-1 text-sm text-body" title="他者の編集を下線で表示">
              <input
                type="checkbox"
                checked={highlightEdits}
                onChange={(e) => setHighlightEdits(e.target.checked)}
                className="rounded accent-celadon"
              />
              <span>下線表示</span>
            </label>
            {/* Font Size Selector */}
            <select
              value={fontSize}
              onChange={(e) => setFontSize(e.target.value as 'xs' | 'sm' | 'base' | 'lg')}
              className="px-2 py-1 text-sm border border-hairline rounded-md bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-celadon"
              title="文字サイズ"
            >
              <option value="xs">極小</option>
              <option value="sm">小</option>
              <option value="base">中</option>
              <option value="lg">大</option>
            </select>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => {
                const text = editor.getText();
                navigator.clipboard.writeText(text).then(() => {
                  alert('テキストをクリップボードにコピーしました');
                });
              }}
              className="px-3 py-1 text-sm bg-surface text-ink border border-hairline rounded-md hover:bg-surface-soft transition-colors"
            >
              テキストをコピー
            </button>
            {!isReadOnly && (<>
            <button
              onClick={handleRewrite}
              disabled={isRewriting}
              title="AIでテキストを編集します"
              className="px-3 py-1 text-sm bg-celadon text-on-celadon rounded-md hover:bg-celadon-active disabled:bg-celadon-disabled disabled:cursor-not-allowed transition-colors"
            >
              {isRewriting ? '処理中...' : 'AI編集'}
            </button>
            <button
              onClick={handleMarkdownEdit}
              title="選択箇所をMarkdownで編集します"
              className="px-3 py-1 text-sm bg-celadon text-on-celadon rounded-md hover:bg-celadon-active transition-colors"
            >
              Markdown編集
            </button>
            </>)}
          </div>
        </div>
      </div>
      </div>

      {/* Editor and Sidebar Container */}
      <div className="flex gap-4">
        {/* Editor */}
        <div className="flex-1">
          <div className={`bg-surface rounded-lg shadow-sm border border-hairline editor-font-${fontSize}`}>
            {/* スクロール可能な本文ボックス（末尾自動追従／本文クリックで停止） */}
            <div className="relative">
              <div
                ref={editorScrollRef}
                onScroll={onEditorScroll}
                onMouseDown={onEditorMouseDown}
                className="h-[60vh] min-h-[320px] overflow-y-auto"
              >
                <EditorContent editor={editor} />
                {/* 認識中テキストは本文末尾にインライン表示（pendingTextInline Decoration） */}
                {isTranscribing && !pendingText && (
                  <div className="px-4 pb-4">
                    <p className="text-muted italic animate-pulse">
                      認識中...
                    </p>
                  </div>
                )}
              </div>
              {/* ▼ 最新へ移動（自動追従停止中に末尾が伸びたとき表示） */}
              {showScrollDown && (
                <button
                  onClick={scrollToBottom}
                  title="最新へ移動して自動追従を再開"
                  aria-label="最新へ移動"
                  className="absolute bottom-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-celadon text-on-celadon shadow-lg ring-1 ring-celadon-active/30 transition-colors hover:bg-celadon-active"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Change History Sidebar */}
        {showHistory && (
          <div className="w-80 flex-shrink-0">
            <div className="bg-surface rounded-lg shadow-sm border border-hairline p-4 sticky top-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-ink">変更履歴</h3>
                <button
                  onClick={() => setShowHistory(false)}
                  className="text-muted hover:text-body transition-colors"
                >
                  ×
                </button>
              </div>
              <div className="space-y-3 max-h-[500px] overflow-y-auto">
                {changeHistory.length === 0 ? (
                  <p className="text-muted text-sm">変更履歴はありません</p>
                ) : (
                  changeHistory.map((entry) => (
                    <div key={entry.id} className="border-l-2 pl-3 py-1" style={{ borderColor: entry.userColor }}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <div
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: entry.userColor }}
                          ></div>
                          <span className="text-xs font-medium text-muted">{entry.userName}</span>
                        </div>
                        <span className="text-xs text-muted">
                          {entry.timestamp.toLocaleTimeString('ja-JP')}
                        </span>
                      </div>
                      <div className="text-sm mt-0.5">
                        <span className={`text-xs font-medium px-1 py-0.5 rounded ${
                          entry.action === 'insert' ? 'bg-success/10 text-success' :
                          entry.action === 'delete' ? 'bg-error/10 text-error' :
                          'bg-celadon-soft text-celadon-active'
                        }`}>
                          {entry.action === 'insert' ? '追加' : entry.action === 'delete' ? '削除' : '変更'}
                        </span>
                        <span className="ml-1.5 text-body text-sm break-all">{entry.content}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Toggle History Button (when hidden) */}
      {!showHistory && (
        <button
          onClick={() => setShowHistory(true)}
          className="fixed right-4 top-1/2 transform -translate-y-1/2 px-2 py-4 bg-celadon text-on-celadon rounded-l-lg shadow-sm hover:bg-celadon-active transition-colors"
        >
          履歴
        </button>
      )}

      {/* AI Edit Modal */}
      {showRewriteModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-surface border border-hairline rounded-lg shadow-sm max-w-4xl w-full mx-4 max-h-[80vh] overflow-hidden">
            {/* ヘッダー */}
            <div className="p-4 border-b border-hairline">
              <h3 className="text-lg font-light text-ink">
                {rewriteModalPhase === 'selection' ? 'AI編集 - テキスト選択' : 'AI編集 - プレビュー'}
              </h3>
            </div>

            {/* コンテンツ */}
            <div className="p-4 overflow-y-auto max-h-[60vh]">
              {rewriteModalPhase === 'selection' ? (
                /* 選択フェーズ */
                <>
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-body-strong mb-2">
                      以下の箇所を選択しています
                    </label>
                    <div className="p-3 bg-surface-soft rounded-md border border-hairline text-sm text-body whitespace-pre-wrap max-h-40 overflow-y-auto">
                      {selectedTextForRewrite}
                    </div>
                  </div>

                  {/* テンプレート選択 */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-body-strong mb-2">
                      テンプレートから選択
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {promptTemplates.map((template, index) => (
                        <button
                          key={index}
                          onClick={() => setCustomPrompt(prev => prev ? `${prev}\n${template.prompt}` : template.prompt)}
                          className="px-2 py-1 text-xs bg-celadon-soft text-celadon-active rounded-md hover:bg-surface-tint transition-colors"
                        >
                          {template.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 履歴選択 */}
                  {promptHistory.length > 0 && (
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-body-strong mb-2">
                        履歴から選択
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {promptHistory.map((prompt, index) => (
                          <button
                            key={index}
                            onClick={() => setCustomPrompt(prompt)}
                            className="px-2 py-1 text-xs bg-surface-soft text-body rounded-md hover:bg-surface-tint transition-colors max-w-xs truncate"
                            title={prompt}
                          >
                            {prompt.length > 20 ? prompt.substring(0, 20) + '...' : prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* プロンプト入力 */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-body-strong mb-2">
                      編集プロンプト <span className="text-error">*</span>
                    </label>
                    <textarea
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder="どのように編集するか指示を入力してください"
                      className={`w-full px-3 py-2 border rounded-md text-sm h-24 text-ink focus:outline-none focus:ring-1 focus:ring-celadon ${
                        !customPrompt.trim() ? 'border-error bg-error/5' : 'border-hairline'
                      }`}
                    />
                    {!customPrompt.trim() && (
                      <p className="text-xs text-error mt-1">編集プロンプトは必須です</p>
                    )}
                  </div>

                  {/* エンジン選択: OpenAI（サーバ）/ Gemini Nano（オンデバイス） */}
                  <div className="mb-2">
                    <label className="block text-sm font-medium text-body-strong mb-2">エンジン</label>
                    <div className="flex items-center gap-4 text-sm text-body">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="rewrite-engine"
                          checked={rewriteEngine === 'openai'}
                          onChange={() => selectRewriteEngine('openai')}
                          className="accent-celadon"
                        />
                        OpenAI（サーバ）
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="rewrite-engine"
                          checked={rewriteEngine === 'nano'}
                          onChange={() => selectRewriteEngine('nano')}
                          className="accent-celadon"
                        />
                        オンデバイス（Gemini Nano）
                      </label>
                    </div>
                    {rewriteEngine === 'nano' && (
                      <p className="text-xs text-muted mt-1">Chrome内蔵のGemini Nanoで処理（外部送信なし）。要 Chrome 138+ ／ <code>chrome://flags/#prompt-api-for-gemini-nano</code> 有効化 ／ 初回モデルDL。</p>
                    )}
                  </div>
                </>
              ) : (
                /* 結果フェーズ */
                <>
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-body-strong mb-2">
                      使用した編集プロンプト
                    </label>
                    <div className="p-2 bg-celadon-soft border border-hairline rounded-md text-sm text-celadon-active">
                      {customPrompt}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h4 className="text-sm font-medium text-body-strong mb-2">
                        元のテキスト
                        <span className="ml-2 text-xs text-error">（削除部分に<span className="line-through">取り消し線</span>）</span>
                      </h4>
                      <div className="p-3 bg-surface-soft rounded-md border border-hairline text-sm text-body whitespace-pre-wrap max-h-80 overflow-y-auto">
                        {rewriteResult && (() => {
                          const diff = Diff.diffWords(rewriteResult.original, rewriteResult.rewritten);
                          return diff.map((part, index) => {
                            if (part.added) {
                              return null; // 追加部分は元のテキストには表示しない
                            }
                            if (part.removed) {
                              return (
                                <span key={index} className="bg-error/10 text-error line-through">
                                  {part.value}
                                </span>
                              );
                            }
                            return <span key={index}>{part.value}</span>;
                          });
                        })()}
                      </div>
                    </div>
                    <div>
                      <h4 className="text-sm font-medium text-body-strong mb-2">
                        修正後のテキスト
                        <span className="ml-2 text-xs text-success">（追加部分に<span className="underline decoration-success decoration-2">下線</span>）</span>
                      </h4>
                      <div className="p-3 bg-success/5 rounded-md border border-hairline text-sm text-body whitespace-pre-wrap max-h-80 overflow-y-auto">
                        {rewriteResult && (() => {
                          const diff = Diff.diffWords(rewriteResult.original, rewriteResult.rewritten);
                          return diff.map((part, index) => {
                            if (part.removed) {
                              return null; // 削除部分は修正後には表示しない
                            }
                            if (part.added) {
                              return (
                                <span key={index} className="bg-success/10 text-success underline decoration-success decoration-2">
                                  {part.value}
                                </span>
                              );
                            }
                            return <span key={index}>{part.value}</span>;
                          });
                        })()}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* フッター */}
            <div className="p-4 border-t border-hairline flex justify-end space-x-3">
              <button
                onClick={closeRewriteModal}
                className="px-4 py-2 text-sm text-ink bg-surface border border-hairline rounded-md hover:bg-surface-soft transition-colors"
              >
                キャンセル
              </button>
              {rewriteModalPhase === 'selection' ? (
                <button
                  onClick={executeRewrite}
                  disabled={isRewriting || !customPrompt.trim()}
                  className="px-4 py-2 text-sm text-on-celadon bg-celadon rounded-md hover:bg-celadon-active disabled:bg-celadon-disabled disabled:cursor-not-allowed transition-colors"
                >
                  {isRewriting ? '処理中...' : 'AI編集を実行'}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setRewriteModalPhase('selection')}
                    disabled={isRewriting}
                    className="px-4 py-2 text-sm text-ink bg-surface border border-hairline rounded-md hover:bg-surface-soft disabled:opacity-50 transition-colors"
                  >
                    {isRewriting ? '処理中...' : '再実行'}
                  </button>
                  <button
                    onClick={applyRewrite}
                    className="px-4 py-2 text-sm text-on-celadon bg-celadon rounded-md hover:bg-celadon-active transition-colors"
                  >
                    適用
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Markdown Edit Modal */}
      {showMarkdownModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-surface border border-hairline rounded-lg shadow-sm w-full max-w-2xl mx-4 flex flex-col max-h-[80vh]">
            {/* ヘッダー */}
            <div className="p-4 border-b border-hairline flex justify-between items-center">
              <h3 className="text-lg font-light text-ink">Markdown編集</h3>
              <button
                onClick={closeMarkdownModal}
                className="text-muted hover:text-body transition-colors"
              >
                ✕
              </button>
            </div>

            {/* コンテンツ */}
            <div className="p-4 overflow-y-auto flex-1">
              <p className="text-sm text-body mb-3">
                選択箇所をMarkdown形式で編集できます。リンクや基本的なHTMLタグの挿入が可能です。
              </p>
              <textarea
                value={markdownText}
                onChange={(e) => setMarkdownText(e.target.value)}
                className="w-full h-64 px-3 py-2 border border-hairline rounded-md font-mono text-sm text-ink resize-none focus:outline-none focus:ring-2 focus:ring-celadon"
                placeholder="Markdownを入力..."
              />
              <p className="text-xs text-muted mt-2">
                例: **太字**, *斜体*, [リンク](URL), # 見出し, - リスト
              </p>
            </div>

            {/* フッター */}
            <div className="p-4 border-t border-hairline flex justify-end gap-2">
              <button
                onClick={closeMarkdownModal}
                className="px-4 py-2 text-sm text-ink bg-surface border border-hairline rounded-md hover:bg-surface-soft transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={applyMarkdownEdit}
                className="px-4 py-2 text-sm text-on-celadon bg-celadon rounded-md hover:bg-celadon-active transition-colors"
              >
                適用
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts Help Modal */}
      <ShortcutHelpModal
        isOpen={showShortcutHelp}
        onClose={() => setShowShortcutHelp(false)}
      />
    </div>
  );
}