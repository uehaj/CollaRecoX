import Link from "next/link";
import { getBasePath } from '@/lib/basePath';
import packageJson from '../../package.json';

export default function Home() {
  return (
    <div className="min-h-screen bg-canvas">
      <main className="container mx-auto px-4 py-16">
        <div className="text-center max-w-4xl mx-auto">
          {/* Header */}
          <h1 className="text-5xl font-light text-ink mb-6">
            AI音声文字起こし
          </h1>
          <p className="text-xl text-body mb-8 leading-relaxed">
            オンデバイス音声認識による、ブラウザ完結のリアルタイム文字起こし。
            マイクからの音声をブラウザ内で文字に変換し、高精度な校正結果を即座に取得できます。
          </p>

          {/* CTA */}
          <div className="space-y-6">
            <div className="flex justify-center space-x-4">
              <Link
                href="/realtime"
                className="inline-block bg-celadon hover:bg-celadon-active text-on-celadon font-medium py-4 px-8 rounded-lg text-lg transition-colors shadow-sm"
              >
                文字起こしの実行 →
              </Link>
            </div>
            <p className="text-sm text-muted">
              サインアップ不要。ブラウザだけで開始できます。
            </p>
            <div className="mt-4">
              <a
                href={`${getBasePath()}/manual.html`}
                className="text-celadon hover:text-celadon-active underline text-sm"
                target="_blank"
                rel="noopener noreferrer"
              >
                📖 マニュアルを見る
              </a>
            </div>
          </div>

          {/* Overview */}
          <div className="mt-16 bg-surface border border-hairline p-8 rounded-lg shadow-sm text-left">
            <h2 className="text-2xl font-light text-ink mb-6">概要</h2>
            <p className="text-body mb-6">
              Collarecoxは、オンデバイス音声認識を用いたリアルタイム音声文字起こしアプリケーションです。
              マイクからの音声入力をブラウザ内で文字に変換し、共同校正機能を使って
              テキストを編集・共有することができます。
            </p>
            <h3 className="text-lg font-medium text-ink mb-4">主な機能</h3>
            <ul className="list-disc list-inside text-body space-y-2">
              <li>リアルタイム音声文字起こし（マイク入力）</li>
              <li>VAD（音声区間検出）による自動文字起こし</li>
              <li>共同校正機能</li>
              <li>文字起こし結果のコピー・クリア</li>
            </ul>
          </div>

          {/* Technical Features */}
          <div className="mt-8 bg-surface border border-hairline p-8 rounded-lg shadow-sm">
            <h2 className="text-2xl font-light text-ink mb-6">特徴</h2>
            <div className="grid md:grid-cols-3 gap-6 text-left">
              <div>
                <h4 className="font-medium text-ink mb-2">リアルタイム認識</h4>
                <p className="text-body text-sm">
                  話しながらブラウザ内でリアルタイムに認識
                </p>
              </div>
              <div>
                <h4 className="font-medium text-ink mb-2">ブラウザベース</h4>
                <p className="text-body text-sm">
                  ダウンロード不要。モダンなWebブラウザで動作
                </p>
              </div>
              <div>
                <h4 className="font-medium text-ink mb-2">プライバシー</h4>
                <p className="text-body text-sm">
                  音声をブラウザ内で処理し、外部に送信しない
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="py-8 text-center text-muted text-sm">
        <p>
          Next.jsで構築。
        </p>
        <p className="mt-2 text-xs text-muted">
          Version {packageJson.version}
        </p>
      </footer>
    </div>
  );
}
