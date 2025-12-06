"use client";

interface EditorHeaderProps {
  sessionId: string;
}

export function EditorHeader({ sessionId }: EditorHeaderProps) {
  return (
    <header className="bg-white shadow-sm border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">共同校正画面</h1>
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
  );
}
