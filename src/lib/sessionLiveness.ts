/**
 * セッション（Yjsルーム）の生存確認ユーティリティ。
 *
 * 共有文書はインメモリ（非永続）で、room への接続数が0になると破棄される。
 * そのため localStorage の「最近のセッション」には、すでに中身が消えた死んだ
 * セッションが残りうる。ここでは指定 sessionId へ一時的に接続し、本文が空かどうかで
 * 「存在する/しない」を判定する（＝中身が空なら存在しないとみなす）。
 *
 * 設計上の注意:
 * - 存在しないセッションへ接続するとサーバー側に空文書が一瞬生成されるが、空なので
 *   どのみち除去対象＝無害。接続を閉じれば接続0で再び破棄される。
 * - 接続条件は editor / realtime と同一（url / room / token なし）。
 * - 判定後は必ず接続を破棄し、プローブ接続を残さない。
 */

import { getBasePath } from "@/lib/basePath";

// "alive"=本文あり / "empty"=同期できたが本文が空 / "unknown"=未確認（タイムアウト・エラー・認証失敗）
export type LivenessResult = "alive" | "empty" | "unknown";

const DEFAULT_TIMEOUT_MS = 4000;

// XmlFragment / XmlElement を再帰的にたどり、含まれるテキストを連結する。
// （空段落のみの文書を「空」と判定するため、要素数ではなく実テキストで判定する）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const collectText = (Y: any, node: any): string => {
  if (node instanceof Y.XmlText) return node.toString();
  if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return node.toArray().map((child: any) => collectText(Y, child)).join("");
  }
  return "";
};

/**
 * 指定セッションの本文有無を確認する。
 * @param sessionId 確認するセッションID
 * @param opts.timeoutMs 同期待ちのタイムアウト（既定 4000ms）。超過時は "unknown"。
 */
export const probeSessionContent = async (
  sessionId: string,
  opts: { timeoutMs?: number } = {}
): Promise<LivenessResult> => {
  if (typeof window === "undefined" || !sessionId) return "unknown";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let Y: typeof import("yjs");
  let HocuspocusProvider: typeof import("@hocuspocus/provider")["HocuspocusProvider"];
  try {
    const [yMod, providerMod] = await Promise.all([
      import("yjs"),
      import("@hocuspocus/provider"),
    ]);
    Y = yMod;
    HocuspocusProvider = providerMod.HocuspocusProvider;
  } catch {
    return "unknown";
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const websocketUrl = `${protocol}//${host}${getBasePath()}/api/yjs-ws`;
  const roomName = `transcribe-editor-v2-${sessionId}`;
  const fieldName = `content-${sessionId}`;

  const ydoc = new Y.Doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let provider: any = null;
  let settled = false;

  return await new Promise<LivenessResult>((resolve) => {
    const timer = setTimeout(() => finish("unknown"), timeoutMs);

    function finish(result: LivenessResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        provider?.disconnect();
        provider?.destroy();
      } catch {
        /* ignore */
      }
      try {
        ydoc.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    }

    try {
      provider = new HocuspocusProvider({
        url: websocketUrl,
        name: roomName,
        document: ydoc,
      });
    } catch {
      finish("unknown");
      return;
    }

    // 認証失敗（COLLAB_AUTH_TOKEN 有効時など）は「未確認」とし、誤って一覧から消さない。
    provider.on("authenticationFailed", () => finish("unknown"));

    provider.on("synced", () => {
      try {
        const fragment = ydoc.getXmlFragment(fieldName);
        const text = collectText(Y, fragment).trim();
        finish(text.length > 0 ? "alive" : "empty");
      } catch {
        finish("unknown");
      }
    });
  });
};
