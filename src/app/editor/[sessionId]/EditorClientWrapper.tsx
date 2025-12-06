"use client";

import { useEffect, useState } from 'react';

interface EditorClientWrapperProps {
  sessionId: string;
}

export function EditorClientWrapper({ sessionId }: EditorClientWrapperProps) {
  const [Component, setComponent] = useState<React.ComponentType<{ sessionId: string }> | null>(null);

  useEffect(() => {
    // Only import on client side
    if (typeof window !== 'undefined') {
      import('./CollaborativeEditorV2').then((mod) => {
        setComponent(() => mod.default);
      });
    }
  }, []);

  if (!Component) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">共同校正エディターを読み込み中...</p>
        </div>
      </div>
    );
  }

  return <Component sessionId={sessionId} />;
}
