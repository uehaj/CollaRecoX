"use client";

import { useParams } from 'next/navigation';
// import SimpleEditor from './SimpleEditor';
import CollaborativeEditorV2 from './CollaborativeEditorV2';

export default function EditorPage() {
  const params = useParams();
  const sessionId = params.sessionId as string;

  if (!sessionId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Invalid Session</h1>
          <p className="text-gray-600">Session ID is required to access the collaborative editor.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">共同編集画面</h1>
              <p className="text-sm text-gray-600 mt-1">Session ID: {sessionId}</p>
            </div>
            <div className="flex items-center space-x-4">
              <div className="text-sm text-gray-500">
                このURLを共有して他の人を招待
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(window.location.href)}
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              >
                URLをコピー
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <CollaborativeEditorV2 sessionId={sessionId} />
      </main>
    </div>
  );
}