"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { getBasePath } from "@/lib/basePath";
import {
  getRecentSessions,
  addRecentSession,
  removeRecentSession,
  relativeTime,
  type RecentSession,
} from "@/lib/recentSessions";
import packageJson from "../../package.json";

/** 新しいセッションIDを生成（既存の /realtime と同形式）。 */
function newSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export default function Home() {
  const router = useRouter();
  const [recent, setRecent] = useState<RecentSession[]>([]);
  const [mounted, setMounted] = useState(false);

  // 履歴はクライアントでのみ読む（SSR不一致を避ける）。
  useEffect(() => {
    setMounted(true);
    setRecent(getRecentSessions());
  }, []);

  // 代表者として新しい配信を開始する。
  const startBroadcast = () => {
    const id = newSessionId();
    addRecentSession(id, "host");
    router.push(`/realtime?session=${id}`);
  };

  // 履歴のセッションを開く（代表者は配信画面へ、参加者は校正画面へ）。
  const openSession = (s: RecentSession) => {
    if (s.role === "host") router.push(`/realtime?session=${encodeURIComponent(s.id)}`);
    else router.push(`/editor/${encodeURIComponent(s.id)}`);
  };

  const forget = (id: string) => {
    removeRecentSession(id);
    setRecent(getRecentSessions());
  };

  return (
    <div className="min-h-screen bg-canvas text-body">
      <AppHeader />

      {/* ─── ヒーロー ─── */}
      <section className="glaze relative overflow-hidden">
        <div className="relative z-10 mx-auto max-w-6xl px-5 pt-20 pb-10 sm:px-8 sm:pt-28">
          <p className="rise rise-1 mb-6 inline-flex items-center gap-2 rounded-full border border-hairline bg-surface px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-celadon-active">
            <span className="h-1.5 w-1.5 rounded-full bg-celadon" />
            リアルタイム字幕 × 共同校正
          </p>
          <h1 className="rise rise-2 max-w-3xl text-[2.6rem] font-light leading-[1.12] tracking-tight text-ink sm:text-6xl">
            声を、その場で字幕に。
          </h1>
          <p className="rise rise-3 mt-6 max-w-xl text-lg leading-relaxed text-body">
            話したそばからリアルタイムに文字化。聞こえづらい方も会議にしっかり参加でき、
            みんなで校正するから、議事録から誤解が消えます。
          </p>
        </div>
      </section>

      {/* ─── 2つの入口 ─── */}
      <section className="mx-auto max-w-6xl px-5 pb-6 sm:px-8">
        <div className="grid items-stretch gap-5 md:grid-cols-2">
          {/* 配信をはじめる（代表者・イニシエータ） */}
          <div className="rise rise-3 card-lift flex flex-col rounded-2xl border border-celadon/30 bg-surface-tint p-8">
            <div className="mb-5 flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-celadon text-on-celadon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </span>
              <span className="rounded-full bg-celadon/15 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-celadon-active">
                代表者として
              </span>
            </div>
            <h2 className="text-xl font-medium text-ink">配信をはじめる</h2>
            <p className="mt-2 mb-6 flex-1 text-sm leading-relaxed text-body">
              あなたが代表となって新しいセッションを開き、声をリアルタイム字幕として配信します。
              参加者はその場で読んで、いっしょに校正できます。
            </p>
            <button
              onClick={startBroadcast}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-celadon px-6 font-medium text-on-celadon transition-colors hover:bg-celadon-active focus:outline-none focus-visible:ring-2 focus-visible:ring-celadon focus-visible:ring-offset-2 focus-visible:ring-offset-surface-tint"
            >
              配信をはじめる
              <span aria-hidden>→</span>
            </button>
          </div>

          {/* 最近のセッション（履歴から再訪） */}
          <div className="rise rise-4 flex flex-col rounded-2xl border border-hairline bg-surface p-8">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-celadon-soft text-celadon-active">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 7v5l3 2M21 12a9 9 0 1 1-3-6.7M21 4v4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h2 className="text-xl font-medium text-ink">最近のセッション</h2>
            <p className="mt-2 mb-5 text-sm leading-relaxed text-body">
              参加した配信をもう一度ひらきます。共有リンクからはいつでも参加できます。
            </p>

            <div className="flex-1">
              {!mounted ? null : recent.length === 0 ? (
                <div className="flex h-full min-h-[120px] flex-col items-center justify-center rounded-xl border border-dashed border-hairline bg-canvas/60 px-6 py-8 text-center">
                  <p className="text-sm text-muted">まだ参加した配信はありません。</p>
                  <p className="mt-1 text-xs text-muted-soft">共有されたリンクを開くと、ここに残ります。</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {recent.map((s) => (
                    <li key={s.id}>
                      <div className="group flex items-center gap-3 rounded-xl border border-hairline bg-surface px-3.5 py-2.5 transition-colors hover:border-celadon/40 hover:bg-surface-soft">
                        <button
                          onClick={() => openSession(s)}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none"
                        >
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
                              s.role === "host"
                                ? "bg-celadon/15 text-celadon-active"
                                : "bg-surface-soft text-muted"
                            }`}
                          >
                            {s.role === "host" ? "代表" : "参加"}
                          </span>
                          <span className="truncate font-mono text-xs text-body">{s.id}</span>
                          <span className="ml-auto shrink-0 text-xs text-muted-soft">{relativeTime(s.at)}</span>
                          <span className="shrink-0 text-celadon opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>→</span>
                        </button>
                        <button
                          onClick={() => forget(s.id)}
                          className="shrink-0 rounded-md p-1 text-muted-soft opacity-0 transition-opacity hover:text-error group-hover:opacity-100"
                          title="履歴から削除"
                          aria-label="履歴から削除"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ─── 3ステップ解説（意義に沿って） ─── */}
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <p className="mb-10 text-center text-xs font-semibold uppercase tracking-[0.14em] text-muted">
          どんなふうに役立つか
        </p>
        <div className="grid gap-10 sm:grid-cols-3">
          {[
            {
              n: "01",
              t: "配信する",
              d: "代表者の声を、その場でリアルタイム字幕に変換します。",
              icon: (
                <path d="M4 14v-4M8 17V7M12 20V4M16 17V7M20 14v-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              ),
            },
            {
              n: "02",
              t: "だれもが参加する",
              d: "聞こえづらくても、字幕を読んで会議に加われます。",
              icon: (
                <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20a6 6 0 0 1 12 0M16.5 5.5a3 3 0 0 1 0 5.8M21 20a6 6 0 0 0-4.5-5.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              ),
            },
            {
              n: "03",
              t: "誤解をなくす",
              d: "みんなで校正して、誤解の残らない正確な議事録に。",
              icon: (
                <path d="M4 12.5 9 17.5 20 6.5M14 13l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              ),
            },
          ].map((s) => (
            <div key={s.n} className="flex flex-col items-start">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-hairline bg-surface text-celadon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                    {s.icon}
                  </svg>
                </span>
                <span className="font-mono text-sm text-muted-soft">{s.n}</span>
              </div>
              <h3 className="text-lg font-medium text-ink">{s.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-body">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── フッター ─── */}
      <footer className="border-t border-hairline-soft">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-5 py-8 text-xs text-muted sm:flex-row sm:px-8">
          <span>聞こえても、聞こえなくても。ことばを、みんなのものに。</span>
          <div className="flex items-center gap-4">
            <a
              href={`${getBasePath()}/manual.html`}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-ink"
            >
              使い方
            </a>
            <span className="text-muted-soft">v{packageJson.version}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
