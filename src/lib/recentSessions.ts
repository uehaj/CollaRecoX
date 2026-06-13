/**
 * 参加した配信（セッション）の履歴を localStorage に保持する。
 * ホーム画面の「最近のセッション」一覧や、共有リンクを介さない再訪に使う。
 */

export type SessionRole = "host" | "guest";

export interface RecentSession {
  id: string;
  role: SessionRole; // host=配信した代表者 / guest=校正に参加
  at: number; // 最終アクセス時刻（ms）
}

const KEY = "collarecox-recent-sessions";
const MAX = 8;

/** 履歴を新しい順で返す。 */
export function getRecentSessions(): RecentSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as RecentSession[])
      .filter((s) => s && typeof s.id === "string")
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/**
 * セッションを履歴に追加（既存なら最終アクセスを更新して先頭へ）。
 * 一度でも host になったセッションは host のまま保持する。
 */
export function addRecentSession(id: string, role: SessionRole): void {
  if (typeof window === "undefined" || !id) return;
  try {
    const existing = getRecentSessions();
    const prev = existing.find((s) => s.id === id);
    const resolvedRole: SessionRole = prev?.role === "host" ? "host" : role;
    const next: RecentSession[] = [
      { id, role: resolvedRole, at: Date.now() },
      ...existing.filter((s) => s.id !== id),
    ].slice(0, MAX);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* localStorage 不可時は黙って無視（フェイルセーフ） */
  }
}

/** 履歴から1件削除する。 */
export function removeRecentSession(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const next = getRecentSessions().filter((s) => s.id !== id);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** ざっくりした相対時刻表記（例: 3分前 / 2時間前 / 昨日 / 5日前）。 */
export function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return "昨日";
  if (day < 30) return `${day}日前`;
  const month = Math.floor(day / 30);
  return `${month}か月前`;
}
