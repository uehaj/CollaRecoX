import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <main className="container mx-auto px-4 py-16">
        <div className="text-center max-w-4xl mx-auto">
          {/* Header */}
          <h1 className="text-5xl font-bold text-gray-900 mb-6">
            AI-Powered Audio Transcription
          </h1>
          <p className="text-xl text-gray-600 mb-8 leading-relaxed">
            Real-time speech-to-text transcription using OpenAI&apos;s latest 
            GPT-4o transcribe models. Stream audio directly from your browser 
            and get instant, accurate transcriptions.
          </p>

          {/* Features */}
          <div className="grid md:grid-cols-3 gap-6 my-12">
            <div className="bg-white p-6 rounded-lg shadow-md">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">
                GPT-4o Mini Transcribe
              </h3>
              <p className="text-gray-600 mb-4">
                Fast and cost-effective batch transcription at ~$0.003 per minute. 
                Perfect for everyday use and high-volume applications.
              </p>
              <div className="text-green-600 font-semibold">Most affordable option</div>
            </div>
            
            <div className="bg-white p-6 rounded-lg shadow-md">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">
                GPT-4o Transcribe
              </h3>
              <p className="text-gray-600 mb-4">
                Premium accuracy batch transcription at ~$0.006 per minute. 
                Lower word error rate for professional applications.
              </p>
              <div className="text-blue-600 font-semibold">Higher accuracy & multilingual</div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow-md border-2 border-orange-200">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">
                Realtime API
              </h3>
              <p className="text-gray-600 mb-4">
                True real-time streaming transcription at ~$0.06-0.24 per minute. 
                Instant results as you speak.
              </p>
              <div className="text-orange-600 font-semibold">Premium real-time</div>
            </div>
          </div>

          {/* CTA */}
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/recorder"
                className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium py-4 px-8 rounded-lg text-lg transition-colors shadow-lg"
              >
                Batch Recording →
              </Link>
              <Link
                href="/realtime"
                className="inline-block bg-orange-600 hover:bg-orange-700 text-white font-medium py-4 px-8 rounded-lg text-lg transition-colors shadow-lg"
              >
                Real-time Streaming →
              </Link>
            </div>
            <p className="text-sm text-gray-500">
              No signup required. Just add your OpenAI API key to get started.
            </p>
          </div>

          {/* Technical Features */}
          <div className="mt-16 bg-white p-8 rounded-lg shadow-md">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Features</h2>
            <div className="grid md:grid-cols-3 gap-6 text-left">
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">Real-time Streaming</h4>
                <p className="text-gray-600 text-sm">
                  Audio is streamed directly to OpenAI for processing as you speak
                </p>
              </div>
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">Browser-based</h4>
                <p className="text-gray-600 text-sm">
                  No downloads required. Works in any modern web browser
                </p>
              </div>
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">Secure</h4>
                <p className="text-gray-600 text-sm">
                  API keys are handled server-side for maximum security
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
      
      <footer className="py-8 text-center text-gray-500 text-sm">
        <p>
          Built with Next.js and OpenAI API. 
          Configure your API key in <code className="bg-gray-100 px-1 rounded">.env.local</code>
        </p>
      </footer>
    </div>
  );
}
