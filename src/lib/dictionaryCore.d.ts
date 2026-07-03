// 固有名詞辞書のコア純関数モジュールの型宣言。
// 実装は同名の dictionaryCore.js（CommonJS）。server.js からは require、
// Next.js の TypeScript クライアントからはこの宣言を通じて import して型付きで利用する。

export interface DictionaryEntry {
  /** 誤認識されやすい語（音声認識結果の表記） */
  wrong: string;
  /** 正しい表記 */
  correct: string;
  /** 登録日時（epoch ms） */
  createdAt: number;
}

export interface DictLimits {
  /** 誤・正それぞれの最大文字数（trim後） */
  maxLen: number;
  /** 永続化する辞書エントリの最大件数（超過分は古いcreatedAtから削除） */
  maxEntries: number;
  /** AI校正プロンプトへ注入するエントリの最大件数（新しい順） */
  promptEntries: number;
}

export type ValidateDictionaryEntryResult =
  | { ok: true; wrong: string; correct: string }
  | { ok: false; reason: string };

export const DICT_LIMITS: DictLimits;

/**
 * 辞書エントリ（誤→正）の入力を検証する。
 * trim後1〜maxLen文字・改行不可・誤と正（trim後）が同一は不可・文字列以外は不可。
 */
export function validateDictionaryEntry(
  wrong: string,
  correct: string
): ValidateDictionaryEntryResult;

/**
 * 辞書エントリ一覧から、AI校正プロンプトへ注入する辞書節の文字列を生成する。
 * createdAt降順（新しい順）に並べ、DICT_LIMITS.promptEntries件までに制限する。
 * 空配列、または該当エントリが無い場合は空文字列を返す。
 */
export function buildDictionaryPromptSection(entries: DictionaryEntry[]): string;

/**
 * createdAtの新しい順にmax件を残し、あふれた古いエントリを分離する。
 * 上限内なら keep は入力順のまま・drop は空。超過時は keep が createdAt降順（新しい順）、
 * drop が createdAt昇順（古い順）で返る。
 */
export function pruneOldest(
  entries: DictionaryEntry[],
  max?: number
): { keep: DictionaryEntry[]; drop: DictionaryEntry[] };
