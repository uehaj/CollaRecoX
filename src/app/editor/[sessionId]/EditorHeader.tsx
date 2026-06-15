"use client";

import packageJson from '../../../../package.json';

interface EditorHeaderProps {
  sessionId: string;
}

export function EditorHeader({ sessionId }: EditorHeaderProps) {
  return (
    <header className="bg-surface border-b border-hairline">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-light text-ink">共同校正画面</h1>
            <p className="text-sm text-body mt-1">Session ID: {sessionId}</p>
          </div>
          <div className="flex items-center space-x-4">
            <div className="text-xs text-muted">
              v{packageJson.version}
            </div>
            <div className="text-sm text-muted">
              このURLを共有して他の人を招待
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(window.location.href)}
              className="px-3 py-1 text-sm bg-celadon text-on-celadon rounded-md hover:bg-celadon-active transition-colors"
            >
              URLをコピー
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
