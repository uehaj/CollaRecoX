import Link from "next/link";
import packageJson from '../../package.json';

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <main className="container mx-auto px-4 py-16">
        <div className="text-center max-w-4xl mx-auto">
          {/* Header */}
          <h1 className="text-5xl font-bold text-gray-900 mb-6">
            AI音声文字起こし
          </h1>
          <p className="text-xl text-gray-600 mb-8 leading-relaxed">
            OpenAI GPT-4oを使用したリアルタイム音声文字起こし。
            ブラウザから直接音声をストリーミングし、高精度な文字起こしを即座に取得できます。
          </p>

          {/* CTA */}
          <div className="space-y-6">
            <div className="flex justify-center space-x-4">
              <Link
                href="/realtime"
                className="inline-block bg-orange-600 hover:bg-orange-700 text-white font-medium py-4 px-8 rounded-lg text-lg transition-colors shadow-lg"
              >
                文字起こしの実行 →
              </Link>
              <Link
                href="/dummy-recorder"
                className="inline-block bg-green-600 hover:bg-green-700 text-white font-medium py-4 px-8 rounded-lg text-lg transition-colors shadow-lg"
              >
                録音データ作成 →
              </Link>
            </div>
            <p className="text-sm text-gray-500">
              サインアップ不要。OpenAI APIキーを設定するだけで開始できます。
            </p>
            <div className="mt-4">
              <a
                href="/collarecox/manual.html"
                className="text-blue-600 hover:text-blue-800 underline text-sm"
                target="_blank"
                rel="noopener noreferrer"
              >
                📖 マニュアルを見る
              </a>
            </div>
          </div>

          {/* Overview */}
          <div className="mt-16 bg-white p-8 rounded-lg shadow-md text-left">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">概要</h2>
            <p className="text-gray-600 mb-6">
              Collarecoxは、OpenAI GPT-4oモデルを使用したリアルタイム音声文字起こしアプリケーションです。
              マイクからの音声入力や録音データをリアルタイムで文字に変換し、共同編集機能を使って
              テキストを編集・共有することができます。
            </p>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">主な機能</h3>
            <ul className="list-disc list-inside text-gray-600 space-y-2">
              <li>リアルタイム音声文字起こし（マイク入力）</li>
              <li>録音データからの文字起こし</li>
              <li>VAD（音声区間検出）による自動文字起こし</li>
              <li>共同校正機能</li>
              <li>文字起こし結果のコピー・クリア</li>
            </ul>
          </div>

          {/* Technical Features */}
          <div className="mt-8 bg-white p-8 rounded-lg shadow-md">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">特徴</h2>
            <div className="grid md:grid-cols-3 gap-6 text-left">
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">リアルタイムストリーミング</h4>
                <p className="text-gray-600 text-sm">
                  話しながらOpenAIに音声を直接ストリーミング
                </p>
              </div>
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">ブラウザベース</h4>
                <p className="text-gray-600 text-sm">
                  ダウンロード不要。モダンなWebブラウザで動作
                </p>
              </div>
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">セキュア</h4>
                <p className="text-gray-600 text-sm">
                  APIキーはサーバー側で安全に管理
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="py-8 text-center text-gray-500 text-sm">
        <p>
          Next.jsとOpenAI APIで構築。
          APIキーは<code className="bg-gray-100 px-1 rounded">.env.local</code>で設定してください。
        </p>
        <p className="mt-2 text-xs text-gray-400">
          Version {packageJson.version}
        </p>
      </footer>
    </div>
  );
}
