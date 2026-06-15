/**
 * 配信セッションの作成と、配信権(hostToken)の端末ローカル保持。
 *
 * 配信権モデル: 配信(音声→字幕注入)は hostToken を持つ「配信者」だけが行える。
 * sessionId は校正リンクで露出するため配信権の証明にはならない。hostToken はサーバーが
 * セッション作成時(POST /api/sessions)に発行し、配信者の端末(localStorage)に保存する。
 */
import { getBasePath } from "./basePath";

const HOST_TOKEN_KEY = "collarecox-host-tokens";

type HostTokenMap = Record<string, string>;

function readMap(): HostTokenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(HOST_TOKEN_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as HostTokenMap) : {};
  } catch {
    return {};
  }
}

/** sessionId に対応する hostToken を返す（無ければ null）。 */
export function getHostToken(sessionId: string): string | null {
  if (!sessionId) return null;
  return readMap()[sessionId] ?? null;
}

/** sessionId と hostToken の対応を保存する。 */
export function setHostToken(sessionId: string, token: string): void {
  if (typeof window === "undefined" || !sessionId || !token) return;
  try {
    const map = readMap();
    map[sessionId] = token;
    window.localStorage.setItem(HOST_TOKEN_KEY, JSON.stringify(map));
  } catch {
    /* localStorage 不可時は無視（フェイルセーフ） */
  }
}

export interface BroadcastSession {
  sessionId: string;
  hostToken: string;
}

/**
 * サーバーに新しい配信セッションを作成させ、発行された hostToken を端末に保存する。
 * 返り値の sessionId が配信者の新規セッションになる。
 */
export async function createBroadcastSession(): Promise<BroadcastSession> {
  const res = await fetch(`${getBasePath()}/api/sessions`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status}`);
  }
  const data = (await res.json()) as Partial<BroadcastSession>;
  if (!data.sessionId || !data.hostToken) {
    throw new Error("Invalid session response");
  }
  setHostToken(data.sessionId, data.hostToken);
  return { sessionId: data.sessionId, hostToken: data.hostToken };
}
