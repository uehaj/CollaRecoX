"use client";

import React, { useEffect, useState, useRef } from 'react';
import { EditorContent, useEditor, Mark, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import TurndownService from 'turndown';
import { marked } from 'marked';
import { DOMSerializer } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import * as Diff from 'diff';
import { useKeyboardShortcuts } from '@/lib/hooks/useKeyboardShortcuts';
import { getBasePath } from '@/lib/basePath';
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

// 編集追跡Decoration用PluginKey
const editTrackKey = new PluginKey('editTrack');
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

  // Markdown Edit states
  const [showMarkdownModal, setShowMarkdownModal] = useState(false);
  const [markdownText, setMarkdownText] = useState('');

  // Force Commit state
  const [isForceCommitPending, setIsForceCommitPending] = useState(false);

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
                  // 既存のDecorationを位置マッピング
                  decorationSet = decorationSet.map(tr.mapping, tr.doc);

                  // ドキュメント変更なし → そのまま
                  if (!tr.docChanged) return decorationSet;

                  // Yjs同期トランザクション（リモート変更）はスキップ
                  if (tr.getMeta('addToHistory') === false) return decorationSet;

                  // 下線表示がOFFなら新しいDecorationを追加しない
                  if (!highlightEditsRef.current) return decorationSet;

                  // 変更範囲を検出しDecorationを追加
                  const newDecos: Decoration[] = [];
                  tr.steps.forEach((_step, i) => {
                    const map = tr.mapping.maps[i];
                    map.forEach((_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => {
                      if (newEnd > newStart && newEnd <= newState.doc.content.size) {
                        newDecos.push(Decoration.inline(newStart, newEnd, {
                          style: `text-decoration: underline; text-decoration-color: ${userInfoRef.current.color}; text-decoration-thickness: 2px; text-underline-offset: 2px;`,
                        }));
                      }
                    });
                  });

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
      // Add Link extension for handling links
      Link.configure({
        openOnClick: true,
        autolink: true,
        HTMLAttributes: {
          class: 'text-blue-600 underline hover:text-blue-800',
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
    onUpdate: ({ editor }) => {
      const currentContent = editor.getText();
      const previousContent = lastContentRef.current;

      if (currentContent !== previousContent) {
        // Determine action type based on content length difference
        let action: 'insert' | 'delete' | 'modify' = 'modify';
        let content = '';

        if (currentContent.length > previousContent.length) {
          action = 'insert';
          // Find the difference (simplified)
          const diffLength = currentContent.length - previousContent.length;
          content = `+${diffLength}文字`;
        } else if (currentContent.length < previousContent.length) {
          action = 'delete';
          const diffLength = previousContent.length - currentContent.length;
          content = `-${diffLength}文字`;
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


  // Document change listener - highlight remote edits in blue
  useEffect(() => {
    if (!ydocRef.current || !editor || !highlightEdits) return;

    try {
      const ydoc = ydocRef.current;

      // Listen to Yjs document updates to detect remote changes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onUpdate = (update: Uint8Array, origin: any) => {
        // origin is null for remote changes, non-null for local changes
        const isRemote = origin === null || origin === 'remote';

        if (isRemote) {
          console.log('[Collaborative Editor V2] 🔵 Remote change detected');

          // Flash the editor to indicate remote change
          const editorElement = document.querySelector('.ProseMirror');
          if (editorElement) {
            editorElement.classList.add('remote-change-flash');
            setTimeout(() => {
              editorElement.classList.remove('remote-change-flash');
            }, 500);
          }
        }
      };

      ydoc.on('update', onUpdate);

      return () => {
        try {
          ydoc.off('update', onUpdate);
        } catch (error) {
          console.warn('[Collaborative Editor V2] ⚠️ Error during update listener cleanup:', error);
        }
      };
    } catch (error) {
      console.error('[Collaborative Editor V2] ❌ Error setting up document listener:', error);
    }
  }, [editor, highlightEdits]);

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
        const pending = statusMap.get('pendingText') as string;
        setPendingText(pending || '');
        if (pending) {
          console.log('[Collaborative Editor V2] 🔤 Pending text:', pending);
        }
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
    if (!editor) return;

    // 選択されたテキストを取得
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');

    if (!selectedText.trim()) {
      alert('テキストを選択してAI再編の範囲を指定してください');
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

  // AI Rewrite - 実行
  const executeRewrite = async () => {
    if (!editor || isRewriting || !selectedTextForRewrite.trim()) return;

    // プロンプトは必須
    if (!customPrompt.trim()) {
      alert('編集プロンプトを入力してください');
      return;
    }

    setIsRewriting(true);
    try {
      const response = await fetch(`${getBasePath()}/api/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: selectedTextForRewrite, prompt: customPrompt }),
      });

      if (!response.ok) {
        throw new Error('Rewrite failed');
      }

      const data = await response.json();
      setRewriteResult({ original: data.original, rewritten: data.rewritten });
      setRewriteModalPhase('result');

      // プロンプト履歴に保存（重複排除、最大10件）
      const trimmedPrompt = customPrompt.trim();
      const newHistory = [trimmedPrompt, ...promptHistory.filter(p => p !== trimmedPrompt)].slice(0, 10);
      setPromptHistory(newHistory);
      localStorage.setItem('ai-rewrite-prompt-history', JSON.stringify(newHistory));
    } catch (error) {
      console.error('[AI Rewrite] Error:', error);
      alert('AI再編に失敗しました');
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
    if (!editor) return;

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
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!editor) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">共同校正エディターを初期化中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 校正者マニュアルバナー */}
      <div className="bg-indigo-600 text-white rounded-lg px-4 py-2 flex items-center justify-between">
        <span className="text-sm font-medium">初めての方へ: 校正の操作方法はマニュアルをご確認ください</span>
        <a
          href={`${getBasePath()}/editor-manual.html`}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-white text-indigo-600 px-3 py-1 rounded text-sm font-medium hover:bg-indigo-50 transition-colors flex-shrink-0"
        >
          校正者マニュアルを開く
        </a>
      </div>
      {/* Sticky Header - Connection Status + Toolbar */}
      <div className="sticky top-0 z-10 bg-gray-50 space-y-2 pb-2">
        {/* Connection Status */}
        <div className="bg-white rounded-lg shadow-sm border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span className="text-sm font-medium">
                {isConnected ? '接続済み' : '接続中...'}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-600">
                {connectedUsers.length > 0 ? connectedUsers.length : userCount}人が参加中:
              </span>
              {/* Connected Users Avatars */}
              <div className="flex items-center -space-x-1">
                {connectedUsers.length > 0 ? (
                  connectedUsers.map((user) => (
                    <div
                      key={user.id}
                      className="w-6 h-6 rounded-full border-2 border-white flex items-center justify-center text-xs text-white font-medium"
                      style={{ backgroundColor: user.color }}
                      title={`${user.name} (${user.id === userIdRef.current ? '自分' : '参加者'})`}
                    >
                      {user.name.charAt(0).toUpperCase()}
                    </div>
                  ))
                ) : (
                  <div
                    className="w-6 h-6 rounded-full border-2 border-white flex items-center justify-center text-xs text-white font-medium"
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
                  className="text-sm px-2 py-0.5 border border-gray-300 rounded w-24 focus:outline-none focus:border-blue-500"
                  autoFocus
                />
                <button
                  onClick={saveUserName}
                  className="text-xs px-2 py-0.5 bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                  保存
                </button>
                <button
                  onClick={cancelEditUserName}
                  className="text-xs px-2 py-0.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                >
                  取消
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-1">
                <span className="text-sm text-gray-500">
                  {userInfo.name} {provider ? '✓' : '⌛'}
                </span>
                <button
                  onClick={startEditingUserName}
                  className="text-xs text-gray-400 hover:text-gray-600"
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
      <div className="bg-white rounded-lg shadow-sm border p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <button
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={`px-3 py-1 text-sm rounded ${editor.isActive('bold') ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              太字
            </button>
            <button
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={`px-3 py-1 text-sm rounded ${editor.isActive('italic') ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              斜体
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              className={`px-3 py-1 text-sm rounded ${editor.isActive('heading', { level: 2 }) ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              見出し
            </button>
            <button
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              className={`px-3 py-1 text-sm rounded ${editor.isActive('bulletList') ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              箇条書き
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHighlight({ color: userInfo.color }).run()}
              className={`px-3 py-1 text-sm rounded ${editor.isActive('highlight') ? 'bg-yellow-500 text-white' : 'bg-gray-200 text-gray-700'}`}
              style={editor.isActive('highlight') ? { backgroundColor: userInfo.color } : {}}
              title="選択したテキストをハイライト"
            >
              🖍 ハイライト
            </button>
            <label className="flex items-center space-x-1 text-sm text-gray-600" title="他者の編集を下線で表示">
              <input
                type="checkbox"
                checked={highlightEdits}
                onChange={(e) => setHighlightEdits(e.target.checked)}
                className="rounded"
              />
              <span>下線表示</span>
            </label>
            {/* Font Size Selector */}
            <select
              value={fontSize}
              onChange={(e) => setFontSize(e.target.value as 'xs' | 'sm' | 'base' | 'lg')}
              className="px-2 py-1 text-sm border border-gray-300 rounded bg-white"
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
              className="px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
            >
              テキストをコピー
            </button>
            <button
              onClick={handleRewrite}
              disabled={isRewriting}
              title="AIでテキストを再編します"
              className="px-3 py-1 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {isRewriting ? '処理中...' : 'AI再編'}
            </button>
            <button
              onClick={handleMarkdownEdit}
              title="選択箇所をMarkdownで編集します"
              className="px-3 py-1 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors"
            >
              Markdown編集
            </button>
          </div>
        </div>
      </div>
      </div>

      {/* Editor and Sidebar Container */}
      <div className="flex gap-4">
        {/* Editor */}
        <div className="flex-1">
          <div className={`bg-white rounded-lg shadow-sm border min-h-[600px] editor-font-${fontSize}`}>
            <EditorContent editor={editor} />
            {/* 手動認識確定ボタン - エディター最下段・右寄せ */}
            <div className="px-4 py-2 border-t border-gray-100 flex justify-end">
              <button
                onClick={handleForceCommit}
                disabled={!isTranscribing || isForceCommitPending}
                title="現在の認識バッファを強制的に確定します"
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  !isTranscribing || isForceCommitPending
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-orange-500 text-white hover:bg-orange-600'
                }`}
              >
                {isForceCommitPending ? '送信中...' : '🎤 手動認識確定'}
              </button>
            </div>
            {pendingText && (
              <div className="px-4 pb-4">
                <p className="text-gray-400 italic">
                  <span className="animate-pulse">認識中: </span>{pendingText}
                </p>
              </div>
            )}
            {isTranscribing && !pendingText && (
              <div className="px-4 pb-4">
                <p className="text-gray-400 italic animate-pulse">
                  認識中...
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Change History Sidebar */}
        {showHistory && (
          <div className="w-80 flex-shrink-0">
            <div className="bg-white rounded-lg shadow-sm border p-4 sticky top-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">変更履歴</h3>
                <button
                  onClick={() => setShowHistory(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ×
                </button>
              </div>
              <div className="space-y-3 max-h-[500px] overflow-y-auto">
                {changeHistory.length === 0 ? (
                  <p className="text-gray-500 text-sm">変更履歴はありません</p>
                ) : (
                  changeHistory.map((entry) => (
                    <div key={entry.id} className="border-l-2 pl-3 py-1" style={{ borderColor: entry.userColor }}>
                      <div className="flex items-center space-x-2">
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: entry.userColor }}
                        ></div>
                        <span className="text-sm font-medium">{entry.userName}</span>
                      </div>
                      <div className="text-sm text-gray-600">
                        <span className={`${entry.action === 'insert' ? 'text-green-600' : entry.action === 'delete' ? 'text-red-600' : 'text-blue-600'}`}>
                          {entry.action === 'insert' ? '追加' : entry.action === 'delete' ? '削除' : '変更'}
                        </span>
                        : {entry.content}
                      </div>
                      <div className="text-xs text-gray-400">
                        {entry.timestamp.toLocaleTimeString('ja-JP')}
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
          className="fixed right-4 top-1/2 transform -translate-y-1/2 px-2 py-4 bg-blue-600 text-white rounded-l-lg shadow-lg hover:bg-blue-700 transition-colors"
        >
          履歴
        </button>
      )}

      {/* Instructions */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-blue-900 mb-2">共同校正</h3>
        <ul className="text-blue-800 space-y-1 text-sm">
          <li>• このURLを他の人と共有して、一緒に校正できます</li>
          <li>• リアルタイム文字起こしの結果が自動的にここに追加されます</li>
          <li>• 複数の人が同時に校正でき、変更がリアルタイムで同期されます</li>
          <li>• 右のサイドバーで変更履歴を確認できます</li>
          <li>• 「AI再編」で誤字修正や句読点整理ができます</li>
        </ul>
      </div>

      {/* AI Rewrite Modal */}
      {showRewriteModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[80vh] overflow-hidden">
            {/* ヘッダー */}
            <div className="p-4 border-b">
              <h3 className="text-lg font-medium text-gray-900">
                {rewriteModalPhase === 'selection' ? 'AI再編 - テキスト選択' : 'AI再編 - プレビュー'}
              </h3>
            </div>

            {/* コンテンツ */}
            <div className="p-4 overflow-y-auto max-h-[60vh]">
              {rewriteModalPhase === 'selection' ? (
                /* 選択フェーズ */
                <>
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      以下の箇所を選択しています
                    </label>
                    <div className="p-3 bg-yellow-50 rounded border border-yellow-200 text-sm whitespace-pre-wrap max-h-40 overflow-y-auto">
                      {selectedTextForRewrite}
                    </div>
                  </div>

                  {/* テンプレート選択 */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      テンプレートから選択
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {promptTemplates.map((template, index) => (
                        <button
                          key={index}
                          onClick={() => setCustomPrompt(prev => prev ? `${prev}\n${template.prompt}` : template.prompt)}
                          className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                        >
                          {template.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 履歴選択 */}
                  {promptHistory.length > 0 && (
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        履歴から選択
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {promptHistory.map((prompt, index) => (
                          <button
                            key={index}
                            onClick={() => setCustomPrompt(prompt)}
                            className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors max-w-xs truncate"
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
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      編集プロンプト <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder="どのように編集するか指示を入力してください"
                      className={`w-full px-3 py-2 border rounded-md text-sm h-24 ${
                        !customPrompt.trim() ? 'border-red-300 bg-red-50' : 'border-gray-300'
                      }`}
                    />
                    {!customPrompt.trim() && (
                      <p className="text-xs text-red-500 mt-1">編集プロンプトは必須です</p>
                    )}
                  </div>
                </>
              ) : (
                /* 結果フェーズ */
                <>
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      使用した編集プロンプト
                    </label>
                    <div className="p-2 bg-purple-50 border border-purple-200 rounded text-sm text-purple-800">
                      {customPrompt}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h4 className="text-sm font-medium text-gray-700 mb-2">
                        元のテキスト
                        <span className="ml-2 text-xs text-red-500">（削除部分に<span className="line-through">取り消し線</span>）</span>
                      </h4>
                      <div className="p-3 bg-gray-50 rounded border text-sm whitespace-pre-wrap max-h-80 overflow-y-auto">
                        {rewriteResult && (() => {
                          const diff = Diff.diffWords(rewriteResult.original, rewriteResult.rewritten);
                          return diff.map((part, index) => {
                            if (part.added) {
                              return null; // 追加部分は元のテキストには表示しない
                            }
                            if (part.removed) {
                              return (
                                <span key={index} className="bg-red-100 text-red-800 line-through">
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
                      <h4 className="text-sm font-medium text-gray-700 mb-2">
                        修正後のテキスト
                        <span className="ml-2 text-xs text-green-600">（追加部分に<span className="underline decoration-green-500 decoration-2">下線</span>）</span>
                      </h4>
                      <div className="p-3 bg-green-50 rounded border border-green-200 text-sm whitespace-pre-wrap max-h-80 overflow-y-auto">
                        {rewriteResult && (() => {
                          const diff = Diff.diffWords(rewriteResult.original, rewriteResult.rewritten);
                          return diff.map((part, index) => {
                            if (part.removed) {
                              return null; // 削除部分は修正後には表示しない
                            }
                            if (part.added) {
                              return (
                                <span key={index} className="bg-green-100 text-green-800 underline decoration-green-500 decoration-2">
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
            <div className="p-4 border-t flex justify-end space-x-3">
              <button
                onClick={closeRewriteModal}
                className="px-4 py-2 text-sm text-gray-700 bg-gray-200 rounded hover:bg-gray-300"
              >
                キャンセル
              </button>
              {rewriteModalPhase === 'selection' ? (
                <button
                  onClick={executeRewrite}
                  disabled={isRewriting || !customPrompt.trim()}
                  className="px-4 py-2 text-sm text-white bg-purple-600 rounded hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {isRewriting ? '処理中...' : 'AI再編を実行'}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setRewriteModalPhase('selection')}
                    disabled={isRewriting}
                    className="px-4 py-2 text-sm text-white bg-purple-600 rounded hover:bg-purple-700 disabled:bg-gray-400"
                  >
                    {isRewriting ? '処理中...' : '再実行'}
                  </button>
                  <button
                    onClick={applyRewrite}
                    className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700"
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
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[80vh]">
            {/* ヘッダー */}
            <div className="p-4 border-b flex justify-between items-center">
              <h3 className="text-lg font-medium text-gray-900">Markdown編集</h3>
              <button
                onClick={closeMarkdownModal}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            {/* コンテンツ */}
            <div className="p-4 overflow-y-auto flex-1">
              <p className="text-sm text-gray-600 mb-3">
                選択箇所をMarkdown形式で編集できます。リンクや基本的なHTMLタグの挿入が可能です。
              </p>
              <textarea
                value={markdownText}
                onChange={(e) => setMarkdownText(e.target.value)}
                className="w-full h-64 px-3 py-2 border border-gray-300 rounded-md font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Markdownを入力..."
              />
              <p className="text-xs text-gray-500 mt-2">
                例: **太字**, *斜体*, [リンク](URL), # 見出し, - リスト
              </p>
            </div>

            {/* フッター */}
            <div className="p-4 border-t flex justify-end gap-2">
              <button
                onClick={closeMarkdownModal}
                className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
              >
                キャンセル
              </button>
              <button
                onClick={applyMarkdownEdit}
                className="px-4 py-2 text-sm text-white bg-indigo-600 rounded hover:bg-indigo-700"
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