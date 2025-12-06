// Server Component - no "use client"
import { EditorHeader } from './EditorHeader';
import { EditorClientWrapper } from './EditorClientWrapper';

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function EditorPage({ params }: PageProps) {
  const { sessionId } = await params;

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
      <EditorHeader sessionId={sessionId} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <EditorClientWrapper sessionId={sessionId} />
      </main>
    </div>
  );
}
