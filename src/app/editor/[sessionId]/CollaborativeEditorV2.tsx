"use client";

import React, { useEffect, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

interface CollaborativeEditorV2Props {
  sessionId: string;
}

export default function CollaborativeEditorV2({ sessionId }: CollaborativeEditorV2Props) {
  const [ydoc] = useState(() => {
    // Ensure unique document per session
    const doc = new Y.Doc();
    console.log('[Collaborative Editor V2] 📄 Created new Y.Doc for session:', sessionId);
    return doc;
  });
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [userCount, setUserCount] = useState(1);

  // Initialize Hocuspocus provider
  useEffect(() => {
    console.log('[Collaborative Editor V2] 🚀 Initializing for session:', sessionId);
    
    // Use the current hostname and port, automatically detecting protocol
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' ? window.location.host : 'localhost:8888';
    const websocketUrl = `${protocol}//${host}/api/yjs-ws`;
    const roomName = `transcribe-editor-v2-${sessionId}`;
    
    console.log('[Collaborative Editor V2] 🔗 Connecting to:', websocketUrl, 'Room:', roomName);
    
    const hocusProvider = new HocuspocusProvider({
      url: websocketUrl,
      name: roomName,
      document: ydoc,
    });
    
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

    return () => {
      console.log('[Collaborative Editor V2] 🧹 Cleaning up Hocuspocus provider');
      if (hocusProvider) {
        try {
          hocusProvider.disconnect();
          hocusProvider.destroy();
        } catch (error) {
          console.error('[Collaborative Editor V2] ❌ Error during cleanup:', error);
        }
      }
      setProvider(null);
      setIsConnected(false);
    };
  }, [sessionId, ydoc]);

  // Create editor with collaboration (no cursor for now)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: false, // Disable history for collaboration
      }),
      Collaboration.configure({
        document: ydoc,
        field: `content-${sessionId}`, // Use session-specific field name
      }),
    ],
    content: `
      <h2>共同編集画面 V2</h2>
      <p>この画面では複数の人が同時に文書を編集できます。</p>
      <p>リアルタイム文字起こしの結果がここに表示され、みんなで編集・修正できます。</p>
      <p><strong>注意:</strong> この版はカーソル同期なしの安定版です。</p>
    `,
    editorProps: {
      attributes: {
        class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl mx-auto focus:outline-none min-h-[500px] p-4',
      },
    },
  });

  // Document change listener for debugging
  useEffect(() => {
    if (!ydoc) return;

    // Use session-specific text field name to avoid conflicts
    const textFieldName = `content-${sessionId}`;
    const ytext = ydoc.getText(textFieldName);
    
    const onChange = () => {
      console.log('[Collaborative Editor V2] 📄 Document content updated:', ytext.toString());
    };

    ytext.observe(onChange);

    return () => {
      ytext.unobserve(onChange);
    };
  }, [ydoc, sessionId]);

  if (!editor) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">共同編集エディターを初期化中...</p>
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
            共同編集 V2 (カーソル同期なし) {provider ? '✓' : '⌛'} 
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
        <h3 className="text-lg font-medium text-blue-900 mb-2">共同編集 V2</h3>
        <ul className="text-blue-800 space-y-1 text-sm">
          <li>• このURLを他の人と共有して、一緒に編集できます</li>
          <li>• リアルタイム文字起こしの結果が自動的にここに追加されます</li>
          <li>• 複数の人が同時に編集でき、変更がリアルタイムで同期されます</li>
          <li>• カーソル表示は無効化されており、より安定した動作を提供します</li>
        </ul>
      </div>
    </div>
  );
}