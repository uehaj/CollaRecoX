import { useEffect, useRef } from "react";

/**
 * 「この画面を閉じる/リロードすると共有文書への接続がゼロになる（＝自分が最後の接続）」
 * ときだけ、ブラウザの離脱確認を表示するフック。
 *
 * 共有Yjs文書は非永続で、room への接続数が0になると破棄される。最後の1人が
 * 何気なく閉じると内容が失われるため、その場合に限り確認を促す。
 *
 * 判定は HocuspocusProvider の awareness（プレゼンス）数で行う。各実画面の provider は
 * 自分のプレゼンスを publish しているため、`getStates().size === 1` なら自分だけが接続中。
 * 棚卸し用の一時プローブ接続は awareness を publish しないため、ここにはカウントされない。
 *
 * @param getProvider 現在の HocuspocusProvider を返すゲッター（ref.current など）。
 * @param enabled 共有文書に接続中のときだけ true。未接続時の誤確認を防ぐゲート。
 */

type AwarenessLike = { getStates: () => Map<unknown, unknown> };
type ProviderLike = { awareness?: AwarenessLike | null } | null | undefined;

export const useLeaveConfirmation = (
  getProvider: () => ProviderLike,
  enabled: boolean
): void => {
  // ハンドラは一度だけ登録し、最新の値は ref 経由で読む（再登録を避ける）。
  const getProviderRef = useRef(getProvider);
  getProviderRef.current = getProvider;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!enabledRef.current) return;
      let count = 0;
      try {
        const states = getProviderRef.current()?.awareness?.getStates();
        count = states ? states.size : 0;
      } catch {
        return; // 判定不能時は邪魔をしない
      }
      // 自分だけが接続している場合のみ確認する（閉じると接続ゼロ＝文書消失の恐れ）。
      if (count === 1) {
        e.preventDefault();
        e.returnValue = ""; // 一部ブラウザで確認ダイアログを出すために必要
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
};
