"use client";

import React, { useEffect, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

interface CollaborativeEditorProps {
  sessionId: string;
}

export default function CollaborativeEditor({ sessionId }: CollaborativeEditorProps) {
  const [ydoc] = useState(() => new Y.Doc());
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [userCount, setUserCount] = useState(1);
  const [isEditorReady, setIsEditorReady] = useState(false);

  // Initialize Y.js WebSocket provider
  useEffect(() => {
    console.log('[Collaborative Editor] 🚀 Initializing for session:', sessionId);
    
    // Use public Yjs demo server for testing (not for production!)
    const websocketUrl = 'wss://demos.yjs.dev/ws';
    const roomName = `transcribe-editor-${sessionId}`;
    
    console.log('[Collaborative Editor] 🔗 Connecting to:', websocketUrl, 'Room:', roomName);
    
    const wsProvider = new WebsocketProvider(websocketUrl, roomName, ydoc);
    
    wsProvider.on('status', (event: { status: string }) => {
      console.log('[WebSocket Provider] Status:', event.status);
      setIsConnected(event.status === 'connected');
    });

    wsProvider.on('connection-close', () => {
      console.log('[WebSocket Provider] Connection closed');
      setIsConnected(false);
    });

    wsProvider.on('connection-error', (event: Event) => {
      console.error('[WebSocket Provider] Connection error:', event);
      setIsConnected(false);
    });

    // Track user count
    wsProvider.awareness.on('change', () => {
      const userCount = wsProvider.awareness.getStates().size;
      console.log('[Awareness] User count changed:', userCount);
      setUserCount(userCount);
    });

    setProvider(wsProvider);
    
    // Wait a bit before marking as ready
    const timer = setTimeout(() => {
      setIsEditorReady(true);
    }, 300);

    return () => {
      console.log('[Collaborative Editor] 🧹 Cleaning up WebSocket provider');
      clearTimeout(timer);
      wsProvider.destroy();
      setProvider(null);
      setIsEditorReady(false);
    };
  }, [sessionId, ydoc]);

  // Generate random user info
  const [userInfo] = useState(() => {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57', '#FF9FF3', '#54A0FF'];
    const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace'];
    
    return {
      name: names[Math.floor(Math.random() * names.length)],
      color: colors[Math.floor(Math.random() * colors.length)],
    };
  });

  // Initialize TipTap editor only when provider is fully ready
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: false, // Disable history for collaboration
      }),
      ...(isEditorReady && provider ? [
        Collaboration.configure({
          document: ydoc,
        }),
        CollaborationCursor.configure({
          provider: provider,
          user: userInfo,
        }),
      ] : []),
    ],
    content: `
      <h2>共同編集画面へようこそ</h2>
      <p>この画面では複数の人が同時に文書を編集できます。</p>
      <p>リアルタイム文字起こしの結果がここに表示され、みんなで編集・修正できます。</p>
    `,
    editorProps: {
      attributes: {
        class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl mx-auto focus:outline-none min-h-[500px] p-4',
      },
    },
  }, [provider, isEditorReady, ydoc, userInfo]);

  // Listen for transcription data from realtime page
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'transcription' && event.data.sessionId === sessionId) {
        console.log('[Editor] 📝 Received transcription:', event.data.text);
        
        if (editor) {
          // Insert transcription at the end of the document
          editor.chain().focus().insertContent(`<p>${event.data.text}</p>`).run();
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [editor, sessionId]);

  if (!editor) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">エディターを初期化中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
              <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
              <span className="text-sm text-gray-600">
                {userCount}人が編集中
              </span>
            </div>
          </div>
          <div className="text-sm text-gray-500">
            {userInfo.name} ({userInfo.color})
          </div>
        </div>
      </div>

      {/* Editor Toolbar */}
      <div className="bg-white rounded-lg shadow-sm border p-3">
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
        </div>
      </div>

      {/* Editor */}
      <div className="bg-white rounded-lg shadow-sm border min-h-[600px]">
        <EditorContent editor={editor} />
      </div>

      {/* Instructions */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-blue-900 mb-2">使い方</h3>
        <ul className="text-blue-800 space-y-1 text-sm">
          <li>• このURLを他の人と共有して、一緒に編集できます</li>
          <li>• リアルタイム文字起こしの結果が自動的にここに追加されます</li>
          <li>• 複数の人が同時に編集でき、変更がリアルタイムで同期されます</li>
          <li>• 他の人のカーソル位置も表示されます</li>
        </ul>
      </div>
    </div>
  );
}