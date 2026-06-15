/**
 * セッションID生成ユーティリティ。
 *
 * リンクシークレット（ケイパビリティ）モデル: セッションへのアクセス権は
 * 「推測不能なIDを知っていること」で表現する。そのため新規IDは暗号学的乱数で生成し、
 * タイムスタンプや Math.random のような推測・列挙が可能な値は使わない。
 */

/** 推測不能なセッションIDを生成する。 */
export function newSessionId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;

  // 標準: crypto.randomUUID（セキュアコンテキスト/Node 19+ で利用可能）
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }

  // フォールバック: getRandomValues による128bit乱数（HTTP等でrandomUUID不可の環境向け）
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // 最終フォールバック（暗号APIが全く無い環境。通常は到達しない）
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
