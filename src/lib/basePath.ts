/**
 * Next.js basePath を動的に取得するユーティリティ。
 * next.config.ts の basePath 設定値がビルド時に注入される。
 * basePath を変更しても、各コンポーネントでハードコードする必要がない。
 */
export const getBasePath = (): string => {
  return process.env.__NEXT_ROUTER_BASEPATH || "";
};
