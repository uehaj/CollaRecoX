"use client";

import React from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

interface SimpleEditorProps {
  sessionId: string;
}

export default function SimpleEditor({ sessionId }: SimpleEditorProps) {
  // Simple editor without collaboration first
  const editor = useEditor({
    extensions: [
      StarterKit,
    ],
    content: `
      <h2>テストエディター (Session: ${sessionId})</h2>
      <p>これは基本的なTipTapエディターです。</p>
      <p>共同編集機能なしで動作をテストしています。</p>
    `,
    editorProps: {
      attributes: {
        class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl mx-auto focus:outline-none min-h-[500px] p-4',
      },
    },
  });

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
        </div>
      </div>

      {/* Editor */}
      <div className="bg-white rounded-lg shadow-sm border min-h-[600px]">
        <EditorContent editor={editor} />
      </div>

      {/* Test Info */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-yellow-900 mb-2">テスト情報</h3>
        <p className="text-yellow-800 text-sm">
          Session ID: {sessionId}<br/>
          これは共同編集機能なしの基本エディターです。<br/>
          まずこれが動作することを確認してから、共同編集機能を追加します。
        </p>
      </div>
    </div>
  );
}