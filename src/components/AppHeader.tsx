import Link from "next/link";
import { getBasePath } from "@/lib/basePath";

/**
 * Collarecox ワードマーク。
 * 青磁タイルに音声波形を模した線アイコン＋軽量ウェイトのロゴタイプ。
 */
export function Wordmark({ size = 30 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        className="inline-flex items-center justify-center rounded-[10px] bg-celadon-soft"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <svg width={Math.round(size * 0.6)} height={Math.round(size * 0.6)} viewBox="0 0 24 24" fill="none">
          <path d="M4 10v4" stroke="#2f8094" strokeWidth="2" strokeLinecap="round" />
          <path d="M8.5 7v10" stroke="#3d9aaf" strokeWidth="2" strokeLinecap="round" />
          <path d="M13 4.5v15" stroke="#3d9aaf" strokeWidth="2" strokeLinecap="round" />
          <path d="M17.5 8v8" stroke="#2f8094" strokeWidth="2" strokeLinecap="round" />
          <path d="M21 10.5v3" stroke="#54b3c8" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="text-[17px] font-medium tracking-tight text-ink">Collarecox</span>
    </span>
  );
}

/**
 * 全画面共通のミニマルヘッダー。
 * 右側スロット(right)に画面固有の操作（セッション名・共有・参加者など）を差し込む。
 */
export function AppHeader({ right }: { right?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-hairline-soft bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
        <Link href="/" className="shrink-0 transition-opacity hover:opacity-75">
          <Wordmark />
        </Link>
        <div className="flex min-w-0 items-center gap-5">
          {right}
          <a
            href={`${getBasePath()}/manual.html`}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-sm text-muted transition-colors hover:text-ink"
          >
            使い方
          </a>
        </div>
      </div>
    </header>
  );
}
